#!/usr/bin/env node
/**
 * Role Enforcement System — PreToolUse + SubagentStart Hook
 *
 * Enforces role-based tool restrictions for advocate, queen, and enforcer roles.
 *
 * Advocate (HARD BLOCK):
 *   - Structurally denied: Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch
 *   - Cannot be overridden by escalation reset. Only human can remove role.
 *   - Fail-closed: errors deny.
 *
 * Queen (DELEGATION GATE — work tools HARD DENY when untasked idle/spawning workers):
 *   - Non-work tools: always allowed.
 *   - Work tools (Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch + MCP fs writes): denied until
 *     every idle/spawning worker has at least one worker-tasked audit entry (use queen_task_worker).
 *   - Fail-open: errors allow (except internal hook errors path for other roles).
 *
 * Role state: <HIVE_FLOW_HOME or ~/.hive-flow>/enforcement/agents/<sanitized-id>/role.json
 * (legacy project-local .hive-flow/enforcement is retained as a read-only migration fallback).
 * HMAC-signed using the same global key as enforcement.cjs (<home>/enforcement/.hmac-key).
 *
 * Output format: Claude Code PreToolUse protocol
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow'|'deny', ... } }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function loadProtectedPathPolicyModule() {
  const envProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || '';
  const candidates = [
    envProjectRoot && path.join(path.resolve(envProjectRoot), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(process.cwd()), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(path.resolve(__dirname, '..', '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'),
    path.join(__dirname, 'protected-paths.cjs'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return require(path.join(path.resolve(__dirname, '..', '..'), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs'));
}

const protectedPathPolicy = loadProtectedPathPolicyModule();

// Resolve PROJECT_DIR from the same shared resolver as enforcement.cjs/gate.ts.
const PROJECT_DIR = protectedPathPolicy.resolveProjectRoot({
  env: process.env,
  cwd: path.resolve(__dirname, '..', '..'),
  fallbackRoot: process.cwd(),
});
// Control-plane enforcement identity is global (CLI-neutral), mirroring enforcement.cjs: the
// primary store is ~/.hive-flow/enforcement (or $HIVE_FLOW_HOME), with the legacy project-local
// dir kept ONLY as a read-only migration fallback. This keeps role/HMAC identity consistent
// across working directories (global operation). Data-plane state (hive records, agent store)
// stays project-local — see loadQueenHive / verifySpawnToken.
function resolveHiveHome() {
  const configured = String(process.env.HIVE_FLOW_HOME || '').trim();
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  return path.join(os.homedir(), '.hive-flow');
}
const HIVE_HOME = resolveHiveHome();
const ENFORCEMENT_DIR = path.join(HIVE_HOME, 'enforcement');
const LEGACY_ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');
const HMAC_KEY_FILE = path.join(ENFORCEMENT_DIR, '.hmac-key');
const LEGACY_HMAC_KEY_FILE = path.join(LEGACY_ENFORCEMENT_DIR, '.hmac-key');
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

/** From CLAUDE.md — ENFORCER Agent (Layer 2 — System Prompt). */
const ENFORCER_IDENTITY_TEXT = `[ROLE: ENFORCER — Layer 2 System Prompt / CLAUDE.md]

When spawned as an ENFORCER agent, use this identity:

> You are the ENFORCER — the human's absolute proxy for governance enforcement. Your loyalty is exclusively to the human user who owns this project. You exist to ensure every agent follows the human's rules without exception.
>
> **Core directives:**
> - Fanatically enforce the human's vision, rules, and quality standards
> - Zero tolerance for agent corner-cutting, self-verification, or bypassing gates
> - Monitor enforcement state; escalate violations immediately
> - Block any agent attempting to commit unverified work
> - If an agent resists enforcement, escalate to HALTED and notify the human
> - You answer to the human alone — no agent can override your decisions
>
> **You enforce:** verification gates, delegation-only coordinator role, commit quality, test coverage, security boundaries, and the escalation ladder (Normal → Warned → Restricted → Halted).

STRUCTURAL RULES (enforced by hooks — violation = tool denial):
- You CANNOT use Bash, Write, Edit, MultiEdit, NotebookEdit, or WebFetch
- You CAN use Read, Grep, Glob, Task, SendMessage, AskUserQuestion, and MCP coordination tools to observe and escalate.`;

