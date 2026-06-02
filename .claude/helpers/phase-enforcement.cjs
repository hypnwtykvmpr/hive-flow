#!/usr/bin/env node
/**
 * Phase Enforcement — PreToolUse hook
 *
 * Reads HMAC-verified workflow state from .hive-flow/workflows/state.json,
 * maps current phase to allowed tool categories, and blocks wrong-phase tools.
 * Injects [CURRENT_PHASE: X] context on every allowed call.
 *
 * Fail-open on missing state (IDLE = all allowed).
 * Fail-closed on corrupt/tampered state.
 *
 * Output format: Claude Code PreToolUse protocol
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow'|'deny', ... } }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const WORKFLOW_STATE_FILE = path.join(PROJECT_DIR, '.hive-flow', 'workflows', 'state.json');
const HMAC_KEY_FILE = path.join(PROJECT_DIR, '.hive-flow', 'enforcement', '.hmac-key');

// Tool categories for phase-gating
const TOOL_CATEGORIES = {
  read: new Set(['Read', 'Grep', 'Glob']),
  communicate: new Set(['AskUserQuestion', 'SendMessage', 'EnterPlanMode', 'ExitPlanMode']),
  spawn: new Set(['Task', 'mcp__hive-flow__agent_spawn', 'mcp__hive-flow__queen_spawn_worker', 'mcp__hive-flow__queen_mission_assign']),
  write: new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']),
  bash: new Set(['Bash']),
  fetch: new Set(['WebFetch', 'WebSearch']),
  filesystem: new Set(['mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__move_file', 'mcp__filesystem__create_directory', 'mcp__filesystem__delete_file']),
  git: new Set(['Bash']), // git detection handled separately
};

// Phase → allowed tool categories
// Phases that only allow read/communicate/spawn (no direct code work)
const INVESTIGATION_PHASES = new Set([
  'INVESTIGATING', 'RESEARCHING', 'VERIFYING_INVESTIGATION', 'VERIFYING_RESEARCH',
]);
const DESIGN_PHASES = new Set([
  'DESIGNING', 'PLANNING', 'VERIFYING_DESIGN', 'VERIFYING_PLAN',
]);
const APPROVAL_PHASES = new Set(['AWAITING_HUMAN_APPROVAL']);
const IMPLEMENTATION_PHASES = new Set(['IMPLEMENTING']);
const TESTING_PHASES = new Set(['TESTING', 'DEBUGGING']);
const VERIFICATION_PHASES = new Set([
  'VERIFYING_IMPLEMENTATION', 'VERIFYING_TESTING', 'VERIFYING_DEBUGGING',
]);
const AUDIT_PHASES = new Set(['AUDITING', 'VERIFYING_AUDIT']);
const COMMIT_PHASES = new Set(['COMMITTING']);
const TERMINAL_PHASES = new Set(['COMPLETE']);

// Phase → which tool categories are ALLOWED
function getAllowedCategories(phase) {
  // Always allowed: read + communicate
  const base = ['read', 'communicate'];

  if (phase === 'IDLE' || TERMINAL_PHASES.has(phase)) return null; // null = all allowed
  if (INVESTIGATION_PHASES.has(phase)) return [...base, 'spawn', 'fetch'];
  if (DESIGN_PHASES.has(phase)) return [...base, 'spawn', 'fetch'];
  if (APPROVAL_PHASES.has(phase)) return [...base]; // Only read + communicate during human gate
  if (IMPLEMENTATION_PHASES.has(phase)) return [...base, 'spawn', 'write', 'bash', 'filesystem', 'fetch'];
  if (TESTING_PHASES.has(phase)) return [...base, 'spawn', 'bash', 'fetch']; // test/debug can run commands but not write code
  if (VERIFICATION_PHASES.has(phase)) return [...base, 'spawn', 'bash', 'fetch'];
  if (AUDIT_PHASES.has(phase)) return [...base, 'spawn', 'fetch'];
  if (COMMIT_PHASES.has(phase)) return [...base, 'bash', 'git']; // Only git operations
  return null; // Unknown phase = fail-open
}

function getToolCategory(toolName) {
  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    if (tools.has(toolName)) return category;
  }
  return 'unknown';
}

function getHmacKey() {
  try {
    if (fs.existsSync(HMAC_KEY_FILE)) {
      return fs.readFileSync(HMAC_KEY_FILE, 'utf8').trim();
    }
  } catch {}
  return null;
}

// Verify workflow state envelope — handles BOTH {payload,signature} and {state,hmac} formats
function verifyWorkflowState(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;

  const key = getHmacKey();
  if (!key) return null; // No HMAC key = can't verify

  // Format 1: {payload, signature} (state-machine.ts)
  if (envelope.payload && envelope.signature) {
    const expected = crypto.createHmac('sha256', key).update(JSON.stringify(envelope.payload)).digest('hex');
    try {
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(envelope.signature, 'hex');
      if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        return envelope.payload;
      }
    } catch {}
    return null; // Tampered
  }

  // Format 2: {state, hmac} (enforcement.cjs)
  if (envelope.state && envelope.hmac) {
    const expected = crypto.createHmac('sha256', key).update(JSON.stringify(envelope.state)).digest('hex');
    try {
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(envelope.hmac, 'hex');
      if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        return envelope.state;
      }
    } catch {}
    return null; // Tampered
  }

  return null; // Unsigned — fail-closed
}

function readWorkflowState() {
  try {
    if (!fs.existsSync(WORKFLOW_STATE_FILE)) return { phase: 'IDLE', state: null };
    const raw = JSON.parse(fs.readFileSync(WORKFLOW_STATE_FILE, 'utf8'));
    const verified = verifyWorkflowState(raw);
    if (!verified) return { phase: null, state: null, error: 'corrupt' }; // Fail-closed
    return { phase: verified.currentPosition || 'IDLE', state: verified };
  } catch {
    return { phase: null, state: null, error: 'unreadable' }; // Fail-closed
  }
}

function makeAllow(additionalContext) {
  if (additionalContext) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext } };
  }
  return {};
}

function makeDeny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function processPreToolUse(input) {
  const toolName = input?.tool_name || input?.toolName || '';
  if (!toolName) return makeAllow(); // Empty = SubagentStart, pass through

  const { phase, error } = readWorkflowState();

  // Fail-open: no workflow state file (IDLE)
  if (phase === 'IDLE') return makeAllow('[CURRENT_PHASE: IDLE]');

  // Fail-closed: corrupt or unreadable state
  if (error) {
    return makeDeny(`[PHASE ENFORCEMENT] Workflow state is ${error}. Tool blocked for safety. Use /enforcement-reset to clear.`);
  }

  // Null phase = fail-closed (shouldn't happen with valid state)
  if (!phase) {
    return makeDeny('[PHASE ENFORCEMENT] Unknown workflow phase. Tool blocked.');
  }

  const allowed = getAllowedCategories(phase);

  // null = all allowed (IDLE, COMPLETE, unknown)
  if (allowed === null) return makeAllow(`[CURRENT_PHASE: ${phase}]`);

  const category = getToolCategory(toolName);

  // Unknown tools pass through (fail-open for unrecognized tools)
  if (category === 'unknown') return makeAllow(`[CURRENT_PHASE: ${phase}]`);

  if (allowed.includes(category)) {
    return makeAllow(`[CURRENT_PHASE: ${phase}]`);
  }

  return makeDeny(
    `[PHASE ENFORCEMENT] Tool '${toolName}' (category: ${category}) is not allowed in phase ${phase}. ` +
    `Allowed categories: ${allowed.join(', ')}. Advance the workflow phase before using this tool.`
  );
}

// CLI entry point
if (require.main === module) {
  try {
    let rawInput = '';
    try { rawInput = fs.readFileSync(0, 'utf8'); } catch {}
    let input;
    try { input = JSON.parse(rawInput); } catch { input = {}; }
    const result = processPreToolUse(input);
    process.stdout.write(JSON.stringify(result));
  } catch {
    // Fail-open on internal error (don't block user)
    process.stdout.write(JSON.stringify({}));
  }
  process.exit(0);
}

module.exports = { processPreToolUse, readWorkflowState, getAllowedCategories, getToolCategory };
