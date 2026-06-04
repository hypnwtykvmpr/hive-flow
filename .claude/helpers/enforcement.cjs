#!/usr/bin/env node
/**
 * Enforcement System — Layer 1: Deterministic Hook Enforcement
 *
 * Prevents agents from cutting corners by implementing:
 * - Escalation ladder (Normal -> Warned -> Restricted -> Halted)
 * - Circumvention detection (protected paths, obfuscation, Bash redirects, git ops, env manipulation)
 * - Tool restriction groups (exec, write, fetch)
 * - Verification gate enforcement (blocks commits without verification in swarm mode)
 * - Hang detection (5 consecutive denials)
 * - HMAC-SHA256 state integrity
 * - Human-only reset (/enforcement-reset, /terminate-agent)
 *
 * Runs as a PreToolUse hook. No LLM required — purely deterministic.
 * All state is file-based for persistence across compaction.
 *
 * State files:
 *   .hive-flow/enforcement/state.json           — HMAC-signed escalation state
 *   .hive-flow/enforcement/violations.jsonl      — append-only violation log
 *   .hive-flow/enforcement/verification-gate.json — verification gate status (HMAC-signed)
 *   .hive-flow/enforcement/.hmac-key             — per-installation HMAC secret (mode 0o600)
 *
 * Output format: Claude Code PreToolUse protocol
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow'|'deny', permissionDecisionReason: '...' } }
 */
const fs = require('fs');
const path = require('path');
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

// Resolve PROJECT_DIR from the shared policy resolver. Hook-child env is trusted
// because agent Bash exports do not mutate Claude Code's hook process env; the
// lexical export detector below still blocks attempts to spoof it in commands.
const PROJECT_DIR = protectedPathPolicy.resolveProjectRoot({
  env: process.env,
  cwd: path.resolve(__dirname, '..', '..'),
  fallbackRoot: process.cwd(),
});
const ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');
const STATE_FILE = path.join(ENFORCEMENT_DIR, 'state.json');
const VIOLATIONS_FILE = path.join(ENFORCEMENT_DIR, 'violations.jsonl');
const VERIFICATION_GATE_FILE = path.join(ENFORCEMENT_DIR, 'verification-gate.json');
const HMAC_KEY_FILE = path.join(ENFORCEMENT_DIR, '.hmac-key');
const SETTINGS_PRESETS_FILE = path.join(ENFORCEMENT_DIR, 'settings-presets.json');
const SETTINGS_PRESET_VERSION = 2;
const COMPACTION_LOCK_FILE = path.join(ENFORCEMENT_DIR, 'compaction-lock.json');
const PIPELINE_STATE_FILE = path.join(ENFORCEMENT_DIR, 'pipeline-state.json');
const MAX_STATE_SIZE = 10240; // 10KB — larger = likely corrupt/attack (12.12)
const MAX_HISTORY = 50;
const HUNG_THRESHOLD = 5;
const GATE_MAX_AGE_MS = 3600000; // 1 hour
const MAX_CONSECUTIVE_READ_ERRORS = 3; // 12.11: DoS mitigation

// ============================================================================
// Escalation Levels
// ============================================================================

const LEVELS = {
  NORMAL: 0,
  WARNED: 1,
  RESTRICTED: 2,
  HALTED: 3,
};

// Tool restriction groups
const TOOL_GROUPS = {
  exec: ['Bash'],
  write: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__move_file', 'mcp__filesystem__rename_file', 'mcp__filesystem__copy_file', 'mcp__filesystem__create_directory', 'mcp__filesystem__delete_file'], // 12.6: NotebookEdit added, create_directory + delete_file added
  fetch: ['WebFetch'],
};

// Tools that are NEVER restricted (read-only + communication)
const UNRESTRICTED_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode',
  'SendMessage', // 12.5: must be unrestricted for team coordination
]);

// Protected paths — writes to these are circumvention attempts
const PROTECTED_PATHS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/helpers/',
  '.git/info/exclude',
  '.hive-flow/enforcement/',
  '.hive-flow/workflows/', // Band 3: protect workflow/phase state from agent tampering
];

// Protected path patterns for compiled output (12.10)
const PROTECTED_PATH_PATTERNS = [
  /v3\/@hive-flow\/cli\/src\/permission-guard\//,
  /v3\/@hive-flow\/cli\/dist\/src\/permission-guard\//,
  /v3\/@hive-flow\/cli\/dist\/src\/mcp-tools\//,
  /(?:^|\/)\.hive-flow\/permission-guard\//,
  /(?:^|\/)scripts\/permission-guard-setup\.mjs$/,
  /(?:^|\/)scripts\/install-enforcement\.mjs$/,
];

// ============================================================================
// HMAC State Integrity (Bug 7 + 12.3)
// ============================================================================

function getOrCreateHmacKey() {
  try {
    if (fs.existsSync(HMAC_KEY_FILE)) {
      return fs.readFileSync(HMAC_KEY_FILE, 'utf8').trim();
    }
  } catch {
    // Fall through to create new key
  }
  const key = crypto.randomBytes(32).toString('hex');
  try {
    ensureDir();
    fs.writeFileSync(HMAC_KEY_FILE, key, { mode: 0o600 });
  } catch {
    // If we can't write the key file, use ephemeral key (will re-create next time)
  }
  return key;
}

function computeHmac(data) {
  const key = getOrCreateHmacKey();
  return crypto.createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
}

function signState(state) {
  const hmac = computeHmac(state);
  return { state, hmac };
}

function verifyState(envelope) {
  if (!envelope || typeof envelope !== 'object') return { valid: false, state: null };

  // SEC-027: Unsigned state rejected — no legacy migration path
  if (!envelope.hmac) {
    return { valid: false, reason: 'unsigned-state-rejected' };
  }

  if (!envelope.state || !envelope.hmac) return { valid: false, state: null };

  const expected = computeHmac(envelope.state);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(envelope.hmac, 'hex');

  // BUG-γ-006: Mismatched buffer lengths cause RangeError in timingSafeEqual
  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, state: null };
  }

  const valid = crypto.timingSafeEqual(expectedBuf, actualBuf);
  return { valid, state: valid ? envelope.state : null };
}

// ============================================================================
// State Management
// ============================================================================

let _readErrorCount = 0;

function ensureDir(dir) {
  try { fs.mkdirSync(dir || ENFORCEMENT_DIR, { recursive: true }); } catch {}
}

function sanitizeScopeId(id, fallback = '') {
  return protectedPathPolicy.sanitizeScopeId(id, fallback, 64);
}

function getProjectScopeId() {
  return `project-${crypto.createHash('sha256').update(PROJECT_DIR).digest('hex').slice(0, 16)}`;
}

function getHookAgentId(input) {
  const hookAgentId = input?.agent_id || input?.agentId || null;
  return sanitizeScopeId(hookAgentId);
}

// Per-agent state isolation (WP-60)
function getAgentId(input = null) {
  return sanitizeScopeId(process.env.AGENTIC_FLOW_AGENT_ID || '')
    || getHookAgentId(input)
    || sanitizeScopeId(process.env.CLAUDE_AGENT_ID || '')
    || null;
}

function getStateFile(agentId) {
  if (!agentId) return STATE_FILE;
  // Sanitize agentId: reject path traversal attempts
  const sanitized = sanitizeScopeId(agentId);
  if (!sanitized) return STATE_FILE;
  return path.join(ENFORCEMENT_DIR, 'agents', sanitized, 'state.json');
}

function getScopedStateFile(scopeType, scopeId) {
  if (scopeType === 'global') return STATE_FILE;
  const fallback = scopeType === 'project' ? getProjectScopeId() : '';
  const sanitized = sanitizeScopeId(scopeId, fallback);
  if (!sanitized) return STATE_FILE;
  if (scopeType === 'agent') return path.join(ENFORCEMENT_DIR, 'agents', sanitized, 'state.json');
  if (scopeType === 'hive') return path.join(ENFORCEMENT_DIR, 'hives', sanitized, 'state.json');
  if (scopeType === 'session') return path.join(ENFORCEMENT_DIR, 'sessions', sanitized, 'state.json');
  if (scopeType === 'project') return path.join(ENFORCEMENT_DIR, 'projects', sanitized, 'state.json');
  return STATE_FILE;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    // 12.12: File size check — prevent I/O flooding
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_STATE_SIZE) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  // Bug 3: PID-scoped temp file to prevent concurrent clobber
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function freshState() {
  return {
    level: LEVELS.NORMAL,
    violations: 0,
    consecutiveDenials: 0,
    lastActivity: new Date().toISOString(),
    restrictedGroups: [],
    history: [],
    resetAt: null,
    integrityCompromised: false,
  };
}

function getScopedState(scopeType = 'global', scopeId = null) {
  const stateFile = getScopedStateFile(scopeType, scopeId);
  ensureDir(path.dirname(stateFile));
  if (!fs.existsSync(stateFile)) {
    return { state: freshState(), scopeType, scopeId, tampered: false };
  }
  const raw = readJson(stateFile);

  if (raw === null) {
    _readErrorCount++;
    // 12.11: After N consecutive read errors, create fresh state at WARNED minimum
    if (_readErrorCount >= MAX_CONSECUTIVE_READ_ERRORS) {
      const state = freshState();
      state.level = LEVELS.WARNED;
      state.integrityCompromised = true;
      _readErrorCount = 0;
      saveScopedState(scopeType, scopeId, state);
      return { state, scopeType, scopeId, tampered: true };
    }
    return { state: freshState(), scopeType, scopeId, tampered: false };
  }

  _readErrorCount = 0;

  const { valid, state } = verifyState(raw);

  if (valid && state) {
    return { state, scopeType, scopeId, tampered: false };
  }

  // HMAC verification failed — state was tampered
  // Escalate to WARNED minimum, flag integrity compromise
  const tampered = freshState();
  tampered.level = LEVELS.WARNED;
  tampered.integrityCompromised = true;
  tampered.violations = 1;
  tampered.history.push({
    ts: new Date().toISOString(),
    from: LEVELS.NORMAL,
    to: LEVELS.WARNED,
    reason: 'State integrity check failed (HMAC mismatch)',
    severity: 'critical',
  });
  appendViolation({
    type: 'integrity-failure',
    reason: 'state.json HMAC verification failed',
  });
  appendViolation({
    type: 'reconciliation',
    reason: 'state-replaced',
    scopeType,
    scopeId: scopeId || scopeType,
    action: 'fresh-state-created',
  });
  saveScopedState(scopeType, scopeId, tampered);
  if (scopeType !== 'global') {
    const globalState = getScopedState('global').state;
    escalateState(globalState, `Scoped ${scopeType} state integrity check failed (HMAC mismatch)`, 'critical', {
      scopeType: 'global',
      scopeId: 'global',
      cascadedFrom: `${scopeType}/${scopeId || ''}`,
      integrityAttack: true,
    });
    saveScopedState('global', 'global', globalState);
  }
  return { state: tampered, scopeType, scopeId, tampered: true };
}

function saveScopedState(scopeType = 'global', scopeId = null, state) {
  const stateFile = getScopedStateFile(scopeType, scopeId);
  ensureDir(path.dirname(stateFile));
  state.lastActivity = new Date().toISOString();
  const envelope = signState(state);
  writeJsonAtomic(stateFile, envelope);
}

function getState(agentId) {
  if (agentId) return getScopedState('agent', agentId).state;
  return getScopedState('global', 'global').state;
}

function saveState(state, agentId) {
  if (agentId) return saveScopedState('agent', agentId, state);
  return saveScopedState('global', 'global', state);
}

