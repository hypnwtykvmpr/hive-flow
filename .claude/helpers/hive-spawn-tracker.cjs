#!/usr/bin/env node
/**
 * Hive Spawn Tracker — PostToolUse hook for the Task tool
 *
 * Tracks agent spawns per hive by parsing [HIVE:id:count/target] tags
 * from Task tool descriptions. Maintains a persistent JSON counter file
 * and injects additionalContext for hive progress / completion signals.
 *
 * Trigger: PostToolUse hook (Task tool)
 * Output: Claude Code PostToolUse protocol — JSON to stdout
 *
 * Safety:
 *   - Inline mkdirSync locking (no dist dependency)
 *   - Atomic write via rename
 *   - Graceful failure — errors never block the hook
 */
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const HIVE_FLOW_DIR = path.join(PROJECT_DIR, '.hive-flow');
const DATA_DIR = path.join(HIVE_FLOW_DIR, 'data');
const TRACKER_FILE = path.join(DATA_DIR, 'hive-spawn-tracker.json');
const LOCK_PATH = path.join(DATA_DIR, '.hive-spawn-tracker.lock');

const LOCK_TIMEOUT_MS = 10000;  // 10s
const STALE_LOCK_MS = 30000;    // 30s — unified with all other components

// Regex: [HIVE:some-id:3/5] — anchored strict charset aligned with gate
const HIVE_TAG_RE = /\[HIVE:([A-Za-z0-9_-]+):(\d+)\/(\d+)\]/;

const INCOMPLETE_WARN_THRESHOLD = 2;  // warnings before escalation
const INCOMPLETE_STALE_MS = 10000;    // 10s — hive considered stale
const COMPLETED_PRUNE_MS = 3600000;   // 1 hour — prune completed hives

// ---------------------------------------------------------------------------
// Inline mkdirSync locking (same pattern as hive-enforcement.cjs)
// ---------------------------------------------------------------------------

/**
 * Acquire a directory-based lock. Returns true if acquired.
 * Uses mkdirSync atomic creation.
 */
function acquireLock(lockDir) {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      return true;
    } catch {
      // Check for stale lock (older than threshold)
      try {
        const lockStat = fs.statSync(lockDir);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          try { fs.rmdirSync(lockDir); } catch { /* race with another cleaner */ }
          continue;
        }
      } catch {
        // Lock dir gone, retry
        continue;
      }
      // Busy-wait with small jittered sleep
      const waitUntil = Date.now() + 50 + Math.random() * 100;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
  return false;
}

/**
 * Release a directory-based lock.
 */
