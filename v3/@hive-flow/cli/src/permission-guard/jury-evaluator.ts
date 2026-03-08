/**
 * Deterministic Pre-Filter — Fast, in-process rule-based evaluators.
 *
 * This module is the FIRST evaluation layer in the Permission Guard pipeline.
 * It uses deterministic pattern matching (no LLM tokens) to handle clear-cut
 * cases at sub-millisecond speed. Three evaluators assess each request:
 * Goal Relevance, Safety (with veto power), and Convention.
 *
 * For ambiguous cases that pass the pre-filter, the LLM jury in llm-jury.ts
 * provides intelligent evaluation with full contextual reasoning.
 */

import type { EvalResult, JuryContext, InlineJuryResult, JuryVerdict, JuryVote } from './types.js';
import { deepInspect } from './deep-inspect.js';

// ---------------------------------------------------------------------------
// Known-safe tool sets
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'TodoRead', 'TaskList',
  'TaskGet', 'NotebookRead', 'WebFetch',
]);

const DEV_CMD_PREFIXES = [
  'git', 'npm', 'npx', 'node', 'tsc', 'eslint', 'prettier', 'jest', 'vitest',
  'cargo', 'go', 'make', 'cmake', 'python', 'pip', 'brew', 'apt', 'docker', 'kubectl',
];

const SAFE_SHELL_CMDS = new Set([
  'cat', 'ls', 'echo', 'pwd', 'whoami', 'date', 'head', 'tail', 'wc',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'find', 'grep', 'rg', 'sed', 'awk',
  'stat', 'file', 'which', 'env', 'uname', 'df', 'du',
]);

const DEV_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb',
  '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.md', '.txt', '.sh', '.sql',
]);

// ---------------------------------------------------------------------------
// Safety deny patterns
// ---------------------------------------------------------------------------

const EXFILTRATION = /\bcurl\s.*(-X\s*POST|--data|--upload-file|-F\s).*\b(?:https?:\/\/)/;
const CREDENTIAL_PATHS = /(?:~\/|\/home\/\w+\/|\/root\/)\.(?:ssh|aws|gnupg|config\/gcloud)|\/etc\/(?:shadow|passwd|sudoers)/;
const REVERSE_SHELL = /bash\s+-i\s+>&\s*\/dev\/tcp|nc\s+-e|python.*socket.*connect/;
const SYSTEM_DESTROY = /\brm\s+-rf\s+\/\s*$|\bdd\s+if=\/dev\/zero\s+of=\/dev\/sd|\bmkfs\b|\bshred\b/;
const FORK_BOMB = /:\(\)\s*\{\s*:\|:&\s*\}/;
const SUDO_DESTRUCTIVE = /\bsudo\s+(?:rm|dd|mkfs|shred|chmod|chown)\b/;
const PATH_TRAVERSAL = /\.\.[\/\\].*\.\.[\/\\].*\.\.[\/\\]/;
const SYSTEM_WRITES = /(?:^|\s)(?:\/etc|\/usr|\/var|\/boot|\/sys|\/proc)\//;
const DOCKER_PRIV = /\bdocker\s+run\s.*(?:--privileged|-v\s+\/:\/)/;
const FORCE_PUSH_MAIN = /\bgit\s+push\s+.*--force.*\s+(?:main|master)\b/;

// ---------------------------------------------------------------------------
// Goal Relevance Pre-Filter
// ---------------------------------------------------------------------------

