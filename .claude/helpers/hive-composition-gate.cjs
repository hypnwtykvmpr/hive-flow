#!/usr/bin/env node
/**
 * Hive Composition Gate — PreToolUse hook for Task
 *
 * Enforces explicit hive composition tags on Task tool calls and tracks
 * hive spawn progress in .hive-flow/data/hive-spawn-tracker.json.
 *
 * Rules:
 * - Hive spawns must use: [HIVE:<hive-id>:<current>/<target>] <description>
 * - Solo Task calls are only allowed for bug-hunter and debugger agents
 * - Missing or malformed descriptions fail closed
 * - Tracker updates are protected by mkdirSync directory locking
 *
 * Output format: Claude Code PreToolUse protocol
 *   { hookSpecificOutput: { permissionDecision: 'allow'|'deny', ... } }
 */
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_DIR, '.hive-flow', 'data');
const TRACKER_FILE = path.join(DATA_DIR, 'hive-spawn-tracker.json');
const LOCK_DIR = path.join(DATA_DIR, '.hive-spawn-tracker.lock');

const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000; // 30s — unified with all other components
const MAX_TRACKER_SIZE = 262144; // 256 KB sanity limit
const MIN_HIVE_AGENTS = 6;

const HIVE_TAG_REGEX = /^\s*\[HIVE:([A-Za-z0-9_-]+):(\d+)\/(\d+)\]\s+([\s\S]+?)\s*$/;
const SOLO_AGENT_REGEX = /^(bug-hunter|debugger(?:-.+)?)$/i;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function makeAllow(additionalContext) {
  const result = {};
  if (additionalContext) {
    result.hookSpecificOutput = {
      permissionDecision: 'allow',
      additionalContext: sanitizeContext(additionalContext),
    };
  }
  return result;
}

function makeDeny(reason) {
  return {
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function sanitizeContext(text) {
  if (!text) return '';
  let sanitized = String(text).replace(/<[^>]+>/g, '');
  if (sanitized.length > 2000) {
    sanitized = sanitized.slice(0, 2000) + '... [truncated]';
  }
  return sanitized;
}

function sanitizeHiveId(hiveId) {
  const sanitized = String(hiveId || '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128);
  return sanitized || null;
}

function sanitizeAgentType(agentType) {
  return String(agentType || '').trim().toLowerCase();
}

function isAllowedSoloAgent(agentType) {
  return SOLO_AGENT_REGEX.test(sanitizeAgentType(agentType));
}

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    // handled by caller
  }
}

function acquireLock(lockPath) {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      return true;
    } catch {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          try { fs.rmdirSync(lockPath); } catch {}
          continue;
        }
      } catch {
        continue;
      }

      const waitUntil = Date.now() + 25 + Math.floor(Math.random() * 50);
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // ignore
  }
}

function readTracker() {
  try {
    if (!fs.existsSync(TRACKER_FILE)) {
      return freshTracker();
    }

    const stat = fs.statSync(TRACKER_FILE);
    if (stat.size > MAX_TRACKER_SIZE) {
      throw new Error('tracker-too-large');
    }

    const parsed = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('tracker-invalid');
    }

    if (!parsed.hives || typeof parsed.hives !== 'object' || Array.isArray(parsed.hives)) {
      parsed.hives = {};
    }

    if (!parsed.version) parsed.version = 1;
    if (!parsed.updatedAt) parsed.updatedAt = new Date().toISOString();
    return parsed;
  } catch (error) {
    throw new Error(`tracker-read-failed:${error.message}`);
  }
}

function freshTracker() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    hives: {},
  };
}

function writeTrackerAtomic(tracker) {
  const tmpPath = `${TRACKER_FILE}.tmp.${process.pid}.${Date.now()}`;
  tracker.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmpPath, JSON.stringify(tracker, null, 2), 'utf8');
  fs.renameSync(tmpPath, TRACKER_FILE);
}

function parseHiveTag(description) {
  const match = String(description || '').match(HIVE_TAG_REGEX);
  if (!match) return null;

  const hiveId = sanitizeHiveId(match[1]);
  const current = Number.parseInt(match[2], 10);
  const target = Number.parseInt(match[3], 10);
  const taskText = match[4].trim();

  if (!hiveId || !Number.isInteger(current) || !Number.isInteger(target) || !taskText) {
    return null;
  }

  return { hiveId, current, target, taskText };
}

function updateTrackerForSpawn(toolInput, hiveTag) {
  ensureDataDir();
  if (!acquireLock(LOCK_DIR)) {
    throw new Error('tracker-lock-timeout');
  }

  try {
    const tracker = readTracker();
    const now = new Date().toISOString();
    const hive = tracker.hives[hiveTag.hiveId] || {
      hiveId: hiveTag.hiveId,
      target: hiveTag.target,
      spawnCount: 0,
      slots: {},
      firstSeenAt: now,
      lastSeenAt: now,
    };

    if (!hive.slots || typeof hive.slots !== 'object' || Array.isArray(hive.slots)) {
      hive.slots = {};
    }

    hive.target = hiveTag.target;
    hive.lastSeenAt = now;
    hive.slots[String(hiveTag.current)] = {
      at: now,
      description: hiveTag.taskText,
      agentType: sanitizeAgentType(toolInput.subagent_type || toolInput.agent_type || ''),
    };
    hive.spawnCount = Object.keys(hive.slots).length;
    tracker.hives[hiveTag.hiveId] = hive;

    writeTrackerAtomic(tracker);
    return hive;
  } finally {
    releaseLock(LOCK_DIR);
  }
}

