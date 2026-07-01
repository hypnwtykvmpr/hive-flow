#!/usr/bin/env node
//
// Sentinel Recovery — SessionStart hook
//
// On session start, scans for dead hive watchers that were monitoring active
// hives. If a watcher's heartbeat is stale (updatedAt > 2 minutes ago) and
// the hive is still active, auto-respawns the watcher as a detached process.
//
// Watcher progress files: .hive-flow/data/watcher-{hiveId}.json
//   Format: { hiveId, watcherPid, updatedAt, completedCount, runningCount, ... }
//
// Safety:
//   - Fail-open: all errors produce {} (never blocks session start)
//   - Respawns in durable-file mode only
//   - Detached spawn (stdio: 'ignore', detached: true, unref'd)
//   - Validates hive is still active before recommending respawn
//

'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { resolveSessionId } = require('./session-id.cjs');

const { loadProtectedPathPolicyModule } = require('./layout-paths.cjs');

const protectedPathPolicy = loadProtectedPathPolicyModule({ env: process.env, cwd: process.cwd(), helperDir: __dirname });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = protectedPathPolicy.resolveProjectRoot({
  env: process.env,
  cwd: path.resolve(__dirname, '..', '..'),
  fallbackRoot: process.cwd(),
});
const HIVE_FLOW_DIR = path.join(PROJECT_DIR, '.hive-flow');
const DATA_DIR = path.join(HIVE_FLOW_DIR, 'data');
const HIVES_DIR = path.join(HIVE_FLOW_DIR, 'hives');
const WATCHER_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'hive-watcher.cjs');

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
function loadHiveRecord(hiveId) {
  if (!hiveId) return null;
  // Sanitize hive ID (same as hive-watcher.cjs)
  const sanitized = String(hiveId).replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
  if (!sanitized) return null;
  const hivePath = path.join(HIVES_DIR, sanitized, 'hive.json');
  return readJson(hivePath);
}

function isHiveActive(hiveId) {
  const record = loadHiveRecord(hiveId);
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

function sanitizeHiveId(hiveId) {
  return String(hiveId || '').replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
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
 * The second argument is kept for legacy callers and intentionally ignored.
 * Returns the new PID or null on failure.
 */
function spawnDetachedWatcher(hiveId, _legacyTmuxPane = null, ownerSessionId = null) {
  if (!fs.existsSync(WATCHER_SCRIPT)) return null;

  const sanitized = sanitizeHiveId(hiveId);
  if (!sanitized) return null;
  const pidLockDir = path.join(DATA_DIR, `watcher-${sanitized}.lock`);
  let lockAcquired = false;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.mkdirSync(pidLockDir);
        lockAcquired = true;
        break;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') return null;

        let stat;
        try {
          stat = fs.statSync(pidLockDir);
        } catch {
          return null;
        }

        if (Date.now() - stat.mtimeMs < 30_000) return null;

        try {
          fs.rmdirSync(pidLockDir);
        } catch {
          return null;
        }
      }
    }
    if (!lockAcquired) return null;

    const args = [WATCHER_SCRIPT, hiveId, '--project-dir', PROJECT_DIR];
    const sessionId = ownerSessionId ? resolveSessionId({ session_id: ownerSessionId }, {}) : null;
    if (sessionId) {
      args.push('--sessionId', sessionId);
    }

    const child = childProcess.spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });

    child.unref();
    return child.pid || null;
  } catch {
    return null;
  } finally {
    if (lockAcquired) {
      try { fs.rmdirSync(pidLockDir); } catch { /* best-effort */ }
    }
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
  const deadWatchers = [];   // { hiveId, reason, respawned, newPid }
  const aliveWatchers = [];  // { hiveId }

  for (const { filePath, data } of watcherFiles) {
    const hiveId = data.hiveId;
    if (!hiveId) continue;

    // Check heartbeat freshness
    const updatedAtMs = data.updatedAt ? new Date(data.updatedAt).getTime() : NaN;
    const heartbeatAge = Number.isFinite(updatedAtMs) ? now - updatedAtMs : NaN;
    const isStale = !Number.isFinite(updatedAtMs) || (now - updatedAtMs) > HEARTBEAT_STALE_MS;

    // Check PID liveness
    const pidAlive = isPidAlive(data.watcherPid);

    if (!isStale && pidAlive) {
      aliveWatchers.push({ hiveId });
      continue;
    }

    // Watcher appears dead — check if hive is still active
    const hiveRecord = loadHiveRecord(hiveId);
    if (!hiveRecord || hiveRecord.status !== 'active') {
      // Hive is no longer active — clean up stale progress file
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      continue;
    }
    const ownerSessionId = data.ownerSessionId || hiveRecord.ownerSessionId || null;

    // Dead watcher + active hive — needs recovery
    const entry = {
      hiveId,
      reason: !pidAlive ? 'pid-dead' : 'heartbeat-stale',
      heartbeatAgeMs: heartbeatAge,
      oldPid: data.watcherPid || null,
      respawned: false,
      newPid: null,
    };

    const newPid = spawnDetachedWatcher(hiveId, null, ownerSessionId);
    if (newPid) {
      entry.respawned = true;
      entry.newPid = newPid;
      // Clean up old progress file (new watcher will create its own)
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
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
    context += `\n${respawnedCount} auto-respawned detached.`;
  }

  if (needsManual.length > 0) {
    const ids = needsManual.map(w => w.hiveId).join(', ');
    context += `\nManual respawn needed for: ${ids}. Use hive_poll_workers to check status, or spawn new watchers.`;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }));
}

module.exports = {
  spawnDetachedWatcher,
};

if (require.main === module) {
  try {
    main();
  } catch {
    // Fail-open: never block session start on internal errors
    process.stdout.write(JSON.stringify({}));
  }
}
