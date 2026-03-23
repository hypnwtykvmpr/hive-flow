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
 *   2. MCP logging notification — emits via stdout pipe to MCP server
 *   3. Progress file — writes .hive-flow/data/watcher-{hiveId}.json every cycle
 *
 * Stale detection: If no worker transitions (completed/failed count) change
 * across 3 consecutive cycles (each cycle = POLL_INTERVAL_MS), the hive is
 * considered stale. No hard timeout cap — purely progress-based.
 *
 * Usage:
 *   node scripts/hive-watcher.js <hiveId> [--tmux-pane <pane>] [--project-dir <dir>]
 *
 * @module scripts/hive-watcher
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15_000;       // 15s between polls
const PROGRESS_INTERVAL_MS = 30 * 60_000; // 30min between tmux progress pings
const STALE_THRESHOLD = 3;              // 3 consecutive unchanged polls = stale
const MAX_RUNTIME_MS = 12 * 60 * 60_000; // 12h hard safety cap (prevent zombie)

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    hiveId: null,
    tmuxPane: null,
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tmux-pane' && args[i + 1]) {
      result.tmuxPane = args[++i];
    } else if (args[i] === '--project-dir' && args[i + 1]) {
      result.projectDir = args[++i];
    } else if (!args[i].startsWith('--') && !result.hiveId) {
      result.hiveId = args[i];
    }
  }

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

  const taskedCount = completedCount + runningCount + failedCount;
  const allComplete = taskedCount > 0 && runningCount === 0;

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
  };
}

// ---------------------------------------------------------------------------
// tmux send-keys — wakes the advocate's Claude Code session
// ---------------------------------------------------------------------------

/**
 * Resolve the tmux pane to target. Priority:
 *   1. Explicit --tmux-pane argument
 *   2. Persisted .hive-flow/data/tmux-pane.txt (captured at SessionStart)
 *   3. null (tmux not available)
 */
function resolveTmuxPane(explicitPane, paths) {
  if (explicitPane) return explicitPane;
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
// MCP notification emitter
// ---------------------------------------------------------------------------

/**
 * Emit an MCP logging notification by writing to the MCP server's
 * notification channel file. The MCP server picks this up and forwards
 * to the client.
 *
 * File format: one JSON line per notification in .hive-flow/data/mcp-notifications.jsonl
 */
function emitMcpNotification(paths, level, message, data) {
  try {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const notifPath = path.join(paths.dataDir, 'mcp-notifications.jsonl');
    const entry = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: {
        level: level || 'info',
        logger: 'hive-watcher',
        data: {
          message,
          ...data,
          timestamp: new Date().toISOString(),
        },
      },
    };
    fs.appendFileSync(notifPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Progress file writer
// ---------------------------------------------------------------------------

function writeProgressFile(paths, hiveId, status) {
  try {
    const sanitized = sanitizeHiveId(hiveId);
    if (!sanitized) return;
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const progressPath = path.join(paths.dataDir, `watcher-${sanitized}.json`);
    const data = {
      hiveId,
      watcherPid: process.pid,
      ...status,
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

function writeDoneMarker(paths, hiveId, status) {
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
    };
    const tmpPath = donePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, donePath);
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
  const tmuxPane = resolveTmuxPane(config.tmuxPane, paths);
  const hasTmux = !!(tmuxBin && tmuxPane);

  appendAuditLog(paths, {
    event: 'watcher-started',
    hiveId,
    pid: process.pid,
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
      emitMcpNotification(paths, 'warning', `Hive watcher timeout: ${hiveId}`, { hiveId, reason: 'max-runtime-exceeded' });
      break;
    }

    // Poll worker status
    const status = pollWorkers(paths.hivesDir, paths.tasksDir, hiveId);

    // Write progress file every cycle
    writeProgressFile(paths, hiveId, status);

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
      writeDoneMarker(paths, hiveId, status);

      // Wake advocate via tmux
      if (hasTmux) {
        tmuxSendKeys(tmuxBin, tmuxPane,
          `[HIVE COMPLETE: ${hiveId}] All workers finished. ${summary}. Run hive_poll_workers or queen_collect_results to review.`);
      }

      // Emit MCP notification
      emitMcpNotification(paths, 'info', `Hive complete: ${hiveId}`, {
        hiveId,
        completedCount: status.completedCount,
        failedCount: status.failedCount,
        idleCount: status.idleCount,
        terminatedCount: status.terminatedCount,
      });

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

      emitMcpNotification(paths, 'warning', `Hive stale: ${hiveId}`, {
        hiveId,
        unchangedCycles,
        runningCount: status.runningCount,
      });

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