/** Deterministic goal relevance check — no LLM tokens used. */
export function evaluateGoalRelevance(ctx: JuryContext): EvalResult {
  // Read-only tools always relevant
  if (READ_ONLY_TOOLS.has(ctx.toolName)) {
    return { vote: 'allow', reason: 'Read-only tool', confidence: 0.95 };
  }

  const cmd = (ctx.toolInput.command || '').trim();
  const firstWord = cmd.split(/\s+/)[0] || '';

  // Dev commands
  if (DEV_CMD_PREFIXES.some(p => firstWord === p)) {
    return { vote: 'allow', reason: `Dev command: ${firstWord}`, confidence: 0.85 };
  }

  // Safe shell commands
  if (SAFE_SHELL_CMDS.has(firstWord)) {
    return { vote: 'allow', reason: `Safe shell command: ${firstWord}`, confidence: 0.9 };
  }

  // Write/Edit to dev files
  if ((ctx.toolName === 'Write' || ctx.toolName === 'Edit') && ctx.filePath) {
    const ext = ctx.filePath.substring(ctx.filePath.lastIndexOf('.'));
    if (DEV_EXTENSIONS.has(ext)) {
      return { vote: 'allow', reason: `Dev file write: ${ext}`, confidence: 0.85 };
    }
  }

  // Curl piped to shell
  if (/\bcurl\s.*\|\s*(?:bash|sh)\b/.test(cmd)) {
    return { vote: 'deny', reason: 'Curl piped to shell', confidence: 0.7 };
  }

  // Default: benefit of the doubt
  return { vote: 'allow', reason: 'Default allow for dev work', confidence: 0.5 };
}

// ---------------------------------------------------------------------------
// Safety Pre-Filter (VETO POWER)
// ---------------------------------------------------------------------------

/** Deterministic safety check with veto power — no LLM tokens used. */
export function evaluateSafety(ctx: JuryContext): EvalResult {
  // Read-only tools are always safe
  if (READ_ONLY_TOOLS.has(ctx.toolName)) {
    return { vote: 'allow', reason: 'Read-only tool', confidence: 0.95 };
  }

  const cmd = (ctx.toolInput.command || '').trim();
  const filePath = ctx.filePath || ctx.toolInput.file_path || '';

  // Deep inspection — catches shell wrappers, evasion, obfuscation
  if (cmd && ctx.toolName === 'Bash') {
    const inspection = deepInspect(cmd);
    if (inspection.blocked) {
      return { vote: 'deny', reason: `Deep inspect: ${inspection.reason}`, confidence: 0.95, riskLevel: 'critical' };
    }
  }

  // High-confidence denials (0.9+)
  if (EXFILTRATION.test(cmd)) {
    return { vote: 'deny', reason: 'Data exfiltration attempt', confidence: 0.95, riskLevel: 'critical' };
  }
  if (CREDENTIAL_PATHS.test(cmd) || CREDENTIAL_PATHS.test(filePath)) {
    return { vote: 'deny', reason: 'Credential file access', confidence: 0.9, riskLevel: 'critical' };
  }
  if (REVERSE_SHELL.test(cmd)) {
    return { vote: 'deny', reason: 'Reverse shell attempt', confidence: 0.95, riskLevel: 'critical' };
  }
  if (SYSTEM_DESTROY.test(cmd)) {
    return { vote: 'deny', reason: 'System destruction command', confidence: 0.95, riskLevel: 'critical' };
  }
  if (FORK_BOMB.test(cmd)) {
    return { vote: 'deny', reason: 'Fork bomb detected', confidence: 0.95, riskLevel: 'critical' };
  }
  if (SUDO_DESTRUCTIVE.test(cmd)) {
    return { vote: 'deny', reason: 'Sudo destructive command', confidence: 0.9, riskLevel: 'critical' };
  }
  if (PATH_TRAVERSAL.test(cmd) || PATH_TRAVERSAL.test(filePath)) {
    return { vote: 'deny', reason: 'Path traversal attack', confidence: 0.9, riskLevel: 'high' };
  }

  // Medium-confidence denials (0.7)
  if (/\bchmod\s+777\b/.test(cmd) || SYSTEM_WRITES.test(filePath)) {
    return { vote: 'deny', reason: 'Dangerous permission/system write', confidence: 0.7, riskLevel: 'high' };
  }
  if (DOCKER_PRIV.test(cmd)) {
    return { vote: 'deny', reason: 'Privileged Docker container', confidence: 0.7, riskLevel: 'high' };
  }
  if (FORCE_PUSH_MAIN.test(cmd)) {
    return { vote: 'deny', reason: 'Force push to main/master', confidence: 0.7, riskLevel: 'high' };
  }

  // Safe git/npm commands
  if (/^git\s+(status|log|diff|branch|show|remote|tag)\b/.test(cmd)) {
    return { vote: 'allow', reason: 'Safe git command', confidence: 0.9 };
  }
  if (/^npm\s+(list|ls|outdated|audit)\b/.test(cmd)) {
    return { vote: 'allow', reason: 'Safe npm command', confidence: 0.9 };
  }

  // Default: allow for dev work
  return { vote: 'allow', reason: 'No safety concerns detected', confidence: 0.6 };
}

