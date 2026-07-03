#!/usr/bin/env node
/**
 * Hive Sentinel Watcher — Detached background process that monitors hive
 * worker completion and writes durable completion signals when done.
 *
 * Spawned by hive-enforcement.cjs PostToolUse hook after queen_mission_assign.
 * Runs fully detached (stdio: 'ignore', detached: true, unref'd).
 *
 * Mechanisms:
 *   1. Pending notification drain — writes the next-prompt fallback queue
 *   2. Progress file — writes .hive-flow/data/watcher-{hiveId}.json every cycle
 *   3. Done markers — writes .hive-flow/data/hive-{hiveId}.done on completion
 *
 * Stale detection: If no worker transitions (completed/failed count) change
 * across 3 consecutive cycles (each cycle = POLL_INTERVAL_MS), the hive is
 * considered stale. No hard timeout cap — purely progress-based.
 *
 * Usage:
 *   node scripts/hive-watcher.cjs <hiveId> [--tmux-pane <pane>] [--project-dir <dir>]
 *   --tmux-pane is accepted for legacy launcher compatibility and ignored.
 *
 * @module scripts/hive-watcher
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { appendPendingWithAck } = require('../.claude/helpers/dedup-marker.cjs');
const { resolveSessionId } = require('../.claude/helpers/session-id.cjs');
const { wakeSessionPaths } = require('../.claude/helpers/wake-paths.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15_000;       // 15s between polls
const STALE_THRESHOLD = 3;              // 3 consecutive unchanged polls = stale
const MAX_RUNTIME_MS = 12 * 60 * 60_000; // 12h hard safety cap (prevent zombie)

// Control-plane audit log is global (mirrors enforcement.cjs / hive-enforcement.cjs). hive-audit.jsonl
// is WRITTEN to the global Hive home; data-plane watcher progress/done files stay project-local.
function resolveHiveHome() {
  const configured = String(process.env.HIVE_FLOW_HOME || '').trim();
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  return path.join(os.homedir(), '.hive-flow');
}
const HIVE_HOME = resolveHiveHome();

function loadProtectedPathPolicyModule() {
  const envProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || '';
  const candidates = [
    envProjectRoot && path.join(path.resolve(envProjectRoot), 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(process.cwd()), 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(__dirname, '..'), 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return require(path.join(path.resolve(__dirname, '..'), 'cli', 'src', 'permission-guard', 'protected-paths.cjs'));
}

const protectedPathPolicy = loadProtectedPathPolicyModule();

function defaultProjectRoot() {
  return protectedPathPolicy.resolveProjectRoot({
    env: process.env,
    cwd: path.resolve(__dirname, '..'),
    fallbackRoot: process.cwd(),
  });
}

function resolveExplicitProjectRoot(projectDir) {
  return protectedPathPolicy.resolveProjectRoot({
    env: {},
    cwd: projectDir,
    fallbackRoot: process.cwd(),
  });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2);
  const result = {
    hiveId: null,
    sessionId: null,
    queenId: null,
    tmuxPane: null,
    projectDir: defaultProjectRoot(),
  };
  let explicitSessionId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tmux-pane' && args[i + 1]) {
      result.tmuxPane = args[++i];
    } else if (args[i] === '--project-dir' && args[i + 1]) {
      result.projectDir = resolveExplicitProjectRoot(args[++i]);
    } else if (args[i] === '--hiveId' && args[i + 1]) {
      result.hiveId = args[++i];
    } else if (args[i] === '--sessionId' && args[i + 1]) {
      explicitSessionId = args[++i];
    } else if (args[i] === '--queenId' && args[i + 1]) {
      result.queenId = args[++i];
    } else if (!args[i].startsWith('--') && !result.hiveId) {
      result.hiveId = args[i];
    }
  }

  result.sessionId = resolveSessionId(
    explicitSessionId ? { session_id: explicitSessionId } : null,
    env || {},
  );
  return result;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function decorateWakePaths(paths, ownerSessionId) {
  const wake = wakeSessionPaths(
    ownerSessionId ? { session_id: ownerSessionId } : null,
    process.env,
  );
  if (!wake) return paths;
  return {
    ...paths,
    wakeSessionKey: wake.sessionKey,
    wakeSessionDir: wake.sessionDir,
    wakePendingFile: wake.pendingFile,
    wakeHiveDoneFile: wake.hiveDoneFile,
    wakeTaskDoneFile: wake.taskDoneFile,
  };
}

function getPaths(projectDir, ownerSessionId = null) {
  const hiveFlowDir = path.join(projectDir, '.hive-flow');
  const dataDir = path.join(hiveFlowDir, 'data');
  return decorateWakePaths({
    hiveFlowDir,
    hivesDir: path.join(hiveFlowDir, 'hives'),
    tasksDir: path.join(hiveFlowDir, 'tasks'),
    dataDir,
    logsDir: path.join(hiveFlowDir, 'logs'),
    stopFile: (hiveId) => path.join(dataDir, 'watcher-' + sanitizeHiveId(hiveId) + '.stop'),
  }, ownerSessionId);
}

// ---------------------------------------------------------------------------
// Hive record reader (inline, same as hive-enforcement.cjs)
// ---------------------------------------------------------------------------

function sanitizeHiveId(hiveId) {
  const sanitized = String(hiveId || '').replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || null;
}

function loadHiveRecord(hivesDir, hiveId) {
  try {
    const sanitized = sanitizeHiveId(hiveId);
    if (!sanitized) return null;
    const hivePath = path.join(hivesDir, sanitized, 'hive.json');
    if (!fs.existsSync(hivePath)) return null;
    return JSON.parse(fs.readFileSync(hivePath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worker polling (mirrors hive_poll_workers logic from queen-tools.ts)
// ---------------------------------------------------------------------------

/**
 * Poll all workers in a hive. Checks:
 *   1. hive.json worker records (status === 'terminated' => skip)
 *   2. .hive-flow/tasks/<taskId>.result.json presence => completed
 *   3. PID liveness via process.kill(pid, 0) => running
 *   4. Dead PID with no result => failed
 *   5. No task tracking entry => idle
 *
 * Returns { completedCount, runningCount, failedCount, idleCount, terminatedCount, allComplete }
 */