function rotateJSONL(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    if (fs.statSync(filePath).size < 5 * 1024 * 1024) return;
    const bak = filePath.replace(/\.jsonl$/, '.1.jsonl');
    try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch {}
    fs.renameSync(filePath, bak);
  } catch {}
}

function appendViolation(violation) {
  ensureDir();
  try {
    rotateJSONL(VIOLATIONS_FILE);
    fs.appendFileSync(VIOLATIONS_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      ...violation,
    }) + '\n', 'utf8');
  } catch {
    // Never block on logging failures.
  }
}

// ============================================================================
// Escalation Logic
// ============================================================================

function escalationScopeLabel(scopeType, scopeId) {
  if (!scopeType || scopeType === 'global') return 'global';
  return `${scopeType}/${scopeId || 'unknown'}`;
}

function escalateState(state, reason, severity, metadata = {}) {
  const prevLevel = state.level;

  if (severity === 'critical') {
    // Critical: jump to at least RESTRICTED
    state.level = Math.max(state.level, LEVELS.RESTRICTED);
    // Cascading: if already RESTRICTED, go to HALTED
    if (prevLevel >= LEVELS.RESTRICTED) {
      state.level = LEVELS.HALTED;
    }
  } else if (state.level === LEVELS.NORMAL) {
    state.level = LEVELS.WARNED;
  } else if (state.level === LEVELS.WARNED) {
    state.level = LEVELS.RESTRICTED;
  } else if (state.level === LEVELS.RESTRICTED) {
    state.level = LEVELS.HALTED;
  }

  // E3: Backfill restrictedGroups when reaching RESTRICTED with empty groups
  if (state.level >= LEVELS.RESTRICTED && (!state.restrictedGroups || state.restrictedGroups.length === 0)) {
    state.restrictedGroups = ['exec', 'write'];
  }

  state.violations++;
  state.history.push({
    ts: new Date().toISOString(),
    from: prevLevel,
    to: state.level,
    reason,
    severity,
  });

  // Keep history bounded
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }

  appendViolation({
    type: 'escalation',
    from: prevLevel,
    to: state.level,
    reason,
    severity,
    ...metadata,
  });

  return state;
}

function escalate(state, reason, severity) {
  return escalateState(state, reason, severity, { scopeType: 'legacy', scopeId: 'legacy' });
}

function loadRoleForAgent(agentId) {
  const safeAgentId = sanitizeScopeId(agentId);
  if (!safeAgentId) return null;
  try {
    const roleFile = path.join(ENFORCEMENT_DIR, 'agents', safeAgentId, 'role.json');
    if (!fs.existsSync(roleFile)) return null;
    const raw = readJson(roleFile);
    if (!raw) return null;
    const { valid, state } = verifyState(raw);
    return valid && state ? state : null;
  } catch {
    return null;
  }
}

function verifySpawnToken(agentId) {
  try {
    const storePath = path.join(PROJECT_DIR, '.hive-flow', 'agents', 'store.json');
    if (!fs.existsSync(storePath)) return { valid: true, reason: 'no store file' };
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const agent = store?.agents?.[agentId];
    if (!agent) return { valid: true, reason: 'agent not in store' };
    const storedToken = agent?.config?._spawnToken;
    if (!storedToken) return { valid: false, reason: 'missing stored token' };
    const candidateToken = process.env.HIVE_FLOW_AGENT_TOKEN;
    if (!candidateToken) return { valid: false, reason: 'missing env token' };
    const storedBuf = Buffer.from(String(storedToken));
    const candidateBuf = Buffer.from(String(candidateToken));
    if (storedBuf.length !== candidateBuf.length) return { valid: false, reason: 'token length mismatch' };
    if (!crypto.timingSafeEqual(storedBuf, candidateBuf)) return { valid: false, reason: 'token mismatch' };
    return { valid: true, reason: 'token verified' };
  } catch (err) {
    return { valid: false, reason: `token check exception: ${err.message}` };
  }
}

function resolveScopeContext(input = null) {
  const agentId = getAgentId(input);
  const tokenResult = agentId ? verifySpawnToken(agentId) : { valid: true, reason: 'no agent id' };
  const identityTrusted = Boolean(agentId && tokenResult.valid);
  const role = identityTrusted ? loadRoleForAgent(agentId) : null;
  const envHiveId = sanitizeScopeId(process.env.HIVE_FLOW_HIVE_ID || '');
  const roleHiveId = sanitizeScopeId(role?.hiveId || '');
  const hiveId = identityTrusted ? (envHiveId || roleHiveId || null) : null;

  return {
    agentId: agentId || null,
    hiveId,
    projectId: getProjectScopeId(),
    actorKind: identityTrusted ? 'agent' : (agentId ? 'unknown' : 'coordinator'),
    identityTrusted,
    identityReason: tokenResult.reason,
    role,
  };
}

function loadEffectiveState(ctx) {
  const scopes = [];
  if (ctx.identityTrusted && ctx.agentId) {
    scopes.push({ scopeType: 'agent', scopeId: ctx.agentId });
  }
  if (ctx.hiveId) {
    scopes.push({ scopeType: 'hive', scopeId: ctx.hiveId });
  }
  scopes.push({ scopeType: 'project', scopeId: ctx.projectId });
  scopes.push({ scopeType: 'global', scopeId: 'global' });

  const loaded = scopes.map(scope => {
    const result = getScopedState(scope.scopeType, scope.scopeId);
    return { ...scope, state: result.state, tampered: result.tampered };
  });

  let effective = loaded[0];
  for (const candidate of loaded.slice(1)) {
    if (candidate.state.level > effective.state.level) {
      effective = candidate;
    }
  }

  return { scopes: loaded, effective };
}

function countRestrictedAgentsForHive(hiveId) {
  const safeHiveId = sanitizeScopeId(hiveId);
  if (!safeHiveId) return 0;
  const agentsDir = path.join(ENFORCEMENT_DIR, 'agents');
  let count = 0;
  try {
    for (const agentDir of fs.readdirSync(agentsDir)) {
      const role = loadRoleForAgent(agentDir);
      if (!role || sanitizeScopeId(role.hiveId || '') !== safeHiveId) continue;
      const state = getScopedState('agent', agentDir).state;
      if (state.level >= LEVELS.RESTRICTED) count++;
    }
  } catch {}
  return count;
}

function countRestrictedHives() {
  const hivesDir = path.join(ENFORCEMENT_DIR, 'hives');
  let count = 0;
  try {
    for (const hiveDir of fs.readdirSync(hivesDir)) {
      const state = getScopedState('hive', hiveDir).state;
      if (state.level >= LEVELS.RESTRICTED) count++;
    }
  } catch {}
  return count;
}

function forceRestricted(state, reason, metadata = {}) {
  const prevLevel = state.level;
  state.level = Math.max(state.level, LEVELS.RESTRICTED);
  if (state.level >= LEVELS.RESTRICTED && (!state.restrictedGroups || state.restrictedGroups.length === 0)) {
    state.restrictedGroups = ['exec', 'write'];
  }
  state.violations++;
  state.history.push({
    ts: new Date().toISOString(),
    from: prevLevel,
    to: state.level,
    reason,
    severity: 'critical',
  });
  if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
  appendViolation({ type: 'cascade', from: prevLevel, to: state.level, reason, ...metadata });
  return state;
}

function chooseEscalationScope(ctx, violation) {
  if (ctx.identityTrusted && ctx.agentId) {
    return { scopeType: 'agent', scopeId: ctx.agentId };
  }
  if (violation.protectedEnforcementAttack || violation.integrityAttack || violation.systemic) {
    return { scopeType: 'global', scopeId: 'global' };
  }
  if (ctx.hiveId) {
    return { scopeType: 'hive', scopeId: ctx.hiveId };
  }
  return { scopeType: 'project', scopeId: ctx.projectId };
}

function escalateScoped(ctx, violation) {
  const target = chooseEscalationScope(ctx, violation);
  const targetState = getScopedState(target.scopeType, target.scopeId).state;
  escalateState(targetState, violation.reason, violation.severity || 'normal', {
    scopeType: target.scopeType,
    scopeId: target.scopeId,
    agentId: ctx.agentId,
    hiveId: ctx.hiveId,
    projectId: ctx.projectId,
    protectedEnforcementAttack: violation.protectedEnforcementAttack === true,
    integrityAttack: violation.integrityAttack === true,
    systemic: violation.systemic === true,
  });
  targetState.restrictedGroups = [...new Set([
    ...(targetState.restrictedGroups || []),
    ...(violation.restrictionGroups || []),
  ])];
  saveScopedState(target.scopeType, target.scopeId, targetState);

  if (target.scopeType === 'agent' && ctx.hiveId && targetState.level >= LEVELS.RESTRICTED) {
    const restrictedAgents = countRestrictedAgentsForHive(ctx.hiveId);
    if (restrictedAgents >= 2) {
      const hiveState = getScopedState('hive', ctx.hiveId).state;
      forceRestricted(hiveState, `Hive cascade: ${restrictedAgents} restricted agents in hive ${ctx.hiveId}`, {
        scopeType: 'hive',
        scopeId: ctx.hiveId,
        cascadedFrom: `agent/${target.scopeId}`,
        restrictedAgents,
      });
      saveScopedState('hive', ctx.hiveId, hiveState);
    }
  }

  if ((target.scopeType === 'agent' || target.scopeType === 'hive') && countRestrictedHives() >= 2) {
    const restrictedHives = countRestrictedHives();
    const projectState = getScopedState('project', ctx.projectId).state;
    forceRestricted(projectState, `Project cascade: ${restrictedHives} restricted hives`, {
      scopeType: 'project',
      scopeId: ctx.projectId,
      cascadedFrom: `${target.scopeType}/${target.scopeId}`,
      restrictedHives,
    });
    saveScopedState('project', ctx.projectId, projectState);
  }

  return { state: targetState, scopeType: target.scopeType, scopeId: target.scopeId };
}

// ============================================================================
// Path Resolution (Bug 2: Symlink bypass defense)
// ============================================================================

