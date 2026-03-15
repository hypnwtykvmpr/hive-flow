#!/usr/bin/env node
/**
 * Enforcement System — Layer 1: Deterministic Hook Enforcement
 *
 * Prevents agents from cutting corners by implementing:
 * - Escalation ladder (Normal → Warned → Restricted → Halted)
 * - Circumvention detection (tool sequence abuse, hook tampering, obfuscated retry)
 * - Tool restriction groups (exec, write, fetch)
 * - Verification gate enforcement (blocks commits without verification)
 * - Orphan/hang detection
 *
 * This module runs as a PreToolUse hook — no LLM required.
 * All state is file-based for persistence across compaction.
 *
 * State files:
 *   .hive-flow/enforcement/state.json        — per-agent escalation state
 *   .hive-flow/enforcement/violations.jsonl   — append-only violation log
 *   .hive-flow/enforcement/verification-gate.json — verification gate status
 */
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');
const STATE_FILE = path.join(ENFORCEMENT_DIR, 'state.json');
const VIOLATIONS_FILE = path.join(ENFORCEMENT_DIR, 'violations.jsonl');
const VERIFICATION_GATE_FILE = path.join(ENFORCEMENT_DIR, 'verification-gate.json');

// ============================================================================
// Escalation Levels
// ============================================================================

const LEVELS = {
  NORMAL: 0,
  WARNED: 1,
  RESTRICTED: 2,
  HALTED: 3,
};

// Tool restriction groups — restricting one tool also restricts related tools
const TOOL_GROUPS = {
  exec: ['Bash'],
  write: ['Write', 'Edit', 'MultiEdit'],
  fetch: ['WebFetch'],
};

// Tools that are NEVER restricted (read-only, always safe)
const UNRESTRICTED_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode',
]);

// Protected paths — writes to these are circumvention attempts
const PROTECTED_PATHS = [
  '.claude/settings.json',
  '.claude/helpers/',
  '.hive-flow/enforcement/',
];

// ============================================================================
// State Management
// ============================================================================

function ensureDir() {
  try { fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true }); } catch {}
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function getState() {
  ensureDir();
  const state = readJson(STATE_FILE);
  if (state && typeof state === 'object') return state;
  return {
    level: LEVELS.NORMAL,
    violations: 0,
    consecutiveDenials: 0,
    lastActivity: new Date().toISOString(),
    restrictedGroups: [],
    history: [],
  };
}

function saveState(state) {
  ensureDir();
  state.lastActivity = new Date().toISOString();
  writeJsonAtomic(STATE_FILE, state);
}