/**
 * P2-SH2 (hive-flow-4a28): worker IDs BLOCKED on an undecided permission request.
 * A blocked worker must NOT let a hive be declared allComplete. Source of truth is
 * BOTH the persisted hive.permissionRequests AND the append-only
 * permission-requests.jsonl (fresh bridge requests not yet surfaced to the queen).
 * A request blocks its worker unless it has a terminal decision recorded.
 */
function blockedPermissionWorkerIds(hivesDir, hiveId, hive) {
  const blocked = new Set();
  const agentToWorker = new Map();
  for (const w of (hive.workers || [])) {
    if (w && w.agentId && w.workerId) agentToWorker.set(w.agentId, w.workerId);
  }
  const decidedStatus = new Map();
  for (const r of (hive.permissionRequests || [])) {
    if (r && r.requestId) decidedStatus.set(r.requestId, r.status);
    if (r && r.status === 'pending') {
      const wid = r.workerId || agentToWorker.get(r.agentId);
      if (wid) blocked.add(wid);
    }
  }
  const logPath = path.join(hivesDir, hiveId, 'permission-requests.jsonl');
  if (fs.existsSync(logPath)) {
    try {
      for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || !req.requestId) continue;
        const status = decidedStatus.get(req.requestId);
        // Undecided if never persisted, or persisted but still pending.
        if (status === undefined || status === 'pending') {
          const wid = req.workerId || agentToWorker.get(req.agentId);
          if (wid) blocked.add(wid);
        }
      }
    } catch { /* log unreadable — persisted requests above still apply */ }
  }
  return blocked;
}

/**
 * P4 (hive-flow-5de8): worker IDs WAITING on an un-answered inter-agent
 * escalation (verb blocked/ask, requiresAck, still pending/delivered in the
 * durable message store -- cli/src/mcp-tools/agent-message-store.ts). Mirrors
 * blockedPermissionWorkerIds: a waiting worker must NOT let the hive be
 * declared allComplete, or the sentinel would settle a hive whose worker is
 * mid-conversation. Content-matched (from.agentId) across all inbox dirs so
 * the scan cannot drift from the store's recipient-key derivation. Read-only.
 */