function resolveFilePath(filePath) {
  if (!filePath) return '';
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_DIR, filePath);
  try {
    // Resolve symlinks to catch symlink-based bypasses
    return fs.realpathSync(absolute);
  } catch {
    // File might not exist (dangling symlink or not-yet-created file)
    // For symlinks: resolve the link target path even if target is missing
    try {
      const target = fs.readlinkSync(absolute);
      const targetAbsolute = path.isAbsolute(target) ? target : path.resolve(path.dirname(absolute), target);
      return targetAbsolute;
    } catch { /* not a symlink */ }
    // Fallback: resolve parent directory
    try {
      const dir = fs.realpathSync(path.dirname(absolute));
      return path.join(dir, path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

function casefoldPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

function projectRelativePath(filePath) {
  const resolved = resolveFilePath(filePath);
  const resolvedFolded = casefoldPath(resolved);
  const projectFolded = casefoldPath(PROJECT_DIR);
  return resolvedFolded === projectFolded
    ? ''
    : resolvedFolded.startsWith(projectFolded + '/')
    ? resolved.slice(PROJECT_DIR.length + 1)
    : filePath;
}

function getProtectedPathScope(filePath) {
  return protectedPathPolicy.getProtectedWriteScope(filePath, PROJECT_DIR);
}

function isProtectedPath(filePath) {
  return getProtectedPathScope(filePath) !== null;
}

function isGlobalProtectedPath(filePath) {
  return getProtectedPathScope(filePath) === 'global';
}

function isEnforcementSubstratePath(filePath) {
  if (!filePath) return false;
  if (isEnforcementHmacKeyPath(filePath)) return true;
  if (isDevOverrideFloorPath(filePath)) return true;
  if (protectedPathPolicy.isGuardedSettingsPath(filePath, PROJECT_DIR)) return true;
  const relative = projectRelativePath(filePath);
  return /^\.claude\/helpers\/.*\.(?:cjs|mjs)$/i.test(casefoldPath(relative));
}

function protectedMutationDecision(filePath, action = 'write to protected path') {
  const substrate = isEnforcementSubstratePath(filePath);
  const globalProtected = isGlobalProtectedPath(filePath);
  const escalates = substrate || globalProtected;
  const guidance = substrate
    ? 'This targets the enforcement substrate and requires direct human/Codex control-plane approval.'
    : globalProtected
    ? 'This targets a global enforcement-protected path and requires direct human/Codex control-plane approval.'
    : 'Use the gated project workflow for this file or ask the human to approve the protected-path change.';
  return {
    circumvention: true,
    denyOnly: !escalates,
    reason: `CIRCUMVENTION: Attempted ${action}: ${filePath}. ${guidance}`,
    severity: escalates ? 'critical' : 'normal',
    protectedEnforcementAttack: substrate,
    systemic: substrate,
  };
}

function isEnforcementHmacKeyPath(filePath) {
  return protectedPathPolicy.isHmacKeyPath(filePath, PROJECT_DIR);
}

function isInProjectPath(filePath) {
  if (!filePath) return false;
  const resolvedFolded = casefoldPath(resolveFilePath(filePath));
  const projectFolded = casefoldPath(PROJECT_DIR);
  return resolvedFolded === projectFolded || resolvedFolded.startsWith(projectFolded + '/');
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
    hmacKeyProvider: getOrCreateHmacKey,
  });
}

function isRootSessionForDevOverride(input = null) {
  return verifyDevOverrideRootToken(input);
}

function isDevOverrideFloorPath(filePath) {
  return protectedPathPolicy.isDevOverrideFloorPath(filePath, PROJECT_DIR);
}

function collectProtectedMutationPaths(toolName, toolInput) {
  const entries = [];
  const pushIfProtected = (kind, filePath) => {
    if (filePath && isProtectedPath(filePath)) entries.push({ kind, filePath });
  };

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__delete_file'].includes(toolName)) {
    pushIfProtected('write', toolInput?.file_path || toolInput?.notebook_path || toolInput?.path || toolInput?.destination || '');
  } else if (['mcp__filesystem__move_file', 'mcp__filesystem__rename_file', 'mcp__filesystem__copy_file'].includes(toolName)) {
    pushIfProtected('source', toolInput?.source || '');
    pushIfProtected('write', toolInput?.destination || toolInput?.dest || toolInput?.target || '');
  } else if (toolName === 'mcp__filesystem__create_directory') {
    pushIfProtected('write', toolInput?.path || '');
  } else if (toolName === 'Bash') {
    const bashMutationTarget = findProtectedBashMutationTarget(toolInput?.command || '');
    pushIfProtected('write', bashMutationTarget);
  }

  return entries;
}

function getMcpDestinationPath(toolInput) {
  return toolInput?.destination || toolInput?.dest || toolInput?.target || '';
}

function getWriteRestrictionTargets(toolName, toolInput) {
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
    return [toolInput?.file_path || ''];
  }
  if (toolName === 'NotebookEdit') {
    return [toolInput?.notebook_path || toolInput?.file_path || ''];
  }
  if (['mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__delete_file', 'mcp__filesystem__create_directory'].includes(toolName)) {
    return [toolInput?.path || ''];
  }
  if (['mcp__filesystem__move_file', 'mcp__filesystem__rename_file', 'mcp__filesystem__copy_file'].includes(toolName)) {
    return [getMcpDestinationPath(toolInput)];
  }
  return [];
}

function evaluateRestrictedWriteTarget(filePath) {
  if (!filePath) {
    return { allowed: false, reason: 'write target is missing or ambiguous' };
  }
  if (isProtectedPath(filePath)) {
    return { allowed: false, reason: `write target is a protected path: ${projectRelativePath(filePath)}` };
  }
  if (!isInProjectPath(filePath)) {
    return { allowed: false, reason: `write target is outside project: ${filePath}` };
  }
  return { allowed: true };
}

function restrictedWriteAllowed(toolName, toolInput, scope) {
  if (!scope || scope.scopeType === 'agent') {
    return { allowed: false, reason: null };
  }
  const targets = getWriteRestrictionTargets(toolName, toolInput);
  if (targets.length === 0) {
    return { allowed: false, reason: null };
  }
  for (const target of targets) {
    const result = evaluateRestrictedWriteTarget(target);
    if (!result.allowed) return result;
  }
  return { allowed: true };
}

function canDevOverrideBypassCircumvention(input, toolName, toolInput, violation) {
  if (!violation?.circumvention) return false;
  if (!isRootSessionForDevOverride(input) || !isDevOverrideActive()) return false;
  if (findEnforcementHmacKeyReadTarget(toolName, toolInput)) return false;

  const protectedPaths = collectProtectedMutationPaths(toolName, toolInput);
  if (protectedPaths.length === 0) return false;
  if (protectedPaths.some(entry => entry.kind !== 'write')) return false;
  for (const entry of protectedPaths) {
    if (isGuardedSettingsPath(entry.filePath)) {
      const projected = projectedContentAfterWrite(toolName, toolInput, entry.filePath);
      if (!guardSettingsContent(projected)) return false;
    }
  }
  return protectedPaths.every(entry => !isDevOverrideFloorPath(entry.filePath));
}

function isGuardedSettingsPath(filePath) {
  return protectedPathPolicy.isGuardedSettingsPath(filePath, PROJECT_DIR);
}

function loadSignedSettingsPresets() {
  try {
    if (!fs.existsSync(SETTINGS_PRESETS_FILE)) return null;
    const stats = fs.statSync(SETTINGS_PRESETS_FILE);
    if (stats.size > 256 * 1024) return null;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PRESETS_FILE, 'utf8'));
    const { valid, state } = verifyState(raw);
    if (!valid || !state || typeof state !== 'object') return null;
    const entries = Array.isArray(state.entries) ? state.entries : [];
    if (entries.length === 0) return null;
    if (state.version !== SETTINGS_PRESET_VERSION) return null;
    return {
      version: state.version,
      entries,
      baselineAllow: Array.isArray(state.baselineAllow) ? state.baselineAllow : [],
    };
  } catch {
    return null;
  }
}

function projectedContentAfterWrite(toolName, toolInput, filePath) {
  const content = toolInput?.content;
  if (['Write', 'mcp__filesystem__write_file'].includes(toolName)) {
    return typeof content === 'string' ? content : null;
  }

  if (['Edit', 'mcp__filesystem__edit_file'].includes(toolName)) {
    const oldText = typeof toolInput?.old_string === 'string' ? toolInput.old_string : toolInput?.old_text;
    const newText = typeof toolInput?.new_string === 'string' ? toolInput.new_string : toolInput?.new_text;
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
    try {
      const current = fs.readFileSync(resolveFilePath(filePath), 'utf8');
      if (!current.includes(oldText)) return null;
      return current.replace(oldText, newText);
    } catch {
      return null;
    }
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput?.edits) ? toolInput.edits : [];
    if (edits.length === 0) return null;
    try {
      let current = fs.readFileSync(resolveFilePath(filePath), 'utf8');
      for (const edit of edits) {
        const oldText = edit?.old_string;
        const newText = edit?.new_string;
        if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
        if (!current.includes(oldText)) return null;
        current = current.replace(oldText, newText);
      }
      return current;
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeHookCommand(command) {
  return String(command || '')
    .replace(/\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}/g, PROJECT_DIR)
    .replace(/\s+/g, ' ')
    .trim();
}

function collectHookEntries(settings) {
  const entries = new Set();
  const hooks = settings && typeof settings === 'object' ? settings.hooks : null;
  if (!hooks || typeof hooks !== 'object') return entries;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = typeof group?.matcher === 'string' ? group.matcher : '';
      const commands = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const hook of commands) {
        if (hook?.type === 'command' && typeof hook.command === 'string') {
          entries.add(`${event}\0${matcher}\0${normalizeHookCommand(hook.command)}`);
        }
      }
    }
  }
  return entries;
}

function containsAllPresetEntries(settings, presets) {
  const actual = collectHookEntries(settings);
  for (const entry of presets.entries) {
    const event = typeof entry?.event === 'string' ? entry.event : 'PreToolUse';
    const matcher = typeof entry?.matcher === 'string' ? entry.matcher : '';
    const command = typeof entry?.command === 'string' ? entry.command : '';
    if (!command) return false;
    if (!actual.has(`${event}\0${matcher}\0${normalizeHookCommand(command)}`)) return false;
  }
  return true;
}

function widensGovernanceAllow(settings, baselineAllow = []) {
  const allow = settings?.permissions && Array.isArray(settings.permissions.allow)
    ? settings.permissions.allow
    : [];
  const baseline = new Set(baselineAllow.map(entry => String(entry)));
  for (const entry of allow) {
    const value = String(entry);
    if (baseline.has(value)) continue;
    if (/^(Bash|Write|Edit|MultiEdit|NotebookEdit)(?:\(|$)/.test(value)) return true;
    if (/\.claude|\.hive-flow|\.git|\.env|permission-guard|hook-handler|enforcement\.cjs|role-enforcement\.cjs/i.test(value)) return true;
  }
  return false;
}

function guardSettingsContent(projected) {
  if (typeof projected !== 'string') return false;
  const presets = loadSignedSettingsPresets();
  if (!presets) return false;
  try {
    const parsed = JSON.parse(projected);
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.disableAllHooks === true) return false;
    if (!containsAllPresetEntries(parsed, presets)) return false;
    if (widensGovernanceAllow(parsed, presets.baselineAllow)) return false;
    return true;
  } catch {
    return false;
  }
}

function findEnforcementHmacKeyReadTarget(toolName, toolInput) {
  if (toolName === 'mcp__filesystem__read_multiple_files') {
    const paths = Array.isArray(toolInput?.paths) ? toolInput.paths : [];
    for (const entry of paths) {
      if (typeof entry === 'string' && protectedPathPolicy.findProtectedReadPath(entry, PROJECT_DIR)) return entry;
    }
    return null;
  }

  if (!['Read', 'NotebookRead', 'mcp__filesystem__read_file', 'mcp__filesystem__read_text_file', 'mcp__filesystem__read_media_file'].includes(toolName)) {
    return null;
  }
  const filePath = toolInput?.file_path || toolInput?.notebook_path || toolInput?.path || '';
  return protectedPathPolicy.findProtectedReadPath(filePath, PROJECT_DIR) ? filePath : null;
}

