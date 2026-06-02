#!/usr/bin/env node
/**
 * Hive Enforcement Hook — PostToolUse for queen_mission_assign & queen_spawn_worker
 *
 * Ensures every hive has at least 5 workers (+ 1 queen = 6 total).
 * After a queen tool returns, reads the hive record, counts live workers,
 * and auto-spawns any deficit via agent_spawn (metadata-only, fast).
 * Then fires detached fork() processes for actual agent execution.
 *
 * Trigger: PostToolUse hook (queen_mission_assign, queen_spawn_worker)
 * Output: Claude Code PostToolUse protocol — JSON to stdout
 *
 * Safety:
 *   - Skips spawning at enforcement level 3 (HALTED)
 *   - Inline mkdirSync locking (no dist dependency for locking)
 *   - Provider cycling: gemini-cli -> codex-cli -> anthropic-cli
 *   - NEVER haiku
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { fork, spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const HIVE_FLOW_DIR = path.join(PROJECT_DIR, '.hive-flow');
const HIVES_DIR = path.join(HIVE_FLOW_DIR, 'hives');
const ENFORCEMENT_DIR = path.join(HIVE_FLOW_DIR, 'enforcement');
const AUDIT_FILE = path.join(ENFORCEMENT_DIR, 'hive-audit.jsonl');

const MIN_WORKERS = 5; // 5 workers + 1 queen = 6 total
const LOCK_TIMEOUT_MS = 10000; // 10s
const STALE_LOCK_MS = 30000; // 30s

// Provider round-robin cycle
const PROVIDERS = ['gemini-cli', 'codex-cli', 'anthropic-cli'];
const PROVIDER_MODELS = {
  'gemini-cli': 'gemini-3.1-pro-preview',
  'codex-cli': 'gpt-5.4',
  'anthropic-cli': 'sonnet',
};

// Triggered tool names
const TRIGGER_TOOLS = new Set([
  'queen_mission_assign',
  'queen_spawn_worker',
  'mcp__hive-flow__queen_mission_assign',
  'mcp__hive-flow__queen_spawn_worker',
]);

// Worker role templates for auto-spawning
const WORKER_ROLES = ['coder', 'reviewer', 'tester', 'researcher'];

// ---------------------------------------------------------------------------
// Enforcement level check
// ---------------------------------------------------------------------------

/**
 * Read the current enforcement level from state.json.
 * Returns 3 (HALTED) if unreadable or tampered — fail-closed.
 * Returns 0 (NORMAL) only for fresh installs with no state file.
 */
function readEnforcementLevel() {
  try {
    const stateFile = path.join(ENFORCEMENT_DIR, 'state.json');
    if (!fs.existsSync(stateFile)) return 0; // No state file = fresh install
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // BUG-08: Reject unsigned state — missing hmac/signature → HALTED (fail-closed)
    if (raw?.state !== undefined && typeof raw.state?.level === 'number') {
      if (!raw.hmac) return 3; // Unsigned state rejected
      if (!verifyEnforcementHmac(raw.state, raw.hmac)) return 3;
      return raw.state.level;
    }
    if (raw?.payload !== undefined && typeof raw.payload?.level === 'number') {
      if (!raw.signature) return 3; // Unsigned state rejected
      if (!verifyEnforcementHmac(raw.payload, raw.signature)) return 3;
      return raw.payload.level;
    }
    return 3; // Unrecognized format — fail-closed
  } catch {
    return 3; // fail-closed
  }
}

/**
 * Verify HMAC-SHA256 signature on enforcement state.
 * Returns true if valid, false otherwise.
 */