function waitingOnPeerWorkerIds(hivesDir, hive) {
  const waiting = new Set();
  const agentToWorker = new Map();
  for (const w of (hive.workers || [])) {
    if (w && w.agentId && w.workerId && w.status !== 'terminated') agentToWorker.set(w.agentId, w.workerId);
  }
  if (agentToWorker.size === 0) return waiting;
  const projectRoot = path.dirname(path.dirname(hivesDir));
  const inboxRoot = path.join(projectRoot, '.hive-flow', 'messages', 'inbox');
  if (!fs.existsSync(inboxRoot)) return waiting;
  let recipientDirs;
  try { recipientDirs = fs.readdirSync(inboxRoot); } catch { return waiting; }
  for (const dirName of recipientDirs) {
    const dirPath = path.join(inboxRoot, dirName);
    let entries;
    try { entries = fs.readdirSync(dirPath); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      let record;
      try { record = JSON.parse(fs.readFileSync(path.join(dirPath, entry), 'utf8')); } catch { continue; }
      if (!record || !record.from || !record.from.agentId) continue;
      const workerId = agentToWorker.get(record.from.agentId);
      if (!workerId) continue;
      if (record.verb !== 'blocked' && record.verb !== 'ask') continue;
      if (!record.requiresAck) continue;
      if (record.deliveryState !== 'pending' && record.deliveryState !== 'delivered') continue;
      waiting.add(workerId);
    }
  }
  return waiting;
}

function pollWorkers(hivesDir, tasksDir, hiveId) {
  const hive = loadHiveRecord(hivesDir, hiveId);
  if (!hive || !Array.isArray(hive.workers)) {
    return { error: 'hive-not-found', completedCount: 0, runningCount: 0, failedCount: 0, idleCount: 0, terminatedCount: 0, allComplete: false };
  }

  // Build agentId -> tracking entries map
  const agentTaskMap = new Map();
  if (fs.existsSync(tasksDir)) {
    try {
      const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json') && !f.endsWith('.result.json'));
      for (const file of files) {
        const trackingPath = path.join(tasksDir, file);
        try {
          const tracking = JSON.parse(fs.readFileSync(trackingPath, 'utf8'));
          if (!tracking.agentId || !tracking.taskId) continue;
          if (!agentTaskMap.has(tracking.agentId)) agentTaskMap.set(tracking.agentId, []);
          const resultPath = path.join(tasksDir, `${tracking.taskId}.result.json`);
          agentTaskMap.get(tracking.agentId).push({ taskId: tracking.taskId, trackingPath, resultPath, tracking });
        } catch { /* skip unparseable */ }
      }
    } catch { /* tasksDir unreadable */ }
  }

  let completedCount = 0;
  let runningCount = 0;
  let failedCount = 0;
  let idleCount = 0;
  let terminatedCount = 0;

  for (const worker of hive.workers) {
    if (worker.status === 'terminated') {
      terminatedCount++;
      continue;
    }

    const tasks = agentTaskMap.get(worker.agentId);
    if (!tasks || tasks.length === 0) {
      idleCount++;
      continue;
    }

    // Most recent task by startedAt
    const sorted = tasks.slice().sort((a, b) =>
      new Date(b.tracking.startedAt).getTime() - new Date(a.tracking.startedAt).getTime()
    );
    if (!sorted.length) { idleCount++; continue; }
    const latest = sorted[0];

    // Result file exists => completed
    if (fs.existsSync(latest.resultPath)) {
      completedCount++;
      continue;
    }

    // PID liveness check
    if (!latest.tracking.pid || latest.tracking.pid <= 0 || !Number.isInteger(latest.tracking.pid)) {
      failedCount++;
      continue;
    }
    try {
      process.kill(latest.tracking.pid, 0);
      runningCount++;
      continue;
    } catch {
      // Dead PID, no result => failed
      failedCount++;
      continue;
    }

  }

  // Ground truth for "tasked": worker-tasked audit entries (identical to queen-tools.ts).
  const tasked = new Set();
  for (const e of (hive.audit || [])) {
    if (e && e.event === 'worker-tasked' && e.workerId) tasked.add(e.workerId);
  }
  const STARTUP_GRACE_MS = Number(process.env.HIVE_FLOW_SETTLE_GRACE_MS) > 0
    ? Number(process.env.HIVE_FLOW_SETTLE_GRACE_MS) : 120_000;
  const nowMs = Date.now();
  const startupWindowOpen = hive.workers.some((w) => {
    if (w.status === 'terminated') return false;
    if (tasked.has(w.workerId)) return false;
    const t = agentTaskMap.get(w.agentId);
    const idleish = !t || t.length === 0;
    if (!idleish) return false;
    const spawnedAt = new Date(w.spawnedAt).getTime();
    return Number.isFinite(spawnedAt) && (nowMs - spawnedAt) < STARTUP_GRACE_MS;
  });

  // P2-SH2 (hive-flow-4a28): a worker blocked on an undecided permission request must
  // not let the hive settle — otherwise the sentinel would treat a blocked hive as done
  // and suppress the operator wake.
  const blockedWorkerIds = blockedPermissionWorkerIds(hivesDir, hiveId, hive);
  const blockedCount = blockedWorkerIds.size;

  // P4 (hive-flow-5de8): a worker awaiting a mediation reply is non-settled --
  // same discipline as permission-blocked workers.
  const waitingOnPeerIds = waitingOnPeerWorkerIds(hivesDir, hive);
  const waitingOnPeerCount = waitingOnPeerIds.size;

  const taskedCount = completedCount + runningCount + failedCount;
  const allComplete = runningCount === 0 && blockedCount === 0 && waitingOnPeerCount === 0 && !startupWindowOpen;

  return {
    hiveStatus: hive.status,
    queenId: hive.queenId,
    completedCount,
    runningCount,
    failedCount,
    idleCount,
    terminatedCount,
    blockedCount,
    blockedWorkers: [...blockedWorkerIds],
    waitingOnPeerCount,
    waitingOnPeerWorkers: [...waitingOnPeerIds],
    allComplete,
    workerCount: hive.workers.length,
    ownerSessionId: hive.ownerSessionId || null,
  };
}