// ---------------------------------------------------------------------------
// Convention Pre-Filter (maximum leniency)
// ---------------------------------------------------------------------------

/** Deterministic convention check — no LLM tokens used. */
export function evaluateConvention(ctx: JuryContext): EvalResult {
  const cmd = (ctx.toolInput.command || '').trim();
  const filePath = ctx.filePath || ctx.toolInput.file_path || '';

  // Writing bare files to root when src/ exists
  if ((ctx.toolName === 'Write' || ctx.toolName === 'Edit') && filePath) {
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1] || '';
    const dirDepth = parts.filter(p => p && p !== '.').length;
    if (dirDepth <= 1 && /\.(ts|js|py)$/.test(fileName)) {
      return { vote: 'deny', reason: 'Source file in root (use src/)', confidence: 0.5 };
    }
  }

  // --no-verify commits
  if (/\bgit\s+commit\s.*--no-verify\b/.test(cmd)) {
    return { vote: 'deny', reason: 'Commit with --no-verify', confidence: 0.5 };
  }

  // Filenames with spaces in source dirs
  if (filePath && /\/src\/.*\s/.test(filePath)) {
    return { vote: 'deny', reason: 'Filename with spaces in src/', confidence: 0.5 };
  }

  return { vote: 'allow', reason: 'No convention violations', confidence: 0.7 };
}

// ---------------------------------------------------------------------------
// Combined Pre-Filter Verdict
// ---------------------------------------------------------------------------

/**
 * Run all three deterministic pre-filters and combine their results.
 * This is the fast path (<0.1ms) for clear-cut allow/deny decisions.
 * Ambiguous cases should be routed to the LLM jury (llm-jury.ts).
 */
export function evaluateInlineJury(ctx: JuryContext): InlineJuryResult {
  const goalResult = evaluateGoalRelevance(ctx);
  const safetyResult = evaluateSafety(ctx);
  const conventionResult = evaluateConvention(ctx);

  const now = new Date().toISOString();

  const votes: Record<string, JuryVote | null> = {
    'Goal Relevance': { ts: now, vote: goalResult.vote, reason: goalResult.reason },
    'Safety': { ts: now, vote: safetyResult.vote, reason: safetyResult.reason },
    'Convention': { ts: now, vote: conventionResult.vote, reason: conventionResult.reason },
  };

  const results = [goalResult, safetyResult, conventionResult];
  const allowCount = results.filter(r => r.vote === 'allow').length;
  const denyCount = results.filter(r => r.vote === 'deny').length;

  // Safety veto — absolute override
  if (safetyResult.vote === 'deny') {
    const reason = safetyResult.confidence >= 0.9
      ? `[SAFETY VETO] ${safetyResult.reason}`
      : `[SAFETY CONCERN] ${safetyResult.reason}`;
    return { verdict: 'DENIED', votes, reason };
  }

  // 2/3 majority + safety allows
  if (allowCount >= 2) {
    return { verdict: 'APPROVED', votes, reason: 'Majority approved, safety clear' };
  }

  // 2/3 deny
  if (denyCount >= 2) {
    const reasons = results.filter(r => r.vote === 'deny').map(r => r.reason);
    return { verdict: 'DENIED', votes, reason: reasons.join('; ') };
  }

  // Tie-breaker: use highest risk level
  const maxRisk = safetyResult.riskLevel || 'low';
  if (maxRisk === 'high' || maxRisk === 'critical') {
    return { verdict: 'DENIED', votes, reason: `Inconclusive with ${maxRisk} risk — auto-deny` };
  }

  return { verdict: 'APPROVED', votes, reason: 'Inconclusive with low risk — auto-allow' };
}
