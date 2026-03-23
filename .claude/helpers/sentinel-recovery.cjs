#!/usr/bin/env node
//
// Sentinel Recovery — SessionStart hook
//
// On session start, scans for dead hive watchers that were monitoring active
// hives. If a watcher's heartbeat is stale (updatedAt > 2 minutes ago) and
// the hive is still active, alerts the advocate to re-spawn. When running
// inside tmux (reads tmux-pane.txt), auto-respawns the watcher as a detached
// process.
//
// Watcher progress files: .hive-flow/data/watcher-{hiveId}.json
//   Format: { hiveId, watcherPid, updatedAt, completedCount, runningCount, ... }
//
// Safety:
//   - Fail-open: all errors produce {} (never blocks session start)
//   - Only respawns in tmux (reads .hive-flow/data/tmux-pane.txt)
//   - Detached spawn (stdio: 'ignore', detached: true, unref'd)
//   - Validates hive is still active before recommending respawn
//

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const HIVE_FLOW_DIR = path.join(PROJECT_DIR, '.hive-flow');
const DATA_DIR = path.join(HIVE_FLOW_DIR, 'data');
const HIVES_DIR = path.join(HIVE_FLOW_DIR, 'hives');
const TMUX_PANE_FILE = path.join(DATA_DIR, 'tmux-pane.txt');
const WATCHER_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'hive-watcher.js');

const HEARTBEAT_STALE_MS = 2 * 60 * 1000; // 2 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file. Returns null on any error.
 */
function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check if a hive is still active by reading its hive.json.
 */
function isHiveActive(hiveId) {
  if (!hiveId) return false;
  // Sanitize hive ID (same as hive-watcher.js)
  const sanitized = String(hiveId).replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
  if (!sanitized) return false;
  const hivePath = path.join(HIVES_DIR, sanitized, 'hive.json');
  const record = readJson(hivePath);
  return record && record.status === 'active';
}

/**
 * Check if a PID is alive via process.kill(pid, 0).
 */
function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read tmux pane from the persisted file. Returns null if not in tmux.
 */
function readTmuxPane() {
  try {
    if (!fs.existsSync(TMUX_PANE_FILE)) return null;
    const pane = fs.readFileSync(TMUX_PANE_FILE, 'utf8').trim();
    return pane || null;
  } catch {
    return null;
  }
}

/**
 * Scan DATA_DIR for watcher-*.json progress files.
 * Returns array of { filePath, data }.
 */
function findWatcherFiles() {
  const results = [];
  if (!fs.existsSync(DATA_DIR)) return results;

  let entries;
  try {
    entries = fs.readdirSync(DATA_DIR);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.startsWith('watcher-') || !entry.endsWith('.json')) continue;
    const filePath = path.join(DATA_DIR, entry);
    const data = readJson(filePath);
    if (data) {
      results.push({ filePath, data });
    }
  }

  return results;
}

/**
 * Spawn a detached watcher process for the given hive.
 * Returns the new PID or null on failure.
 */
function spawnDetachedWatcher(hiveId, tmuxPane) {
  if (!fs.existsSync(WATCHER_SCRIPT)) return null;

  try {
    const args = [WATCHER_SCRIPT, hiveId, '--project-dir', PROJECT_DIR];
    if (tmuxPane) {
      args.push('--tmux-pane', tmuxPane);
    }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });

    child.unref();
    return child.pid || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const watcherFiles = findWatcherFiles();
  if (watcherFiles.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const now = Date.now();
  const tmuxPane = readTmuxPane();
  const hasTmux = !!tmuxPane;

  const deadWatchers = [];   // { hiveId, reason, respawned, newPid }
  const aliveWatchers = [];  // { hiveId }

  for (const { filePath, data } of watcherFiles) {
    const hiveId = data.hiveId;
    if (!hiveId) continue;

    // Check heartbeat freshness
    const updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
    const heartbeatAge = now - updatedAt;
    const isStale = heartbeatAge > HEARTBEAT_STALE_MS;

    // Check PID liveness
    const pidAlive = isPidAlive(data.watcherPid);

    if (!isStale && pidAlive) {
      aliveWatchers.push({ hiveId });
      continue;
    }

    // Watcher appears dead — check if hive is still active
    if (!isHiveActive(hiveId)) {
      // Hive is no longer active — clean up stale progress file
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      continue;
    }

    // Dead watcher + active hive — needs recovery
    const entry = {
      hiveId,
      reason: !pidAlive ? 'pid-dead' : 'heartbeat-stale',
      heartbeatAgeMs: heartbeatAge,
      oldPid: data.watcherPid || null,
      respawned: false,
      newPid: null,
    };

    // Auto-respawn if in tmux
    if (hasTmux) {
      const newPid = spawnDetachedWatcher(hiveId, tmuxPane);
      if (newPid) {
        entry.respawned = true;
        entry.newPid = newPid;
        // Clean up old progress file (new watcher will create its own)
        try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      }
    }

    deadWatchers.push(entry);
  }

  if (deadWatchers.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Build context message for the advocate
  const lines = deadWatchers.map(w => {
    if (w.respawned) {
      return `  - ${w.hiveId}: watcher died (${w.reason}), auto-respawned (pid=${w.newPid})`;
    }
    return `  - ${w.hiveId}: watcher died (${w.reason}), NEEDS MANUAL RESPAWN`;
  });

  const respawnedCount = deadWatchers.filter(w => w.respawned).length;
  const needsManual = deadWatchers.filter(w => !w.respawned);

  let context = `[SENTINEL RECOVERY] ${deadWatchers.length} dead watcher(s) found for active hives.\n${lines.join('\n')}`;

  if (respawnedCount > 0) {
    context += `\n${respawnedCount} auto-respawned in tmux.`;
  }

  if (needsManual.length > 0) {
    const ids = needsManual.map(w => w.hiveId).join(', ');
    context += `\nManual respawn needed for: ${ids}. Use hive_poll_workers to check status, or spawn new watchers.`;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      additionalContext: context,
    },
  }));
}

try {
  main();
} catch {
  // Fail-open: never block session start on internal errors
  process.stdout.write(JSON.stringify({}));
}
