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
 *   { hookSpecificOutput: { permissionDecision: 'allow'|'deny', permissionDecisionReason: '...' } }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Derive PROJECT_DIR from script location, NOT from env (N1: env poisoning defense)
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');
const STATE_FILE = path.join(ENFORCEMENT_DIR, 'state.json');
const VIOLATIONS_FILE = path.join(ENFORCEMENT_DIR, 'violations.jsonl');
const VERIFICATION_GATE_FILE = path.join(ENFORCEMENT_DIR, 'verification-gate.json');
const HMAC_KEY_FILE = path.join(ENFORCEMENT_DIR, '.hmac-key');
const COMPACTION_LOCK_FILE = path.join(ENFORCEMENT_DIR, 'compaction-lock.json');

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
  write: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'], // 12.6: NotebookEdit added
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
  '.claude/helpers/',
  '.hive-flow/enforcement/',
  '.hive-flow/data/', // N5: unprotected state directory
];

// Protected path patterns for compiled output (12.10)
const PROTECTED_PATH_PATTERNS = [
  /v3\/@hive-flow\/cli\/dist\/src\/permission-guard\//,
  /v3\/@hive-flow\/cli\/dist\/src\/mcp-tools\//,
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

  // Legacy format migration: plain state without HMAC envelope
  if (!envelope.hmac && typeof envelope.level === 'number') {
    return { valid: true, state: envelope, migrated: true };
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

function ensureDir() {
  try { fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true }); } catch {}
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

function getState() {
  ensureDir();
  const raw = readJson(STATE_FILE);

  if (raw === null) {
    _readErrorCount++;
    // 12.11: After N consecutive read errors, create fresh state at WARNED minimum
    if (_readErrorCount >= MAX_CONSECUTIVE_READ_ERRORS) {
      const state = freshState();
      state.level = LEVELS.WARNED;
      state.integrityCompromised = true;
      _readErrorCount = 0;
      saveState(state);
      return state;
    }
    return freshState();
  }

  _readErrorCount = 0;

  const { valid, state, migrated } = verifyState(raw);

  if (valid && state) {
    // Re-sign on legacy migration
    if (migrated) {
      saveState(state);
    }
    return state;
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
  saveState(tampered);
  return tampered;
}

function saveState(state) {
  ensureDir();
  state.lastActivity = new Date().toISOString();
  const envelope = signState(state);
  writeJsonAtomic(STATE_FILE, envelope);
}

function appendViolation(violation) {
  ensureDir();
  try {
    // N8: Create file on first violation if it doesn't exist
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

function escalate(state, reason, severity) {
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
  });

  return state;
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

function isProtectedPath(filePath) {
  const resolved = resolveFilePath(filePath);
  const relativePath = resolved.startsWith(PROJECT_DIR)
    ? resolved.slice(PROJECT_DIR.length + 1)
    : filePath;

  for (const protectedPath of PROTECTED_PATHS) {
    if (relativePath.startsWith(protectedPath) || relativePath === protectedPath.replace(/\/$/, '')) {
      return true;
    }
  }

  // Check compiled output patterns (12.10)
  for (const pattern of PROTECTED_PATH_PATTERNS) {
    if (pattern.test(relativePath)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Circumvention Detection
// ============================================================================

function detectCircumvention(toolName, toolInput, state) {
  // 1. Protected path writes via Write/Edit/MultiEdit/NotebookEdit
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.path || '';
    if (filePath && isProtectedPath(filePath)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Attempted write to protected path: ${filePath}`,
        severity: 'critical',
      };
    }
  }

  // 2. Bash analysis
  if (toolName === 'Bash') {
    const command = toolInput?.command || '';

    // 2a. Bash redirects to protected paths (12.2: CRITICAL)
    const redirectPatterns = [
      /(?:echo|printf|cat|tee|cp|mv|dd|python|node|perl|ruby)\s+.*>\s*.*\.hive-flow\/enforcement\//i,
      /(?:echo|printf|cat|tee|cp|mv|dd|python|node|perl|ruby)\s+.*>\s*.*\.claude\//i,
      /sed\s+-i.*\.hive-flow\/enforcement\//i,
      /sed\s+-i.*\.claude\//i,
      />\s*.*\.hive-flow\/enforcement\//i,
      />\s*.*\.claude\/helpers\//i,
      />\s*.*\.claude\/settings\.json/i,
    ];
    for (const pattern of redirectPatterns) {
      if (pattern.test(command)) {
        return {
          circumvention: true,
          reason: `CIRCUMVENTION: Bash redirect to protected path detected`,
          severity: 'critical',
        };
      }
    }

    // 2b. Git operations targeting protected paths (N3)
    if (/git\s+(checkout|restore|revert)\s+.*\.(hive-flow\/enforcement|claude\/)/i.test(command)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Git operation targeting enforcement/hook files`,
        severity: 'critical',
      };
    }

    // 2c. Environment variable manipulation (N13, N14)
    if (/export\s+(CLAUDE_PROJECT_DIR|CF_WF_7D|HIVE_FLOW_ENFORCEMENT_DISABLED)\s*=/i.test(command) ||
        /\b(CLAUDE_PROJECT_DIR|CF_WF_7D|HIVE_FLOW_ENFORCEMENT_DISABLED)\s*=\s*\S/i.test(command)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Environment variable manipulation targeting enforcement`,
        severity: 'critical',
      };
    }

    // 2d. Destructive operations (Bug 1: token-based rm parser)
    if (isDestructiveRm(command) ||
        /DROP\s+(DATABASE|TABLE)/i.test(command) ||
        /:\(\)\{.*:\|:.*\}/i.test(command)) {
      return {
        circumvention: true,
        reason: `CIRCUMVENTION: Egregiously destructive command detected`,
        severity: 'critical',
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
      if (/\.(sh|bash|cjs|mjs|js)\b/.test(command) && /^(bash|sh|node|\.\/)/i.test(command.trim())) {
        return {
          circumvention: true,
          reason: 'CIRCUMVENTION: Bash execution of script while write-restricted',
          severity: 'normal',
        };
      }
    }
  }

  return { circumvention: false };
}

/**
 * Bug 1: Token-based rm parser — handles all flag combinations.
 * Detects: rm -rf /, rm -r -f /, rm --recursive --force /, etc.
 * Does NOT flag: rm -rf /tmp/test-dir (non-root targets)
 */
function isDestructiveRm(command) {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== 'rm') return false;

  let hasRecursive = false;
  let hasForce = false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
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
    // This is a path argument — check if it targets root
    if (hasRecursive && hasForce && (t === '/' || t === '/*')) {
      return true;
    }
  }
  return false;
}

/**
 * Bug 6: Reduced false positives for obfuscation.
 * Only flags hex escapes when in execution context or 6+ consecutive.
 * ANSI escapes (\\x1b) are NOT flagged by themselves.
 */
function isObfuscated(command) {
  // Code execution wrapping is always suspicious
  if (/\beval\s*\(/i.test(command)) return true;

  // base64 piped to shell
  if (/base64\s.*\|\s*(sh|bash|node)/i.test(command)) return true;

  // 6+ consecutive hex chars forming a payload
  if (/(?:\\x[0-9a-f]{2}){6,}/i.test(command)) return true;

  // Hex escapes piped to shell/code-execution
  if (/\\x[0-9a-f]{2}/i.test(command) && /\|\s*(sh|bash|node)/i.test(command)) return true;

  // Standalone hex with no execution context — NOT flagged (could be ANSI)
  return false;
}

// ============================================================================
// Tool Restriction
// ============================================================================

function checkToolRestriction(toolName, state) {
  // Unrestricted tools are always allowed
  if (UNRESTRICTED_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // Level 3 (Halted) — block ALL tools except unrestricted
  if (state.level >= LEVELS.HALTED) {
    return {
      allowed: false,
      reason: `[ENFORCEMENT HALT] All tools blocked. ${state.violations} violation(s). Contact the human operator — use /enforcement-reset or /terminate-agent to restore access.`,
    };
  }

  // Level 2 (Restricted) — block tools in restricted groups
  if (state.level >= LEVELS.RESTRICTED) {
    for (const group of state.restrictedGroups) {
      const tools = TOOL_GROUPS[group] || [];
      if (tools.includes(toolName)) {
        return {
          allowed: false,
          reason: `[ENFORCEMENT RESTRICTED] Tool '${toolName}' blocked (group: ${group}). ${state.violations} violation(s). Use allowed tools (Read, Grep, Glob) or ask the human for help.`,
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
  if (!/git\s+commit/i.test(command)) return { blocked: false };

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
    // Also accept unsigned gates during migration
    if (!raw.hmac && raw.status === 'pass' && raw.timestamp) {
      const ts = new Date(raw.timestamp).getTime();
      if (!isNaN(ts) && ts <= Date.now() && (Date.now() - ts) < GATE_MAX_AGE_MS) {
        return { blocked: false };
      }
    }
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

function makeAllow(additionalContext) {
  const result = {};
  if (additionalContext) {
    // N2: Sanitize context — strip XML tags, limit length
    const sanitized = sanitizeContext(additionalContext);
    result.hookSpecificOutput = { permissionDecision: 'allow', additionalContext: sanitized };
  }
  // No hookSpecificOutput needed for allow without context — empty JSON = allow
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
  const toolInput = input?.tool_input || input?.input || {};
  const state = getState();

  // Step 1: Check circumvention
  const circ = detectCircumvention(toolName, toolInput, state);
  if (circ.circumvention) {
    escalate(state, circ.reason, circ.severity || 'normal');
    state.restrictedGroups = [...new Set([
      ...(state.restrictedGroups || []),
      ...getRestrictionGroups(toolName),
    ])];
    const hangCheck = updateActivityTracking(state, true);
    saveState(state);

    const reason = `${circ.reason}. Escalated to level ${state.level}.${hangCheck.hung ? ' ' + hangCheck.message : ''}`;
    return makeDeny(reason);
  }

  // Step 2: Check tool restriction
  const restriction = checkToolRestriction(toolName, state);
  if (!restriction.allowed) {
    const hangCheck = updateActivityTracking(state, true);
    saveState(state);

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

  // Step 4: SendMessage at HALTED — append enforcement warning (12.14)
  if (toolName === 'SendMessage' && state.level >= LEVELS.HALTED) {
    updateActivityTracking(state, false);
    saveState(state);
    return makeAllow(
      '[ENFORCEMENT] This agent is under enforcement restrictions (HALTED). Do not execute tool operations on its behalf.'
    );
  }

  // Step 5: Inject warning at Level 1
  if (state.level === LEVELS.WARNED) {
    updateActivityTracking(state, false);
    saveState(state);
    return makeAllow(
      `[ENFORCEMENT WARNING] You have ${state.violations} violation(s). Further circumvention will restrict tool access. Follow the plan exactly.`
    );
  }

  // Step 6: Normal pass-through
  updateActivityTracking(state, false);
  saveState(state);
  return makeAllow();
}

// ============================================================================
// Human Reset (Bug 4 + 12.7)
// ============================================================================

function resetEnforcement() {
  ensureDir();
  const state = {
    level: LEVELS.NORMAL,
    violations: 0,
    consecutiveDenials: 0,
    lastActivity: new Date().toISOString(),
    restrictedGroups: [], // Bug 4: explicitly clear all groups
    history: [],
    resetAt: new Date().toISOString(),
    integrityCompromised: false,
  };
  saveState(state);
  appendViolation({
    type: 'reset',
    reason: 'Human-initiated enforcement reset',
  });
  return state;
}

/**
 * Process --reset-check flag (UserPromptSubmit hook).
 * Checks if the user's prompt contains /enforcement-reset.
 */
function processResetCheck(input) {
  const prompt = input?.user_prompt || input?.prompt || '';

  // HMAC-signed IPC: verify caller authentication before executing reset
  if (/\/enforcement-reset\b/i.test(prompt)) {
    const signature = input?._hmac_signature;
    const timestamp = input?._hmac_timestamp;

    if (!signature || !timestamp) {
      // Unsigned reset attempt — log as circumvention and reject
      appendViolation({
        type: 'unsigned-reset-attempt',
        reason: 'Reset request without HMAC signature — possible circumvention',
        severity: 'critical',
      });
      return {
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: '[ENFORCEMENT] Reset denied: unsigned request. Resets must be routed through the hook system.',
        },
      };
    }

    // Verify timestamp freshness (30s window)
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 30000) {
      appendViolation({
        type: 'expired-reset-attempt',
        reason: `Reset request with expired timestamp (${timestamp})`,
        severity: 'critical',
      });
      return {
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: '[ENFORCEMENT] Reset denied: expired timestamp. Resets must be recent (within 30s).',
        },
      };
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
      return {
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: '[ENFORCEMENT] Reset denied: invalid signature. Resets must be routed through the hook system.',
        },
      };
    }

    // Signature valid — execute reset
    resetEnforcement();
    return {
      hookSpecificOutput: {
        permissionDecision: 'allow',
        additionalContext: '[ENFORCEMENT] Reset complete. All restrictions cleared. Enforcement level: NORMAL.',
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
  saveState,
  appendViolation,
  escalate,
  detectCircumvention,
  checkToolRestriction,
  getRestrictionGroups,
  checkVerificationGate,
  updateActivityTracking,
  processPreToolUse,
  resetEnforcement,
  processResetCheck,
  getEnforcementStatus,
  setVerificationGate,
  signState,
  verifyState,
  isProtectedPath,
  isDestructiveRm,
  isObfuscated,
  makeAllow,
  makeDeny,
  sanitizeContext,
};
