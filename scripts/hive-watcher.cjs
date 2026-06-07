#!/usr/bin/env node
/**
 * Hive Sentinel Watcher — Detached background process that monitors hive
 * worker completion and wakes the advocate when done.
 *
 * Spawned by hive-enforcement.cjs PostToolUse hook after queen_mission_assign.
 * Runs fully detached (stdio: 'ignore', detached: true, unref'd).
 *
 * Mechanisms:
 *   1. tmux send-keys — writes to advocate pty stdin when in tmux
 *   2. Pending notification drain — writes the next-prompt fallback queue
 *   3. Progress file — writes .hive-flow/data/watcher-{hiveId}.json every cycle
 *
 * Stale detection: If no worker transitions (completed/failed count) change
 * across 3 consecutive cycles (each cycle = POLL_INTERVAL_MS), the hive is
 * considered stale. No hard timeout cap — purely progress-based.
 *
 * Usage:
 *   node scripts/hive-watcher.cjs <hiveId> [--tmux-pane <pane>] [--project-dir <dir>]
 *
 * @module scripts/hive-watcher
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { appendPendingWithAck } = require('../.claude/helpers/dedup-marker.cjs');
const { resolveSessionId, sanitizeSessionId } = require('../.claude/helpers/session-id.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15_000;       // 15s between polls
const PROGRESS_INTERVAL_MS = 30 * 60_000; // 30min between tmux progress pings
const STALE_THRESHOLD = 3;              // 3 consecutive unchanged polls = stale
const MAX_RUNTIME_MS = 12 * 60 * 60_000; // 12h hard safety cap (prevent zombie)

function loadProtectedPathPolicyModule() {
  const envProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || '';
  const candidates = [
    envProjectRoot && path.join(path.resolve(envProjectRoot), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(process.cwd()), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(__dirname, '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return require(path.join(path.resolve(__dirname, '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'));
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

function getPaths(projectDir) {
  const hiveFlowDir = path.join(projectDir, '.hive-flow');
  const dataDir = path.join(hiveFlowDir, 'data');
  return {
    hiveFlowDir,
    hivesDir: path.join(hiveFlowDir, 'hives'),
    tasksDir: path.join(hiveFlowDir, 'tasks'),
    dataDir,
    logsDir: path.join(hiveFlowDir, 'logs'),
    tmuxPaneDir: path.join(dataDir, 'panes'),
    tmuxPaneFile: path.join(dataDir, 'tmux-pane.txt'),
    stopFile: (hiveId) => path.join(dataDir, 'watcher-' + sanitizeHiveId(hiveId) + '.stop'),
  };
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

  const taskedCount = completedCount + runningCount + failedCount;
  const allComplete = runningCount === 0 && !startupWindowOpen;

  return {
    hiveStatus: hive.status,
    queenId: hive.queenId,
    completedCount,
    runningCount,
    failedCount,
    idleCount,
    terminatedCount,
    allComplete,
    workerCount: hive.workers.length,
    ownerSessionId: hive.ownerSessionId || null,
    ownerTmuxPane: hive.ownerTmuxPane || null,
  };
}

// ---------------------------------------------------------------------------
// tmux send-keys — wakes the advocate's Claude Code session
// ---------------------------------------------------------------------------

/**
 * Resolve the tmux pane to target. Priority:
 *   1. Explicit --tmux-pane argument
 *   2. Persisted .hive-flow/data/panes/<sessionId>.txt
 *   3. Persisted .hive-flow/data/tmux-pane.txt (legacy SessionStart fallback)
 *   4. null (tmux not available)
 */
