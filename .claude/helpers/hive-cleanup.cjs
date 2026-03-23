#!/usr/bin/env node
//
// Hive Cleanup — Idle Agent Termination
//
// Trigger: Stop event + TeammateIdle event
//
// Flow:
//   1. Read all .hive-flow/hives/{id}/hive.json files
//   2. For each active hive, identify idle workers past threshold
//   3. Terminate excess idle workers (never below 5 workers per hive)
//   4. Update hive records, decrement budget.workersAllocated
//   5. Output cleanup summary JSON to stdout
//
// Safety:
//   - NEVER terminate below 5 workers per active hive (queen + 5 = 6 min)
//   - NEVER terminate queens
//   - NEVER terminate workers with status 'busy'
//   - Only terminate workers idle past threshold
//   - Uses mkdirSync locking for hive file access
//

'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = parseInt(process.env.HIVE_FLOW_IDLE_TIMEOUT_MS, 10) || 900000; // 15 min
const MIN_WORKERS_PER_HIVE = 5; // queen is separate; keep at least 5 workers alive
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const HIVES_DIR = path.join(PROJECT_DIR, '.hive-flow', 'hives');
const LOCK_MAX_WAIT = 10000; // 10s
const LOCK_STALE_THRESHOLD = 30000; // 30s

// ---------------------------------------------------------------------------
// Locking — mkdirSync-based (mirrors hive-store.ts withHiveLock)
// ---------------------------------------------------------------------------

function acquireLockSync(lockPath) {
  const start = Date.now();
  while (Date.now() - start < LOCK_MAX_WAIT) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch {
      // Check for stale lock
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_THRESHOLD) {
          try { fs.rmdirSync(lockPath); } catch { /* race */ }
          continue;
        }
      } catch {
        // Lock gone, retry
        continue;
      }
      // Busy-wait with small sleep (sync context)
      const waitUntil = Date.now() + 50 + Math.random() * 100;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { fs.rmdirSync(lockPath); } catch { /* ignore */ }
}

