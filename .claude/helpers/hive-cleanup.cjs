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
const TASKS_DIR = path.join(PROJECT_DIR, '.hive-flow', 'tasks');
const AGENTS_DIR = path.join(PROJECT_DIR, '.hive-flow', 'agents');
const AGENT_STORE_PATH = path.join(AGENTS_DIR, 'store.json');
const LOCK_MAX_WAIT = parseInt(process.env.HIVE_FLOW_CLEANUP_LOCK_MAX_WAIT_MS, 10) || 1500;
const LOCK_STALE_THRESHOLD = 30000; // 30s
const CLEANUP_MAX_RUNTIME_MS = parseInt(process.env.HIVE_FLOW_CLEANUP_MAX_RUNTIME_MS, 10) || 4000;
const WAIT_SIGTERM_MS = parseInt(process.env.HIVE_FLOW_REAP_WAIT_MS, 10) || 3000;

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
      sleepSync(50 + Math.random() * 100);
    }
  }
  return false;
}

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(1, Math.floor(ms)));
}

function deadlineExceeded(deadline) {
  return Date.now() > deadline;
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
// OS reaper — resolve worker PIDs from task tracking files
// ---------------------------------------------------------------------------

function resolveWorkerPid(agentId) {
  try {
    if (!agentId || !fs.existsSync(TASKS_DIR)) return null;
    const files = fs.readdirSync(TASKS_DIR)
      .filter(f => f.endsWith('.json') && !f.endsWith('.result.json'));
    let best = null;
    for (const file of files) {
      let tracking;
      try {
        tracking = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), 'utf-8'));
      } catch {
        continue;
      }
      if (!tracking || tracking.agentId !== agentId) continue;
      if (!Number.isInteger(tracking.pid) || tracking.pid <= 1) continue;
      const startedAt = new Date(tracking.startedAt).getTime();
      const ts = Number.isFinite(startedAt) ? startedAt : 0;
      if (!best || ts > best.ts) best = { pid: tracking.pid, ts };
    }
    return best ? best.pid : null;
  } catch {
    return null;
  }
}

async function reapWithEscalation(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return 'unsafe-pid';
  if (pid === process.pid) return 'self';
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return 'gone';
  }

  await new Promise(resolve => setTimeout(resolve, WAIT_SIGTERM_MS));

  try {
    process.kill(pid, 0);
  } catch {
    return 'terminated';
  }

  try {
    process.kill(pid, 'SIGKILL');
    return 'killed';
  } catch {
    return 'killed-race';
  }
}

async function reapWorkerProcess(agentId) {
  const pid = resolveWorkerPid(agentId);
  if (!pid) return { agentId, signalled: false, reason: 'no-tracking-pid' };
  if (pid === process.pid || pid <= 1) {
    return { agentId, pid, signalled: false, reason: 'self-or-init' };
  }
  const outcome = await reapWithEscalation(pid);
  return {
    agentId,
    pid,
    signalled: outcome === 'terminated' || outcome === 'killed' || outcome === 'killed-race',
    reason: outcome,
  };
}

function isPositivePid(pid) {
  return Number.isInteger(pid) && pid > 1;
}

function isPidDefinitelyDead(pid) {
  if (!isPositivePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err && err.code === 'ESRCH';
  }
}

// ---------------------------------------------------------------------------
// Core cleanup logic
// ---------------------------------------------------------------------------