function resolveTmuxPane(explicitPane, paths, sessionId = null) {
  if (explicitPane) return explicitPane;
  const sanitizedSessionId = sanitizeSessionId(sessionId);
  if (sanitizedSessionId && paths.tmuxPaneDir) {
    try {
      const sessionPaneFile = path.join(paths.tmuxPaneDir, `${sanitizedSessionId}.txt`);
      if (fs.existsSync(sessionPaneFile)) {
        const pane = fs.readFileSync(sessionPaneFile, 'utf8').trim();
        if (pane) return pane;
      }
    } catch { /* ignore */ }
  }
  try {
    if (fs.existsSync(paths.tmuxPaneFile)) {
      const pane = fs.readFileSync(paths.tmuxPaneFile, 'utf8').trim();
      if (pane) return pane;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Find the tmux binary. Returns path or null.
 */
function findTmux() {
  const candidates = ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/bin/tmux'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Try PATH
  try {
    const result = execFileSync('which', ['tmux'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch { /* not found */ }
  return null;
}

/**
 * Send a message to the advocate's tmux pane.
 * Uses execFileSync with argument arrays (no shell interpolation).
 */
function tmuxSendKeys(tmuxBin, pane, message) {
  try {
    execFileSync(tmuxBin, ['send-keys', '-t', pane, message, 'Enter'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
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
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Audit log (mirrors hive-enforcement.cjs pattern)
// ---------------------------------------------------------------------------

function appendAuditLog(paths, entry) {
  try {
    fs.mkdirSync(path.join(paths.hiveFlowDir, 'enforcement'), { recursive: true });
    const auditPath = path.join(paths.hiveFlowDir, 'enforcement', 'hive-audit.jsonl');
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

// ---------------------------------------------------------------------------
// Main watcher loop
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  if (!config.hiveId) {
    process.stderr.write('hive-watcher: missing hiveId argument\n');
    process.exit(1);
  }

  const paths = getPaths(config.projectDir);
  const hiveId = config.hiveId;
  const startedAt = Date.now();

  // Resolve tmux
  const tmuxBin = findTmux();
  const tmuxPane = resolveTmuxPane(config.tmuxPane, paths, config.sessionId);
  const hasTmux = !!(tmuxBin && tmuxPane);

  appendAuditLog(paths, {
    event: 'watcher-started',
    hiveId,
    pid: process.pid,
    ownerSessionId: config.sessionId || 'none',
    tmuxPane: tmuxPane || 'none',
    hasTmux,
  });

  // Track stale detection state
  let prevCompletedCount = -1;
  let prevFailedCount = -1;
  let unchangedCycles = 0;
  let lastProgressPing = Date.now(); // timestamp of last tmux progress update

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
    if (handleStopRequest(paths, hiveId, pollWorkers(paths.hivesDir, paths.tasksDir, hiveId))) {
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
      if (hasTmux) {
        tmuxSendKeys(tmuxBin, tmuxPane,
          `[HIVE TIMEOUT: ${hiveId}] Watcher reached ${MAX_RUNTIME_MS / 3600000}h safety cap. Check hive_status manually.`);
      }
      break;
    }

    // Poll worker status
    const status = pollWorkers(paths.hivesDir, paths.tasksDir, hiveId);

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

      // Wake advocate via tmux
      if (hasTmux) {
        tmuxSendKeys(tmuxBin, tmuxPane,
          `[HIVE COMPLETE: ${hiveId}] All workers finished. ${summary}. Run hive_poll_workers or queen_collect_results to review.`);
      }

      break;
    }

    // ---- STALE detection (progress-based) ----
    if (status.completedCount === prevCompletedCount && status.failedCount === prevFailedCount) {
      unchangedCycles++;
    } else {
      unchangedCycles = 0;
      prevCompletedCount = status.completedCount;
      prevFailedCount = status.failedCount;
    }

    if (unchangedCycles >= STALE_THRESHOLD) {
      appendAuditLog(paths, {
        event: 'watcher-hive-stale',
        hiveId,
        pid: process.pid,
        unchangedCycles,
        runningCount: status.runningCount,
        completedCount: status.completedCount,
        failedCount: status.failedCount,
      });

      // Wake advocate with stale warning
      if (hasTmux) {
        tmuxSendKeys(tmuxBin, tmuxPane,
          `[HIVE STALE: ${hiveId}] No progress for ${unchangedCycles} cycles (${unchangedCycles * POLL_INTERVAL_MS / 1000}s). ${status.runningCount} workers still running. Check hive_poll_workers.`);
      }

      // Reset stale counter — allow continued monitoring (don't exit on stale, just notify)
      unchangedCycles = 0;
      prevCompletedCount = status.completedCount;
      prevFailedCount = status.failedCount;
    }

    // ---- Progress ping (every 30 min via tmux) ----
    const now = Date.now();
    if (hasTmux && (now - lastProgressPing) >= PROGRESS_INTERVAL_MS) {
      tmuxSendKeys(tmuxBin, tmuxPane,
        `[HIVE PROGRESS: ${hiveId}] running=${status.runningCount} completed=${status.completedCount} failed=${status.failedCount} idle=${status.idleCount}`);
      lastProgressPing = now;
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

main().catch(err => {
  process.stderr.write('hive-watcher: fatal error: ' + (err?.message || String(err)) + '\n');
  process.exit(1);
});