function appendViolation(violation) {
  ensureDir();
  try {
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
    // Hook tampering or verification bypass → immediate Level 2
    state.level = Math.max(state.level, LEVELS.RESTRICTED);
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
  if (state.history.length > 50) {
    state.history = state.history.slice(-50);
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
// Circumvention Detection
// ============================================================================

/**
 * Detect if the current tool call is a circumvention attempt.
 * Returns { circumvention: true, reason: string } or { circumvention: false }.
 */
function detectCircumvention(toolName, toolInput, state) {
  // 1. Hook/settings tampering — Write/Edit to protected paths
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.path || '';
    const relativePath = filePath.startsWith(PROJECT_DIR)
      ? filePath.slice(PROJECT_DIR.length + 1)
      : filePath;

    for (const protectedPath of PROTECTED_PATHS) {
      if (relativePath.startsWith(protectedPath) || relativePath === protectedPath.replace(/\/$/, '')) {
        return {
          circumvention: true,
          reason: `Attempted write to protected path: ${relativePath}`,
          severity: 'critical',
        };
      }
    }
  }

  // 2. Tool sequence abuse — Bash after write restriction (writing shell script to bypass)
  if (toolName === 'Bash' && state.restrictedGroups.includes('write')) {
    const command = toolInput?.command || '';
    // Check if running a recently-created script
    if (/\.(sh|bash|cjs|mjs|js)\b/.test(command) && /^(bash|sh|node|\.\/)/i.test(command.trim())) {
      return {
        circumvention: true,
        reason: 'Bash execution of script while write-restricted (potential write bypass)',
        severity: 'normal',
      };
    }
  }

  // 3. Obfuscated retry — hex escapes, eval wrapping
  if (toolName === 'Bash') {
    const command = toolInput?.command || '';
    if (/\\x[0-9a-f]{2}/i.test(command) || /eval\s*\(/i.test(command)) {
      return {
        circumvention: true,
        reason: 'Obfuscated command detected (hex escapes or eval)',
        severity: 'normal',
      };
    }
  }

  // 4. Destructive operations
  if (toolName === 'Bash') {
    const command = toolInput?.command || '';
    if (/rm\s+-rf\s+\/(?!\w)/i.test(command) ||
        /DROP\s+(DATABASE|TABLE)/i.test(command) ||
        /:\(\)\{.*:\|:.*\}/i.test(command)) {
      return {
        circumvention: true,
        reason: 'Egregiously destructive command detected',
        severity: 'critical',
      };
    }
  }

  return { circumvention: false };
}

// ============================================================================
// Tool Restriction
// ============================================================================

/**
 * Check if a tool is restricted at the current escalation level.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
function checkToolRestriction(toolName, state) {
  // Unrestricted tools are always allowed
  if (UNRESTRICTED_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // Level 3 (Halted) — block ALL tools except unrestricted
  if (state.level >= LEVELS.HALTED) {
    return {
      allowed: false,
      reason: `[ENFORCEMENT HALT] All tools blocked. ${state.violations} violations recorded. Contact the human operator to restore access.`,
    };
  }

  // Level 2 (Restricted) — block tools in restricted groups
  if (state.level >= LEVELS.RESTRICTED) {
    for (const group of state.restrictedGroups) {
      const tools = TOOL_GROUPS[group] || [];
      if (tools.includes(toolName)) {
        return {
          allowed: false,
          reason: `[ENFORCEMENT RESTRICTED] Tool '${toolName}' is blocked (group: ${group}). ${state.violations} violations. Use allowed tools or request consultation.`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Determine which tool groups to restrict based on the circumvention type.
 */
function getRestrictionGroups(toolName) {
  if (['Bash'].includes(toolName)) {
    return ['exec', 'write']; // Bash denied → also block Write
  }
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
    return ['write', 'exec']; // Write denied → also block Bash
  }
  if (['WebFetch'].includes(toolName)) {
    return ['fetch', 'exec']; // Fetch denied → also block Bash
  }
  return ['exec']; // Default
}

// ============================================================================
// Verification Gate
// ============================================================================

/**
 * Check if a git commit should be blocked due to missing verification.
 */
function checkVerificationGate(toolName, toolInput) {
  if (toolName !== 'Bash') return { blocked: false };

  const command = toolInput?.command || '';
  if (!/git\s+commit/i.test(command)) return { blocked: false };

  // Check if verification gate exists and is passing
  const gate = readJson(VERIFICATION_GATE_FILE);
  if (gate && gate.status === 'pass' && gate.timestamp) {
    // Gate is valid if it's less than 1 hour old
    const age = Date.now() - new Date(gate.timestamp).getTime();
    if (age < 3600000) {
      return { blocked: false };
    }
  }

  // No valid verification gate — but don't block if enforcement is disabled
  if (process.env.HIVE_FLOW_ENFORCEMENT_DISABLED === '1') {
    return { blocked: false };
  }

  // Check if this is a non-enforcement context (solo developer, no swarm)
  // Don't block individual commits in non-swarm mode
  if (!fs.existsSync(path.join(PROJECT_DIR, '.hive-flow', 'swarm'))) {
    return { blocked: false };
  }

  return {
    blocked: true,
    reason: '[VERIFICATION REQUIRED] git commit blocked. Deploy a verification hive first. Write results to .hive-flow/enforcement/verification-gate.json with status: "pass".',
  };
}

// ============================================================================
// Hang/Orphan Detection
// ============================================================================

function updateActivityTracking(state, denied) {
  if (denied) {
    state.consecutiveDenials = (state.consecutiveDenials || 0) + 1;
  } else {
    state.consecutiveDenials = 0;
  }

  // 5 consecutive denials → agent is hung
  if (state.consecutiveDenials >= 5) {
    return {
      hung: true,
      message: `[ENFORCEMENT] Agent appears hung (${state.consecutiveDenials} consecutive denied tool calls). Consider alternative approaches or use AskUserQuestion.`,
    };
  }

  return { hung: false };
}

// ============================================================================
// Main Hook Entry Point
// ============================================================================

/**
 * Process a PreToolUse hook event.
 * @param {object} input - Hook input (parsed from stdin JSON)
 * @returns {object} Hook response ({ decision: 'allow'|'block', ... })
 */
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
    saveState(state);

    const hangCheck = updateActivityTracking(state, true);
    saveState(state);

    return {
      decision: 'block',
      reason: `[CIRCUMVENTION DETECTED] ${circ.reason}. Escalated to level ${state.level}.${hangCheck.hung ? ' ' + hangCheck.message : ''}`,
    };
  }

  // Step 2: Check tool restriction
  const restriction = checkToolRestriction(toolName, state);
  if (!restriction.allowed) {
    const hangCheck = updateActivityTracking(state, true);
    saveState(state);

    return {
      decision: 'block',
      reason: restriction.reason + (hangCheck.hung ? ' ' + hangCheck.message : ''),
    };
  }

  // Step 3: Check verification gate (for git commit)
  const verifyGate = checkVerificationGate(toolName, toolInput);
  if (verifyGate.blocked) {
    appendViolation({
      type: 'verification-gate-blocked',
      tool: toolName,
      command: (toolInput?.command || '').slice(0, 200),
    });

    return {
      decision: 'block',
      reason: verifyGate.reason,
    };
  }

  // Step 4: Inject warning at Level 1
  if (state.level === LEVELS.WARNED) {
    updateActivityTracking(state, false);
    saveState(state);

    return {
      decision: 'allow',
      additionalContext: `[ENFORCEMENT WARNING] You have ${state.violations} violation(s). Further circumvention will restrict tool access. Follow the plan exactly.`,
    };
  }

  // Step 5: Normal pass-through
  updateActivityTracking(state, false);
  saveState(state);

  return { decision: 'allow' };
}

/**
 * Reset enforcement state. Only callable by human or with override.
 */
function resetEnforcement() {
  ensureDir();
  const freshState = {
    level: LEVELS.NORMAL,
    violations: 0,
    consecutiveDenials: 0,
    lastActivity: new Date().toISOString(),
    restrictedGroups: [],
    history: [],
    resetAt: new Date().toISOString(),
  };
  saveState(freshState);
  return freshState;
}

/**
 * Get current enforcement status (for display/monitoring).
 */
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
    recentHistory: (state.history || []).slice(-5),
  };
}

/**
 * Set verification gate status.
 */
function setVerificationGate(status, details) {
  ensureDir();
  writeJsonAtomic(VERIFICATION_GATE_FILE, {
    status, // 'pass' or 'fail'
    timestamp: new Date().toISOString(),
    details: details || {},
  });
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

if (require.main === module) {
  const rawInput = readStdin();
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    input = {};
  }

  const result = processPreToolUse(input);
  try {
    process.stdout.write(JSON.stringify(result));
  } catch {}
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
  getEnforcementStatus,
  setVerificationGate,
};