async function cleanupIdleAgents(deadline = Date.now() + CLEANUP_MAX_RUNTIME_MS) {
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
    if (deadlineExceeded(deadline)) {
      summary.errors.push({ error: `Cleanup runtime budget exceeded after scanning ${summary.hivesScanned} hives` });
      break;
    }
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
            const reap = await reapWorkerProcess(entry.agentId);
            entry.reap = reap;
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
// Stale busy cleanup — only demote busy agents whose tracked child PID is gone
// ---------------------------------------------------------------------------

async function cleanupStaleBusyAgents(deadline = Date.now() + CLEANUP_MAX_RUNTIME_MS) {
  const summary = {
    staleBusyFound: 0,
    staleBusyReaped: 0,
    hiveWorkersReaped: 0,
    staleBusyAgents: [],
    errors: [],
  };

  if (!fs.existsSync(AGENT_STORE_PATH)) return summary;
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const lockPath = path.join(AGENTS_DIR, '.store.lock');
  if (!acquireLockSync(lockPath)) {
    summary.errors.push({ error: 'Could not acquire store lock for stale busy cleanup' });
    return summary;
  }

  const staleByAgentId = new Map();
  const nowIso = new Date().toISOString();

  try {
    let store;
    try {
      store = JSON.parse(fs.readFileSync(AGENT_STORE_PATH, 'utf-8'));
    } catch (err) {
      summary.errors.push({ error: err?.message || String(err) });
      return summary;
    }

    for (const [id, agent] of Object.entries(store.agents || {})) {
      if (deadlineExceeded(deadline)) {
        summary.errors.push({ error: 'Cleanup runtime budget exceeded while scanning stale busy agents' });
        break;
      }
      if (!agent || agent.status !== 'busy') continue;
      const pid = agent.currentTaskPid;
      if (!isPositivePid(pid)) continue;
      if (!isPidDefinitelyDead(pid)) continue;

      summary.staleBusyFound++;
      agent.status = 'idle';
      agent.idleSince = nowIso;
      delete agent.currentTaskPid;
      staleByAgentId.set(id, { agentId: id, pid, status: 'idle' });
    }

    if (staleByAgentId.size > 0) {
      const tmpPath = AGENT_STORE_PATH + '.tmp.' + process.pid;
      fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
      fs.renameSync(tmpPath, AGENT_STORE_PATH);
      summary.staleBusyReaped = staleByAgentId.size;
      summary.staleBusyAgents = [...staleByAgentId.values()];
    }
  } finally {
    releaseLock(lockPath);
  }

  if (staleByAgentId.size === 0) return summary;

  const activeHives = listActiveHives();
  for (const hive of activeHives) {
    if (deadlineExceeded(deadline)) {
      summary.errors.push({ error: 'Cleanup runtime budget exceeded while updating stale busy hive workers' });
      break;
    }
    try {
      withHiveLockSync(hive.hiveId, () => {
        const freshHive = loadHive(hive.hiveId);
        if (!freshHive || freshHive.status !== 'active') return;
        let changed = false;
        for (const worker of freshHive.workers || []) {
          if (!worker || worker.status !== 'busy') continue;
          const stale = staleByAgentId.get(worker.agentId);
          if (!stale) continue;
          worker.status = 'idle';
          worker.idleSince = nowIso;
          changed = true;
          summary.hiveWorkersReaped++;
          stale.hiveId = freshHive.hiveId;
          stale.workerId = worker.workerId;
        }
        if (!changed) return;
        if (!freshHive.audit) freshHive.audit = [];
        for (const stale of staleByAgentId.values()) {
          if (stale.hiveId !== freshHive.hiveId) continue;
          freshHive.audit.push({
            timestamp: nowIso,
            event: 'worker-idle',
            hiveId: freshHive.hiveId,
            detail: 'Stale busy cleanup: marked worker idle after child PID disappeared',
            agentId: stale.agentId,
            workerId: stale.workerId,
            pid: stale.pid,
          });
        }
        saveHive(freshHive.hiveId, freshHive);
      });
    } catch (err) {
      summary.errors.push({ hiveId: hive.hiveId, error: err?.message || String(err) });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// C1: Orphaned agent cleanup — idle agents not in any active hive
// ---------------------------------------------------------------------------

async function cleanupOrphanedAgents(deadline = Date.now() + CLEANUP_MAX_RUNTIME_MS) {
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
    if (deadlineExceeded(deadline)) {
      summary.errors.push({ error: 'Cleanup runtime budget exceeded while scanning orphaned agents' });
      break;
    }
    if (agent.status !== 'idle') continue;
    if (activeAgentIds.has(id)) continue;
    const createdAt = new Date(agent.createdAt).getTime();
    if (now - createdAt > IDLE_TIMEOUT_MS) {
      summary.orphansFound++;
      try {
        const terminateHandler = await getTerminateHandler();
        if (terminateHandler) await terminateHandler({ agentId: id });
        const reap = await reapWorkerProcess(id);
        summary.orphansTerminated++;
        summary.terminated.push({ agentId: id, reason: 'orphaned-idle', reap });
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

function cleanupStaleHiveDirs(deadline = Date.now() + CLEANUP_MAX_RUNTIME_MS) {
  const summary = { hivesArchived: 0, archived: [], errors: [] };
  const hivesDir = path.join(PROJECT_DIR, '.hive-flow', 'hives');
  if (!fs.existsSync(hivesDir)) return summary;
  const now = Date.now();
  let entries;
  try { entries = fs.readdirSync(hivesDir, { withFileTypes: true }); } catch { return summary; }
  for (const entry of entries) {
    if (deadlineExceeded(deadline)) {
      summary.errors.push({ error: 'Cleanup runtime budget exceeded while scanning stale hive dirs' });
      break;
    }
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
const RESULT_TTL_MS = parseInt(process.env.HIVE_FLOW_RESULT_TTL_MS, 10) || 14400000; // 4 hours
const STUCK_ACTIVE_THRESHOLD_MS = parseInt(process.env.HIVE_FLOW_STUCK_ACTIVE_THRESHOLD_MS, 10) || (12 * 60 * 60_000);
const LEGACY_WATCHER_TTL_MS = parseInt(process.env.HIVE_FLOW_LEGACY_WATCHER_TTL_MS, 10) || 14400000; // 4 hours

function findHiveByTaskTracking(tracking) {
  if (tracking && tracking.hiveId) return loadHive(String(tracking.hiveId));
  if (!fs.existsSync(HIVES_DIR)) return null;
  try {
    const entries = fs.readdirSync(HIVES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const hive = loadHive(entry.name);
      if (!hive || !Array.isArray(hive.workers)) continue;
      if (hive.workers.some(w => w.agentId === tracking?.agentId || w.taskId === tracking?.taskId)) {
        return hive;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function autoFailStuckActiveHives(deadline = Date.now() + CLEANUP_MAX_RUNTIME_MS) {
  const summary = { hivesScanned: 0, autoFailed: 0, failed: [], errors: [] };
  const activeHives = listActiveHives();
  summary.hivesScanned = activeHives.length;
  const now = Date.now();

  for (const hive of activeHives) {
    if (deadlineExceeded(deadline)) {
      summary.errors.push({ error: 'Cleanup runtime budget exceeded while auto-failing stuck active hives' });
      break;
    }
    const updatedAt = new Date(hive.updatedAt || hive.createdAt || 0).getTime();
    if (!Number.isFinite(updatedAt) || now - updatedAt < STUCK_ACTIVE_THRESHOLD_MS) continue;

    const workersToReap = [];
    try {
      withHiveLockSync(hive.hiveId, () => {
        const freshHive = loadHive(hive.hiveId);
        if (!freshHive || freshHive.status !== 'active') return;
        const freshUpdatedAt = new Date(freshHive.updatedAt || freshHive.createdAt || 0).getTime();
        if (!Number.isFinite(freshUpdatedAt) || now - freshUpdatedAt < STUCK_ACTIVE_THRESHOLD_MS) return;

        freshHive.status = 'failed';
        if (!freshHive.error) freshHive.error = 'stuck-active-timeout';
        freshHive.completedAt = new Date().toISOString();
        if (!freshHive.audit) freshHive.audit = [];
        freshHive.audit.push({
          timestamp: new Date().toISOString(),
          event: 'error',
          hiveId: freshHive.hiveId,
          detail: 'Auto-failed stuck active hive during cleanup',
        });
        for (const w of freshHive.workers || []) {
          if (w.role === 'queen' || w.status === 'terminated') continue;
          if (w.agentId) workersToReap.push(w.agentId);
        }
        saveHive(freshHive.hiveId, freshHive);
      });

      if (workersToReap.length === 0 && loadHive(hive.hiveId)?.status !== 'failed') continue;

      const reaped = [];
      for (const agentId of workersToReap) {
        reaped.push(await reapWorkerProcess(agentId));
      }
      summary.autoFailed++;
      summary.failed.push({ hiveId: hive.hiveId, reaped });
    } catch (err) {
      summary.errors.push({ hiveId: hive.hiveId, error: err?.message || String(err) });
    }
  }
  return summary;
}

function cleanupOrphanedTasks(deadline = Date.now() + CLEANUP_MAX_RUNTIME_MS) {
  const summary = { tasksCleaned: 0, completedResultsCleaned: 0, cleaned: [], errors: [] };
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
    if (deadlineExceeded(deadline)) {
      summary.errors.push({ error: 'Cleanup runtime budget exceeded while scanning orphaned tasks' });
      break;
    }
    const jsonPath = path.join(tasksDir, `${taskId}.json`);
    const resultPath = path.join(tasksDir, `${taskId}.result.json`);
    const taskFilePath = path.join(tasksDir, `${taskId}.task`);
    // Skip if result exists (completed task)
    if (fs.existsSync(resultPath)) {
      try {
        const tracking = fs.existsSync(jsonPath)
          ? JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
          : { taskId };
        const resultStat = fs.statSync(resultPath);
        if (now - resultStat.mtimeMs < RESULT_TTL_MS) continue;
        const hive = findHiveByTaskTracking(tracking);
        if (!hive || (hive.status !== 'completed' && hive.status !== 'failed' && hive.status !== 'terminated')) continue;
        try { fs.unlinkSync(jsonPath); } catch { /* ignore */ }
        try { fs.unlinkSync(resultPath); } catch { /* ignore */ }
        try { fs.unlinkSync(taskFilePath); } catch { /* ignore */ }
        summary.completedResultsCleaned++;
        summary.cleaned.push(taskId);
      } catch (err) {
        summary.errors.push({ taskId, error: err?.message || String(err) });
      }
      continue;
    }
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

function cleanupLegacyWatchersDir(deadline = Date.now() + CLEANUP_MAX_RUNTIME_MS) {
  const summary = { watchersPruned: 0, pruned: [], errors: [] };
  const legacyWatchersDir = path.join(PROJECT_DIR, '.hive-flow', 'watchers');
  const liveDataDir = path.join(PROJECT_DIR, '.hive-flow', 'data');
  if (legacyWatchersDir === liveDataDir || legacyWatchersDir.startsWith(liveDataDir + path.sep)) {
    summary.errors.push({ error: 'Legacy watcher path overlaps live data watcher path' });
    return summary;
  }
  if (!fs.existsSync(legacyWatchersDir)) return summary;
  let entries;
  try { entries = fs.readdirSync(legacyWatchersDir, { withFileTypes: true }); } catch { return summary; }
  const now = Date.now();
  for (const entry of entries) {
    if (deadlineExceeded(deadline)) {
      summary.errors.push({ error: 'Cleanup runtime budget exceeded while pruning legacy watchers' });
      break;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(legacyWatchersDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs < LEGACY_WATCHER_TTL_MS) continue;
      fs.unlinkSync(filePath);
      summary.watchersPruned++;
      summary.pruned.push(entry.name);
    } catch (err) {
      summary.errors.push({ file: entry.name, error: err?.message || String(err) });
    }
  }
  try {
    if (fs.readdirSync(legacyWatchersDir).length === 0) fs.rmdirSync(legacyWatchersDir);
  } catch { /* ignore */ }
  return summary;
}

// ---------------------------------------------------------------------------
// Main — run all cleanup and output JSON to stdout
// ---------------------------------------------------------------------------

(async () => {
  try {
    const deadline = Date.now() + CLEANUP_MAX_RUNTIME_MS;
    const hiveResult = await cleanupIdleAgents(deadline);
    const staleBusyResult = await cleanupStaleBusyAgents(deadline);
    const orphanResult = await cleanupOrphanedAgents(deadline);
    const autoFailResult = await autoFailStuckActiveHives(deadline);
    const hiveDirResult = cleanupStaleHiveDirs(deadline);
    const pruneResult = pruneTerminatedAgents();
    const taskResult = cleanupOrphanedTasks(deadline);
    const watcherResult = cleanupLegacyWatchersDir(deadline);

    const combined = {
      ...hiveResult,
      staleBusyReaped: staleBusyResult.staleBusyReaped,
      hiveWorkersReaped: staleBusyResult.hiveWorkersReaped,
      orphansFound: orphanResult.orphansFound,
      orphansTerminated: orphanResult.orphansTerminated,
      hivesAutoFailed: autoFailResult.autoFailed,
      hivesArchived: hiveDirResult.hivesArchived,
      agentsPruned: pruneResult.agentsPruned,
      tasksCleaned: taskResult.tasksCleaned,
      completedResultsCleaned: taskResult.completedResultsCleaned,
      legacyWatchersPruned: watcherResult.watchersPruned,
    };
    if (orphanResult.terminated.length > 0) {
      combined.terminated = (combined.terminated || []).concat(orphanResult.terminated);
    }
    if (staleBusyResult.staleBusyAgents.length > 0) {
      combined.staleBusyAgents = staleBusyResult.staleBusyAgents;
    }
    if (hiveDirResult.archived?.length > 0) {
      combined.archived = hiveDirResult.archived;
    }
    if (autoFailResult.failed?.length > 0) {
      combined.autoFailed = autoFailResult.failed;
    }
    if (watcherResult.pruned?.length > 0) {
      combined.legacyWatchers = watcherResult.pruned;
    }
    const allErrors = [
      ...(hiveResult.errors || []),
      ...(staleBusyResult.errors || []),
      ...(orphanResult.errors || []),
      ...(autoFailResult.errors || []),
      ...(hiveDirResult.errors || []),
      ...(pruneResult.errors || []),
      ...(taskResult.errors || []),
      ...(watcherResult.errors || []),
    ];
    if (allErrors.length > 0) combined.errors = allErrors;

    const totalWork = (combined.workersTerminated || 0) + (combined.orphansTerminated || 0)
      + (combined.hivesAutoFailed || 0) + (combined.hivesArchived || 0) + (combined.agentsPruned || 0)
      + (combined.tasksCleaned || 0) + (combined.completedResultsCleaned || 0) + (combined.legacyWatchersPruned || 0)
      + (combined.staleBusyReaped || 0) + (combined.hiveWorkersReaped || 0);
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