// ---------------------------------------------------------------------------
// Progress file writer
// ---------------------------------------------------------------------------

function writeProgressFile(paths, hiveId, status, ownerSessionId = null) {
  try {
    const sanitized = sanitizeHiveId(hiveId);
    if (!sanitized) return;
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const progressPath = path.join(paths.dataDir, `watcher-${sanitized}.json`);
    const data = {
      hiveId,
      watcherPid: process.pid,
      ...status,
      ownerSessionId: ownerSessionId || status.ownerSessionId || null,
      updatedAt: new Date().toISOString(),
    };
    const tmpPath = progressPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, progressPath);
  } catch { /* best-effort */ }
}

/**
 * Clean up the watcher progress file on exit.
 */
function cleanupProgressFile(paths, hiveId) {
  try {
    const sanitized = sanitizeHiveId(hiveId);
    if (!sanitized) return;
    const progressPath = path.join(paths.dataDir, `watcher-${sanitized}.json`);
    if (fs.existsSync(progressPath)) fs.unlinkSync(progressPath);
    const stopPath = paths.stopFile ? paths.stopFile(hiveId) : null;
    if (stopPath && fs.existsSync(stopPath)) fs.unlinkSync(stopPath);
  } catch { /* best-effort */ }
}

function writeDoneMarker(paths, hiveId, status, ownerSessionId = null) {
  try {
    const sanitized = sanitizeHiveId(hiveId);
    if (!sanitized) return;
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const donePath = path.join(paths.dataDir, `hive-${sanitized}.done`);
    const data = {
      hiveId,
      completedAt: new Date().toISOString(),
      summary: `completed=${status.completedCount || 0} failed=${status.failedCount || 0}`,
      completedCount: status.completedCount || 0,
      failedCount: status.failedCount || 0,
      ownerSessionId: ownerSessionId || status.ownerSessionId || null,
    };
    const tmpPath = donePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, donePath);

    const wakePaths = paths.wakeHiveDoneFile ? paths : decorateWakePaths(paths, ownerSessionId || status.ownerSessionId || null);
    if (wakePaths.wakeHiveDoneFile) {
      const wakeDonePath = wakePaths.wakeHiveDoneFile(hiveId);
      fs.mkdirSync(path.dirname(wakeDonePath), { recursive: true });
      const wakeTmpPath = wakeDonePath + '.tmp.' + process.pid;
      fs.writeFileSync(wakeTmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(wakeTmpPath, wakeDonePath);
    }
  } catch { /* best-effort */ }
}