function verifyEnforcementHmac(stateObj, hmacHex) {
  try {
    const crypto = require('crypto');
    const hmacKeyFile = path.join(ENFORCEMENT_DIR, '.hmac-key');
    if (!fs.existsSync(hmacKeyFile)) return false;
    const key = fs.readFileSync(hmacKeyFile, 'utf8').trim();
    if (!key) return false;
    const expected = crypto.createHmac('sha256', key).update(JSON.stringify(stateObj)).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(hmacHex, 'hex');
    if (expectedBuf.length !== actualBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inline mkdirSync locking (self-contained, NO dist dependency)
// ---------------------------------------------------------------------------

/**
 * Acquire a directory-based lock. Returns true if acquired.
 * Uses mkdirSync atomic creation — same mechanism as hive-store.ts & agent-tools.ts.
 */
function acquireLock(lockPath) {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      return true;
    } catch {
      // Check for stale lock (older than 30s)
      try {
        const lockStat = fs.statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          try { fs.rmdirSync(lockPath); } catch { /* race with another cleaner */ }
          continue;
        }
      } catch {
        // Lock dir gone, retry
        continue;
      }
      // Busy-wait with small sleep (synchronous spinlock)
      const waitUntil = Date.now() + 50 + Math.random() * 100;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
  return false;
}

/**
 * Release a directory-based lock.
 */
function releaseLock(lockPath) {
  try { fs.rmdirSync(lockPath); } catch { /* ignore */ }
}

function countLiveWorkers(workers) {
  return (Array.isArray(workers) ? workers : []).filter(w => w.status !== 'terminated').length;
}

// ---------------------------------------------------------------------------
// Hive record helpers (inline — no dist dependency)
// ---------------------------------------------------------------------------

function sanitizeHiveId(hiveId) {
  const sanitized = String(hiveId || '').replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || null;
}

function getHiveDir(hiveId) {
  const sanitized = sanitizeHiveId(hiveId);
  if (!sanitized) return null;
  return path.join(HIVES_DIR, sanitized);
}

function getLockPath(hiveId) {
  const hiveDir = getHiveDir(hiveId);
  if (!hiveDir) return null;
  return path.join(hiveDir, '.lock');
}

function loadHiveRecord(hiveId) {
  try {
    const hiveDir = getHiveDir(hiveId);
    if (!hiveDir) return null;
    const hivePath = path.join(hiveDir, 'hive.json');
    if (!fs.existsSync(hivePath)) return null;
    return JSON.parse(fs.readFileSync(hivePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveHiveRecord(hiveId, record) {
  try {
    const hiveDir = getHiveDir(hiveId);
    if (!hiveDir) return false;
    fs.mkdirSync(hiveDir, { recursive: true });
    record.updatedAt = new Date().toISOString();
    const targetPath = path.join(hiveDir, 'hive.json');
    const tmpPath = targetPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch {
    return false;
  }
}

function releaseReservedWorkerSlot(hiveId, lockPath, slots = 1) {
  if (!acquireLock(lockPath)) {
    appendAuditLog({
      event: 'worker-reservation-release-failed',
      hiveId,
      reason: 'lock-timeout',
    });
    return;
  }

  try {
    const record = loadHiveRecord(hiveId);
    if (!record) {
      releaseLock(lockPath);
      return;
    }

    const liveWorkerCount = countLiveWorkers(record.workers);
    if (!record.budget) {
      record.budget = { workersAllocated: liveWorkerCount };
    } else {
      const currentAllocated = Number.isFinite(record.budget.workersAllocated)
        ? record.budget.workersAllocated
        : liveWorkerCount;
      record.budget.workersAllocated = Math.max(liveWorkerCount, currentAllocated - slots);
    }

    saveHiveRecord(hiveId, record);
    releaseLock(lockPath);
  } catch {
    releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Extract hiveId from tool_response content-array
// ---------------------------------------------------------------------------

/**
 * tool_response arrives as a JSON string containing a content-array:
 *   '[{ "type": "text", "text": "<json>" }]'
 *
 * The inner text is JSON with a `hiveId` field.
 */
function extractHiveId(input) {
  try {
    const toolResponse = input.tool_response || input.tool_result || '';
    const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
    if (!responseStr) return null;

    // Parse the content-array wrapper
    let contentArray;
    try {
      contentArray = JSON.parse(responseStr);
    } catch {
      // Maybe it's already the inner object
      try {
        const inner = JSON.parse(responseStr);
        if (inner && inner.hiveId) return inner.hiveId;
      } catch { /* fall through */ }
      return null;
    }

    // Content-array: [{ type: "text", text: "<json>" }]
    if (Array.isArray(contentArray)) {
      for (const item of contentArray) {
        if (item && item.type === 'text' && typeof item.text === 'string') {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed && parsed.hiveId) return parsed.hiveId;
          } catch { /* try next item */ }
        }
      }
    }

    // Direct object with hiveId
    if (contentArray && typeof contentArray === 'object' && contentArray.hiveId) {
      return contentArray.hiveId;
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

function rotateJSONL(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    if (fs.statSync(filePath).size < 5 * 1024 * 1024) return;
    const bak = filePath.replace(/\.jsonl$/, '.1.jsonl');
    try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch {}
    fs.renameSync(filePath, bak);
  } catch {}
}

function appendAuditLog(entry) {
  try {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    rotateJSONL(AUDIT_FILE);
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(AUDIT_FILE, line);
  } catch { /* audit is best-effort */ }
}

// ---------------------------------------------------------------------------
// Agent spawn via dynamic ESM import of agent-tools.js from dist/
// ---------------------------------------------------------------------------

let _agentToolsPromise = null;

/**
 * Lazy-load the compiled agent-tools.js from dist/ via CJS-ESM bridge.
 * Returns the agentTools array or null on failure.
 */
function loadAgentTools() {
  if (_agentToolsPromise) return _agentToolsPromise;
  try {
    const { pathToFileURL } = require('url');
    const agentToolsPath = path.join(
      __dirname, '..', '..', 'v3', '@hive-flow', 'cli', 'dist', 'src', 'mcp-tools', 'agent-tools.js'
    );
    if (!fs.existsSync(agentToolsPath)) {
      _agentToolsPromise = Promise.resolve(null);
      return _agentToolsPromise;
    }
    _agentToolsPromise = import(pathToFileURL(agentToolsPath).href)
      .then(mod => mod.agentTools || null)
      .catch(() => null);
    return _agentToolsPromise;
  } catch {
    _agentToolsPromise = Promise.resolve(null);
    return _agentToolsPromise;
  }
}

/**
 * Spawn a single worker via agent_spawn handler (metadata-only, fast).
 * Returns the spawn result or null on failure.
 */
async function spawnWorkerViaAgentTools(agentTools, role, provider, model, hiveId, queenId) {
  try {
    const spawnHandler = agentTools.find(t => t.name === 'agent_spawn');
    if (!spawnHandler) return null;
    const workerId = `worker-${randomUUID()}`;
    const result = await spawnHandler.handler({
      agentType: role,
      agentId: workerId,
      provider: provider,
      model: model,
      config: {
        autoSpawnedBy: 'hive-enforcement',
        hiveId,
        queenId,
      },
    });
    if (!result) return null;
    return { ...result, workerId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fire-and-forget worker execution via fork()
// ---------------------------------------------------------------------------

/**
 * Launch a detached background process for the spawned worker.
 * Non-blocking, fire-and-forget — mirrors terminate-agent.cjs pattern.
 */
function launchWorkerProcess(agentId, provider, role) {
  try {
    // The worker execution script — if it exists, fork it
    const workerScript = path.join(__dirname, 'hive-worker-exec.cjs');
    if (!fs.existsSync(workerScript)) {
      // No worker exec script — the spawn was metadata-only, which is still useful
      // The queen will task workers via queen_task_worker later
      appendAuditLog({
        event: 'worker-fork-skipped',
        agentId,
        provider,
        role,
        reason: 'hive-worker-exec.cjs not found — metadata-only spawn',
      });
      return;
    }
    const child = fork(workerScript, [agentId, provider, role], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });
    child.on('error', (err) => {
      appendAuditLog({
        event: 'worker-fork-error',
        agentId,
        provider,
        role,
        reason: err?.message || String(err),
      });
    });
    appendAuditLog({
      event: 'worker-fork-started',
      agentId,
      provider,
      role,
      pid: child.pid || null,
    });
    child.unref();
  } catch {
    appendAuditLog({
      event: 'worker-fork-error',
      agentId,
      provider,
      role,
      reason: 'fork-threw-synchronously',
    });
    // Fire-and-forget — failure must not block the hook
  }
}

function ensureHiveWatcherLaunched(toolName, sanitizedId) {
  if (toolName !== 'queen_mission_assign' && toolName !== 'mcp__hive-flow__queen_mission_assign') {
    return;
  }

  try {
    const watcherScript = path.join(PROJECT_DIR, 'scripts', 'hive-watcher.js');
    if (!fs.existsSync(watcherScript)) return;

    const progressFile = path.join(HIVE_FLOW_DIR, 'data', `watcher-${sanitizedId}.json`);
    let watcherAlive = false;
    try {
      if (fs.existsSync(progressFile)) {
        const prog = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        const age = Date.now() - new Date(prog.updatedAt || 0).getTime();
        watcherAlive = age < 60000;
      }
    } catch { /* treat as dead */ }

    if (watcherAlive) return;

    let tmuxPane = '';
    try {
      const tmuxFile = path.join(HIVE_FLOW_DIR, 'data', 'tmux-pane.txt');
      if (fs.existsSync(tmuxFile)) tmuxPane = fs.readFileSync(tmuxFile, 'utf8').trim();
    } catch { /* no tmux */ }

    const args = [watcherScript, sanitizedId, '--project-dir', PROJECT_DIR];
    if (tmuxPane) args.push('--tmux-pane', tmuxPane);

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });
    child.unref();

    appendAuditLog({
      event: 'watcher-launched',
      hiveId: sanitizedId,
      pid: child.pid || null,
      tmuxPane: tmuxPane || null,
    });
  } catch (err) {
    appendAuditLog({
      event: 'watcher-launch-error',
      hiveId: sanitizedId,
      reason: err?.message || String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Main enforcement logic
// ---------------------------------------------------------------------------

async function processPostToolUse(input) {
  const toolName = input.tool_name || '';

  // Only trigger on queen tools
  if (!TRIGGER_TOOLS.has(toolName)) {
    return {};
  }

  // Check enforcement level — skip spawning at HALTED (level 3)
  const enforcementLevel = readEnforcementLevel();
  if (enforcementLevel >= 3) {
    appendAuditLog({
      event: 'hive-enforcement-skipped',
      tool: toolName,
      reason: 'enforcement-level-HALTED',
      level: enforcementLevel,
    });
    return {};
  }

  // Extract hiveId from tool_response content-array
  const hiveId = extractHiveId(input);
  if (!hiveId) {
    appendAuditLog({
      event: 'hive-enforcement-skipped',
      tool: toolName,
      reason: 'no-hiveId-in-response',
    });
    return {};
  }

  const sanitizedId = sanitizeHiveId(hiveId);
  if (!sanitizedId) {
    return {};
  }

  const lockPath = getLockPath(sanitizedId);
  if (!lockPath) {
    return {};
  }

  // Step 1: Acquire lock, read hive record, count live workers
  if (!acquireLock(lockPath)) {
    appendAuditLog({
      event: 'hive-enforcement-skipped',
      hiveId: sanitizedId,
      tool: toolName,
      reason: 'lock-timeout',
    });
    return {};
  }

  let record;
  let liveWorkerCount;
  let deficit;
  let queenId;
  try {
    record = loadHiveRecord(sanitizedId);
    if (!record) {
      releaseLock(lockPath);
      appendAuditLog({
        event: 'hive-enforcement-skipped',
        hiveId: sanitizedId,
        tool: toolName,
        reason: 'hive-record-not-found',
      });
      return {};
    }

    queenId = record.queenId;

    ensureHiveWatcherLaunched(toolName, sanitizedId);

    // Count live workers plus any already-reserved budget slots.
    const workers = Array.isArray(record.workers) ? record.workers : [];
    liveWorkerCount = countLiveWorkers(workers);
    if (!record.budget) {
      record.budget = { workersAllocated: liveWorkerCount };
    }
    const currentAllocated = Number.isFinite(record.budget.workersAllocated)
      ? Math.max(record.budget.workersAllocated, liveWorkerCount)
      : liveWorkerCount;
    deficit = MIN_WORKERS - currentAllocated;

    if (deficit <= 0) {
      if (record.budget.workersAllocated !== currentAllocated) {
        record.budget.workersAllocated = currentAllocated;
        saveHiveRecord(sanitizedId, record);
      }
      releaseLock(lockPath);
      appendAuditLog({
        event: 'hive-enforcement-ok',
        hiveId: sanitizedId,
        tool: toolName,
        liveWorkers: currentAllocated,
        deficit: 0,
      });
      return {};
    }

    record.budget.workersAllocated = currentAllocated + deficit;
    saveHiveRecord(sanitizedId, record);
  } catch (err) {
    releaseLock(lockPath);
    appendAuditLog({
      event: 'hive-enforcement-error',
      hiveId: sanitizedId,
      tool: toolName,
      reason: 'read-phase-error: ' + (err?.message || String(err)),
    });
    return {};
  }

  // Step 2: Release lock BEFORE spawning (spawning may take time)
  releaseLock(lockPath);

  // Step 3: Load agent-tools from dist/
  const agentTools = await loadAgentTools();
  if (!agentTools) {
    releaseReservedWorkerSlot(sanitizedId, lockPath, deficit);
    appendAuditLog({
      event: 'hive-enforcement-skipped',
      hiveId: sanitizedId,
      tool: toolName,
      reason: 'agent-tools-not-available',
      deficit,
    });
    return {};
  }

  // Step 4: Spawn deficit workers with provider cycling
  const spawnedWorkers = [];
  const existingProviderCount = countLiveWorkers(record.workers);

  for (let i = 0; i < deficit; i++) {
    const providerIndex = (existingProviderCount + i) % PROVIDERS.length;
    const provider = PROVIDERS[providerIndex];
    const model = PROVIDER_MODELS[provider];
    const role = WORKER_ROLES[i % WORKER_ROLES.length];

    // 4a: Spawn via agent_spawn handler (metadata-only, fast)
    const spawnResult = await spawnWorkerViaAgentTools(agentTools, role, provider, model, sanitizedId, queenId);
    if (!spawnResult || !spawnResult.agentId) {
      releaseReservedWorkerSlot(sanitizedId, lockPath);
      appendAuditLog({
        event: 'worker-spawn-failed',
        hiveId: sanitizedId,
        role,
        provider,
        model,
        reason: 'agent_spawn returned no agentId',
      });
      continue;
    }

    const workerId = spawnResult.workerId || spawnResult.agentId;

    // 4b: Re-acquire lock, register worker in hive record, save
    if (!acquireLock(lockPath)) {
      releaseReservedWorkerSlot(sanitizedId, lockPath);
      appendAuditLog({
        event: 'worker-register-failed',
        hiveId: sanitizedId,
        workerId,
        reason: 'lock-timeout-on-register',
      });
      continue;
    }

    try {
      // Re-read hive record (may have changed)
      const freshRecord = loadHiveRecord(sanitizedId);
      if (!freshRecord) {
        releaseLock(lockPath);
        releaseReservedWorkerSlot(sanitizedId, lockPath);
        continue;
      }

      // Register worker
      if (!Array.isArray(freshRecord.workers)) {
        freshRecord.workers = [];
      }
      freshRecord.workers.push({
        workerId,
        agentId: spawnResult.agentId,
        role,
        provider,
        status: 'idle',
        spawnedAt: new Date().toISOString(),
        idleSince: new Date().toISOString(),
      });

      // Preserve any still-outstanding reservations while keeping the count
      // aligned with the actual live worker floor.
      if (!freshRecord.budget) {
        freshRecord.budget = { workersAllocated: countLiveWorkers(freshRecord.workers) };
      } else {
        const currentAllocated = Number.isFinite(freshRecord.budget.workersAllocated)
          ? freshRecord.budget.workersAllocated
          : 0;
        freshRecord.budget.workersAllocated = Math.max(
          currentAllocated,
          countLiveWorkers(freshRecord.workers)
        );
      }

      // Append audit entry (in-memory — MUST save after)
      if (!Array.isArray(freshRecord.audit)) {
        freshRecord.audit = [];
      }
      freshRecord.audit.push({
        timestamp: new Date().toISOString(),
        event: 'worker-spawned',
        hiveId: sanitizedId,
        detail: 'Auto-spawned by hive-enforcement: ' + role + ' via ' + provider + ' (' + model + ')',
        agentId: spawnResult.agentId,
        workerId,
      });

      // Save hive record (MUST call saveHive after appendHiveAudit)
      saveHiveRecord(sanitizedId, freshRecord);
      releaseLock(lockPath);

      spawnedWorkers.push({
        workerId,
        agentId: spawnResult.agentId,
        role,
        provider,
        model,
        resolvedModel: spawnResult.resolvedModel || model,
      });

      // 4c: Fire-and-forget fork for actual worker execution
      launchWorkerProcess(spawnResult.agentId, provider, role);
    } catch (err) {
      releaseLock(lockPath);
      releaseReservedWorkerSlot(sanitizedId, lockPath);
      appendAuditLog({
        event: 'worker-register-error',
        hiveId: sanitizedId,
        workerId,
        reason: err?.message || String(err),
      });
    }
  }

  // Step 5: Append to hive-audit.jsonl
  appendAuditLog({
    event: 'hive-enforcement-complete',
    hiveId: sanitizedId,
    tool: toolName,
    liveWorkersBefore: liveWorkerCount,
    deficit,
    spawned: spawnedWorkers.length,
    workers: spawnedWorkers.map(w => ({
      workerId: w.workerId,
      agentId: w.agentId,
      role: w.role,
      provider: w.provider,
    })),
  });

  // Step 6: Emit additionalContext to queen with worker IDs and providers
  if (spawnedWorkers.length > 0) {
    const workerSummary = spawnedWorkers
      .map(w => w.role + '(' + w.provider + ':' + w.agentId + ')')
      .join(', ');
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '[HIVE_ENFORCEMENT] Auto-spawned ' + spawnedWorkers.length + ' worker(s) for hive ' + sanitizedId + ' (deficit was ' + deficit + '): ' + workerSummary + '. Workers are registered in hive.json. Use queen_task_worker to assign tasks.',
      },
    };
  }

  return {};
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    try {
      const rawInput = readStdin();
      let input;
      try {
        input = JSON.parse(rawInput);
      } catch {
        input = {};
      }

      const result = await processPostToolUse(input);
      process.stdout.write(JSON.stringify(result));
    } catch (err) {
      // Fire-and-forget — errors must not block the hook. Emit empty JSON = allow.
      appendAuditLog({
        event: 'hive-enforcement-crash',
        reason: err?.message || String(err),
      });
      process.stdout.write(JSON.stringify({}));
    }
    process.exit(0);
  })();
}

// ---------------------------------------------------------------------------
// Exports (for testing and programmatic use)
// ---------------------------------------------------------------------------

module.exports = {
  processPostToolUse,
  extractHiveId,
  readEnforcementLevel,
  verifyEnforcementHmac,
  acquireLock,
  releaseLock,
  loadHiveRecord,
  saveHiveRecord,
  sanitizeHiveId,
  appendAuditLog,
  ensureHiveWatcherLaunched,
  TRIGGER_TOOLS,
  PROVIDERS,
  PROVIDER_MODELS,
  MIN_WORKERS,
};
