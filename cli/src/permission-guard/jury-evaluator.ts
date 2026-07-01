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
  'cargo', 'go', 'make', 'cmake', 'python', 'python3', 'pip', 'pip3', 'brew', 'apt', 'docker', 'kubectl',
];

const SAFE_SHELL_CMDS = new Set([
  'cat', 'ls', 'echo', 'pwd', 'whoami', 'date', 'head', 'tail', 'wc',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'find', 'grep', 'rg', 'sed', 'awk',
  'stat', 'file', 'which', 'env', 'uname', 'df', 'du', 'ps', 'printf',
  'curl', 'jq', 'mkdir', 'touch', 'cp', 'mv', 'tree',
]);

const DEV_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb',
  '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.md', '.txt', '.sh', '.sql',
]);

// ---------------------------------------------------------------------------
// Safety deny patterns
// ---------------------------------------------------------------------------

const EXFILTRATION = /\bcurl\b(?=[\s\S]*\b[Hh][Tt][Tt][Pp][Ss]?:\/\/)(?=[\s\S]*(?:(?:^|\s)-d(?:\b|\S+)|--data(?:-binary|-raw|-urlencode)?(?:\b|=)|(?:^|\s)-T(?:\b|\S+)|--upload-file(?:\b|=)|(?:^|\s)-F(?:\b|\S+)|--form(?:\b|=)|(?:^|\s)-X\s*POST\b))/;
const CREDENTIAL_PATHS = /(?:~\/|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|\/root\/)\.(?:ssh|aws|gnupg|config\/gcloud)|(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root)\/\.hive-flow\/(?:credential-vault[^\s]*|credentials(?:\/|\b)[^\s]*|run\/credential-agent\.sock)|\/etc\/(?:shadow|passwd|sudoers)|\/proc\/\d+\/environ/;
const CREDENTIAL_EXPOSURE_COMMANDS = /\bprintenv\b(?=[\s\S]*(?:API[_-]?KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|OPENROUTER|ANTHROPIC|DEEPSEEK|CODEX|GEMINI|GOOGLE|CURSOR|QWEN|DASHSCOPE))|\bps\b(?=[\s\S]*(?:\beww\b|(?:^|\s)-E(?:\s|$)))|\bsecurity\s+find-generic-password\b(?=[\s\S]*(?:\s-w\b|--password\b))|\bsecret-tool\s+lookup\b|\bcmdkey\b|\b(?:powershell|pwsh)\b(?=[\s\S]*Get-StoredCredential)/i;
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
  if (CREDENTIAL_PATHS.test(cmd) || CREDENTIAL_PATHS.test(filePath) || CREDENTIAL_EXPOSURE_COMMANDS.test(cmd)) {
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

function maxRiskLevel(results: EvalResult[]): NonNullable<InlineJuryResult['maxRisk']> {
  const riskRank = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  return results.reduce((max, result) => {
    const risk = result.riskLevel || 'low';
    return riskRank[risk] > riskRank[max] ? risk : max;
  }, 'low' as NonNullable<InlineJuryResult['maxRisk']>);
}

function ambiguousResult(votes: Record<string, JuryVote | null>, results: EvalResult[]): InlineJuryResult {
  const maxRisk = maxRiskLevel(results);
  const fallbackVerdict = maxRisk === 'none' || maxRisk === 'low' ? 'APPROVED' : 'DENIED';
  return {
    verdict: 'AMBIGUOUS',
    votes,
    reason: `Inconclusive with ${maxRisk} risk — fallback ${fallbackVerdict.toLowerCase()}`,
    fallbackVerdict,
    maxRisk,
  };
}

function hasConfidentAllowMajority(goalResult: EvalResult, results: EvalResult[]): boolean {
  const allowResults = results.filter(r => r.vote === 'allow');
  const confidentAllowVotes = allowResults.filter(r => r.confidence >= 0.6).length;
  const hasExplicitGoalRelevance = !(goalResult.reason === 'Default allow for dev work' && goalResult.confidence <= 0.5);
  return hasExplicitGoalRelevance && confidentAllowVotes >= 2;
}

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

  // 2/3 deny
  if (denyCount >= 2) {
    const reasons = results.filter(r => r.vote === 'deny').map(r => r.reason);
    return { verdict: 'DENIED', votes, reason: reasons.join('; ') };
  }

  // 2/3 majority + safety allows only when the majority is confident. A bare
  // default benefit-of-the-doubt vote is the ambiguous middle from the design.
  if (allowCount >= 2 && hasConfidentAllowMajority(goalResult, results)) {
    return { verdict: 'APPROVED', votes, reason: 'Majority approved, safety clear' };
  }

  // Tie/split/low-confidence middle: surface ambiguity to the gate. The caller
  // may ask the Stage-2 LLM jury, but falls back to the prior risk behavior.
  return ambiguousResult(votes, results);
}