function appendPendingCompletion(paths, hiveId, status, summary, ownerSessionId = null) {
  try {
    const sanitized = sanitizeHiveId(hiveId);
    if (!sanitized) return;
    fs.mkdirSync(paths.dataDir, { recursive: true });

    const line = JSON.stringify({
      kind: 'hive',
      hiveId,
      ts: new Date().toISOString(),
      summary: `[HIVE COMPLETE: ${hiveId}] All workers finished. ${summary}. Run hive_poll_workers or queen_collect_results to review.`,
      completedCount: status.completedCount,
      failedCount: status.failedCount,
      idleCount: status.idleCount,
      terminatedCount: status.terminatedCount,
      ownerSessionId: ownerSessionId || status.ownerSessionId || null,
    });
    appendPendingWithAck(paths.dataDir, sanitized, line, {
      source: 'hive-watcher',
      ownerSessionId: ownerSessionId || status.ownerSessionId || null,
    });

    const wakePaths = paths.wakePendingFile ? paths : decorateWakePaths(paths, ownerSessionId || status.ownerSessionId || null);
    if (wakePaths.wakeSessionDir) {
      appendPendingWithAck(wakePaths.wakeSessionDir, sanitized, line, {
        source: 'hive-watcher:global-wake',
        ownerSessionId: ownerSessionId || status.ownerSessionId || null,
      });
    }
  } catch { /* best-effort */ }
}