function releaseLock(lockDir) {
  try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tracker file helpers
// ---------------------------------------------------------------------------

/**
 * Load the tracker state from disk. Returns {} if missing or corrupt.
 */
function loadTracker() {
  try {
    if (!fs.existsSync(TRACKER_FILE)) return {};
    return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Save the tracker state atomically (write tmp, rename).
 */
function saveTracker(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = TRACKER_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, TRACKER_FILE);
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Prune & incomplete-batch helpers
// ---------------------------------------------------------------------------

/**
 * E7: Prune completed hives where spawnCount >= target AND lastSeenAt > 1 hour ago.
 * Called on every write cycle before saving.
 */
function pruneCompletedHives(envelope) {
  const now = Date.now();
  const hiveIds = Object.keys(envelope.hives || {});
  for (const id of hiveIds) {
    const hive = envelope.hives[id];
    if (
      hive.spawnCount >= hive.target &&
      hive.lastSeenAt &&
      (now - new Date(hive.lastSeenAt).getTime()) > COMPLETED_PRUNE_MS
    ) {
      delete envelope.hives[id];
    }
  }
}

/**
 * E6: Check all OTHER hives (besides currentHiveId) for incomplete status.
 * A hive is incomplete if spawnCount < target and lastSeenAt > INCOMPLETE_STALE_MS ago.
 * Returns additionalContext string if escalation triggered, or null.
 */
function checkIncompleteBatches(envelope, currentHiveId) {
  const now = Date.now();
  const incompleteHives = [];

  for (const [id, hive] of Object.entries(envelope.hives || {})) {
    if (id === currentHiveId) continue;
    if (
      hive.spawnCount < hive.target &&
      hive.lastSeenAt &&
      (now - new Date(hive.lastSeenAt).getTime()) > INCOMPLETE_STALE_MS
    ) {
      // Increment warning count
      hive.warningCount = (hive.warningCount || 0) + 1;
      incompleteHives.push({ id, spawnCount: hive.spawnCount, target: hive.target, warnings: hive.warningCount });
    }
  }

  if (incompleteHives.length === 0) return null;

  const escalated = incompleteHives.filter(h => h.warnings > INCOMPLETE_WARN_THRESHOLD);
  if (escalated.length > 0) {
    const details = escalated.map(h => `${h.id} (${h.spawnCount}/${h.target}, ${h.warnings} warnings)`).join(', ');
    return `[HIVE_INCOMPLETE_ESCALATION] Stale incomplete hives detected: ${details}. These hives have not reached their target agent count.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main hook logic
// ---------------------------------------------------------------------------

/**
 * Check if the Task tool spawn actually succeeded by inspecting tool_response.
 */
function isSpawnSuccess(input) {
  try {
    const raw = input.tool_response || input.tool_result || input.response || '';
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const parsed = JSON.parse(str);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        try {
          const inner = JSON.parse(item.text);
          if (inner.success === true || inner.agentId || inner.id) return true;
        } catch { /* not JSON text */ }
      }
      if (item && (item.success === true || item.agentId || item.id)) return true;
    }
  } catch { /* unparseable — assume success for graceful degradation */ return true; }
  return false;
}

function processPostToolUse(input) {
  const toolName = input.tool_name || '';

  // Only act on the Task tool (case-insensitive)
  if (toolName.toLowerCase() !== 'task') {
    return {};
  }

  // Check if spawn succeeded before tracking
  if (!isSpawnSuccess(input)) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '[HIVE_SPAWN_FAILED] Task tool call did not succeed. Spawn not counted.',
      },
    };
  }

  // Parse description for [HIVE:id:count/target]
  const description = (input.tool_input && input.tool_input.description) || '';
  const match = description.match(HIVE_TAG_RE);
  if (!match) {
    return {};
  }

  const hiveId = (match[1] || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
  const declaredIndex = parseInt(match[2], 10);
  const target = parseInt(match[3], 10);

  if (!hiveId || isNaN(target) || target <= 0) {
    return {};
  }

  // Acquire lock before reading/writing tracker state
  if (!acquireLock(LOCK_PATH)) {
    return {};
  }

  let spawnCount;
  let additionalMessages = [];
  try {
    // Use envelope schema matching hive-composition-gate.cjs
    const state = loadTracker();
    const envelope = (state && state.version === 1 && state.hives)
      ? state
      : { version: 1, updatedAt: new Date().toISOString(), hives: {} };

    // E7: Prune completed hives before processing
    pruneCompletedHives(envelope);

    // E6: Check other hives for incomplete batches before updating current
    const escalation = checkIncompleteBatches(envelope, hiveId);
    if (escalation) {
      additionalMessages.push(escalation);
    }

    // Initialize hive entry if needed
    if (!envelope.hives[hiveId]) {
      envelope.hives[hiveId] = {
        hiveId,
        target,
        spawnCount: 0,
        slots: {},
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
    }

    const hive = envelope.hives[hiveId];
    hive.target = target;
    hive.lastSeenAt = new Date().toISOString();

    // Record this spawn in slots (keyed by declared index) — gate-aligned schema
    const slotKey = String(declaredIndex || Object.keys(hive.slots).length + 1);
    const truncated = description.length > 200 ? description.slice(0, 200) + '...' : description;
    hive.slots[slotKey] = {
      at: new Date().toISOString(),
      description: truncated,
      agentType: (input.tool_input?.subagent_type || input.tool_input?.agent_type || '').toLowerCase(),
    };

    // Derive count from slots (same as gate does)
    hive.spawnCount = Object.keys(hive.slots).length;
    spawnCount = hive.spawnCount;

    envelope.updatedAt = new Date().toISOString();
    saveTracker(envelope);
  } catch {
    releaseLock(LOCK_PATH);
    return {};
  }

  releaseLock(LOCK_PATH);

  // Emit additionalContext based on progress
  let contextMsg;
  if (spawnCount >= target) {
    contextMsg = '[HIVE_COMPLETE] Hive ' + hiveId + ' reached ' + spawnCount + '/' + target + ' agents';
  } else {
    contextMsg = '[HIVE_PROGRESS] Hive ' + hiveId + ': ' + spawnCount + '/' + target + ' agents spawned';
  }

  if (additionalMessages.length > 0) {
    contextMsg += ' | ' + additionalMessages.join(' | ');
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: contextMsg,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

if (require.main === module) {
  try {
    const rawInput = readStdin();
    let input;
    try {
      input = JSON.parse(rawInput);
    } catch {
      input = {};
    }

    const result = processPostToolUse(input);
    process.stdout.write(JSON.stringify(result));
  } catch {
    // Errors must not block the hook — emit empty JSON = allow
    process.stdout.write(JSON.stringify({}));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exports (for testing and programmatic use)
// ---------------------------------------------------------------------------

module.exports = {
  processPostToolUse,
  acquireLock,
  releaseLock,
  loadTracker,
  saveTracker,
  pruneCompletedHives,
  checkIncompleteBatches,
  HIVE_TAG_RE,
};