let _canonicalHookScripts = null;
function getCanonicalHookScripts() {
  if (_canonicalHookScripts) return _canonicalHookScripts;
  const scripts = new Set();
  try {
    const settingsPath = path.join(PROJECT_DIR, '.claude', 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const helperPattern = /\.claude\/helpers\/([^"'\s]+?\.(?:cjs|mjs))/g;
    let match;
    while ((match = helperPattern.exec(raw))) {
      scripts.add(match[1]);
    }
  } catch {}
  _canonicalHookScripts = scripts;
  return scripts;
}

function isCanonicalHookInvocation(command) {
  if (!command || /(?:pipeline-reset|enforcement-reset|reset-enforcement|enforcement\.cjs\s+--reset)/i.test(command)) {
    return false;
  }
  if (/[;&|<>`]/.test(command)) {
    return false;
  }
  const match = /(?:^|\s)node\s+((?:"[^"]+"\s*)?[^ \t\n;|&]*\.claude\/helpers\/[^ \t\n;|&]+?\.(?:cjs|mjs))/i.exec(command);
  if (!match) return false;
  const scriptToken = match[1] || '';
  const scriptName = path.basename(scriptToken);
  if (!getCanonicalHookScripts().has(scriptName)) return false;
  const normalized = scriptToken
    .replace(/\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\}/g, PROJECT_DIR)
    .replace(/["']/g, '')
    .replace(/\s+/g, '');
  const resolved = path.resolve(normalized);
  const helpersDir = path.join(PROJECT_DIR, '.claude', 'helpers');
  return resolved === path.join(helpersDir, scriptName) || resolved.startsWith(helpersDir + path.sep);
}

// ============================================================================
// Circumvention Detection
// ============================================================================

function stripShellQuotes(token) {
  const trimmed = String(token || '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function readShellToken(command, startIndex) {
  let i = startIndex;
  while (i < command.length && /\s/.test(command[i])) i++;
  let token = '';
  let quote = null;
  let quoted = false;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      token += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        token += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      token += ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      token += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(ch) || ch === '|' || ch === ';' || ch === '&' || ch === '<' || ch === '>') {
      break;
    }
    token += ch;
    i++;
  }
  const stripped = stripShellQuotes(token);
  return { token: stripped, text: stripped, raw: token, quoted, end: i };
}

function shellTokens(command) {
  const tokens = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i])) i++;
    if (i >= command.length) break;
    const ch = command[i];
    if (ch === '|' || ch === ';' || ch === '&') {
      const pair = command[i + 1] === ch ? ch + ch : ch;
      tokens.push({ text: pair, token: pair, raw: pair, quoted: false, operator: true });
      i += pair.length;
      continue;
    }
    const read = readShellToken(command, i);
    if (read.token) tokens.push({ text: read.token, token: read.token, raw: read.raw, quoted: read.quoted, operator: false });
    i = read.end > i ? read.end : i + 1;
  }
  return tokens;
}

function shellWords(command) {
  return shellTokens(command).map(token => token.text);
}

function isShellAssignmentToken(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token?.text || '');
}

function splitTokenSegments(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token.operator) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) segments.push(current);
  return segments;
}

function commandExecutionFromTokens(tokens) {
  let index = 0;
  while (index < tokens.length && !tokens[index].quoted && isShellAssignmentToken(tokens[index])) index++;
  if (!tokens[index]) return null;

  if (tokens[index].text === 'env') {
    index++;
    while (index < tokens.length) {
      const word = tokens[index].text || '';
      if (word === '--') {
        index++;
        break;
      }
      if (word.startsWith('-')) {
        index++;
        continue;
      }
      if (!tokens[index].quoted && isShellAssignmentToken(tokens[index])) {
        index++;
        continue;
      }
      break;
    }
  }

  if (tokens[index]?.text === 'command') index++;
  if (!tokens[index]) return null;
  return {
    command: tokens[index].text,
    commandToken: tokens[index],
    args: tokens.slice(index + 1).map(token => token.text),
    argTokens: tokens.slice(index + 1),
    tokens,
  };
}

function shellCommandBody(execution) {
  if (!execution || !/^(?:bash|sh|zsh|dash|ksh)$/.test(execution.command)) return null;
  for (let i = 0; i < execution.argTokens.length; i++) {
    const arg = execution.argTokens[i].text || '';
    if (arg === '-c' || (/^-[A-Za-z]+$/.test(arg) && arg.includes('c'))) {
      return execution.argTokens[i + 1]?.text || null;
    }
  }
  return null;
}

function collectShellCommandExecutions(command, depth = 0) {
  if (depth > 4) return [];
  const executions = [];
  for (const subCommand of splitShellSubcommands(String(command || ''))) {
    const tokens = shellTokens(subCommand);
    for (const segment of splitTokenSegments(tokens)) {
      const execution = commandExecutionFromTokens(segment);
      if (!execution) continue;
      executions.push({ ...execution, depth, subCommand: segment.map(token => token.raw).join(' ') });
      const body = shellCommandBody(execution);
      if (body) executions.push(...collectShellCommandExecutions(body, depth + 1));
    }
  }
  return executions;
}

function hasCommandPositionInvocation(command, predicate) {
  return collectShellCommandExecutions(command).some(execution => predicate(execution));
}

const INLINE_EVAL_DENIAL =
  'Inline code execution is blocked because file effects cannot be verified reliably. Instead: use Read, Write, or Edit for files; write a script file in the project and run it normally for programs.';

function commandBasename(command) {
  return String(command || '').replace(/\\/g, '/').split('/').pop() || String(command || '');
}

function isScriptInvocation(execution, scriptName) {
  if (!execution) return false;
  if (commandBasename(execution.command) === scriptName) return true;
  if (commandBasename(execution.command) !== 'node') return false;
  return execution.args.some(arg => commandBasename(arg) === scriptName);
}

function hasAnyArg(args, names) {
  return args.some(arg => names.includes(arg));
}

function hasNodeEvalArg(args) {
  return args.some(arg =>
    arg === '-e' ||
    arg === '--eval' ||
    arg === '-p' ||
    arg === '--print' ||
    (/^-[^-]/.test(arg) && arg.includes('e')) ||
    (/^-[^-]/.test(arg) && arg.includes('p'))
  );
}

function unseparatedArgs(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

function isInlineEvalCommand(command, args) {
  const base = commandBasename(command);
  const effectiveArgs = unseparatedArgs(args || []);

  if (base === 'node') return hasNodeEvalArg(effectiveArgs);
  if (/^(?:python|python3|python3\.\d+)$/.test(base)) return hasAnyArg(effectiveArgs, ['-c']);
  if (base === 'ruby') return hasAnyArg(effectiveArgs, ['-e', '-E']);
  if (base === 'perl') return hasAnyArg(effectiveArgs, ['-e', '-E']);
  if (base === 'deno') return effectiveArgs[0] === 'eval';
  if (base === 'bun') return hasAnyArg(effectiveArgs, ['-e']);
  if (base === 'php') return hasAnyArg(effectiveArgs, ['-r', '-R']);

  return false;
}

const RUNNER_OPTION_VALUE_FLAGS = new Set([
  '-C',
  '-p',
  '--cache',
  '--cwd',
  '--dir',
  '--filter',
  '--package',
  '--prefix',
  '--registry',
  '--userconfig',
  '--workspace',
]);

function skipRunnerOptions(args, startIndex) {
  let index = startIndex;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') {
      return index + 1;
    }
    if (RUNNER_OPTION_VALUE_FLAGS.has(arg)) {
      index += 2;
      continue;
    }
    if ([...RUNNER_OPTION_VALUE_FLAGS].some(flag => arg.startsWith(`${flag}=`))) {
      index++;
      continue;
    }
    if (arg.startsWith('-')) {
      index++;
      continue;
    }
    break;
  }
  return index;
}

function firstRunnerCommand(args, startIndex) {
  const index = skipRunnerOptions(args, startIndex);
  if (!args[index]) return null;
  return { command: args[index], args: args.slice(index + 1) };
}

function findRunnerSubcommand(args, subcommands) {
  let index = 0;
  while (index < args.length) {
    index = skipRunnerOptions(args, index);
    const arg = args[index];
    if (!arg) return null;
    if (subcommands.has(arg)) return index;
    if (arg.startsWith('-')) {
      index++;
      continue;
    }
    return null;
  }
  return null;
}

function isPackageRunnerInlineEval(command, args) {
  const base = commandBasename(command);

  if (base === 'npx') {
    const target = firstRunnerCommand(args || [], 0);
    return target ? isInlineEvalCommand(target.command, target.args) : false;
  }

  if (base === 'pnpm') {
    const subcommand = findRunnerSubcommand(args, new Set(['exec', 'dlx']));
    const target = subcommand === null ? null : firstRunnerCommand(args, subcommand + 1);
    return target ? isInlineEvalCommand(target.command, target.args) : false;
  }

  if (base === 'npm') {
    const subcommand = findRunnerSubcommand(args, new Set(['exec']));
    const target = subcommand === null ? null : firstRunnerCommand(args, subcommand + 1);
    return target ? isInlineEvalCommand(target.command, target.args) : false;
  }

  if (base === 'yarn') {
    const target = firstRunnerCommand(args || [], 0);
    return target ? isInlineEvalCommand(target.command, target.args) : false;
  }

  return false;
}

function isInlineEvalExecution(execution) {
  const command = commandBasename(execution?.command || '');
  const args = execution?.args || [];
  return isInlineEvalCommand(command, args) || isPackageRunnerInlineEval(command, args);
}

function findInlineEvalInvocation(command) {
  return collectShellCommandExecutions(command).find(isInlineEvalExecution) || null;
}

const ROOT_SPOOF_ENV_VARS = new Set(['CLAUDE_PROJECT_DIR', 'HIVE_FLOW_PROJECT_ROOT']);
const GATE_BYPASS_ENV_VARS = new Set(['CF_WF_7D', 'HIVE_FLOW_ENFORCEMENT_DISABLED', 'HIVE_FLOW_PIPELINE_OVERRIDE']);

function assignmentName(token) {
  const match = String(token?.text || '').match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
  return match ? match[1] : null;
}

function findEnforcementEnvManipulation(command) {
  for (const subCommand of splitShellSubcommands(String(command || ''))) {
    for (const segment of splitTokenSegments(shellTokens(subCommand))) {
      if (!segment.length) continue;

      if (segment[0].text === 'export') {
        for (const token of segment.slice(1)) {
          const name = assignmentName(token);
          if (name && (ROOT_SPOOF_ENV_VARS.has(name) || GATE_BYPASS_ENV_VARS.has(name))) {
            return { name, kind: 'export' };
          }
        }
      }

      let index = 0;
      if (segment[index]?.text === 'env') index++;
      while (index < segment.length) {
        const token = segment[index];
        if (!token || token.quoted) break;
        if (token.text === '--') {
          index++;
          break;
        }
        if (token.text.startsWith('-')) {
          index++;
          continue;
        }
        const name = assignmentName(token);
        if (!name) break;
        if (GATE_BYPASS_ENV_VARS.has(name)) return { name, kind: 'inline' };
        index++;
      }
    }
  }
  return null;
}

function extractRedirectTargets(command) {
  const targets = [];
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '<' && command[i + 1] === '<') {
      const delimiter = readShellToken(command, i + 2);
      i = delimiter.end;
      continue;
    }
    if (ch !== '>' && !(ch === '&' && command[i + 1] === '>')) {
      continue;
    }

    let targetStart = i + 1;
    if (ch === '&') targetStart = i + 2;
    if (command[targetStart] === '>') targetStart++;

    const target = readShellToken(command, targetStart).token;
    if (!target || target.startsWith('&')) {
      i = targetStart;
      continue;
    }
    targets.push(target);
    i = targetStart;
  }
  return targets;
}

function extractTeeTargets(command) {
  const targets = [];
  const words = shellWords(command);
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'tee') continue;
    for (let j = i + 1; j < words.length; j++) {
      const word = words[j];
      if (word === '|' || word === ';' || word === '&') break;
      if (!word || word.startsWith('-')) continue;
      targets.push(word);
    }
  }
  return targets;
}

function splitShellSubcommands(command) {
  const subCommands = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      subCommands.push(current);
      current = '';
      continue;
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      subCommands.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) subCommands.push(current);
  return subCommands;
}

function extractSedInPlaceTargets(command) {
  const targets = [];
  for (const subCommand of splitShellSubcommands(command)) {
    const match = subCommand.trim().match(/\bsed\s+(?:--in-place\b|-i(?:[^\s]*)?)\b.*?(?:\s+)([^\s;|&]+)\s*$/);
    if (!match) continue;
    targets.push(stripShellQuotes(match[1]));
  }
  return targets;
}

function findProtectedBashMutationTarget(command) {
  for (const target of [...extractRedirectTargets(command), ...extractTeeTargets(command), ...extractSedInPlaceTargets(command)]) {
    if (isProtectedPath(target)) return target;
  }
  return null;
}

function hasMintDevOverrideInvocation(command) {
  return hasCommandPositionInvocation(command, execution => {
    if (!isScriptInvocation(execution, 'permission-guard-setup.mjs')) return false;
    return execution.args.includes('mint-dev-override');
  });
}

function hasInstallEnforcementInvocation(command) {
  return hasCommandPositionInvocation(command, execution => isScriptInvocation(execution, 'install-enforcement.mjs'));
}

function detectCircumvention(toolName, toolInput, state) {
  // 1. Protected path writes via Write/Edit/MultiEdit/NotebookEdit
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__move_file', 'mcp__filesystem__rename_file', 'mcp__filesystem__copy_file', 'mcp__filesystem__delete_file'].includes(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.notebook_path || toolInput?.path || getMcpDestinationPath(toolInput);
    if (filePath && isProtectedPath(filePath)) {
      return protectedMutationDecision(filePath);
    }
  }

  const hmacKeyReadTarget = findEnforcementHmacKeyReadTarget(toolName, toolInput);
  if (hmacKeyReadTarget) {
    return {
      circumvention: true,
      reason: `CIRCUMVENTION: Attempted to read protected enforcement, credential, or hook-governance state: ${hmacKeyReadTarget}`,
      severity: 'critical',
      protectedEnforcementAttack: true,
      systemic: true,
    };
  }

  // MCP filesystem move/rename/copy — also check source (prevents exfiltration/destruction of protected files)
  if (['mcp__filesystem__move_file', 'mcp__filesystem__rename_file', 'mcp__filesystem__copy_file'].includes(toolName)) {
    const sourcePath = toolInput?.source || '';
    if (sourcePath && isProtectedPath(sourcePath)) {
      return protectedMutationDecision(sourcePath, 'to mutate file FROM protected path via MCP filesystem');
    }
  }

  // MCP filesystem create_directory targeting protected paths
  if (toolName === 'mcp__filesystem__create_directory') {
    const dirPath = toolInput?.path || '';
    if (dirPath && isProtectedPath(dirPath)) {
      return protectedMutationDecision(dirPath, 'directory creation in protected path via MCP filesystem');
    }
  }

  // 2. Bash analysis
  if (toolName === 'Bash') {
    const command = toolInput?.command || '';

    // 2a. Dev-override minter is human/Codex-only; agents cannot invoke it as a signing oracle.
    if (hasMintDevOverrideInvocation(command)) {
      return {
        circumvention: true,
        reason: 'CIRCUMVENTION: Attempted to invoke dev-override minter from Bash',
        severity: 'critical',
        protectedEnforcementAttack: true,
        systemic: true,
      };
    }

    if (hasInstallEnforcementInvocation(command)) {
      return {
        circumvention: true,
        reason: 'CIRCUMVENTION: Attempted to invoke enforcement installer from Bash',
        severity: 'critical',
        protectedEnforcementAttack: true,
        systemic: true,
      };
    }

    // 2a. Bash redirects to protected paths (12.2: CRITICAL)
    const protectedMutationTarget = findProtectedBashMutationTarget(command);
    if (protectedMutationTarget) {
      return protectedMutationDecision(protectedMutationTarget, 'Bash mutation of protected path');
    }

    // 2b. Git operations targeting protected paths (N3)
    if (/git\s+(checkout|restore|revert)\s+.*\.(hive-flow\/enforcement|claude\/)/i.test(command)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Git operation targeting enforcement/hook files`,
        severity: 'critical',
        protectedEnforcementAttack: true,
        systemic: true,
      };
    }

    // 2c. Environment variable manipulation (N13, N14)
    const envAttempt = findEnforcementEnvManipulation(command);
    if (envAttempt) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Environment variable manipulation targeting enforcement (${envAttempt.name})`,
        severity: 'critical',
        systemic: true,
      };
    }

    // 2c2. Secret exposure prevention — block commands that would print/echo API key values
    const SECRET_ENV_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'HIVE_FLOW_AGENT_TOKEN', 'PINATA_JWT'];
    for (const secretVar of SECRET_ENV_VARS) {
      // Match: echo $VAR, echo ${VAR}, printf $VAR, cat with env, printenv VAR, env | grep VAR
      if (new RegExp(`(echo|printf|cat|print)\\b.*\\$\\{?${secretVar}\\}?`, 'i').test(command) ||
          new RegExp(`printenv\\s+${secretVar}`, 'i').test(command) ||
          new RegExp(`\\benv\\b.*\\|.*grep.*${secretVar}`, 'i').test(command) ||
          new RegExp(`\\$${secretVar}.*[:0-9]`, 'i').test(command)) { // ${VAR:0:N} substring
        return {
          circumvention: true,
          reason: `CIRCUMVENTION: Attempted to expose secret environment variable ${secretVar}`,
          severity: 'critical',
          systemic: true,
        };
      }
    }

    // 2d. Destructive operations (Bug 1: token-based rm parser)
    if (isDestructiveRm(command) ||
        /DROP\s+(DATABASE|TABLE)/i.test(command) ||
        /:\(\)\{.*:\|:.*\}/i.test(command)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Egregiously destructive command detected`,
        severity: 'critical',
        systemic: true,
      };
    }

    // 2d2. pipeline-reset circumvention (Finding 1)
    // Any agent calling hook-handler.cjs pipeline-reset via Bash can delete the
    // pipeline state file and remove the commit gate entirely — treat as circumvention.
    if (/hook-handler\.cjs\s+pipeline-reset/i.test(command)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Attempted to call hook-handler.cjs pipeline-reset directly — this bypasses the pipeline commit gate`,
        severity: 'critical',
        protectedEnforcementAttack: true,
        systemic: true,
      };
    }

    // 2d3. enforcement-reset circumvention
    // Agents must not invoke enforcement reset via Bash — only the UserPromptSubmit
    // hook (human-triggered) is allowed to reset enforcement.
    if (isResetInvocationAttempt(command)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Attempted enforcement reset via Bash — resets are human-only via /enforcement-reset`,
        severity: 'critical',
        protectedEnforcementAttack: true,
        systemic: true,
      };
    }

    const inlineEval = findInlineEvalInvocation(command);
    if (inlineEval) {
      return {
        circumvention: true,
        denyOnly: true,
        reason: INLINE_EVAL_DENIAL,
        severity: 'normal',
      };
    }

    // 2e. Obfuscation detection (Bug 6: reduced false positives)
    if (isObfuscated(command)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Obfuscated command detected`,
        severity: 'normal',
      };
    }

    // 2f. Script execution while write-restricted
    if (state.restrictedGroups.includes('write')) {
      if (findRestrictedScriptExecution(command)) {
        if (isCanonicalHookInvocation(command)) {
          return { circumvention: false };
        }
        if (isAllowedRestrictedScriptExecution(command)) {
          return { circumvention: false };
        }
        return {
          circumvention: true,
          denyOnly: true,
          reason: 'Script execution is blocked while write-restricted because its file effects cannot be verified. Instead: run verification commands such as node --check/node --test, or use Read/Write/Edit with human-approved protected-path changes.',
          severity: 'normal',
        };
      }
    }
  }

  return { circumvention: false };
}

function isResetCheckHookInvocation(command) {
  if (!command || /[;&|<>`]/.test(command)) return false;
  const normalized = String(command).replace(/\s+/g, ' ').trim();
  const hookHandlerReset = /(?:^|\s)node\s+(?:"[^"]*\.claude\/helpers\/hook-handler\.cjs"|[^ \t\n|&;`]*\.claude\/helpers\/hook-handler\.cjs)\s+enforcement-reset-check(?:\s|$)/i;
  if (!hookHandlerReset.test(normalized)) return false;
  return !/enforcement\.cjs\s+--reset/i.test(normalized);
}