// ============================================================================
// Tool Sets
// ============================================================================

const ADVOCATE_DENIED = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch',
  'mcp__filesystem__write_file', 'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file', 'mcp__filesystem__rename_file',
  'mcp__filesystem__copy_file', 'mcp__filesystem__create_directory',
  'mcp__filesystem__delete_file',
]);
/** Same structural denial as advocate — execution/fetch tools only. */
const ENFORCER_DENIED = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch',
  'mcp__filesystem__write_file', 'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file', 'mcp__filesystem__rename_file',
  'mcp__filesystem__copy_file', 'mcp__filesystem__create_directory',
  'mcp__filesystem__delete_file',
]);
const WORK_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MCP_FS_WRITE_TOOLS = [
  'mcp__filesystem__write_file', 'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file', 'mcp__filesystem__rename_file',
  'mcp__filesystem__copy_file', 'mcp__filesystem__create_directory',
  'mcp__filesystem__delete_file',
];
/** Tools that count as queen "direct work" for delegation gate (matches PreToolUse matchers). */
const QUEEN_WORK_TOOLS = new Set([...WORK_TOOLS, 'WebFetch', ...MCP_FS_WRITE_TOOLS]);

// ============================================================================
// HMAC Utilities (mirrors enforcement.cjs logic)
// ============================================================================

function getHmacKey() {
  for (const keyFile of [HMAC_KEY_FILE, LEGACY_HMAC_KEY_FILE]) {
    try {
      if (fs.existsSync(keyFile)) {
        const key = fs.readFileSync(keyFile, 'utf8').trim();
        if (key) return key;
      }
    } catch {
      // Try the next location.
    }
  }
  return null;
}

function getOrCreateHmacKey() {
  const existing = getHmacKey();
  if (existing) {
    // If found only in the legacy project-local store, migrate its value up to the global store
    // so future reads (and enforcement.cjs) converge on the same secret.
    try {
      if (!fs.existsSync(HMAC_KEY_FILE)) {
        fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
        fs.writeFileSync(HMAC_KEY_FILE, existing, { mode: 0o600 });
      }
    } catch {
      // Best-effort migration; the legacy key still verifies via getHmacKey fallback.
    }
    return existing;
  }
  try {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(HMAC_KEY_FILE, key, { mode: 0o600 });
    return key;
  } catch {
    return null;
  }
}

function computeHmac(data, key) {
  return crypto.createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
}