function withHiveLockSync(hiveId, fn) {
  const lockPath = path.join(HIVES_DIR, hiveId, '.lock');
  // Ensure hive dir exists (lock dir lives inside it)
  const hiveDir = path.join(HIVES_DIR, hiveId);
  if (!fs.existsSync(hiveDir)) {
    fs.mkdirSync(hiveDir, { recursive: true });
  }
  if (!acquireLockSync(lockPath)) {
    throw new Error(`Failed to acquire hive lock for ${hiveId} within ${LOCK_MAX_WAIT}ms`);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Hive I/O helpers
// ---------------------------------------------------------------------------

function loadHive(hiveId) {
  try {
    const hivePath = path.join(HIVES_DIR, hiveId, 'hive.json');
    if (!fs.existsSync(hivePath)) return null;
    return JSON.parse(fs.readFileSync(hivePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveHive(hiveId, record) {
  const hivePath = path.join(HIVES_DIR, hiveId, 'hive.json');
  const tmpPath = hivePath + '.tmp.' + process.pid;
  record.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(tmpPath, hivePath);
}

function listActiveHives() {
  if (!fs.existsSync(HIVES_DIR)) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(HIVES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const record = loadHive(entry.name);
        if (record && record.status === 'active') {
          results.push(record);
        }
      }
    }
  } catch { /* return whatever we have */ }
  return results;
}

// ---------------------------------------------------------------------------
// Agent termination via dynamic import of agent-tools.js (ESM from CJS)
// ---------------------------------------------------------------------------

let _agentTerminateHandler = null;

async function getTerminateHandler() {
  if (_agentTerminateHandler) return _agentTerminateHandler;

  const agentToolsPath = path.join(
    __dirname, '..', '..', 'v3', '@hive-flow', 'cli', 'dist', 'src', 'mcp-tools', 'agent-tools.js'
  );

  if (!fs.existsSync(agentToolsPath)) {
    return null;
  }

  try {
    const { pathToFileURL } = require('url');
    const mod = await import(pathToFileURL(agentToolsPath).href);
    const tools = mod.agentTools || [];
    const terminateTool = tools.find(t => t.name === 'agent_terminate');
    if (terminateTool && typeof terminateTool.handler === 'function') {
      _agentTerminateHandler = terminateTool.handler;
      return _agentTerminateHandler;
    }
  } catch {
    // Cannot load — fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core cleanup logic
// ---------------------------------------------------------------------------

async function cleanupIdleAgents() {
  const summary = {
    hivesScanned: 0,
    hivesWithCleanup: 0,
    workersTerminated: 0,
    terminated: [],
    errors: [],
  };

  const activeHives = listActiveHives();
  summary.hivesScanned = activeHives.length;

  if (activeHives.length === 0) {
    return summary;
  }

  const terminateHandler = await getTerminateHandler();

  const now = Date.now();

  for (const hive of activeHives) {
    try {
      const terminatedInHive = [];

      withHiveLockSync(hive.hiveId, () => {
        // Re-read under lock for freshness
        const freshHive = loadHive(hive.hiveId);
        if (!freshHive || freshHive.status !== 'active') return;

        const workers = freshHive.workers || [];

        // Partition workers
        const liveWorkers = workers.filter(w => w.status !== 'terminated');
        const idleWorkers = [];
        const nonIdleWorkers = [];

        for (const w of liveWorkers) {
          // Skip queens — NEVER terminate
          if (w.role === 'queen') {
            nonIdleWorkers.push(w);
            continue;
          }

          // Skip busy workers — NEVER terminate
          if (w.status === 'busy') {
            nonIdleWorkers.push(w);
            continue;
          }

          // Check idle threshold: use idleSince (falls back to spawnedAt)
          if (w.status === 'idle') {
            const idleSince = new Date(w.idleSince || w.spawnedAt).getTime();
            if (now - idleSince > IDLE_TIMEOUT_MS) {
              idleWorkers.push(w);
            } else {
              nonIdleWorkers.push(w);
            }
          } else {
            // spawning / error — count as non-idle (don't terminate)
            nonIdleWorkers.push(w);
          }
        }

        // Compute how many we can terminate:
        // terminatable = max(0, idleCount - max(0, MIN_WORKERS - nonIdleCount))
        // This ensures at least MIN_WORKERS_PER_HIVE workers remain alive.
        const keepFromIdle = Math.max(0, MIN_WORKERS_PER_HIVE - nonIdleWorkers.length);
        const terminatableCount = Math.max(0, idleWorkers.length - keepFromIdle);

        if (terminatableCount === 0) return;

        // Select workers to terminate (oldest idle first)
        const toTerminate = idleWorkers
          .sort((a, b) => new Date(a.spawnedAt).getTime() - new Date(b.spawnedAt).getTime())
          .slice(0, terminatableCount);

        // Mark as terminated in hive record
        for (const w of toTerminate) {
          w.status = 'terminated';
          w.terminatedAt = new Date().toISOString();
          terminatedInHive.push({ workerId: w.workerId, agentId: w.agentId, hiveId: freshHive.hiveId });
        }

        // Decrement budget
        freshHive.budget.workersAllocated = Math.max(
          0,
          (freshHive.budget.workersAllocated || 0) - toTerminate.length
        );

        // Append audit entries
        if (!freshHive.audit) freshHive.audit = [];
        for (const w of toTerminate) {
          freshHive.audit.push({
            timestamp: new Date().toISOString(),
            event: 'worker-terminated',
            hiveId: freshHive.hiveId,
            detail: 'Idle cleanup: terminated worker ' + w.workerId + ' (agent ' + w.agentId + ')',
            agentId: w.agentId,
            workerId: w.workerId,
          });
        }

        // Persist
        saveHive(freshHive.hiveId, freshHive);
      });

      // After releasing hive lock, terminate agents in the agent store (async)
      if (terminatedInHive.length > 0) {
        summary.hivesWithCleanup++;

        for (const entry of terminatedInHive) {
          try {
            if (terminateHandler) {
              await terminateHandler({ agentId: entry.agentId });
            }
            summary.workersTerminated++;
            summary.terminated.push(entry);
          } catch (err) {
            summary.errors.push({
              agentId: entry.agentId,
              error: err && err.message ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      summary.errors.push({
        hiveId: hive.hiveId,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// C1: Orphaned agent cleanup — idle agents not in any active hive
// ---------------------------------------------------------------------------

async function cleanupOrphanedAgents() {
  const summary = { orphansFound: 0, orphansTerminated: 0, terminated: [], errors: [] };
  const activeHives = listActiveHives();
  const activeAgentIds = new Set();
  for (const hive of activeHives) {
    for (const w of (hive.workers || [])) {
      if (w.agentId) activeAgentIds.add(w.agentId);
    }
  }
  const storePath = path.join(PROJECT_DIR, '.hive-flow', 'agents', 'store.json');
  let store;
  try {
    if (!fs.existsSync(storePath)) return summary;
    store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  } catch { return summary; }
  const now = Date.now();
  for (const [id, agent] of Object.entries(store.agents || {})) {
    if (agent.status !== 'idle') continue;
    if (activeAgentIds.has(id)) continue;
    const createdAt = new Date(agent.createdAt).getTime();
    if (now - createdAt > IDLE_TIMEOUT_MS) {
      summary.orphansFound++;
      try {
        const terminateHandler = await getTerminateHandler();
        if (terminateHandler) await terminateHandler({ agentId: id });
        summary.orphansTerminated++;
        summary.terminated.push({ agentId: id, reason: 'orphaned-idle' });
      } catch (err) {
        summary.errors.push({ agentId: id, error: err?.message || String(err) });
      }
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// C3: Stale hive directory cleanup — completed/failed/terminated >1h
// ---------------------------------------------------------------------------

const STALE_HIVE_THRESHOLD_MS = 14400000; // 4 hours

function cleanupStaleHiveDirs() {
  const summary = { hivesArchived: 0, archived: [], errors: [] };
  const hivesDir = path.join(PROJECT_DIR, '.hive-flow', 'hives');
  if (!fs.existsSync(hivesDir)) return summary;
  const now = Date.now();
  let entries;
  try { entries = fs.readdirSync(hivesDir, { withFileTypes: true }); } catch { return summary; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const hivePath = path.join(hivesDir, entry.name, 'hive.json');
    let record;
    try { record = JSON.parse(fs.readFileSync(hivePath, 'utf-8')); } catch { continue; }
    if (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'terminated') continue;
    const updatedAt = new Date(record.updatedAt).getTime();
    if (now - updatedAt < STALE_HIVE_THRESHOLD_MS) continue;
    try {
      fs.rmSync(path.join(hivesDir, entry.name), { recursive: true, force: true });
      summary.hivesArchived++;
      summary.archived.push({ hiveId: record.hiveId, status: record.status });
    } catch (err) {
      summary.errors.push({ hiveId: record.hiveId, error: err?.message || String(err) });
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// C4: Agent store pruning — remove terminated agents >1h
// ---------------------------------------------------------------------------

const AGENT_PRUNE_THRESHOLD_MS = 3600000;

function pruneTerminatedAgents() {
  const summary = { agentsPruned: 0, pruned: [], errors: [] };
  const storePath = path.join(PROJECT_DIR, '.hive-flow', 'agents', 'store.json');
  const lockPath = path.join(PROJECT_DIR, '.hive-flow', 'agents', '.store.lock');
  if (!fs.existsSync(storePath)) return summary;
  if (!acquireLockSync(lockPath)) {
    summary.errors.push({ error: 'Could not acquire store lock for pruning' });
    return summary;
  }
  try {
    const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    const now = Date.now();
    const toPrune = [];
    for (const [id, agent] of Object.entries(store.agents || {})) {
      if (agent.status !== 'terminated') continue;
      const createdAt = new Date(agent.createdAt).getTime();
      if (now - createdAt > AGENT_PRUNE_THRESHOLD_MS) toPrune.push(id);
    }
    if (toPrune.length === 0) return summary;
    for (const id of toPrune) {
      delete store.agents[id];
      summary.agentsPruned++;
      summary.pruned.push(id);
    }
    const tmpPath = storePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmpPath, storePath);
  } catch (err) {
    summary.errors.push({ error: err?.message || String(err) });
  } finally {
    releaseLock(lockPath);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// W3: Orphaned task file cleanup — stale .task/.json files with no result
// ---------------------------------------------------------------------------

const TASK_TTL_MS = 3600000; // 1 hour

function cleanupOrphanedTasks() {
  const summary = { tasksCleaned: 0, cleaned: [], errors: [] };
  const tasksDir = path.join(PROJECT_DIR, '.hive-flow', 'tasks');
  if (!fs.existsSync(tasksDir)) return summary;
  const now = Date.now();
  let entries;
  try { entries = fs.readdirSync(tasksDir); } catch { return summary; }
  // Group by task ID prefix
  const taskIds = new Set();
  for (const entry of entries) {
    const match = entry.match(/^(task-[a-f0-9-]+)\./);
    if (match) taskIds.add(match[1]);
  }
  for (const taskId of taskIds) {
    const jsonPath = path.join(tasksDir, `${taskId}.json`);
    const resultPath = path.join(tasksDir, `${taskId}.result.json`);
    const taskFilePath = path.join(tasksDir, `${taskId}.task`);
    // Skip if result exists (completed task)
    if (fs.existsSync(resultPath)) continue;
    // Check age of tracking file
    try {
      const stat = fs.statSync(jsonPath);
      if (now - stat.mtimeMs < TASK_TTL_MS) continue;
      // Stale task — no result after TTL. Clean up.
      try { fs.unlinkSync(jsonPath); } catch { /* ignore */ }
      try { fs.unlinkSync(taskFilePath); } catch { /* ignore */ }
      summary.tasksCleaned++;
      summary.cleaned.push(taskId);
    } catch {
      // No tracking file — check .task file age
      try {
        const stat = fs.statSync(taskFilePath);
        if (now - stat.mtimeMs < TASK_TTL_MS) continue;
        try { fs.unlinkSync(taskFilePath); } catch { /* ignore */ }
        summary.tasksCleaned++;
        summary.cleaned.push(taskId);
      } catch { /* neither file exists, skip */ }
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Main — run all cleanup and output JSON to stdout
// ---------------------------------------------------------------------------

(async () => {
  try {
    const hiveResult = await cleanupIdleAgents();
    const orphanResult = await cleanupOrphanedAgents();
    const hiveDirResult = cleanupStaleHiveDirs();
    const pruneResult = pruneTerminatedAgents();
    const taskResult = cleanupOrphanedTasks();

    const combined = {
      ...hiveResult,
      orphansFound: orphanResult.orphansFound,
      orphansTerminated: orphanResult.orphansTerminated,
      hivesArchived: hiveDirResult.hivesArchived,
      agentsPruned: pruneResult.agentsPruned,
      tasksCleaned: taskResult.tasksCleaned,
    };
    if (orphanResult.terminated.length > 0) {
      combined.terminated = (combined.terminated || []).concat(orphanResult.terminated);
    }
    if (hiveDirResult.archived?.length > 0) {
      combined.archived = hiveDirResult.archived;
    }
    const allErrors = [
      ...(hiveResult.errors || []),
      ...(orphanResult.errors || []),
      ...(hiveDirResult.errors || []),
      ...(pruneResult.errors || []),
      ...(taskResult.errors || []),
    ];
    if (allErrors.length > 0) combined.errors = allErrors;

    const totalWork = (combined.workersTerminated || 0) + (combined.orphansTerminated || 0)
      + (combined.hivesArchived || 0) + (combined.agentsPruned || 0) + (combined.tasksCleaned || 0);
    if (totalWork === 0 && allErrors.length === 0) {
      process.stdout.write(JSON.stringify({}));
    } else {
      process.stdout.write(JSON.stringify(combined));
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      error: err && err.message ? err.message : String(err),
    }));
  }
})();