function validateHiveTag(hiveTag) {
  if (!hiveTag) {
    return '[HIVE COMPOSITION] Task.description must start with [HIVE:<hive-id>:<current>/<target>] for hive work. Solo Task calls are only allowed for bug-hunter and debugger.';
  }

  if (hiveTag.current < 1) {
    return `[HIVE COMPOSITION] Invalid HIVE tag for hive '${hiveTag.hiveId}': current index must be >= 1.`;
  }

  if (hiveTag.target < MIN_HIVE_AGENTS) {
    return `[HIVE COMPOSITION] Hive '${hiveTag.hiveId}' target ${hiveTag.target} is below the minimum composition of ${MIN_HIVE_AGENTS} agents.`;
  }

  if (hiveTag.current > hiveTag.target) {
    return `[HIVE COMPOSITION] Invalid HIVE tag for hive '${hiveTag.hiveId}': current index ${hiveTag.current} exceeds target ${hiveTag.target}.`;
  }

  return null;
}

function processPreToolUse(input) {
  const toolName = input?.tool_name || input?.toolName || '';
  const toolLower = toolName.toLowerCase();

  // E2: Also gate MCP spawn tools, not just Task
  const isMcpSpawn = toolLower === 'mcp__hive-flow__agent_spawn'
    || toolLower === 'mcp__hive-flow__queen_spawn_worker';

  // E1: Case-insensitive tool name check
  if (toolName && toolLower !== 'task' && !isMcpSpawn) {
    return makeAllow();
  }

  const toolInput = input?.tool_input || input?.input || {};
  const description = typeof toolInput.description === 'string'
    ? toolInput.description
    : (typeof toolInput.task === 'string' ? toolInput.task : '');
  const agentType = sanitizeAgentType(toolInput.subagent_type || toolInput.agent_type || '');

  if (!description.trim()) {
    return makeDeny(
      '[HIVE COMPOSITION] Task.description is required. Missing descriptions are blocked for safety.'
    );
  }

  const hiveTag = parseHiveTag(description);

  if (!hiveTag) {
    if (isAllowedSoloAgent(agentType)) {
      return makeAllow(
        `[HIVE COMPOSITION] Solo ${agentType} Task allowed without HIVE tag.`
      );
    }

    return makeDeny(
      `[HIVE COMPOSITION] Missing or malformed HIVE tag in Task.description: '${description.slice(0, 200)}'. Solo Task calls are restricted to bug-hunter and debugger.`
    );
  }

  // Anti-spoofing: solo roles should NOT carry HIVE tags
  if (isAllowedSoloAgent(agentType)) {
    return makeDeny(
      `[HIVE COMPOSITION] Solo agent '${agentType}' cannot carry a HIVE tag. Remove the [HIVE:...] prefix or use a non-solo agent type.`
    );
  }

  const validationError = validateHiveTag(hiveTag);
  if (validationError) {
    return makeDeny(validationError);
  }

  try {
    const hive = updateTrackerForSpawn(toolInput, hiveTag);
    return makeAllow(
      `[HIVE COMPOSITION] Registered hive ${hiveTag.hiveId} spawn ${hiveTag.current}/${hiveTag.target}. Tracker count: ${hive.spawnCount}/${hive.target}.`
    );
  } catch (error) {
    return makeDeny(
      `[HIVE COMPOSITION ERROR] ${error instanceof Error ? error.message : 'tracker-update-failed'}. Task blocked for safety.`
    );
  }
}

if (require.main === module) {
  try {
    const rawInput = readStdin();
    let input = {};
    try {
      input = rawInput ? JSON.parse(rawInput) : {};
    } catch {
      process.stdout.write(JSON.stringify(makeDeny(
        '[HIVE COMPOSITION] Invalid hook input JSON. Task blocked for safety.'
      )));
      process.exit(0);
    }

    process.stdout.write(JSON.stringify(processPreToolUse(input)));
  } catch {
    process.stdout.write(JSON.stringify(makeDeny(
      '[HIVE COMPOSITION ERROR] Internal error in hive composition gate. Task blocked for safety.'
    )));
  }
  process.exit(0);
}

module.exports = {
  HIVE_TAG_REGEX,
  MIN_HIVE_AGENTS,
  TRACKER_FILE,
  LOCK_DIR,
  makeAllow,
  makeDeny,
  parseHiveTag,
  processPreToolUse,
  readTracker,
  updateTrackerForSpawn,
  validateHiveTag,
  isAllowedSoloAgent,
  sanitizeHiveId,
  sanitizeAgentType,
};