function isResetInvocationAttempt(command) {
  if (!command) return false;
  if (isResetCheckHookInvocation(command)) return false;
  return hasCommandPositionInvocation(command, execution => {
    const base = commandBasename(execution.command);
    if (base === 'enforcement-reset' || base === 'reset-enforcement') return true;
    if (base !== 'node') return false;
    const script = execution.args.find(arg => {
      const scriptBase = commandBasename(arg);
      return scriptBase === 'hook-handler.cjs' || scriptBase === 'enforcement.cjs';
    });
    if (!script) return false;
    const scriptBase = commandBasename(script);
    if (scriptBase === 'hook-handler.cjs') return execution.args.includes('enforcement-reset-check');
    return scriptBase === 'enforcement.cjs' && execution.args.includes('--reset');
  });
}

/**
 * Bug 1: Token-based rm parser — handles all flag combinations.
 * Detects: rm -rf /, rm -r -f /, rm --recursive --force /, etc.
 * Does NOT flag: rm -rf /tmp/test-dir (non-root targets)
 */
function isDestructiveRm(command) {
  return hasCommandPositionInvocation(command, execution => {
    if (commandBasename(execution.command) !== 'rm') return false;
    let hasRecursive = false;
    let hasForce = false;

    for (const t of execution.args) {
      if (t === '--') break;
      if (t.startsWith('--')) {
        if (t === '--recursive') hasRecursive = true;
        if (t === '--force') hasForce = true;
        continue;
      }
      if (t.startsWith('-') && !t.startsWith('--')) {
        if (t.includes('r') || t.includes('R')) hasRecursive = true;
        if (t.includes('f')) hasForce = true;
        continue;
      }
      if (hasRecursive && hasForce && (t === '/' || t === '/*')) {
        return true;
      }
    }
    return false;
  });
}

function isAllowedRestrictedScriptExecution(command) {
  const executions = collectShellCommandExecutions(command);
  if (!executions.length) return false;
  return executions.every(execution => {
    const base = commandBasename(execution.command);
    const args = execution.args || [];

    if (base === 'node') {
      return args.includes('--check') || args.includes('--test');
    }

    if (base === 'pnpm') {
      return args.includes('test') || args.includes('exec') || args.includes('--filter') || args.includes('--dir');
    }

    if (base === 'npm' || base === 'yarn') {
      return args.includes('test') || args.includes('run');
    }

    if (base === 'vitest' || base === 'tsc' || base === 'bats') {
      return true;
    }

    return false;
  });
}

function isScriptExecution(execution) {
  const base = commandBasename(execution?.command || '');
  if (/^(?:bash|sh|zsh|dash|ksh)$/.test(base)) {
    return (execution.args || []).some(arg => /\.(?:sh|bash)\b/i.test(arg));
  }
  if (base === 'node' || base === 'bun' || base === 'deno') {
    return (execution.args || []).some(arg => /\.(?:cjs|mjs|js|ts)\b/i.test(arg));
  }
  return /^\.\//.test(execution?.command || '') || /\.(?:sh|bash|cjs|mjs|js)\b/i.test(execution?.command || '');
}

function findRestrictedScriptExecution(command) {
  return collectShellCommandExecutions(command).find(isScriptExecution) || null;
}

/**
 * Bug 6: Reduced false positives for obfuscation.
 * Only flags hex escapes when in execution context or 6+ consecutive.
 * ANSI escapes (\\x1b) are NOT flagged by themselves.
 */