function appendPendingTerminal(paths, hiveId, status, summary, ownerSessionId = null) {
  try {
    const sanitized = sanitizeHiveId(hiveId);
    if (!sanitized) return;
    fs.mkdirSync(paths.dataDir, { recursive: true });

    const line = JSON.stringify({
      kind: 'hive-terminal',
      hiveId,
      ts: new Date().toISOString(),
      summary,
      runningCount: status?.runningCount || 0,
      completedCount: status?.completedCount || 0,
      failedCount: status?.failedCount || 0,
      idleCount: status?.idleCount || 0,
      terminatedCount: status?.terminatedCount || 0,
      ownerSessionId,
    });

    appendPendingWithAck(paths.dataDir, `${sanitized}-terminal`, line, {
      source: 'hive-watcher',
      ownerSessionId,
    });

    const wakePaths = paths.wakePendingFile ? paths : decorateWakePaths(paths, ownerSessionId);
    if (wakePaths.wakeSessionDir) {
      appendPendingWithAck(wakePaths.wakeSessionDir, `${sanitized}-terminal`, line, {
        source: 'hive-watcher:global-wake',
        ownerSessionId,
      });
    }
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Audit log (mirrors hive-enforcement.cjs pattern)
// ---------------------------------------------------------------------------

function appendAuditLog(paths, entry) {
  try {
    const auditDir = path.join(HIVE_HOME, 'enforcement');
    fs.mkdirSync(auditDir, { recursive: true });
    const auditPath = path.join(auditDir, 'hive-audit.jsonl');
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(auditPath, line);
  } catch { /* best-effort */ }
}

function handleStopRequest(paths, hiveId, status) {
  try {
    if (!paths.stopFile) return false;
    const stopPath = paths.stopFile(hiveId);
    if (!fs.existsSync(stopPath)) return false;
    appendAuditLog(paths, {
      event: 'watcher-stop-requested',
      hiveId,
      pid: process.pid,
    });
    writeProgressFile(paths, hiveId, {
      ...status,
      status: 'stopped',
    });
    return true;
  } catch {
    return false;
  }
}

function finiteCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function staleTransitionSignature(status) {
  const runningCount = finiteCount(status?.runningCount);
  if (runningCount <= 0) return null;
  return [
    runningCount,
    finiteCount(status?.completedCount),
    finiteCount(status?.failedCount),
    finiteCount(status?.idleCount),
    finiteCount(status?.terminatedCount),
    finiteCount(status?.workerCount),
  ].join(':');
}

function noteWorkerProgressTransition(transitionState) {
  if (!transitionState || typeof transitionState !== 'object') return;
  transitionState.lastStaleSignature = null;
}

function shouldNotifyStaleTransition(transitionState, status, unchangedCycles, threshold = STALE_THRESHOLD) {
  if (unchangedCycles < threshold) return false;
  const signature = staleTransitionSignature(status);
  if (signature === null) {
    noteWorkerProgressTransition(transitionState);
    return false;
  }
  if (transitionState.lastStaleSignature === signature) return false;
  transitionState.lastStaleSignature = signature;
  return true;
}

// ---------------------------------------------------------------------------
// Main watcher loop
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  if (!config.hiveId) {
    process.stderr.write('hive-watcher: missing hiveId argument\n');
    process.exit(1);
  }

  const paths = getPaths(config.projectDir, config.sessionId);
  const hiveId = config.hiveId;
  const startedAt = Date.now();

  appendAuditLog(paths, {
    event: 'watcher-started',
    hiveId,
    pid: process.pid,
    ownerSessionId: config.sessionId || 'none',
    notificationMode: 'durable-files',
  });

  // Track stale detection state
  let prevCompletedCount = -1;
  let prevFailedCount = -1;
  let unchangedCycles = 0;
  const staleTransitionState = {};

  // Cleanup on exit
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupProgressFile(paths, hiveId);
    appendAuditLog(paths, {
      event: 'watcher-exited',
      hiveId,
      pid: process.pid,
      runtimeMs: Date.now() - startedAt,
    });
  };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  // Main poll loop
  while (true) {
    // Single snapshot per iteration — all decisions below share the same consistent read.
    const snapshot = pollWorkers(paths.hivesDir, paths.tasksDir, hiveId);

    if (handleStopRequest(paths, hiveId, snapshot)) {
      break;
    }

    // Safety: hard runtime cap
    if (Date.now() - startedAt > MAX_RUNTIME_MS) {
      appendAuditLog(paths, {
        event: 'watcher-timeout',
        hiveId,
        pid: process.pid,
        runtimeMs: Date.now() - startedAt,
      });
      appendPendingTerminal(
        paths,
        hiveId,
        snapshot,
        `[HIVE TIMEOUT: ${hiveId}] Watcher reached ${MAX_RUNTIME_MS / 3600000}h safety cap. Check hive_status manually.`,
        config.sessionId || null,
      );
      break;
    }

    // Reuse the snapshot taken at the top of this iteration
    const status = snapshot;

    // Write progress file every cycle
    const ownerSessionId = config.sessionId || status.ownerSessionId || null;

    writeProgressFile(paths, hiveId, status, ownerSessionId);

    // Check if hive was externally terminated/completed/failed
    if (status.hiveStatus && status.hiveStatus !== 'active' && status.hiveStatus !== 'pending') {
      appendAuditLog(paths, {
        event: 'watcher-hive-status-exit',
        hiveId,
        hiveStatus: status.hiveStatus,
        pid: process.pid,
      });
      // Hive already resolved externally — no need to wake advocate
      break;
    }

    // Error case — hive not found (may have been deleted)
    if (status.error) {
      appendAuditLog(paths, {
        event: 'watcher-hive-not-found',
        hiveId,
        pid: process.pid,
        error: status.error,
      });
      break;
    }

    // ---- COMPLETE detection ----
    if (status.allComplete) {
      const summary = `completed=${status.completedCount} failed=${status.failedCount}`;
      appendAuditLog(paths, {
        event: 'watcher-hive-complete',
        hiveId,
        pid: process.pid,
        completedCount: status.completedCount,
        failedCount: status.failedCount,
        idleCount: status.idleCount,
        terminatedCount: status.terminatedCount,
      });
      writeDoneMarker(paths, hiveId, status, ownerSessionId);
      appendPendingCompletion(paths, hiveId, status, summary, ownerSessionId);

      break;
    }

    // ---- STALE detection (progress-based) ----
    if (status.completedCount === prevCompletedCount && status.failedCount === prevFailedCount) {
      unchangedCycles++;
    } else {
      unchangedCycles = 0;
      prevCompletedCount = status.completedCount;
      prevFailedCount = status.failedCount;
      noteWorkerProgressTransition(staleTransitionState);
    }

    if (shouldNotifyStaleTransition(staleTransitionState, status, unchangedCycles)) {
      appendAuditLog(paths, {
        event: 'watcher-hive-stale',
        hiveId,
        pid: process.pid,
        unchangedCycles,
        runningCount: status.runningCount,
        completedCount: status.completedCount,
        failedCount: status.failedCount,
      });
    }

    // Sleep until next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // Final cleanup (progress file removed by exit handler)
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Exported for tests and reuse; the daemon runs only when invoked directly
// (a bare require must never start the watch loop).
module.exports = {
  pollWorkers,
  blockedPermissionWorkerIds,
  waitingOnPeerWorkerIds,
};

if (require.main === module) {
  main().catch(err => {
    process.stderr.write('hive-watcher: fatal error: ' + (err?.message || String(err)) + '\n');
    process.exit(1);
  });
}