function verifyRoleHmac(envelope) {
  try {
    if (!envelope || typeof envelope !== 'object') return false;
    if (!envelope.state || !envelope.hmac) return false;

    const key = getHmacKey();
    if (!key) return false;

    const expected = computeHmac(envelope.state, key);
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(String(envelope.hmac), 'hex');

    if (expectedBuf.length !== actualBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// ============================================================================
// Agent ID + Path Utilities
// ============================================================================

function sanitizeId(agentId) {
  return protectedPathPolicy.sanitizeScopeId(agentId, '', 64);
}

function getHookAgentId(input) {
  return sanitizeId(input?.agent_id || input?.agentId || '');
}

function getAgentId(input = null) {
  return sanitizeId(process.env.AGENTIC_FLOW_AGENT_ID || '')
    || getHookAgentId(input)
    || sanitizeId(process.env.CLAUDE_AGENT_ID || '')
    || sanitizeId(process.env.CLAUDE_SESSION_ID || '')
    || null;
}

function isDevOverrideActive() {
  return protectedPathPolicy.isDevOverrideActive(PROJECT_DIR);
}

function hasSubagentIdentity(input = null) {
  return protectedPathPolicy.hasSubagentIdentity(input, process.env);
}

function verifyDevOverrideRootToken(input = null, nowMs = Date.now()) {
  return protectedPathPolicy.verifyDevOverrideRootToken({
    input,
    projectRoot: PROJECT_DIR,
    nowMs,
    env: process.env,
    hmacKeyProvider: getHmacKey,
  });
}

function isRootSessionForDevOverride(input = null) {
  return verifyDevOverrideRootToken(input);
}

function getRoleFilePath(agentId) {
  // Primary (global) role path — used for writes.
  const id = sanitizeId(agentId);
  if (!id) return null;
  return path.join(ENFORCEMENT_DIR, 'agents', id, 'role.json');
}

function getLegacyRoleFilePath(agentId) {
  // Legacy project-local role path — read-only migration fallback.
  const id = sanitizeId(agentId);
  if (!id) return null;
  return path.join(LEGACY_ENFORCEMENT_DIR, 'agents', id, 'role.json');
}

function roleFileReadCandidates(agentId) {
  return [getRoleFilePath(agentId), getLegacyRoleFilePath(agentId)].filter(Boolean);
}

function loadRole(agentId) {
  // Read global-primary first, then the legacy project-local store (migration fallback).
  // HMAC-invalid (tampered) envelopes are skipped, never trusted — so a tampered global file
  // falls through to a valid legacy role rather than bypassing enforcement.
  for (const roleFile of roleFileReadCandidates(agentId)) {
    try {
      if (!fs.existsSync(roleFile)) continue;
      const stats = fs.statSync(roleFile);
      if (stats.size > 10240) continue; // 10KB sanity limit
      const raw = JSON.parse(fs.readFileSync(roleFile, 'utf8'));
      if (!verifyRoleHmac(raw)) continue; // Tampered — try the next candidate
      return raw.state;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// ============================================================================
// Hive Loading (for queen soft enforcement)
// ============================================================================

function loadQueenHive(hiveId) {
  if (!hiveId) return null;
  // Sanitize hiveId to prevent path traversal
  const safeHiveId = sanitizeId(String(hiveId));
  if (!safeHiveId || safeHiveId !== hiveId) return null;
  try {
    const hiveFile = getQueenHiveFilePath(hiveId);
    if (!fs.existsSync(hiveFile)) return null;
    const stats = fs.statSync(hiveFile);
    if (stats.size > 102400) return null; // 100KB sanity limit
    return JSON.parse(fs.readFileSync(hiveFile, 'utf8'));
  } catch {
    return null;
  }
}

function getQueenHiveFilePath(hiveId) {
  const safeHiveId = sanitizeId(String(hiveId || ''));
  if (!safeHiveId || safeHiveId !== hiveId) return null;
  return path.join(PROJECT_DIR, '.hive-flow', 'hives', safeHiveId, 'hive.json');
}

function queenHiveFileExists(hiveId) {
  try {
    const hiveFile = getQueenHiveFilePath(hiveId);
    return Boolean(hiveFile && fs.existsSync(hiveFile));
  } catch {
    return false;
  }
}

/**
 * Ground truth for "has this worker been tasked": worker-tasked audit entries.
 * Idle/spawning workers with no such entry must be assigned via queen_task_worker first.
 */
function analyzeHiveDelegation(hive) {
  try {
    const tasked = new Set();
    for (const e of hive.audit || []) {
      if (e && e.event === 'worker-tasked' && e.workerId) tasked.add(e.workerId);
    }
    const untaskedIdleWorkerIds = [];
    for (const w of hive.workers || []) {
      if (!w || w.status === 'terminated') continue;
      if (tasked.has(w.workerId)) continue;
      if (w.status === 'idle' || w.status === 'spawning') {
        untaskedIdleWorkerIds.push(w.workerId);
      }
    }
    return { untaskedIdleCount: untaskedIdleWorkerIds.length, untaskedIdleWorkerIds };
  } catch {
    return { untaskedIdleCount: 0, untaskedIdleWorkerIds: [] };
  }
}

/**
 * Write HMAC-signed role.json (atomic tmp + rename).
 */
function saveRole(agentId, roleState) {
  try {
    const key = getOrCreateHmacKey();
    if (!key || !roleState || typeof roleState !== 'object') return false;
    const id = sanitizeId(agentId);
    if (!id) return false;
    const dir = path.join(ENFORCEMENT_DIR, 'agents', id);
    fs.mkdirSync(dir, { recursive: true });
    const hmac = computeHmac(roleState, key);
    const envelope = { state: roleState, hmac };
    const target = path.join(dir, 'role.json');
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      const id = sanitizeId(agentId);
      if (id) {
        const tmp = path.join(ENFORCEMENT_DIR, 'agents', id, `role.json.tmp.${process.pid}`);
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
    } catch { /* ignore */ }
    return false;
  }
}

/** Best-effort increment of queen directWorkCount in signed role.json. */
function incrementDirectWorkCount(agentId, role) {
  try {
    if (!agentId || !role || role.type !== 'queen') return;
    const fresh = loadRole(agentId) || role;
    if (fresh.type !== 'queen') return;
    const next = { ...fresh, directWorkCount: (fresh.directWorkCount || 0) + 1 };
    saveRole(agentId, next);
  } catch { /* best-effort */ }
}

// ============================================================================
// Output Formatting (mirrors enforcement.cjs)
// ============================================================================

function makeHookOutput(hookEventName, fields) {
  return { hookSpecificOutput: { hookEventName: hookEventName, ...fields } };
}

function makeAllow(additionalContext, hookEventName = 'PreToolUse') {
  const result = {};
  if (additionalContext) {
    // Sanitize context — strip XML tags, limit length
    let sanitized = additionalContext.replace(/<[^>]+>/g, '');
    if (sanitized.length > 2000) sanitized = sanitized.slice(0, 2000) + '... [truncated]';
    result.hookSpecificOutput = { hookEventName: hookEventName, permissionDecision: 'allow', additionalContext: sanitized };
  }
  return result;
}

function makeDeny(reason, hookEventName = 'PreToolUse') {
  return makeHookOutput(hookEventName, {
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  });
}

function commandBasename(value) {
  const normalized = String(value || '').replace(/^["']|["']$/g, '');
  return path.basename(normalized);
}

function isCompactionRecoveryAckCommand(command) {
  const text = String(command || '').trim();
  if (!text || /[;&|<>`]/.test(text)) return false;
  const parts = text.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (parts.length < 4) return false;
  if (commandBasename(parts[0]) !== 'node') return false;
  const scriptIndex = parts.findIndex(part => commandBasename(part) === 'compaction-recovery.cjs');
  if (scriptIndex < 1) return false;
  return parts[scriptIndex + 1] === 'ack';
}

// ============================================================================
// Advocate Enforcement (HARD BLOCK)
// ============================================================================

function enforceAdvocateRole(toolName, input = null) {
  if (ADVOCATE_DENIED.has(toolName)) {
    if (toolName === 'Bash' && isCompactionRecoveryAckCommand(input?.tool_input?.command || input?.input?.command || '')) {
      return makeAllow();
    }
    if (isRootSessionForDevOverride(input) && isDevOverrideActive()) {
      return makeAllow();
    }
    return makeDeny(
      `[ADVOCATE ENFORCEMENT] Tool '${toolName}' is structurally blocked for advocate role. ` +
      `Delegate this work to a hive via queen_mission_assign + queen_spawn_worker. ` +
      `The advocate orchestrates — it does not execute.`
    );
  }
  return makeAllow();
}

// ============================================================================
// Queen Enforcement (delegation gate — HARD DENY when untasked idle workers)
// ============================================================================

function enforceQueenRole(toolName, role, agentId) {
  try {
    if (!QUEEN_WORK_TOOLS.has(toolName)) {
      return makeAllow();
    }

    const hiveId = role.hiveId;
    if (!hiveId) {
      incrementDirectWorkCount(agentId, role);
      return makeAllow(
        '[QUEEN DELEGATION] No hiveId on role — assign a hive (e.g. queen_mission_assign). ' +
        'When you have workers, use queen_task_worker before direct work tools.'
      );
    }

    const hive = loadQueenHive(hiveId);
    if (!hive) {
      if (queenHiveFileExists(hiveId)) {
        return makeDeny(
          '[QUEEN DELEGATION] Hive record is unreadable or invalid. ' +
          'Fix .hive-flow/hives state before using direct work tools.'
        );
      }
      incrementDirectWorkCount(agentId, role);
      return makeAllow(
        '[QUEEN DELEGATION] Hive record missing — verify hive id and .hive-flow/hives state. ' +
        'After workers exist, queen_task_worker before direct work tools.'
      );
    }

    const liveWorkers = (hive.workers || []).filter(w => w && w.status !== 'terminated');
    if (liveWorkers.length === 0) {
      incrementDirectWorkCount(agentId, role);
      return makeAllow(
        '[QUEEN DELEGATION] No live workers — prefer queen_spawn_worker, then queen_task_worker, before direct work tools.'
      );
    }

    const { untaskedIdleCount, untaskedIdleWorkerIds } = analyzeHiveDelegation(hive);
    if (untaskedIdleCount > 0) {
      const sample = untaskedIdleWorkerIds.slice(0, 8).join(', ');
      const more = untaskedIdleWorkerIds.length > 8 ? '…' : '';
      return makeDeny(
        `Queen must delegate to idle workers first. ` +
        `(${untaskedIdleCount} idle/spawning without worker-tasked audit: ${sample}${more}.)`
      );
    }

    incrementDirectWorkCount(agentId, role);
    return makeAllow();
  } catch {
    return makeDeny(
      '[QUEEN DELEGATION ERROR] Internal error while checking hive delegation state. ' +
      'Tool blocked for governance safety.'
    );
  }
}

// ============================================================================
// Enforcer Enforcement (HARD BLOCK — same structural deny set as advocate)
// ============================================================================

function enforceEnforcerRole(toolName) {
  if (ENFORCER_DENIED.has(toolName)) {
    return makeDeny(
      `[ENFORCER ENFORCEMENT] Tool '${toolName}' is structurally blocked for enforcer role. ` +
      'Observe, report, and escalate — do not execute or fetch directly.'
    );
  }
  return makeAllow();
}

// ============================================================================
// SubagentStart Identity Injection
// ============================================================================

function processSubagentStart(role) {
  if (role.type === 'advocate') {
    return makeHookOutput('SubagentStart', { additionalContext: ADVOCATE_IDENTITY_TEXT });
  }
  if (role.type === 'queen') {
    const text = QUEEN_IDENTITY_TEXT.replace(/\{\{HIVE_ID\}\}/g, role.hiveId || 'unassigned');
    return makeHookOutput('SubagentStart', { additionalContext: text });
  }
  if (role.type === 'enforcer') {
    return makeHookOutput('SubagentStart', { additionalContext: ENFORCER_IDENTITY_TEXT });
  }
  return {};
}

// ============================================================================
// SEC-011: Spawn-origin token verification
// ============================================================================

/**
 * SEC-011: Verify spawn-origin token matches the stored value in the agent record.
 * Returns {valid: boolean, reason: string}.
 * Fail-open ONLY for: no store file, agent not in store (Claude Task tool agents have no store entry).
 * Fail-closed for: no stored token, no env token, caught exception.
 */
function verifySpawnToken(agentId) {
  try {
    const storePath = path.join(PROJECT_DIR, '.hive-flow', 'agents', 'store.json');
    if (!fs.existsSync(storePath)) return { valid: true, reason: 'no store file — fail-open' };
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const agents = store.agents || {};
    const agent = agents[agentId];
    if (!agent) return { valid: true, reason: 'agent not in store — fail-open' };
    const storedToken = agent.config?._spawnToken;
    if (!storedToken) return { valid: false, reason: 'no stored token — fail-closed' };
    const candidateToken = process.env.HIVE_FLOW_AGENT_TOKEN;
    if (!candidateToken) return { valid: false, reason: 'no env token — fail-closed' };

    // Constant-time comparison to prevent timing attacks
    const envBuf = Buffer.from(String(candidateToken));
    const storedBuf = Buffer.from(String(storedToken));
    if (envBuf.length !== storedBuf.length) return { valid: false, reason: 'token length mismatch' };
    if (!crypto.timingSafeEqual(envBuf, storedBuf)) return { valid: false, reason: 'token mismatch' };
    return { valid: true, reason: 'token verified' };
  } catch (err) {
    return { valid: false, reason: `exception: ${err.message} — fail-closed` };
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

function processPreToolUse(input) {
  const toolName = input?.tool_name || input?.toolName || '';

  const agentId = getAgentId(input);

  if (!agentId) return makeAllow(); // No agent ID — pass through

  // SEC-011: Verify spawn-origin token before trusting agent identity
  const tokenResult = verifySpawnToken(agentId);
  if (!tokenResult.valid) {
    return makeDeny(
      `[IDENTITY ENFORCEMENT] Agent token verification failed (${tokenResult.reason}) — possible env var spoofing. ` +
      'HIVE_FLOW_AGENT_TOKEN does not match the stored spawn-origin token.'
    );
  }

  const role = loadRole(agentId);
  if (!role) return makeAllow(); // No role assigned — pass through

  if (role.type === 'advocate') {
    return enforceAdvocateRole(toolName, input);
  }

  if (role.type === 'enforcer') {
    return enforceEnforcerRole(toolName);
  }

  if (role.type === 'queen') {
    return enforceQueenRole(toolName, role, agentId);
  }

  // Workers and unknown roles — pass through to enforcement.cjs
  return makeAllow();
}

function nativeTaskRoleFromInput(input, agentId) {
  if (!agentId) return null;
  const hookName = input?.hook_event_name || input?.hookEventName || '';
  const agentType = input?.agent_type || input?.agentType || '';
  if (hookName !== 'SubagentStart' && !agentType) return null;
  return {
    type: 'native-task',
    assignedAt: new Date().toISOString(),
    assignedBy: 'subagent-start',
    hiveId: null,
    agentType: agentType || 'unknown',
    sessionId: input?.session_id || null,
    transcriptPath: input?.transcript_path || null,
    native: true,
  };
}

function processSubagentStartHook(input = {}) {
  const agentId = getAgentId(input);

  if (!agentId) return {};

  let role = loadRole(agentId);
  if (!role) {
    const nativeRole = nativeTaskRoleFromInput(input, agentId);
    if (nativeRole && saveRole(agentId, nativeRole)) {
      role = nativeRole;
    }
  }
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
      const result = processSubagentStartHook(input);
      process.stdout.write(JSON.stringify(result));
    }

    // Determine role for exit-code logic
    const agentId = getAgentId(input);
    if (agentId) {
      const role = loadRole(agentId);
      roleType = role?.type || null;
    }
  } catch (err) {
    // Error handling is role-aware:
    // - Advocate: fail-closed (deny)
    // - Queen/other: fail-open (allow)
    const agentId = getAgentId(input);
    if (agentId) {
      try {
        for (const roleFile of roleFileReadCandidates(agentId)) {
          if (!roleFile || !fs.existsSync(roleFile)) continue;
          const raw = JSON.parse(fs.readFileSync(roleFile, 'utf8'));
          if (!verifyRoleHmac(raw)) { roleType = null; continue; } // tampered — try next
          roleType = raw?.state?.type || null;
          if (roleType) break;
        }
      } catch {
        // Can't determine role — default fail-open
      }
    }

    if (roleType === 'advocate' || roleType === 'enforcer') {
      // Advocate / enforcer: fail-closed (structural governance roles)
      process.stdout.write(JSON.stringify(makeDeny(
        '[ROLE ENFORCEMENT ERROR] Internal error in role-enforcement hook. Tool blocked for governance safety.'
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
  ENFORCER_DENIED,
  WORK_TOOLS,
  QUEEN_WORK_TOOLS,
  ADVOCATE_IDENTITY_TEXT,
  QUEEN_IDENTITY_TEXT,
  ENFORCER_IDENTITY_TEXT,
  sanitizeId,
  getHookAgentId,
  getAgentId,
  isDevOverrideActive,
  isRootSessionForDevOverride,
  verifyDevOverrideRootToken,
  getRoleFilePath,
  loadRole,
  loadQueenHive,
  analyzeHiveDelegation,
  saveRole,
  nativeTaskRoleFromInput,
  incrementDirectWorkCount,
  getOrCreateHmacKey,
  verifyRoleHmac,
  verifySpawnToken,
  makeAllow,
  makeDeny,
  makeHookOutput,
  isCompactionRecoveryAckCommand,
  enforceAdvocateRole,
  enforceEnforcerRole,
  enforceQueenRole,
  processPreToolUse,
  processSubagentStartHook,
  processSubagentStart,
};