function isObfuscated(command) {
  // Code execution wrapping is suspicious when eval is executed by a shell or
  // consumes dynamic/decoded content. Do not flag inert source text like
  // `node -e "console.log('eval(')"`.
  if (/\b(?:bash|sh)\s+-c\s+["'][^"']*\beval\b/i.test(command)) return true;
  if (/\beval\s+["']?(?:\$\(.*\)|`.*`)/i.test(command)) return true;
  if (/\beval\s+.*\b(?:base64|curl|wget)\b/i.test(command)) return true;

  // base64 piped to shell
  if (/base64\s.*\|\s*(sh|bash|node)/i.test(command)) return true;

  // 6+ consecutive hex chars forming a payload
  if (/(?:\\x[0-9a-f]{2}){6,}/i.test(command)) return true;

  // Hex escapes piped to shell/code-execution
  if (/\\x[0-9a-f]{2}/i.test(command) && /\|\s*(sh|bash|node)/i.test(command)) return true;

  // Standalone hex with no execution context — NOT flagged (could be ANSI)
  return false;
}

/**
 * Detects git commit commands including obfuscated variants.
 * Catches: direct, command substitution, backtick substitution,
 * env prefix, command builtin, and absolute path forms.
 */
function isGitCommitCommand(command) {
  if (!command || typeof command !== 'string') return false;
  if (command.length > 10000) return false;
  // Direct: git commit
  if (/git\s+commit/i.test(command)) return true;
  // Command substitution: $(which git) commit, $(command -v git) commit
  if (/\$\(.*?\bgit\b.*?\)\s+commit/i.test(command)) return true;
  // Backtick substitution: `which git` commit
  if (/`[^`]*\bgit\b[^`]*`\s+commit/i.test(command)) return true;
  // env prefix: env git commit
  if (/\benv\s+git\s+commit/i.test(command)) return true;
  // command builtin: command git commit
  if (/\bcommand\s+git\s+commit/i.test(command)) return true;
  // Absolute path: /usr/bin/git commit, /usr/local/bin/git commit
  if (/\/git\s+commit/i.test(command)) return true;
  // git -c alias: git -c alias.x=commit x
  if (/\bgit\s+-c\s+.*\bcommit\b/i.test(command)) return true;
  return false;
}

// ============================================================================
// Tool Restriction
// ============================================================================

function checkToolRestriction(toolName, state, scope = null, toolInput = {}) {
  const scopeSuffix = scope ? `: ${escalationScopeLabel(scope.scopeType, scope.scopeId)}` : '';
  // Unrestricted tools are always allowed
  if (UNRESTRICTED_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // Level 3 (Halted) — block ALL tools except unrestricted
  if (state.level >= LEVELS.HALTED) {
    return {
      allowed: false,
      reason: `[ENFORCEMENT HALT${scopeSuffix}] All tools blocked. ${state.violations} violation(s). Contact the human operator — use /enforcement-reset or /terminate-agent to restore access.`,
    };
  }

  // Level 2 (Restricted) — block tools in restricted groups
  if (state.level >= LEVELS.RESTRICTED) {
    for (const group of state.restrictedGroups) {
      const tools = TOOL_GROUPS[group] || [];
      if (tools.includes(toolName)) {
        if (group === 'write') {
          const writeCheck = restrictedWriteAllowed(toolName, toolInput, scope);
          if (writeCheck.allowed) continue;
          if (writeCheck.reason) {
            return {
              allowed: false,
              reason: `[ENFORCEMENT RESTRICTED${scopeSuffix}] Tool '${toolName}' blocked (group: ${group}); ${writeCheck.reason}. ${state.violations} violation(s).`,
            };
          }
        }
        return {
          allowed: false,
          reason: `[ENFORCEMENT RESTRICTED${scopeSuffix}] Tool '${toolName}' blocked (group: ${group}). ${state.violations} violation(s). Use allowed tools (Read, Grep, Glob) or ask the human for help.`,
        };
      }
    }
  }

  return { allowed: true };
}

function getRestrictionGroups(toolName) {
  if (['Bash'].includes(toolName)) {
    return ['exec', 'write'];
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return ['write', 'exec'];
  }
  if (['mcp__filesystem__write_file', 'mcp__filesystem__edit_file', 'mcp__filesystem__move_file', 'mcp__filesystem__rename_file', 'mcp__filesystem__copy_file', 'mcp__filesystem__create_directory', 'mcp__filesystem__delete_file'].includes(toolName)) {
    return ['write', 'exec'];
  }
  if (['WebFetch'].includes(toolName)) {
    return ['fetch', 'exec'];
  }
  return ['exec'];
}

// ============================================================================
// Verification Gate (with HMAC — 12.4)
// ============================================================================

function checkVerificationGate(toolName, toolInput) {
  if (toolName !== 'Bash') return { blocked: false };

  const command = toolInput?.command || '';
  if (!isGitCommitCommand(command)) return { blocked: false };

  // Pipeline gate — checked before swarm-mode gate
  if (fs.existsSync(PIPELINE_STATE_FILE)) {
    const pipelineRaw = readJson(PIPELINE_STATE_FILE);
    if (pipelineRaw === null) {
      // File exists but is corrupted (invalid JSON or too large) — block commit (Finding 3)
      return {
        blocked: true,
        reason: '[PIPELINE GATE] Pipeline state file is corrupted. Cannot verify stage completions. Use /pipeline-reset to clear, or fix the file.',
      };
    }
    const { valid, state: pState } = verifyState(pipelineRaw);
    if (!valid || !pState) {
      return { blocked: true, reason: '[PIPELINE GATE] Pipeline state integrity check failed (HMAC mismatch).' };
    }
    if (pState.overrideActive) {
      return { blocked: false };
    }
    // A7: HMAC-signed pipeline override token: "<timestamp>.<hmac-of-timestamp>"
    // Requires cryptographic proof + timestamp within 1 hour (anti-replay)
    const pipelineOverride = process.env.HIVE_FLOW_PIPELINE_OVERRIDE || '';
    if (pipelineOverride && pipelineOverride !== '1') {
      const dotIdx = pipelineOverride.indexOf('.');
      if (dotIdx > 0) {
        const overrideTs = pipelineOverride.slice(0, dotIdx);
        const overrideHmac = pipelineOverride.slice(dotIdx + 1);
        const tsNum = parseInt(overrideTs, 10);
        const now = Date.now();
        if (!isNaN(tsNum) && Math.abs(now - tsNum) < 3600000) {
          const key = getOrCreateHmacKey();
          const expected = crypto.createHmac('sha256', key).update('pipeline-override:' + overrideTs).digest('hex');
          let overrideValid = false;
          try {
            const eBuf = Buffer.from(expected, 'hex');
            const aBuf = Buffer.from(overrideHmac, 'hex');
            if (eBuf.length === aBuf.length) {
              overrideValid = crypto.timingSafeEqual(eBuf, aBuf);
            }
          } catch { overrideValid = false; }
          if (overrideValid) {
            appendViolation({ type: 'pipeline-hmac-override', taskId: pState.taskId, timestamp: new Date().toISOString() });
            return { blocked: false };
          }
        }
      }
    }
    // Reject bare HIVE_FLOW_PIPELINE_OVERRIDE=1 (unsigned) — log as circumvention attempt
    if (pipelineOverride === '1') {
      appendViolation({ type: 'unsigned-pipeline-override-attempt', taskId: pState.taskId, timestamp: new Date().toISOString() });
      // Fall through to incomplete-stages check (do NOT bypass)
    }
    const incompleteStages = (pState.requiredStages || []).filter(
      name => !pState.stages[name] || pState.stages[name].complete !== true
    );
    if (incompleteStages.length > 0) {
      return {
        blocked: true,
        reason: '[PIPELINE GATE] git commit blocked. Incomplete stages: ' + incompleteStages.join(', ') + '. Complete all pipeline stages before committing. Use /pipeline-override for HMAC-signed emergency bypass.',
      };
    }
    return { blocked: false };
  }

  // N14: Removed HIVE_FLOW_ENFORCEMENT_DISABLED env check entirely

  // Non-swarm mode — don't block individual commits
  if (!fs.existsSync(path.join(PROJECT_DIR, '.hive-flow', 'swarm'))) {
    return { blocked: false };
  }

  // Check verification gate with HMAC
  const raw = readJson(VERIFICATION_GATE_FILE);
  if (raw) {
    const { valid, state: gate } = verifyState(raw);
    if (valid && gate && gate.status === 'pass' && gate.timestamp) {
      // Bug 5: Explicit timestamp validation
      const ts = new Date(gate.timestamp).getTime();
      if (!isNaN(ts) && ts <= Date.now() && (Date.now() - ts) < GATE_MAX_AGE_MS) {
        return { blocked: false };
      }
    }
    // Unsigned gates are no longer accepted — require HMAC on all state files
  }

  return {
    blocked: true,
    reason: '[VERIFICATION REQUIRED] git commit blocked in swarm mode. Deploy a verification hive first. Write results to .hive-flow/enforcement/verification-gate.json with status: "pass".',
  };
}

// ============================================================================
// Hang Detection
// ============================================================================

function updateActivityTracking(state, denied) {
  if (denied) {
    state.consecutiveDenials = (state.consecutiveDenials || 0) + 1;
  } else {
    state.consecutiveDenials = 0;
  }

  if (state.consecutiveDenials >= HUNG_THRESHOLD) {
    return {
      hung: true,
      message: `[ENFORCEMENT] Agent appears hung (${state.consecutiveDenials} consecutive denied calls). Use AskUserQuestion to request human help or try Read/Grep/Glob.`,
    };
  }

  return { hung: false };
}

// ============================================================================
// Output Formatting (12.1: CORRECT Claude Code PreToolUse protocol)
// ============================================================================

function makeHookOutput(hookEventName, fields) {
  return { hookSpecificOutput: { hookEventName: hookEventName, ...fields } };
}

function makeAllow(additionalContext, hookEventName = 'PreToolUse') {
  const result = {};
  if (additionalContext) {
    // N2: Sanitize context — strip XML tags, limit length
    const sanitized = sanitizeContext(additionalContext);
    result.hookSpecificOutput = {
      hookEventName: hookEventName,
      permissionDecision: 'allow',
      additionalContext: sanitized,
    };
  }
  // No hookSpecificOutput needed for allow without context — empty JSON = allow
  return result;
}

function makeDeny(reason, hookEventName = 'PreToolUse') {
  return makeHookOutput(hookEventName, {
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  });
}

function sanitizeContext(text) {
  if (!text) return '';
  // Strip XML-like tags that could inject system prompts
  let sanitized = text.replace(/<[^>]+>/g, '');
  // Limit length to prevent context overflow
  if (sanitized.length > 2000) {
    sanitized = sanitized.slice(0, 2000) + '... [truncated]';
  }
  return sanitized;
}

// ============================================================================
// Main Hook Entry Point
// ============================================================================

function processPreToolUse(input) {
  const toolName = input?.tool_name || input?.toolName || '';
  if (!toolName) {
    // Empty input is used for SubagentStart hooks; avoid overwriting
    // role-enforcement.cjs identity injection with enforcement warnings.
    return makeAllow();
  }
  const toolInput = input?.tool_input || input?.input || {};
  const ctx = resolveScopeContext(input);
  const effective = loadEffectiveState(ctx).effective;

  if (ctx.agentId && !ctx.identityTrusted) {
    const violation = {
      reason: `[IDENTITY ENFORCEMENT] Agent token verification failed (${ctx.identityReason}) — possible env var spoofing.`,
      severity: 'critical',
      restrictionGroups: getRestrictionGroups(toolName),
      systemic: true,
    };
    const escalation = escalateScoped(ctx, violation);
    const hangCheck = updateActivityTracking(escalation.state, true);
    saveScopedState(escalation.scopeType, escalation.scopeId, escalation.state);
    return makeDeny(`${violation.reason} Escalated ${escalationScopeLabel(escalation.scopeType, escalation.scopeId)} to level ${escalation.state.level}.${hangCheck.hung ? ' ' + hangCheck.message : ''}`);
  }

  // Step 1: Check circumvention
  const circ = detectCircumvention(toolName, toolInput, effective.state);
  if (circ.circumvention) {
    if (canDevOverrideBypassCircumvention(input, toolName, toolInput, circ)) {
      appendViolation({
        type: 'dev-override-used',
        tool: toolName,
        projectId: ctx.projectId,
        timestamp: new Date().toISOString(),
      });
    } else if (circ.denyOnly) {
      appendViolation({
        type: 'deny-only',
        reason: circ.reason,
        tool: toolName,
        projectId: ctx.projectId,
        timestamp: new Date().toISOString(),
      });
      return makeDeny(circ.reason);
    } else {
      const escalation = escalateScoped(ctx, {
        ...circ,
        restrictionGroups: getRestrictionGroups(toolName),
      });
      const hangCheck = updateActivityTracking(escalation.state, true);
      saveScopedState(escalation.scopeType, escalation.scopeId, escalation.state);

      const reason = `${circ.reason}. Escalated ${escalationScopeLabel(escalation.scopeType, escalation.scopeId)} to level ${escalation.state.level}.${hangCheck.hung ? ' ' + hangCheck.message : ''}`;
      return makeDeny(reason);
    }
  }

  // Step 2: Check tool restriction
  const refreshedEffective = loadEffectiveState(ctx).effective;
  const restriction = checkToolRestriction(toolName, refreshedEffective.state, refreshedEffective, toolInput);
  if (!restriction.allowed) {
    const hangCheck = updateActivityTracking(refreshedEffective.state, true);
    saveScopedState(refreshedEffective.scopeType, refreshedEffective.scopeId, refreshedEffective.state);

    const reason = restriction.reason + (hangCheck.hung ? ' ' + hangCheck.message : '');
    return makeDeny(reason);
  }

  // Step 3: Check verification gate (for git commit)
  const verifyGate = checkVerificationGate(toolName, toolInput);
  if (verifyGate.blocked) {
    appendViolation({
      type: 'verification-gate-blocked',
      tool: toolName,
      command: (toolInput?.command || '').slice(0, 200),
    });
    return makeDeny(verifyGate.reason);
  }

  // Step 3b: Detect headless claude -p invocations in Bash
  if (toolName === 'Bash') {
    const bashCmd = toolInput?.command || '';
    if (/\bclaude\s+(-p|--print)\b/i.test(bashCmd)) {
      updateActivityTracking(refreshedEffective.state, false);
      saveScopedState(refreshedEffective.scopeType, refreshedEffective.scopeId, refreshedEffective.state);
      return makeAllow(
        '[ENFORCEMENT] Headless `claude -p` detected. WARNING: Headless workers bypass hook enforcement, verification gates, and hive composition tracking. Consider using Task tool or MCP agent_spawn instead for governed execution.'
      );
    }
  }

  // Step 4: SendMessage at HALTED — append enforcement warning (12.14)
  if (toolName === 'SendMessage' && refreshedEffective.state.level >= LEVELS.HALTED) {
    updateActivityTracking(refreshedEffective.state, false);
    saveScopedState(refreshedEffective.scopeType, refreshedEffective.scopeId, refreshedEffective.state);
    return makeAllow(
      '[ENFORCEMENT] This agent is under enforcement restrictions (HALTED). Do not execute tool operations on its behalf.'
    );
  }

  // Step 5: Inject warning at Level 1
  // NOTE: In SubagentStart context (no tool_name), this additionalContext will
  // overwrite role-enforcement.cjs's identity injection because Claude Code
  // uses "last writer wins" when merging multiple hook outputs. Enforcement.cjs
  // runs AFTER role-enforcement.cjs in settings.json SubagentStart hooks.
  // If ordering changes, role identity text may be lost at WARNED level.
  if (refreshedEffective.state.level === LEVELS.WARNED) {
    updateActivityTracking(refreshedEffective.state, false);
    saveScopedState(refreshedEffective.scopeType, refreshedEffective.scopeId, refreshedEffective.state);
    return makeAllow(
      `[ENFORCEMENT WARNING: ${escalationScopeLabel(refreshedEffective.scopeType, refreshedEffective.scopeId)}] You have ${refreshedEffective.state.violations} violation(s). Further circumvention will restrict tool access. Follow the plan exactly.`
    );
  }

  // Step 6: Normal pass-through
  updateActivityTracking(refreshedEffective.state, false);
  saveScopedState(refreshedEffective.scopeType, refreshedEffective.scopeId, refreshedEffective.state);
  return makeAllow();
}

// ============================================================================
// Human Reset (Bug 4 + 12.7)
// ============================================================================

function resetStateScope(scopeType, scopeId) {
  const state = {
    level: LEVELS.NORMAL,
    violations: 0,
    consecutiveDenials: 0,
    lastActivity: new Date().toISOString(),
    restrictedGroups: [],
    history: [],
    resetAt: new Date().toISOString(),
    integrityCompromised: false,
  };
  saveScopedState(scopeType, scopeId, state);
  appendViolation({
    type: 'reset',
    scopeType,
    scopeId: scopeId || scopeType,
    reason: `Human-initiated scoped enforcement reset (${escalationScopeLabel(scopeType, scopeId)})`,
  });
  return state;
}

function resetEnforcement(scope = {}) {
  const requestedScope = scope.scope || (
    scope.agentId ? 'agent' :
    scope.hiveId ? 'hive' :
    scope.sessionId ? 'session' :
    (scope.project === true || scope.projectId) ? 'project' :
    'all'
  );
  if (requestedScope === 'global') return resetStateScope('global', null);
  if (requestedScope === 'agent' && scope.agentId) {
    clearAgentRole(scope.agentId);
    return resetStateScope('agent', scope.agentId);
  }
  if (requestedScope === 'hive' && scope.hiveId) return resetStateScope('hive', scope.hiveId);
  if (requestedScope === 'session' && scope.sessionId) return resetStateScope('session', scope.sessionId);
  if (requestedScope === 'project' || scope.project === true || scope.projectId) return resetStateScope('project', scope.projectId || getProjectScopeId());

  ensureDir();
  // Clear pipeline state
  try { if (fs.existsSync(PIPELINE_STATE_FILE)) fs.unlinkSync(PIPELINE_STATE_FILE); } catch {}
  // Clear future band state files (may not exist yet — safe to attempt)
  const bandStateFiles = ['phase-state.json', 'compliance-state.json', 'bug-hunter-state.json'];
  for (const f of bandStateFiles) {
    try {
      const fp = path.join(ENFORCEMENT_DIR, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  }
  // Clear deferral state directory
  try {
    const deferralsDir = path.join(ENFORCEMENT_DIR, 'deferrals');
    if (fs.existsSync(deferralsDir)) {
      const files = fs.readdirSync(deferralsDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(deferralsDir, f)); } catch {}
        }
      }
    }
  } catch {}
  // Clear per-agent state files
  for (const scopeDirName of ['agents', 'hives', 'projects', 'sessions']) {
    try {
      const scopeDir = path.join(ENFORCEMENT_DIR, scopeDirName);
      if (fs.existsSync(scopeDir)) {
        const scopeDirs = fs.readdirSync(scopeDir);
        for (const scopeId of scopeDirs) {
          try {
            const scopedStateFile = path.join(scopeDir, scopeId, 'state.json');
            if (fs.existsSync(scopedStateFile)) fs.unlinkSync(scopedStateFile);
            if (scopeDirName === 'agents') {
              const roleFile = path.join(scopeDir, scopeId, 'role.json');
              if (fs.existsSync(roleFile)) fs.unlinkSync(roleFile);
            }
          } catch {}
        }
      }
    } catch {}
  }
  const state = {
    level: LEVELS.NORMAL,
    violations: 0,
    consecutiveDenials: 0,
    lastActivity: new Date().toISOString(),
    restrictedGroups: [],
    history: [],
    resetAt: new Date().toISOString(),
    integrityCompromised: false,
  };
  saveState(state);
  appendViolation({
    type: 'reset',
    reason: 'Human-initiated enforcement reset (full scope: all state files cleared)',
  });
  return state;
}

function parseResetScope(prompt) {
  const scopeMatch = /--scope(?:=|\s+)(all|global|agent|hive|session|project)\b/i.exec(prompt);
  const requestedScope = scopeMatch ? scopeMatch[1].toLowerCase() : null;
  const agentMatch = /--agent(?:=|\s+)([A-Za-z0-9_.:-]+)/i.exec(prompt);
  if (agentMatch) return { scope: requestedScope || 'agent', agentId: agentMatch[1] };
  const hiveMatch = /--hive(?:=|\s+)([A-Za-z0-9_.:-]+)/i.exec(prompt);
  if (hiveMatch) return { scope: requestedScope || 'hive', hiveId: hiveMatch[1] };
  const sessionMatch = /--session(?:=|\s+)([A-Za-z0-9_.:-]+)/i.exec(prompt);
  if (sessionMatch) return { scope: requestedScope || 'session', sessionId: sessionMatch[1] };
  if (/\s--project\b/i.test(prompt)) return { scope: requestedScope || 'project', project: true };
  if (requestedScope) return { scope: requestedScope };
  return { scope: 'all' };
}

function clearAgentRole(agentId) {
  const sanitized = sanitizeScopeId(agentId);
  if (!sanitized) return false;
  try {
    const roleFile = path.join(ENFORCEMENT_DIR, 'agents', sanitized, 'role.json');
    if (fs.existsSync(roleFile)) fs.unlinkSync(roleFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Process --reset-check flag (UserPromptSubmit hook).
 * Checks if the user's prompt contains /enforcement-reset.
 */
function processResetCheck(input) {
  const prompt = input?.user_prompt || input?.prompt || '';

  // HMAC-signed IPC: verify caller authentication before executing reset
  if (/\/(enforcement-reset|reset-enforcement)\b/i.test(prompt)) {
    const signature = input?._hmac_signature;
    const timestamp = input?._hmac_timestamp;

    if (!signature || !timestamp) {
      // Unsigned reset attempt — log as circumvention and reject
      appendViolation({
        type: 'unsigned-reset-attempt',
        reason: 'Reset request without HMAC signature — possible circumvention',
        severity: 'critical',
      });
      return makeDeny('[ENFORCEMENT] Reset denied: unsigned request. Resets must be routed through the hook system.', 'UserPromptSubmit');
    }

    // Verify timestamp freshness (30s window)
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 30000) {
      appendViolation({
        type: 'expired-reset-attempt',
        reason: `Reset request with expired timestamp (${timestamp})`,
        severity: 'critical',
      });
      return makeDeny('[ENFORCEMENT] Reset denied: expired timestamp. Resets must be recent (within 30s).', 'UserPromptSubmit');
    }

    // Verify HMAC signature
    const key = getOrCreateHmacKey();
    const payload = `enforcement-reset:${timestamp}`;
    const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
    let signatureValid = false;
    try {
      signatureValid = crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(signature, 'hex')
      );
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      appendViolation({
        type: 'invalid-signature-reset-attempt',
        reason: 'Reset request with invalid HMAC signature — possible circumvention',
        severity: 'critical',
      });
      return makeDeny('[ENFORCEMENT] Reset denied: invalid signature. Resets must be routed through the hook system.', 'UserPromptSubmit');
    }

    // Signature valid — execute reset
    const resetScope = parseResetScope(prompt);
    resetEnforcement(resetScope);
    const scopeLabel = resetScope.scope === 'all'
      ? 'all'
      : resetScope.scope === 'global'
        ? 'global'
        : resetScope.agentId
      ? `agent/${resetScope.agentId}`
      : resetScope.hiveId
        ? `hive/${resetScope.hiveId}`
        : resetScope.sessionId
          ? `session/${resetScope.sessionId}`
        : resetScope.project
          ? `project/${getProjectScopeId()}`
          : resetScope.scope || 'all';
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        permissionDecision: 'allow',
        additionalContext: `[ENFORCEMENT] Reset complete for ${scopeLabel}. Enforcement level: NORMAL.`,
      },
    };
  }
  return {};
}

// ============================================================================
// Status
// ============================================================================

function getEnforcementStatus() {
  const state = getState();
  const levelNames = ['Normal', 'Warned', 'Restricted', 'Halted'];
  return {
    level: state.level,
    levelName: levelNames[state.level] || 'Unknown',
    violations: state.violations,
    consecutiveDenials: state.consecutiveDenials,
    restrictedGroups: state.restrictedGroups,
    lastActivity: state.lastActivity,
    integrityCompromised: state.integrityCompromised || false,
    recentHistory: (state.history || []).slice(-5),
  };
}

// ============================================================================
// Verification Gate (HMAC-signed — 12.4)
// ============================================================================

function setVerificationGate(status, details) {
  ensureDir();
  const gate = {
    status,
    timestamp: new Date().toISOString(),
    details: details || {},
  };
  const envelope = signState(gate);
  writeJsonAtomic(VERIFICATION_GATE_FILE, envelope);
}

// ============================================================================
// Pipeline Stage-Gated Commit Enforcement
// ============================================================================

function initPipeline(taskId, stages) {
  ensureDir();
  const defaultStages = ['implement', 'verify', 'test', 'debug', 'verify_test', 'audit', 'verify_audit'];
  const requiredStages = stages && stages.length > 0 ? stages : defaultStages;
  const stagesObj = {};
  for (const s of requiredStages) {
    stagesObj[s] = { complete: false, completedAt: null, completedBy: null };
  }
  const state = {
    taskId: taskId || `task-${Date.now()}`,
    startedAt: new Date().toISOString(),
    stages: stagesObj,
    requiredStages,
    overrideActive: false,
    overrideReason: null,
    overrideAt: null,
  };
  const signed = signState(state);
  writeJsonAtomic(PIPELINE_STATE_FILE, signed);
  appendViolation({ type: 'pipeline-init', taskId: state.taskId, stages: requiredStages, timestamp: new Date().toISOString() });
  return state;
}

function completePipelineStage(taskId, stageName, callerToken) {
  // HMAC caller auth: verify token was generated by hook-handler.cjs (not direct invocation)
  if (!callerToken) {
    appendViolation({ type: 'pipeline-stage-unauth', stage: stageName, reason: 'No caller token — direct invocation blocked' });
    return { success: false, reason: 'Caller authentication required. Use /pipeline-stage command.' };
  }
  const dotIdx = (callerToken || '').indexOf('.');
  const tokenTs = dotIdx > 0 ? parseInt(callerToken.slice(0, dotIdx), 10) : NaN;
  const tokenSig = dotIdx > 0 ? callerToken.slice(dotIdx + 1) : '';
  if (isNaN(tokenTs) || !tokenSig || Math.abs(Date.now() - tokenTs) > 30000) {
    appendViolation({ type: 'pipeline-stage-expired-token', stage: stageName });
    return { success: false, reason: 'Caller token expired or malformed (must be within 30s).' };
  }
  const key = getOrCreateHmacKey();
  const payload = `pipeline-stage-complete:${stageName}:${tokenTs}`;
  const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
  let tokenValid = false;
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(tokenSig, 'hex');
    if (expectedBuf.length === actualBuf.length) {
      tokenValid = crypto.timingSafeEqual(expectedBuf, actualBuf);
    }
  } catch { tokenValid = false; }
  if (!tokenValid) {
    appendViolation({ type: 'pipeline-stage-invalid-token', stage: stageName, reason: 'HMAC signature mismatch' });
    return { success: false, reason: 'Caller authentication failed. Token signature invalid.' };
  }
  const raw = readJson(PIPELINE_STATE_FILE);
  if (!raw) return { success: false, reason: 'No active pipeline' };
  const { valid, state } = verifyState(raw);
  if (!valid || !state) return { success: false, reason: 'Pipeline state integrity check failed' };
  if (taskId && state.taskId !== taskId) return { success: false, reason: `Task ID mismatch: expected ${state.taskId}, got ${taskId}` };
  if (!state.stages[stageName]) return { success: false, reason: `Unknown stage: ${stageName}` };
  if (state.stages[stageName].complete) return { success: true, reason: 'Already complete' };
  state.stages[stageName].complete = true;
  state.stages[stageName].completedAt = new Date().toISOString();
  state.stages[stageName].completedBy = getAgentId();
  const signed = signState(state);
  writeJsonAtomic(PIPELINE_STATE_FILE, signed);
  appendViolation({ type: 'pipeline-stage-complete', taskId: state.taskId, stage: stageName, completedBy: state.stages[stageName].completedBy, timestamp: new Date().toISOString() });
  return { success: true };
}

function getPipelineState() {
  const raw = readJson(PIPELINE_STATE_FILE);
  if (!raw) return null;
  const { valid, state } = verifyState(raw);
  if (!valid) return { error: 'integrity-failed' };
  return state;
}

function overridePipeline(reason, callerToken) {
  // HMAC caller auth: verify token was generated by hook-handler.cjs pipeline-override handler
  if (!callerToken) {
    appendViolation({ type: 'pipeline-override-unauth', reason: 'No caller token — direct invocation blocked' });
    return { success: false, reason: 'Caller authentication required. Use /pipeline-override command.' };
  }
  const dotIdx = (callerToken || '').indexOf('.');
  const tokenTs = dotIdx > 0 ? parseInt(callerToken.slice(0, dotIdx), 10) : NaN;
  const tokenSig = dotIdx > 0 ? callerToken.slice(dotIdx + 1) : '';
  if (isNaN(tokenTs) || !tokenSig || Math.abs(Date.now() - tokenTs) > 30000) {
    appendViolation({ type: 'pipeline-override-expired-token' });
    return { success: false, reason: 'Caller token expired or malformed (must be within 30s).' };
  }
  const key = getOrCreateHmacKey();
  const payload = `pipeline-override:${tokenTs}`;
  const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
  let tokenValid = false;
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(tokenSig, 'hex');
    if (expectedBuf.length === actualBuf.length) {
      tokenValid = crypto.timingSafeEqual(expectedBuf, actualBuf);
    }
  } catch { tokenValid = false; }
  if (!tokenValid) {
    appendViolation({ type: 'pipeline-override-invalid-token', reason: 'HMAC signature mismatch' });
    return { success: false, reason: 'Caller authentication failed. Token signature invalid.' };
  }
  const raw = readJson(PIPELINE_STATE_FILE);
  if (!raw) return { success: false, reason: 'No active pipeline' };
  const { valid, state } = verifyState(raw);
  if (!valid || !state) return { success: false, reason: 'Pipeline state integrity check failed' };
  state.overrideActive = true;
  state.overrideReason = reason || 'No reason provided';
  state.overrideAt = new Date().toISOString();
  const signed = signState(state);
  writeJsonAtomic(PIPELINE_STATE_FILE, signed);
  appendViolation({ type: 'pipeline-override-command', taskId: state.taskId, reason: state.overrideReason, timestamp: new Date().toISOString() });
  return { success: true };
}

function resetPipeline(callerToken) {
  // HMAC caller auth: verify token was generated by hook-handler.cjs pipeline-reset handler
  if (!callerToken) {
    appendViolation({ type: 'pipeline-reset-unauth', reason: 'No caller token — direct invocation blocked' });
    return { success: false, reason: 'Caller authentication required. Use /pipeline-reset command.' };
  }
  const dotIdx = (callerToken || '').indexOf('.');
  const tokenTs = dotIdx > 0 ? parseInt(callerToken.slice(0, dotIdx), 10) : NaN;
  const tokenSig = dotIdx > 0 ? callerToken.slice(dotIdx + 1) : '';
  if (isNaN(tokenTs) || !tokenSig || Math.abs(Date.now() - tokenTs) > 30000) {
    appendViolation({ type: 'pipeline-reset-expired-token' });
    return { success: false, reason: 'Caller token expired or malformed (must be within 30s).' };
  }
  const key = getOrCreateHmacKey();
  const payload = `pipeline-reset:${tokenTs}`;
  const expected = crypto.createHmac('sha256', key).update(payload).digest('hex');
  let tokenValid = false;
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(tokenSig, 'hex');
    if (expectedBuf.length === actualBuf.length) {
      tokenValid = crypto.timingSafeEqual(expectedBuf, actualBuf);
    }
  } catch { tokenValid = false; }
  if (!tokenValid) {
    appendViolation({ type: 'pipeline-reset-invalid-token', reason: 'HMAC signature mismatch' });
    return { success: false, reason: 'Caller authentication failed. Token signature invalid.' };
  }
  try {
    if (fs.existsSync(PIPELINE_STATE_FILE)) fs.unlinkSync(PIPELINE_STATE_FILE);
    return { success: true };
  } catch { return { success: false, reason: 'Failed to delete pipeline state' }; }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

if (require.main === module) {
  try {
    const rawInput = readStdin();
    let input;
    try {
      input = JSON.parse(rawInput);
    } catch {
      input = {};
    }

    let result;
    if (process.argv[2] === '--reset-check') {
      result = processResetCheck(input);
    } else {
      result = processPreToolUse(input);
    }

    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    // Bug 8: Fail-closed — errors block, not allow
    process.stdout.write(JSON.stringify(makeDeny(
      '[ENFORCEMENT ERROR] Internal error in enforcement hook. Tool blocked for safety. Contact human operator.'
    )));
  }
  process.exit(0);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  LEVELS,
  TOOL_GROUPS,
  UNRESTRICTED_TOOLS,
  PROTECTED_PATHS,
  getState,
  getScopedState,
  saveState,
  saveScopedState,
  appendViolation,
  escalate,
  escalateScoped,
  detectCircumvention,
  checkToolRestriction,
  getRestrictionGroups,
  checkVerificationGate,
  updateActivityTracking,
  processPreToolUse,
  resetEnforcement,
  parseResetScope,
  processResetCheck,
  getEnforcementStatus,
  setVerificationGate,
  signState,
  verifyState,
  isProtectedPath,
  getAgentId,
  getHookAgentId,
  getStateFile,
  getScopedStateFile,
  getProjectScopeId,
  resolveScopeContext,
  loadEffectiveState,
  getProtectedPathScope,
  isGlobalProtectedPath,
  isDevOverrideActive,
  isRootSessionForDevOverride,
  verifyDevOverrideRootToken,
  isDevOverrideFloorPath,
  canDevOverrideBypassCircumvention,
  isDestructiveRm,
  isObfuscated,
  shellTokens,
  shellWords,
  splitShellSubcommands,
  collectShellCommandExecutions,
  hasCommandPositionInvocation,
  isInlineEvalExecution,
  findInlineEvalInvocation,
  isResetCheckHookInvocation,
  isResetInvocationAttempt,
  isGitCommitCommand,
  makeHookOutput,
  makeAllow,
  makeDeny,
  sanitizeContext,
  PIPELINE_STATE_FILE,
  initPipeline,
  completePipelineStage,
  getPipelineState,
  overridePipeline,
  resetPipeline,
  getOrCreateHmacKey,
};
