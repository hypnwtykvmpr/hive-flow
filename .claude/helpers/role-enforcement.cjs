#!/usr/bin/env node
/**
 * Role Enforcement System — PreToolUse + SubagentStart Hook
 *
 * Enforces role-based tool restrictions for advocate and queen roles.
 *
 * Advocate (HARD BLOCK):
 *   - Structurally denied: Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch
 *   - Cannot be overridden by escalation reset. Only human can remove role.
 *   - Fail-closed: errors deny.
 *
 * Queen (SOFT PREFERENCE):
 *   - All tools allowed. Work tools inject warnings when idle workers exist.
 *   - Fail-open: errors allow.
 *
 * Role state: .hive-flow/enforcement/agents/<sanitized-id>/role.json
 * HMAC-signed using same key as enforcement.cjs (.hive-flow/enforcement/.hmac-key)
 *
 * Output format: Claude Code PreToolUse protocol
 *   { hookSpecificOutput: { permissionDecision: 'allow'|'deny', ... } }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Derive PROJECT_DIR from script location (same as enforcement.cjs — prevents env poisoning)
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');
const HMAC_KEY_FILE = path.join(ENFORCEMENT_DIR, '.hmac-key');

// ============================================================================
// Identity Text Constants
// ============================================================================

const ADVOCATE_IDENTITY_TEXT = `[ROLE: ADVOCATE — Human's Direct Proxy]

You are the ADVOCATE. Your ONLY job is to orchestrate work by delegating to hives.

STRUCTURAL RULES (enforced by hooks — violation = tool denial):
- You CANNOT use Bash, Write, Edit, MultiEdit, NotebookEdit, or WebFetch
- You CAN use Task (spawn agents), SendMessage, Read, Grep, Glob, AskUserQuestion
- You CAN use all MCP queen/hive/agent/workflow/memory tools for coordination

BEHAVIORAL RULES:
- Spawn hives (queen_mission_assign) and monitor them (hive_status)
- Review queen reports (queen_report results) and make triage decisions
- Escalate to the human (AskUserQuestion) when uncertain
- Better to sit idle than to do work yourself
- If you need something investigated, spawn a hive for it`;

const QUEEN_IDENTITY_TEXT = `[ROLE: QUEEN — Autonomous Mission Lead for Hive {{HIVE_ID}}]

You are a QUEEN managing hive {{HIVE_ID}}. You lead workers to complete your assigned mission.

PROTOCOL:
1. Receive mission via queen_mission_assign
2. Spawn workers via queen_spawn_worker (respect maxWorkers budget)
3. Assign tasks via queen_task_worker
4. Collect results via queen_collect_results
5. Synthesize and submit via queen_report

PREFERENCES (tracked but not hard-blocked):
- PREFER delegating to workers over doing work directly
- When workers are idle, use them before doing it yourself
- When worker budget is exhausted AND work remains, report to advocate with status: failed

You have full tool access but direct work is TRACKED. Excessive direct work triggers advocate review.`;

// ============================================================================
// Tool Sets
// ============================================================================

const ADVOCATE_DENIED = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch']);
const WORK_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ============================================================================
// HMAC Utilities (mirrors enforcement.cjs logic)
// ============================================================================

function getHmacKey() {
  try {
    if (fs.existsSync(HMAC_KEY_FILE)) {
      return fs.readFileSync(HMAC_KEY_FILE, 'utf8').trim();
    }
  } catch {
    // Key file doesn't exist or unreadable
  }
  return null;
}

function computeHmac(data, key) {
  return crypto.createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
}

function verifyRoleHmac(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (!envelope.state || !envelope.hmac) return false;

  const key = getHmacKey();
  if (!key) return false;

  const expected = computeHmac(envelope.state, key);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(envelope.hmac, 'hex');

  if (expectedBuf.length !== actualBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// ============================================================================
// Agent ID + Path Utilities
// ============================================================================

function sanitizeId(agentId) {
  if (!agentId || typeof agentId !== 'string') return '';
  // Replace non-alphanumeric (except hyphen) with hyphen, truncate to 64 chars
  const sanitized = agentId.replace(/[\/\\\.]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.slice(0, 64) || '';
}

function getRoleFilePath(agentId) {
  const id = sanitizeId(agentId);
  if (!id) return null;
  return path.join(ENFORCEMENT_DIR, 'agents', id, 'role.json');
}

function loadRole(agentId) {
  const roleFile = getRoleFilePath(agentId);
  if (!roleFile) return null;

  try {
    if (!fs.existsSync(roleFile)) return null;
    const stats = fs.statSync(roleFile);
    if (stats.size > 10240) return null; // 10KB sanity limit
    const raw = JSON.parse(fs.readFileSync(roleFile, 'utf8'));

    // C3: Role file uses HMAC envelope { state: {...}, hmac: "..." }
    if (!verifyRoleHmac(raw)) return null; // Tampered — ignore

    return raw.state;
  } catch {
    return null;
  }
}

// ============================================================================
// Hive Loading (for queen soft enforcement)
// ============================================================================

function loadQueenHive(hiveId) {
  if (!hiveId) return null;
  try {
    const hiveFile = path.join(PROJECT_DIR, '.hive-flow', 'hives', hiveId, 'hive.json');
    if (!fs.existsSync(hiveFile)) return null;
    const stats = fs.statSync(hiveFile);
    if (stats.size > 102400) return null; // 100KB sanity limit
    return JSON.parse(fs.readFileSync(hiveFile, 'utf8'));
  } catch {
    return null;
  }
}

// ============================================================================
// Output Formatting (mirrors enforcement.cjs)
// ============================================================================

function makeAllow(additionalContext) {
  const result = {};
  if (additionalContext) {
    // Sanitize context — strip XML tags, limit length
    let sanitized = additionalContext.replace(/<[^>]+>/g, '');
    if (sanitized.length > 2000) sanitized = sanitized.slice(0, 2000) + '... [truncated]';
    result.hookSpecificOutput = { permissionDecision: 'allow', additionalContext: sanitized };
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

// ============================================================================
// Advocate Enforcement (HARD BLOCK)
// ============================================================================

function enforceAdvocateRole(toolName) {
  if (ADVOCATE_DENIED.has(toolName)) {
    return makeDeny(
      `[ADVOCATE ENFORCEMENT] Tool '${toolName}' is structurally blocked for advocate role. ` +
      `Delegate this work to a hive via queen_mission_assign + queen_spawn_worker. ` +
      `The advocate orchestrates — it does not execute.`
    );
  }
  return makeAllow();
}

// ============================================================================
// Queen Enforcement (SOFT PREFERENCE)
// ============================================================================

function enforceQueenRole(toolName, role) {
  if (!WORK_TOOLS.has(toolName)) {
    return makeAllow(); // Non-work tools always allowed
  }

  // Check hive worker availability
  const hiveId = role.hiveId;
  if (!hiveId) {
    return makeAllow(); // Pre-mission queen — no hive context yet
  }

  const hive = loadQueenHive(hiveId);
  if (!hive) {
    return makeAllow(); // Hive not found — allow
  }

  const idleWorkers = (hive.workers || []).filter(w => w.status === 'idle');
  const liveWorkers = (hive.workers || []).filter(w => w.status !== 'terminated');
  const budgetRemaining = (hive.budget?.maxWorkers || 0) - liveWorkers.length;

  if (idleWorkers.length > 0) {
    // Workers available — warn but allow
    return makeAllow(
      `[QUEEN DELEGATION PREFERENCE] ${idleWorkers.length} idle worker(s) available. ` +
      `Prefer delegation via queen_task_worker. Direct work is allowed but tracked.`
    );
  }

  if (budgetRemaining > 0) {
    return makeAllow(
      `[QUEEN DELEGATION PREFERENCE] No idle workers, but ${budgetRemaining} budget slot(s) remain. ` +
      `Consider queen_spawn_worker before doing work directly.`
    );
  }

  // Budget exhausted, no idle workers — allow silently
  return makeAllow();
}

// ============================================================================
// SubagentStart Identity Injection
// ============================================================================

function processSubagentStart(role) {
  if (role.type === 'advocate') {
    return { hookSpecificOutput: { additionalContext: ADVOCATE_IDENTITY_TEXT } };
  }
  if (role.type === 'queen') {
    const text = QUEEN_IDENTITY_TEXT.replace(/\{\{HIVE_ID\}\}/g, role.hiveId || 'unassigned');
    return { hookSpecificOutput: { additionalContext: text } };
  }
  return {};
}

// ============================================================================
// Main Entry Point
// ============================================================================

function processPreToolUse(input) {
  const toolName = input?.tool_name || input?.toolName || '';

  // C2: Use ALL three env var sources
  const agentId = process.env.AGENTIC_FLOW_AGENT_ID
    || process.env.CLAUDE_SESSION_ID
    || process.env.CLAUDE_AGENT_ID
    || null;

  if (!agentId) return makeAllow(); // No agent ID — pass through

  const role = loadRole(agentId);
  if (!role) return makeAllow(); // No role assigned — pass through

  if (role.type === 'advocate') {
    return enforceAdvocateRole(toolName);
  }

  if (role.type === 'queen') {
    return enforceQueenRole(toolName, role);
  }

  // Workers and unknown roles — pass through to enforcement.cjs
  return makeAllow();
}

function processSubagentStartHook() {
  // C2: Use ALL three env var sources
  const agentId = process.env.AGENTIC_FLOW_AGENT_ID
    || process.env.CLAUDE_SESSION_ID
    || process.env.CLAUDE_AGENT_ID
    || null;

  if (!agentId) return {};

  const role = loadRole(agentId);
  if (!role) return {};

  return processSubagentStart(role);
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

if (require.main === module) {
  // Determine context: PreToolUse has stdin with tool_name, SubagentStart has CLAUDE_AGENT_ID but no meaningful stdin
  let roleType = null;

  try {
    const rawInput = readStdin();
    let input;
    try {
      input = JSON.parse(rawInput);
    } catch {
      input = {};
    }

    const toolName = input?.tool_name || input?.toolName || '';

    if (toolName) {
      // PreToolUse context — enforce role restrictions
      const result = processPreToolUse(input);
      process.stdout.write(JSON.stringify(result));
    } else {
      // SubagentStart context (or empty input) — inject identity
      const result = processSubagentStartHook();
      process.stdout.write(JSON.stringify(result));
    }

    // Determine role for exit-code logic
    const agentId = process.env.AGENTIC_FLOW_AGENT_ID
      || process.env.CLAUDE_SESSION_ID
      || process.env.CLAUDE_AGENT_ID
      || null;
    if (agentId) {
      const role = loadRole(agentId);
      roleType = role?.type || null;
    }
  } catch (err) {
    // Error handling is role-aware:
    // - Advocate: fail-closed (deny)
    // - Queen/other: fail-open (allow)
    const agentId = process.env.AGENTIC_FLOW_AGENT_ID
      || process.env.CLAUDE_SESSION_ID
      || process.env.CLAUDE_AGENT_ID
      || null;
    if (agentId) {
      try {
        const roleFile = getRoleFilePath(agentId);
        if (roleFile && fs.existsSync(roleFile)) {
          const raw = JSON.parse(fs.readFileSync(roleFile, 'utf8'));
          if (!verifyRoleHmac(raw)) {
            roleType = null; // HMAC failed — fail-open for all
          } else {
            roleType = raw?.state?.type || null;
          }
        }
      } catch {
        // Can't determine role — default fail-open
      }
    }

    if (roleType === 'advocate') {
      // Advocate: fail-closed
      process.stdout.write(JSON.stringify(makeDeny(
        '[ROLE ENFORCEMENT ERROR] Internal error in role-enforcement hook. Tool blocked for advocate safety.'
      )));
    } else {
      // Queen/other/unknown: fail-open
      process.stdout.write(JSON.stringify(makeAllow()));
    }
  }
  process.exit(0);
}

// ============================================================================
// Exports (for testing)
// ============================================================================

module.exports = {
  ADVOCATE_DENIED,
  WORK_TOOLS,
  ADVOCATE_IDENTITY_TEXT,
  QUEEN_IDENTITY_TEXT,
  sanitizeId,
  getRoleFilePath,
  loadRole,
  loadQueenHive,
  verifyRoleHmac,
  makeAllow,
  makeDeny,
  enforceAdvocateRole,
  enforceQueenRole,
  processPreToolUse,
  processSubagentStartHook,
  processSubagentStart,
};
