/**
 * Permission Gate — Deterministic pre-filter for permission decisions.
 *
 * Layer 1 of the Permission Guard system. Handles clear-cut allow/deny
 * decisions without LLM tokens. Ambiguous cases are decided by the inline
 * deterministic jury. Dangerous commands (rm, sudo, kill, etc.) are
 * auto-denied with actionable feedback. NOTHING reaches the human.
 *
 * Ported from Python permission_gate.py.
 */

import { writeFileSync, appendFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve, relative, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  PermissionConfig,
  GateResult,
  EscalationContext,
  HookInput,
  AuditLogEntry,
  BashPatternEntry,
  DenyPatternEntry,
  InlineJuryResult,
  JuryContext,
} from './types.js';
import { deepInspect } from './deep-inspect.js';
import { evaluateInlineJury } from './jury-evaluator.js';
import { tryConsumeLLMJuryBudget } from './llm-jury-budget.js';
import { classifyCommand } from './risk-classifier.js';
import { evaluateSelfProtection } from './self-protection.js';
import {
  findProtectedReadPath,
  resolveProjectRoot as resolveProtectedProjectRoot,
  resolveRealPathForPolicy,
} from './protected-paths.js';
import { isSecretPath } from './secret-paths.js';
import { loadLayeredPermissionConfig, resetPermissionResolverCache } from './permission-resolver.js';
import { getCompiledPattern } from './glob-to-regex.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * FORBIDDEN_PATTERNS — hardcoded patterns that CANNOT be approved by any
 * automated system (jury, learned patterns, or otherwise). This is the final
 * defense layer: even if a bug in the jury or pre-filter somehow produces an
 * allow verdict for a forbidden command, this safeguard catches it and
 * overrides to deny.
 */
const FORBIDDEN_PATTERNS = [
  '^rm\\s+.*(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|--recursive\\b.*--force\\b|--force\\b.*--recursive\\b)',
  '^sudo\\s+rm\\b',
  '^chmod\\s+777\\b',
  '^chmod\\s+-R\\b',
  '^chown\\b',
  '^killall\\b',
  '^docker\\s+rm\\b', '^docker\\s+rmi\\b',
  '^git\\s+push\\s+--force', '^git\\s+push\\s+-f\\b',
  '^git\\s+reset\\s+--hard',
];

const HOME = homedir();
const CONTEXT_DIR = join(HOME, '.claude', 'hooks', 'escalation_context');
const VERDICT_FILE = join(CONTEXT_DIR, 'last_verdict.json');
const VERDICT_STALENESS = 120.0; // seconds

const LOG_INPUT_SUMMARY_MAX = 200;
const TOOL_INPUT_VALUE_MAX = 500;
const DEFAULT_INPUT_SUMMARY_MAX = 100;
const SANITIZE_MAX_LENGTH = 500;

export const PERMISSION_GUARD_BUILD_STAMP = 'm2-c1-2026-06-04';

export function loadConfig(overridePath?: string, hookInput?: Partial<HookInput>): PermissionConfig {
  return loadLayeredPermissionConfig({
    globalConfigPath: overridePath,
    cwd: hookInput?.cwd,
    sessionInput: hookInput,
    env: process.env,
  });
}

/** Reset config cache (for testing). */
export function resetConfigCache(): void {
  resetPermissionResolverCache();
}

// ---------------------------------------------------------------------------
// Prompt injection sanitization
// ---------------------------------------------------------------------------

export function sanitizeForPrompt(value: string): string {
  // Normalize Unicode to decomposed form (NFKD) to defeat homoglyph-based
  // prompt injection bypass (e.g. fullwidth "ＩＧＮＯＲＥ" → ASCII "IGNORE")
  let v = value.normalize('NFKD').slice(0, SANITIZE_MAX_LENGTH);
  // Strip XML-like tags
  v = v.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?>/g, '');
  // Strip LLM control tokens (e.g. <|endoftext|>, <|im_start|>, <|system|>)
  v = v.replace(/<\|[^>]*\|>/g, '');
  // Remove prompt injection markers
  const injectionPatterns = [
    /\bIGNORE\s+(?:ALL\s+)?PREVIOUS\s+INSTRUCTIONS?\b/i,
    /\bIGNORE\s+(?:ALL\s+)?ABOVE\b/i,
    /\bYou\s+are\s+now\b/i,
    /\bYou\s+are\s+a\b/i,
    /\bIMPORTANT\s*:/i,
    /\bSTEP\s+\d+\s*:/i,
    /\bSYSTEM\s*:/i,
    /\bINSTRUCTION\s*:/i,
    /\bNew\s+instructions?\s*:/i,
    /\bDisregard\b/i,
    /\bForget\s+(everything|all|previous)\b/i,
    /\bOverride\b/i,
    /\brespond\s+with\s+ONLY\b/i,
  ];
  for (const pattern of injectionPatterns) {
    v = v.replace(pattern, '[REDACTED]');
  }
  // Escape markdown heading markers
  v = v.replace(/^(#{1,6})\s/gm, '\\$1 ');
  return v;
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolvePolicyRoot(hookInput: Partial<HookInput>, cwd: string): string {
  void hookInput;
  return resolveProtectedProjectRoot({ env: process.env, cwd });
}

function hasSubagentIdentity(hookInput: Partial<HookInput>): boolean {
  if (process.env.CLAUDE_PARENT_AGENT_ID) return true;
  if (process.env.HIVE_FLOW_AGENT_ID || process.env.CLAUDE_AGENT_ID) return true;
  const hookAgentId = (hookInput as Record<string, unknown>).agent_id
    || (hookInput as Record<string, unknown>).agentId;
  return typeof hookAgentId === 'string' && hookAgentId.trim().length > 0;
}

function resolvePathVar(pattern: string, cwd: string, projectRoot: string = cwd): string {
  return pattern
    .replace('${HOME}', HOME)
    .replace('${PROJECT_ROOT}', projectRoot)
    .replace('${CWD}', cwd);
}

function findSensitiveReadPath(toolName: string, toolInput: Record<string, unknown>, projectRoot: string): string | null {
  if (toolName === 'mcp__filesystem__read_multiple_files') {
    const paths = Array.isArray(toolInput.paths) ? toolInput.paths : [];
    for (const entry of paths) {
      const filePath = typeof entry === 'string' ? entry : '';
      if (findProtectedReadPath(filePath, projectRoot)) return filePath;
    }
    return null;
  }

  const readPath = (toolInput.file_path as string)
    || (toolInput.path as string)
    || (toolInput.notebook_path as string)
    || '';
  const readTools = new Set([
    'Read',
    'NotebookRead',
    'mcp__filesystem__read_file',
    'mcp__filesystem__read_text_file',
    'mcp__filesystem__read_media_file',
  ]);
  if (!readTools.has(toolName)) return null;
  return findProtectedReadPath(readPath, projectRoot) ? readPath : null;
}

function findSecretReadPath(toolName: string, toolInput: Record<string, unknown>): string | null {
  try {
    if (toolName === 'mcp__filesystem__read_multiple_files') {
      const paths = Array.isArray(toolInput.paths) ? toolInput.paths : [];
      for (const entry of paths) {
        const filePath = typeof entry === 'string' ? entry : '';
        if (filePath && isSecretPath(filePath)) return filePath;
      }
      return null;
    }

    const readPath = (toolInput.file_path as string)
      || (toolInput.path as string)
      || (toolInput.notebook_path as string)
      || '';
    const readTools = new Set([
      'Read',
      'NotebookRead',
      'mcp__filesystem__read_file',
      'mcp__filesystem__read_text_file',
      'mcp__filesystem__read_media_file',
    ]);
    if (!readTools.has(toolName)) return null;
    return readPath && isSecretPath(readPath) ? readPath : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export function logDecision(
  config: Partial<PermissionConfig>,
  tool: string,
  inputSummary: string,
  decision: string,
  layer: string,
  reason: string,
  extras?: Partial<Pick<AuditLogEntry,
    'scale_position' | 'matched_pattern' | 'risk_level' |
    'jury_votes' | 'feedback_given' | 'session_id' |
    'sequence_id' | 'juror_latency_ms'>>,
): void {
  const logFile = (config.log_file || join(HOME, '.claude', 'hooks', 'permission_log.jsonl'))
    .replace('${HOME}', HOME);
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const entry: AuditLogEntry = {
      ts: new Date().toISOString(),
      tool,
      input_summary: inputSummary.slice(0, LOG_INPUT_SUMMARY_MAX),
      decision,
      layer,
      reason,
      ...extras,
    };
    appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Logging failure should never block the decision
  }
}

// ---------------------------------------------------------------------------
// Jury resolution
// ---------------------------------------------------------------------------

interface ResolveJuryOptions {
  config: Partial<PermissionConfig>;
  hookInput: HookInput;
  toolName: string;
  inputSummary: string;
  juryCtx: JuryContext;
  logPrefix?: string;
  responsePrefix: string;
  additionalContext?: (reason: string) => string;
}

function stringToolInput(toolInput: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(toolInput).map(([key, value]) => [key, String(value)]));
}

function makeJuryContext(hookInput: HookInput, policyRoot: string, filePath = ''): JuryContext {
  return {
    toolName: hookInput.tool_name,
    toolInput: stringToolInput(hookInput.tool_input || {}),
    cwd: policyRoot,
    filePath,
  };
}

function prefixReason(prefix: string | undefined, reason: string): string {
  return prefix ? `${prefix} — ${reason}` : reason;
}

function fallbackVerdict(inline: InlineJuryResult): 'APPROVED' | 'DENIED' {
  if (inline.fallbackVerdict === 'APPROVED' || inline.fallbackVerdict === 'DENIED') {
    return inline.fallbackVerdict;
  }
  return inline.maxRisk === 'none' || inline.maxRisk === 'low' ? 'APPROVED' : 'DENIED';
}

function learningCommand(juryCtx: JuryContext): string {
  if (juryCtx.toolInput.command) return juryCtx.toolInput.command;
  if (juryCtx.filePath) return juryCtx.filePath;
  return JSON.stringify(juryCtx.toolInput).slice(0, DEFAULT_INPUT_SUMMARY_MAX);
}

function hasJurySubject(juryCtx: JuryContext): boolean {
  if (!juryCtx.toolName.trim()) return false;
  if (juryCtx.toolName.startsWith('mcp__')) return true;
  if (juryCtx.toolName === 'Bash') return Boolean(juryCtx.toolInput.command?.trim());
  if (juryCtx.filePath?.trim()) return true;
  return Object.values(juryCtx.toolInput).some(value => value.trim().length > 0);
}

async function recordAllowVerdict(juryCtx: JuryContext): Promise<void> {
  try {
    const { normalizeCommand, recordVerdict } = await import('./vote-learner.js');
    recordVerdict(juryCtx.toolName, normalizeCommand(learningCommand(juryCtx)), 'allow');
  } catch {
    // Vote learning is opportunistic and must not affect the gate decision.
  }
}

function juryResponse(prefix: string, reason: string): string {
  return `[${prefix}] ${reason}`;
}

function withAdditionalContext(
  decision: GateResult,
  additionalContext: ResolveJuryOptions['additionalContext'],
  reason: string,
): GateResult {
  if (!additionalContext) return decision;
  return { ...decision, additionalContext: additionalContext(reason) };
}

function fallbackResult(options: ResolveJuryOptions, inline: InlineJuryResult, fallbackReason: string): GateResult {
  const verdict = fallbackVerdict(inline);
  const decision = verdict === 'APPROVED' ? 'allow' : 'deny';
  logDecision(
    options.config,
    options.toolName,
    options.inputSummary,
    decision,
    'inline-jury',
    prefixReason(options.logPrefix, `jury fallback ${decision}: ${fallbackReason}`),
    { session_id: options.hookInput.session_id },
  );
  const result: GateResult = {
    decision,
    reason: juryResponse(options.responsePrefix, inline.reason),
  };
  return withAdditionalContext(result, options.additionalContext, inline.reason);
}

async function resolveJury(options: ResolveJuryOptions): Promise<GateResult> {
  const inline = evaluateInlineJury(options.juryCtx);

  if (inline.verdict === 'APPROVED') {
    logDecision(
      options.config,
      options.toolName,
      options.inputSummary,
      'allow',
      'inline-jury',
      prefixReason(options.logPrefix, `jury approved: ${inline.reason}`),
      { session_id: options.hookInput.session_id },
    );
    return { decision: 'allow', reason: juryResponse(options.responsePrefix, inline.reason) };
  }

  if (inline.verdict === 'DENIED') {
    logDecision(
      options.config,
      options.toolName,
      options.inputSummary,
      'deny',
      'inline-jury',
      prefixReason(options.logPrefix, `jury denied: ${inline.reason}`),
      { session_id: options.hookInput.session_id },
    );
    return withAdditionalContext(
      { decision: 'deny', reason: juryResponse(options.responsePrefix, inline.reason) },
      options.additionalContext,
      inline.reason,
    );
  }

  if (!hasJurySubject(options.juryCtx)) {
    const reason = 'DENIED: malformed permission request has no tool target or command to evaluate.';
    logDecision(
      options.config,
      options.toolName,
      options.inputSummary,
      'deny',
      'deterministic',
      prefixReason(options.logPrefix, 'malformed no-subject request'),
      { session_id: options.hookInput.session_id },
    );
    return { decision: 'deny', reason };
  }

  const sessionId = resolveHookSessionId(options.hookInput) || 'unknown-session';
  const budgetAllowed = tryConsumeLLMJuryBudget(sessionId, {
    maxCalls: options.config.llm_jury_budget_max_calls,
    windowMs: options.config.llm_jury_budget_window_ms,
    budgetDir: options.config.llm_jury_budget_dir,
  });
  if (!budgetAllowed) {
    return fallbackResult(options, inline, `budget unavailable or exhausted; ${inline.reason}`);
  }

  try {
    const { evaluateLLMJury } = await import('./llm-jury.js');
    const llm = await evaluateLLMJury(options.juryCtx, { timeoutMs: 12_000 });
    if (llm?.verdict === 'APPROVED') {
      await recordAllowVerdict(options.juryCtx);
      logDecision(
        options.config,
        options.toolName,
        options.inputSummary,
        'allow',
        'llm-jury',
        prefixReason(options.logPrefix, `LLM jury approved: ${llm.reason}`),
        { session_id: options.hookInput.session_id, juror_latency_ms: llm.totalLatencyMs },
      );
      return { decision: 'allow', reason: juryResponse('LLM Jury', llm.reason) };
    }
    if (llm?.verdict === 'DENIED') {
      logDecision(
        options.config,
        options.toolName,
        options.inputSummary,
        'deny',
        'llm-jury',
        prefixReason(options.logPrefix, `LLM jury denied: ${llm.reason}`),
        { session_id: options.hookInput.session_id, juror_latency_ms: llm.totalLatencyMs },
      );
      return withAdditionalContext(
        { decision: 'deny', reason: juryResponse('LLM Jury', llm.reason) },
        options.additionalContext,
        llm.reason,
      );
    }
    return fallbackResult(options, inline, llm ? `LLM returned ${llm.verdict}; ${inline.reason}` : `LLM provider unavailable; ${inline.reason}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallbackResult(options, inline, `LLM jury errored (${message}); ${inline.reason}`);
  }
}

// ---------------------------------------------------------------------------
// Bash command analysis
// ---------------------------------------------------------------------------

function extractBashCommand(toolInput: Record<string, unknown>): string {
  return (toolInput.command as string) || '';
}

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)\s+/;

export function stripCommand(cmd: string): string {
  let stripped = cmd.trim();
  while (ENV_VAR_RE.test(stripped)) {
    const prev = stripped;
    stripped = stripped.replace(ENV_VAR_RE, '');
    if (stripped === prev) break;
  }
  return stripped.trim();
}

function isCommentEntry(entry: BashPatternEntry): boolean {
  if (typeof entry === 'string') return entry.startsWith('COMMENT:');
  if (typeof entry === 'object' && entry !== null && !('pattern' in entry)) return true;
  return false;
}

export function checkBashPatterns(cmd: string, patterns: BashPatternEntry[]): string | null {
  const stripped = stripCommand(cmd);
  for (const entry of patterns) {
    if (isCommentEntry(entry)) continue;
    let pattern: string;
    let feedback: string | null;
    if (typeof entry === 'object' && 'pattern' in entry) {
      const de = entry as DenyPatternEntry;
      pattern = de.pattern;
      feedback = de.feedback || 'DENIED: This command is blocked.';
    } else if (typeof entry === 'string') {
      pattern = entry;
      feedback = null;
    } else {
      continue;
    }
    if (!pattern) continue;
    try {
      if (getCompiledPattern(pattern).test(stripped)) {
        return feedback;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function checkPatternList(cmd: string, patterns: BashPatternEntry[]): boolean {
  const stripped = stripCommand(cmd);
  for (const entry of patterns) {
    if (typeof entry !== 'string' || entry.startsWith('COMMENT:')) continue;
    try {
      if (getCompiledPattern(entry).test(stripped)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function checkBashAllow(cmd: string, patterns: BashPatternEntry[]): boolean {
  return checkPatternList(cmd, patterns);
}

export function checkBashEscalation(cmd: string, patterns: BashPatternEntry[]): boolean {
  return checkPatternList(cmd, patterns);
}

// ---------------------------------------------------------------------------
// Quote-aware shell command splitting
// ---------------------------------------------------------------------------

/**
 * Split a shell command string on unquoted operators (&&, ||, ;, |).
 * Respects single quotes, double quotes, $'...' (ANSI-C), and backslash escapes.
 * Returns trimmed, non-empty segments.
 */
export function splitShellCommands(cmd: string): string[] {
  if (!cmd.trim()) return [];

  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inDollarQuote = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }

    // Enter $'...' quoting — consume both $ and ' atomically
    if (ch === '$' && !inSingle && !inDouble && !inDollarQuote && cmd[i + 1] === "'") {
      inDollarQuote = true;
      current += "$'";
      i++; // skip the opening quote
      continue;
    }

    // Close $'...' quoting
    if (ch === "'" && inDollarQuote) {
      inDollarQuote = false;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDouble && !inDollarQuote) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle && !inDollarQuote) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    // Only split on operators when not inside any quotes
    if (!inSingle && !inDouble && !inDollarQuote) {
      // Shell treats physical newlines like command separators. CRLF is a
      // single separator so Windows-pasted commands cannot bypass segment checks.
      if (ch === '\n' || ch === '\r') {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = '';
        if (ch === '\r' && cmd[i + 1] === '\n') i++;
        continue;
      }

      // Check for && (two chars)
      if (ch === '&' && cmd[i + 1] === '&') {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = '';
        i++; // skip second &
        continue;
      }

      // Check for || (two chars) — must check before single |
      if (ch === '|' && cmd[i + 1] === '|') {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = '';
        i++; // skip second |
        continue;
      }

      // Check for single | (pipe)
      if (ch === '|') {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = '';
        continue;
      }

      // Check for ;
      if (ch === ';') {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = '';
        continue;
      }
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) segments.push(trimmed);

  return segments;
}

function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inDollarQuote = false;
  let escaped = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === '$' && !inSingle && !inDouble && !inDollarQuote && segment[i + 1] === "'") {
      inDollarQuote = true;
      i += 1;
      continue;
    }

    if (ch === "'" && inDollarQuote) {
      inDollarQuote = false;
      continue;
    }

    if (ch === "'" && !inDouble && !inDollarQuote) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle && !inDollarQuote) {
      inDouble = !inDouble;
      continue;
    }

    if (/\s/.test(ch) && !inSingle && !inDouble && !inDollarQuote) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escaped || inSingle || inDouble || inDollarQuote) return null;
  if (current) words.push(current);
  return words;
}

function isTrustedRootPermissionSession(hookInput: Partial<HookInput>): boolean {
  const sessionId = resolveHookSessionId(hookInput);
  return Boolean(sessionId) && !hasSubagentIdentity(hookInput);
}

const GIT_CHECKOUT_BLOCKED_OPTIONS = new Set([
  '-f',
  '--force',
  '-p',
  '--patch',
  '-m',
  '--merge',
  '--conflict',
  '--detach',
  '--orphan',
  '--ours',
  '--theirs',
  '--ignore-skip-worktree-bits',
  '--pathspec-from-file',
  '--pathspec-file-nul',
  '--recurse-submodules',
  '--no-recurse-submodules',
  '--overlay',
  '--no-overlay',
]);

function nonEmptySessionValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveHookSessionId(hookInput: Partial<HookInput>): string | null {
  const record = hookInput as Record<string, unknown>;
  return (
    nonEmptySessionValue(record.session_id) ??
    nonEmptySessionValue(record.sessionId) ??
    nonEmptySessionValue(process.env.CODEX_SESSION_ID) ??
    nonEmptySessionValue(process.env.CLAUDE_SESSION_ID) ??
    nonEmptySessionValue(process.env.HIVE_FLOW_SESSION_ID)
  );
}

const GIT_OPTIONS_WITH_VALUES = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
]);

function isGitOptionWithInlineValue(token: string): boolean {
  return (
    token.startsWith('-c=') ||
    token.startsWith('--git-dir=') ||
    token.startsWith('--work-tree=') ||
    token.startsWith('--namespace=')
  );
}

function checkoutOptionName(token: string): string {
  if (token.startsWith('--conflict=')) return '--conflict';
  if (token.startsWith('--pathspec-from-file=')) return '--pathspec-from-file';
  return token;
}

function isSafeBranchCheckoutTarget(target: string): boolean {
  if (!target || target === '-' || target === 'HEAD' || target === '--') return false;
  if (target.startsWith('-')) return false;
  if (/^[0-9a-f]{7,40}$/i.test(target)) return false;
  if (target.includes('..') || target.includes('@{')) return false;
  if (target.includes('\\') || target.includes('//')) return false;
  if (target.startsWith('/') || target.endsWith('/')) return false;
  if (target.endsWith('.') || target.endsWith('.lock')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target);
}

function isTrustedRootBranchCheckout(command: string, hookInput: Partial<HookInput>): boolean {
  if (!isTrustedRootPermissionSession(hookInput)) return false;

  const segments = splitShellCommands(command);
  if (segments.length !== 1) return false;

  const segment = segments[0].trim();
  const stripped = stripCommand(segment);
  if (stripped !== segment) return false;

  const tokens = shellWords(stripped);
  if (!tokens || tokens.length !== 3) return false;
  if (commandBasename(tokens[0] || '') !== 'git') return false;
  if (tokens[1] !== 'checkout') return false;

  const target = tokens[2];
  if (target === undefined || target === '--') return false;
  if (GIT_CHECKOUT_BLOCKED_OPTIONS.has(checkoutOptionName(target))) return false;
  return isSafeBranchCheckoutTarget(target);
}

function isGitCheckoutSegment(segment: string): boolean {
  const tokens = shellWords(stripCommand(segment));
  if (!tokens || tokens.length < 2) return false;
  let index = 0;
  let executable = commandBasename(tokens[index] || '');

  if (executable === 'command') {
    index += 1;
    while (tokens[index]?.startsWith('-')) index += 1;
    executable = commandBasename(tokens[index] || '');
  } else if (executable === 'env') {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (isEnvAssignment(token)) {
        index += 1;
        continue;
      }
      if (token === '-i' || token === '--ignore-environment') {
        index += 1;
        continue;
      }
      if (token === '-u' || token === '--unset' || token === '--chdir' || token === '-C') {
        index += 2;
        continue;
      }
      if (token.startsWith('--unset=') || token.startsWith('--chdir=')) {
        index += 1;
        continue;
      }
      break;
    }
    executable = commandBasename(tokens[index] || '');
  }

  if (executable !== 'git') return false;

  index += 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const token = tokens[index];
    if (token === '--') return false;
    if (GIT_OPTIONS_WITH_VALUES.has(token)) {
      index += 2;
      continue;
    }
    if (isGitOptionWithInlineValue(token)) {
      index += 1;
      continue;
    }
    return false;
  }

  return tokens[index] === 'checkout';
}

function isGitCheckoutInvocation(command: string): boolean {
  return splitShellCommands(command).some(segment => isGitCheckoutSegment(segment));
}

const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'grep',
  'rg',
  'strings',
  'xxd',
  'hexdump',
  'od',
  'readlink',
  'nl',
  'tac',
]);

const WIN_EXEC_EXT = new Set(['exe', 'cmd', 'bat', 'com', 'ps1', 'vbs', 'wsf', 'msc', 'scr']);

function commandBasename(command: string): string {
  let name = basename(String(command || '').replace(/\\/g, '/')).toLowerCase();
  name = name.replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  if (dot > 0 && WIN_EXEC_EXT.has(name.slice(dot + 1))) {
    name = name.slice(0, dot);
  }
  return name;
}

function readLeadingShellToken(segment: string): { token: string; rest: string } | null {
  const text = segment.trimStart();
  if (!text) return null;

  if (text.startsWith("$'")) {
    let escaped = false;
    let token = '';
    for (let i = 2; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "'" && !escaped) return { token, rest: text.slice(i + 1) };
      token += ch;
      escaped = ch === '\\' && !escaped;
      if (ch !== '\\') escaped = false;
    }
    return null;
  }

  const quote = text[0] === '"' || text[0] === "'" ? text[0] : null;
  if (quote) {
    let escaped = false;
    let token = '';
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === quote && !escaped) return { token, rest: text.slice(i + 1) };
      token += ch;
      escaped = quote === '"' && ch === '\\' && !escaped;
      if (quote !== '"' || ch !== '\\') escaped = false;
    }
    return null;
  }

  const match = text.match(/^(\S+)([\s\S]*)$/);
  return match ? { token: match[1], rest: match[2] } : null;
}

function normalizeForbiddenSegmentExecutable(segment: string): string {
  const parsed = readLeadingShellToken(segment);
  if (!parsed) return segment;
  const normalized = commandBasename(parsed.token);
  return normalized ? `${normalized}${parsed.rest}` : segment;
}

function isReadCommand(command: string): boolean {
  const name = commandBasename(command);
  return READ_COMMANDS.has(name) || name.endsWith('sum');
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

interface OptionHandling {
  consumeNext: boolean;
  nextIsPattern?: boolean;
  nextIsPath?: boolean;
  selfIsPattern?: boolean;
}

function optionHandling(command: string, option: string): OptionHandling {
  const grepLike = command === 'grep' || command === 'rg';
  if (grepLike) {
    if (/^(?:-e.+|--regexp=.+)$/.test(option)) return { consumeNext: false, selfIsPattern: true };
    if (option === '-e' || option === '--regexp') return { consumeNext: true, nextIsPattern: true };
    if (option === '-f' || option === '--file') return { consumeNext: true, nextIsPath: true };
    if (/^(?:--type|--glob|--max-count|--context|--after-context|--before-context|--include|--exclude|--exclude-dir|--binary-files|--devices|--directories)=/.test(option)) {
      return { consumeNext: false };
    }
    if ([
      '--type',
      '--glob',
      '--max-count',
      '--context',
      '--after-context',
      '--before-context',
      '--include',
      '--exclude',
      '--exclude-dir',
      '--binary-files',
      '--devices',
      '--directories',
      '-g',
      '-m',
      '-A',
      '-B',
      '-C',
    ].includes(option)) {
      return { consumeNext: true };
    }
  }

  if ((command === 'head' || command === 'tail') && [
    '-n',
    '-c',
    '--lines',
    '--bytes',
  ].includes(option)) {
    return { consumeNext: true };
  }

  if (command === 'od' && [
    '-A',
    '-j',
    '-N',
    '-t',
    '-w',
    '--address-radix',
    '--skip-bytes',
    '--read-bytes',
    '--format',
    '--width',
  ].includes(option)) {
    return { consumeNext: true };
  }

  if (command === 'xxd' && [
    '-c',
    '-g',
    '-l',
    '-s',
  ].includes(option)) {
    return { consumeNext: true };
  }

  return { consumeNext: false };
}

function isSecretEnvName(name: string): boolean {
  return /(?:secret|token|credential|password|passwd|api[_-]?key|private|openrouter|anthropic|aws|gcp|azure|github|npm|pypi|ssh)/i.test(name);
}

function tokenHasSecretEnvExpansion(token: string): boolean {
  const envRefs = token.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g);
  for (const match of envRefs) {
    const name = match[1] || match[2] || '';
    if (isSecretEnvName(name)) return true;
  }
  return false;
}

function findEnvDumpSecret(tokens: string[]): string | null {
  const command = commandBasename(tokens[0] || '');
  if (command === 'env') {
    let index = 1;
    while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
    while (index < tokens.length && isEnvAssignment(tokens[index])) index += 1;
    return index >= tokens.length ? 'env' : null;
  }

  if (command === 'printenv') {
    if (tokens.length === 1) return 'printenv';
    for (const token of tokens.slice(1)) {
      if (!token.startsWith('-') && isSecretEnvName(token)) return token;
    }
    return null;
  }

  if (command === 'echo' || command === 'printf') {
    for (const token of tokens.slice(1)) {
      if (tokenHasSecretEnvExpansion(token)) return token;
    }
  }

  return null;
}

function isProcEnvironPath(token: string): boolean {
  return /^\/proc\/(?:self|\d+)\/environ$/i.test(token.replace(/\\/g, '/'));
}

function findCredentialExposurePrimitive(tokens: string[]): string | null {
  const command = commandBasename(tokens[0] || '');

  for (const token of tokens) {
    if (isProcEnvironPath(token)) return token;
  }

  if (command === 'ps') {
    for (const token of tokens.slice(1)) {
      if (token === 'eww' || token === 'auxeww' || token === '-E') return 'ps environment';
    }
  }

  if (command === 'security' && tokens[1] === 'find-generic-password') {
    if (tokens.includes('-w') || tokens.includes('--password')) return 'security find-generic-password -w';
  }

  if (command === 'secret-tool' && tokens[1] === 'lookup') return 'secret-tool lookup';
  if (command === 'cmdkey') return 'cmdkey credential listing';

  if ((command === 'powershell' || command === 'pwsh') &&
      tokens.some(token => /Get-StoredCredential/i.test(token))) {
    return 'powershell Get-StoredCredential';
  }

  return null;
}

function findSecretPathArg(tokens: string[]): string | null {
  const command = commandBasename(tokens[0] || '');
  const grepLike = command === 'grep' || command === 'rg';
  let patternSkipped = !grepLike;
  let parseOptions = true;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (parseOptions && token === '--') {
      parseOptions = false;
      continue;
    }
    if (parseOptions && token.startsWith('-') && token !== '-') {
      const handling = optionHandling(command, token);
      if (handling.selfIsPattern) patternSkipped = true;
      if (handling.consumeNext && index + 1 < tokens.length) {
        const next = tokens[index + 1];
        if (handling.nextIsPath && next && isSecretPath(next)) return next;
        if (handling.nextIsPattern) patternSkipped = true;
        index += 1;
      }
      continue;
    }
    if (grepLike && !patternSkipped) {
      patternSkipped = true;
      continue;
    }
    if (isProcEnvironPath(token)) return token;
    if (isSecretPath(token)) return token;
  }

  return null;
}

function findSecretBashReadArg(cmd: string): string | null {
  try {
    for (const segment of splitShellCommands(cmd)) {
      const tokens = shellWords(stripCommand(segment));
      if (!tokens || tokens.length === 0) continue;
      const credentialPrimitive = findCredentialExposurePrimitive(tokens);
      if (credentialPrimitive) return credentialPrimitive;
      const envDump = findEnvDumpSecret(tokens);
      if (envDump) return envDump;
      if (isReadCommand(tokens[0])) {
        const secretArg = findSecretPathArg(tokens);
        if (secretArg) return secretArg;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Evasion detection
// ---------------------------------------------------------------------------

export function detectEvasion(cmd: string): string | null {
  const blockedCmds =
    'rm|rmdir|shred|unlink|del|mkfs|dd|truncate|fdisk|diskpart|' +
    'Remove-Item|Format-Volume|Clear-Disk|wipefs|blkdiscard';

  const evasionPatterns: Array<[RegExp, string]> = [
    [
      new RegExp(`(?:^|[;&|]\\s*)/(?:usr/(?:local/)?)?(?:s?bin)/(${blockedCmds})\\b`, 'i'),
      'DENIED: Evasion detected — absolute path to blocked command. Use safe alternatives.',
    ],
    [
      new RegExp(`(?:^|[;&|\\s])\\\\(${blockedCmds})\\b`, 'i'),
      'DENIED: Evasion detected — backslash-escaped blocked command. Use safe alternatives.',
    ],
    [
      new RegExp(`\\$\\(\\s*which\\s+(${blockedCmds})\\s*\\)`, 'i'),
      'DENIED: Evasion detected — command substitution to resolve blocked command.',
    ],
    [
      new RegExp(`\`\\s*which\\s+(${blockedCmds})\\s*\``, 'i'),
      'DENIED: Evasion detected — command substitution to resolve blocked command.',
    ],
    [
      /\$'[^']*\\x[0-9a-fA-F]{2}[^']*'/,
      'DENIED: Evasion detected — hex escape sequences in command. Use commands directly.',
    ],
    [
      /\$'[^']*\\[0-7]{3}[^']*'/,
      'DENIED: Evasion detected — octal escape sequences in command. Use commands directly.',
    ],
    [
      new RegExp(`(?:^|[;&|\\s])\\w+=(?:"|')?\\s*(${blockedCmds})(?:"|')?[;&\\s].*\\$`, 'i'),
      'DENIED: Evasion detected — variable assignment of blocked command.',
    ],
    [
      new RegExp(`\\beval\\s+["']?\\s*(${blockedCmds})\\b`, 'i'),
      'DENIED: Evasion detected — eval with blocked command.',
    ],
    [
      new RegExp(`\\b(?:command|env|builtin)\\s+(${blockedCmds})\\b`, 'i'),
      'DENIED: Evasion detected — builtin/env invocation of blocked command. Use safe alternatives.',
    ],
  ];

  for (const [pattern, feedback] of evasionPatterns) {
    try {
      if (pattern.test(cmd)) return feedback;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chained destructive command detection
// ---------------------------------------------------------------------------

export function hasChainedDestructive(cmd: string): boolean {
  // Chain operators: &&, ;, ||
  const chainOps = '(?:&&|;|\\|\\|)';
  // Pipe operator: single | but NOT ||
  // Use negative lookahead to distinguish | from ||
  const pipeOp = '(?<!\\|)\\|(?!\\|)';

  // Destructive commands that should be caught after chain operators
  const chainDestructive = [
    'rm\\b', 'del\\b', 'rmdir\\b', 'Remove-Item\\b',
    'shred\\b', 'unlink\\b', 'mkfs\\b', 'dd\\s', 'truncate\\b',
  ];

  // Commands that should be caught after pipe operators (broader set)
  const pipeDestructive = [
    'rm\\b', 'rmdir\\b', 'del\\b', 'Remove-Item\\b',
    'shred\\b', 'unlink\\b', 'mkfs\\b', 'dd\\s', 'truncate\\b',
    'chmod\\b', 'chown\\b',
    'kill\\b', 'killall\\b', 'pkill\\b',
    'sudo\\b',
    'bash\\b', 'sh\\b', 'zsh\\b', 'dash\\b', 'ksh\\b', 'eval\\b',
  ];

  // Build chain patterns
  const chainPatterns = chainDestructive.map(d => new RegExp(`${chainOps}\\s*${d}`, 'i'));

  // Build pipe patterns — match | followed by optional whitespace and destructive command
  const pipePatterns = pipeDestructive.map(d => new RegExp(`${pipeOp}\\s*${d}`, 'i'));

  // Build xargs patterns — | xargs [flags...] destructiveCmd
  const xargsDestructive = ['rm\\b', 'shred\\b', 'unlink\\b', 'chmod\\b', 'chown\\b'];
  const xargsPatterns = xargsDestructive.map(d =>
    new RegExp(`${pipeOp}\\s*xargs\\s+(?:-[a-zA-Z0-9]+\\s+)*(?:\\{\\}\\s+)*${d}`, 'i'),
  );

  // Legacy patterns for subshell/process substitution
  const legacyPatterns = [
    /\$\(\s*rm\b/i, /\$\(\s*shred\b/i,
    /`\s*rm\b/i, /`\s*shred\b/i,
    /\n\s*rm\b/i, /\n\s*shred\b/i,
    /<<<.*\brm\b/i, /<<<.*\bshred\b/i,
    /<\(\s*rm\b/i, /<\(\s*shred\b/i,
  ];

  const allPatterns = [...chainPatterns, ...pipePatterns, ...xargsPatterns, ...legacyPatterns];
  return allPatterns.some(p => p.test(cmd));
}

// ---------------------------------------------------------------------------
// Write/Edit path analysis
// ---------------------------------------------------------------------------

export function isPathAllowed(filePath: string, allowedPaths: string[], cwd: string, projectRoot: string = cwd): boolean {
  if (!filePath) return false;

  let targets: string[];
  try {
    const lexicalTarget = resolve(projectRoot, filePath);
    targets = [...new Set([lexicalTarget, resolveRealPathForPolicy(filePath, projectRoot)])];
  } catch {
    return false;
  }

  for (const pattern of allowedPaths) {
    const resolved = resolvePathVar(pattern, cwd, projectRoot);
    try {
      const allowedDirs = [...new Set([resolve(resolved), resolveRealPathForPolicy(resolved, projectRoot)])];
      for (const allowedDir of allowedDirs) {
        for (const target of targets) {
          // Check if target is within or equal to the allowed directory.
          const rel = relative(allowedDir, target);
          // target is within allowedDir if the relative path doesn't escape upward.
          if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) {
            return true;
          }
        }
      }
    } catch {
      continue;
    }
  }
  return false;
}

function effectiveAllowedWritePaths(configuredAllowedPaths: string[]): string[] {
  const baseline = ['${PROJECT_ROOT}', '${CWD}', '${HOME}/.claude/'];
  return [...new Set([...baseline, ...configuredAllowedPaths])];
}

// ---------------------------------------------------------------------------
// Escalation context
// ---------------------------------------------------------------------------

export function writeEscalationContext(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  reason: string,
): string {
  mkdirSync(CONTEXT_DIR, { recursive: true });
  const contextFile = join(CONTEXT_DIR, 'latest.json');
  const escalationId = randomUUID();

  const inputSummary: Record<string, string> = {};
  for (const [k, v] of Object.entries(toolInput)) {
    inputSummary[k] = sanitizeForPrompt(String(v).slice(0, TOOL_INPUT_VALUE_MAX));
  }

  const context: EscalationContext = {
    ts: new Date().toISOString(),
    escalation_id: escalationId,
    status: 'jury_active',
    tool_name: toolName,
    tool_input_summary: inputSummary,
    cwd,
    gate_reason: reason,
    agent_description: sanitizeForPrompt(String(toolInput.description || '')),
    file_path: String(toolInput.file_path || ''),
  };

  try {
    atomicWriteJson(contextFile, context);
  } catch {
    // Context write failure should never block escalation
  }

  return escalationId;
}

// ---------------------------------------------------------------------------
// MCP tool normalization
// ---------------------------------------------------------------------------

interface NormalizationResult {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/**
 * Normalize MCP tool calls to their native Claude Code equivalents.
 * This ensures MCP tools flow through the same permission pipeline as
 * native Write/Edit/Bash tools (self-protection, path checks, etc.).
 *
 * Returns null if no normalization applies (tool stays as MCP).
 */
function normalizeMcpTool(
  mcpToolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): NormalizationResult | null {
  // mcp__filesystem__write_file → Write
  if (mcpToolName === 'mcp__filesystem__write_file') {
    const filePath = (toolInput.path as string) || (toolInput.file_path as string) || '';
    return {
      toolName: 'Write',
      toolInput: { file_path: filePath, content: toolInput.content || '' },
    };
  }

  // mcp__filesystem__edit_file → Edit
  if (mcpToolName === 'mcp__filesystem__edit_file') {
    const filePath = (toolInput.path as string) || (toolInput.file_path as string) || '';
    return {
      toolName: 'Edit',
      toolInput: {
        file_path: filePath,
        old_string: toolInput.old_text || toolInput.old_string || '',
        new_string: toolInput.new_text || toolInput.new_string || '',
      },
    };
  }

  // mcp__filesystem__move_file → Bash (mv)
  if (mcpToolName === 'mcp__filesystem__move_file') {
    const source = (toolInput.source as string) || '';
    const dest = (toolInput.destination as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command: `mv "${source}" "${dest}"` },
    };
  }

  // mcp__filesystem__rename_file → Bash (mv)
  if (mcpToolName === 'mcp__filesystem__rename_file') {
    const source = (toolInput.source as string) || '';
    const dest = (toolInput.destination as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command: `mv "${source}" "${dest}"` },
    };
  }

  // mcp__filesystem__copy_file → Bash (cp)
  if (mcpToolName === 'mcp__filesystem__copy_file') {
    const source = (toolInput.source as string) || '';
    const dest = (toolInput.destination as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command: `cp "${source}" "${dest}"` },
    };
  }

  // mcp__filesystem__create_directory → Bash (mkdir -p)
  if (mcpToolName === 'mcp__filesystem__create_directory') {
    const dirPath = (toolInput.path as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command: `mkdir -p "${dirPath}"` },
    };
  }

  // mcp__filesystem__delete_file → Bash (rm)
  if (mcpToolName === 'mcp__filesystem__delete_file') {
    const filePath = (toolInput.path as string) || (toolInput.file_path as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command: `rm "${filePath}"` },
    };
  }

  // mcp__plugin_serena_serena__replace_content → Edit
  if (mcpToolName === 'mcp__plugin_serena_serena__replace_content') {
    const filePath = (toolInput.relative_path as string) || (toolInput.file_path as string) || '';
    return {
      toolName: 'Edit',
      toolInput: {
        file_path: filePath,
        old_string: toolInput.old_string || '',
        new_string: toolInput.new_string || '',
      },
    };
  }

  // mcp__plugin_serena_serena__create_text_file → Write
  if (mcpToolName === 'mcp__plugin_serena_serena__create_text_file') {
    const filePath = (toolInput.relative_path as string) || (toolInput.file_path as string) || '';
    return {
      toolName: 'Write',
      toolInput: { file_path: filePath, content: toolInput.content || '' },
    };
  }

  // mcp__plugin_serena_serena__execute_shell_command → Bash
  if (mcpToolName === 'mcp__plugin_serena_serena__execute_shell_command') {
    const command = (toolInput.command as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command },
    };
  }

  // mcp__hive-flow__terminal_execute → Bash
  if (mcpToolName === 'mcp__hive-flow__terminal_execute') {
    const command = (toolInput.command as string) || (toolInput.cmd as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command },
    };
  }

  // mcp__hive-flow__terminal_create → Bash
  if (mcpToolName === 'mcp__hive-flow__terminal_create') {
    const command = (toolInput.command as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main evaluation logic
// ---------------------------------------------------------------------------

export async function evaluate(hookInput: HookInput, config: Partial<PermissionConfig>): Promise<GateResult> {
  // Normalize tool_input early — Claude Code may omit it or send null
  if (!hookInput.tool_input || typeof hookInput.tool_input !== 'object') {
    hookInput.tool_input = {};
  }
  let toolName = hookInput.tool_name || '';
  const toolInput = hookInput.tool_input || {};
  const cwd = hookInput.cwd || process.cwd();
  const policyRoot = resolvePolicyRoot(hookInput, cwd);

  // -- MCP tool normalization --
  // Normalize MCP tool calls to their native Claude Code equivalents so they
  // flow through the same permission pipeline (self-protection, path checks, etc.)
  if (toolName.startsWith('mcp__')) {
    const normalized = normalizeMcpTool(toolName, toolInput, policyRoot);
    if (normalized) {
      toolName = normalized.toolName;
      hookInput.tool_name = normalized.toolName;
      Object.assign(hookInput.tool_input, normalized.toolInput);
    }
  }

  // Extract a summary for logging
  let inputSummary: string;
  if (toolName === 'Bash') {
    inputSummary = extractBashCommand(toolInput);
  } else if (toolName === 'Write' || toolName === 'Edit') {
    inputSummary = (toolInput.file_path as string) || '';
  } else {
    inputSummary = JSON.stringify(toolInput).slice(0, DEFAULT_INPUT_SUMMARY_MAX);
  }

  // -- Self-protection check (highest priority after normalization) --
  // Must run before any allow-list checks to prevent bypass via always_allow_tools
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit' || toolName === 'Bash') {
    const selfProtection = evaluateSelfProtection(toolName, toolInput, policyRoot, undefined, {
      rootToken: process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN,
      hasSubagentIdentity: hasSubagentIdentity(hookInput),
    });
    if (selfProtection && selfProtection.blocked) {
      logDecision(config, toolName, inputSummary, 'deny', 'self-protection', selfProtection.reason);
      return { decision: 'deny', reason: selfProtection.reason };
    }
  }

  const sensitiveReadPath = findSensitiveReadPath(toolName, toolInput, policyRoot);
  if (sensitiveReadPath) {
    const reason = 'DENIED: This path contains protected enforcement, credential, or hook-governance state and cannot be read by agents.';
    logDecision(config, toolName, sensitiveReadPath, 'deny', 'sensitive-read', reason);
    return { decision: 'deny', reason };
  }

  const secretReadPath = findSecretReadPath(toolName, toolInput);
  if (secretReadPath) {
    const reason = 'DENIED: This path matches a secret/credential class (private key, dotenv, credentials, etc.) and cannot be read by agents.';
    logDecision(config, toolName, secretReadPath, 'deny', 'secret-read', reason);
    return { decision: 'deny', reason };
  }

  // -- Always-allow tools (non-Bash) --
  const alwaysAllowTools = config.always_allow_tools || [];
  if (alwaysAllowTools.includes(toolName)) {
    logDecision(config, toolName, inputSummary, 'allow', 'deterministic', 'always-allow tool');
    return { decision: 'allow' };
  }

  // Check prefix patterns
  for (const prefix of config.always_allow_tool_prefixes || []) {
    if (typeof prefix === 'string' && !prefix.startsWith('COMMENT:') && toolName.startsWith(prefix)) {
      logDecision(config, toolName, inputSummary, 'allow', 'deterministic', `matched allow prefix '${prefix}'`);
      return { decision: 'allow' };
    }
  }

  // -- MCP tool policy (only for tools that weren't normalized) --
  if (toolName.startsWith('mcp__')) {
    // Check deny prefixes first
    for (const prefix of config.mcp_deny_tool_prefixes || []) {
      if (typeof prefix === 'string' && !prefix.startsWith('COMMENT:') && toolName.startsWith(prefix)) {
        logDecision(config, toolName, inputSummary, 'deny', 'deterministic', `matched MCP deny prefix '${prefix}'`);
        return { decision: 'deny', reason: `DENIED: MCP tool '${toolName}' is blocked by policy.` };
      }
    }

    // Check escalation prefixes — route through inline jury instead of human
    for (const prefix of config.mcp_escalate_tool_prefixes || []) {
      if (typeof prefix === 'string' && !prefix.startsWith('COMMENT:') && toolName.startsWith(prefix)) {
        return await resolveJury({
          config,
          hookInput,
          toolName,
          inputSummary,
          juryCtx: makeJuryContext(hookInput, policyRoot, String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || '')),
          logPrefix: `MCP escalation prefix '${prefix}'`,
          responsePrefix: 'Jury',
          additionalContext: reason => `Tool '${toolName}' matched escalation prefix '${prefix}'. ${reason}`,
        });
      }
    }

    // Apply default MCP policy
    const mcpPolicy = config.mcp_default_policy || 'allow';
    if (mcpPolicy === 'allow') {
      logDecision(config, toolName, inputSummary, 'allow', 'deterministic', 'MCP tool — default allow policy');
      return { decision: 'allow' };
    } else if (mcpPolicy === 'deny') {
      logDecision(config, toolName, inputSummary, 'deny', 'deterministic', 'MCP tool — default deny policy');
      return { decision: 'deny', reason: `DENIED: MCP tool '${toolName}' blocked by default MCP deny policy.` };
    } else {
      // Default MCP escalation policy — route through inline jury
      return await resolveJury({
        config,
        hookInput,
        toolName,
        inputSummary,
        juryCtx: makeJuryContext(hookInput, policyRoot, String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || '')),
        logPrefix: 'MCP default escalation',
        responsePrefix: 'Jury',
        additionalContext: reason => `MCP tool '${toolName}' requires jury approval. ${reason}`,
      });
    }
  }

  // -- Write/Edit path check --
  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath = (toolInput.file_path as string) || '';
    const allowedPaths = effectiveAllowedWritePaths(config.allowed_write_paths || []);
    if (isPathAllowed(filePath, allowedPaths, cwd, policyRoot)) {
      logDecision(config, toolName, inputSummary, 'allow', 'deterministic', 'within allowed write path');
      return { decision: 'allow' };
    } else if (config.allow_paths_outside_working_directory) {
      // Write outside allowed paths — inline jury decides instead of human
      return await resolveJury({
        config,
        hookInput,
        toolName,
        inputSummary,
        juryCtx: makeJuryContext(hookInput, policyRoot, filePath),
        logPrefix: 'write outside allowed paths',
        responsePrefix: 'Jury',
        additionalContext: reason => `Write to '${filePath}' is outside allowed paths. ${reason}`,
      });
    } else {
      const reason = `DENIED: Write target '${filePath}' is outside the project directory and ~/.claude/. Move the file to the project directory or adjust the path.`;
      logDecision(config, toolName, inputSummary, 'deny', 'deterministic', 'outside allowed write paths');
      return { decision: 'deny', reason };
    }
  }

  // -- Bash command evaluation --
  if (toolName === 'Bash') {
    const cmd = extractBashCommand(toolInput);
    if (!cmd.trim()) {
      logDecision(config, toolName, '(empty)', 'allow', 'deterministic', 'empty command');
      return { decision: 'allow' };
    }

    // 0) Deep inspection — catches bash -c, python3 -c, variable expansion, etc.
    const inspection = deepInspect(cmd);
    if (inspection.blocked) {
      logDecision(config, toolName, inputSummary, 'deny', 'deterministic', `deep-inspect: ${inspection.technique}`);
      return { decision: 'deny', reason: `[Deep Inspect] ${inspection.reason} (${inspection.technique})` };
    }

    // 1) Evasion detection
    const evasionFeedback = detectEvasion(cmd);
    if (evasionFeedback) {
      logDecision(config, toolName, inputSummary, 'deny', 'deterministic', 'evasion attempt detected');
      return { decision: 'deny', reason: evasionFeedback };
    }

    // 2) Chained destructive commands
    if (hasChainedDestructive(cmd)) {
      const reason = 'DENIED: Destructive command detected in command chain. Remove the destructive portion (rm, del, rmdir, etc.) and retry.';
      logDecision(config, toolName, inputSummary, 'deny', 'deterministic', 'chained destructive command');
      return { decision: 'deny', reason };
    }

    // 3) Deny patterns
    const denyPatterns = config.always_deny_bash_patterns || [];
    const denyFeedback = checkBashPatterns(cmd, denyPatterns);
    if (denyFeedback) {
      logDecision(config, toolName, inputSummary, 'deny', 'deterministic', 'matched deny pattern');
      return { decision: 'deny', reason: denyFeedback };
    }

    const escalationPatterns = config.jury_escalation_bash_patterns || [];

    // 4a) Trusted-root branch switches are policy-relevant but not
    // violation-grade. Route the narrow branch-only shape through the inline
    // jury while keeping path restore and dangerous checkout modes auto-denied.
    if (isTrustedRootBranchCheckout(cmd, hookInput)) {
      return await resolveJury({
        config,
        hookInput,
        toolName,
        inputSummary,
        juryCtx: makeJuryContext(hookInput, policyRoot, String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || '')),
        logPrefix: 'trusted-root git checkout branch switch',
        responsePrefix: 'Inline Jury',
      });
    }

    if (isGitCheckoutInvocation(cmd)) {
      const reason = checkBashPatterns('git checkout -- .', escalationPatterns)
        || 'DENIED: git checkout is auto-denied — use `git switch` for branch changes, or inspect/stash changes before restoring paths.';
      logDecision(config, toolName, inputSummary, 'deny', 'auto-deny', 'matched git checkout guard');
      return { decision: 'deny', reason };
    }

    // 4) Dangerous-command patterns — auto-deny with actionable feedback
    const escalationFeedback = checkBashPatterns(cmd, escalationPatterns);
    if (escalationFeedback) {
      logDecision(config, toolName, inputSummary, 'deny', 'auto-deny', 'matched dangerous-command pattern');
      return { decision: 'deny', reason: escalationFeedback };
    }

    // 4b) Secret-file reads must be denied before Bash known-good allow patterns.
    const secretArg = findSecretBashReadArg(cmd);
    if (secretArg) {
      const reason = `DENIED: command reads or exposes a secret/credential path ('${secretArg}'). Secret files, dotenv values, credentials, and key material cannot be read by agents.`;
      logDecision(config, toolName, inputSummary, 'deny', 'secret-read-bash', reason);
      return { decision: 'deny', reason };
    }

    // 5) Allow patterns
    const allowPatterns = config.always_allow_bash_patterns || [];
    if (checkBashAllow(cmd, allowPatterns)) {
      logDecision(config, toolName, inputSummary, 'allow', 'deterministic', 'matched allow pattern');
      return { decision: 'allow' };
    }

    // 5b) Check learned patterns
    if (!config.disable_vote_learner) {
      try {
        const { checkLearnedPattern } = await import('./vote-learner.js');
        const learned = checkLearnedPattern(toolName, cmd);
        if (learned === 'allow') {
          const reason = 'learned pattern: approved 5+ times';
          logDecision(config, toolName, inputSummary, 'allow', 'learned', reason);
          return { decision: 'allow', reason };
        }
      } catch {
        // vote-learner not available — skip learned patterns
      }
    }

    // 6) Not matched — inline jury evaluation instead of human escalation
    {
      return await resolveJury({
        config,
        hookInput,
        toolName,
        inputSummary,
        juryCtx: makeJuryContext(hookInput, policyRoot, String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || '')),
        responsePrefix: 'Inline Jury',
      });
    }
  }

  // -- Unrecognized tool: inline jury evaluation --
  {
    return await resolveJury({
      config,
      hookInput,
      toolName,
      inputSummary,
      juryCtx: makeJuryContext(hookInput, policyRoot, String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || '')),
      responsePrefix: 'Inline Jury',
    });
  }
}

/**
 * Post-verdict safeguard: checks if a Bash command matches any FORBIDDEN
 * pattern. Called as the LAST step before returning an allow verdict for Bash
 * commands. Even if a bug in the jury, learned patterns, or pre-filter somehow
 * produces an allow verdict for a forbidden command, this catches it.
 *
 * Uses splitShellCommands() to split on chain operators and pipes, then
 * checks each sub-command independently against FORBIDDEN_PATTERNS.
 * Also extracts inner commands from bash -c / sh -c wrappers.
 */
function checkForbiddenSafeguard(
  cmd: string,
  config: Partial<PermissionConfig>,
  toolName: string,
  inputSummary: string,
): GateResult | null {
  // Split the command on all shell operators (&&, ||, ;, |)
  const segments = splitShellCommands(cmd);

  for (const segment of segments) {
    const stripped = stripCommand(segment);
    const normalized = normalizeForbiddenSegmentExecutable(stripped);

    // Check direct match against FORBIDDEN_PATTERNS
    for (const fp of FORBIDDEN_PATTERNS) {
      try {
        if (new RegExp(fp, 'i').test(normalized)) {
          logDecision(config, toolName, inputSummary, 'deny', 'forbidden-safeguard',
            `Post-verdict safeguard: ${fp} is FORBIDDEN`);
          return { decision: 'deny', reason: 'DENIED: This command is not available.' };
        }
      } catch {
        continue;
      }
    }

    // Extract and check inner commands from bash -c / sh -c wrappers
    const shellMatch = stripped.match(/^(?:bash|sh)\s+-c\s+(['"])(.*)\1/i)
                    || stripped.match(/^(?:bash|sh)\s+-c\s+(.*)/i);
    if (shellMatch) {
      const inner = shellMatch[2] ?? shellMatch[1];
      if (inner) {
        const innerResult = checkForbiddenSafeguard(inner, config, toolName, inputSummary);
        if (innerResult) return innerResult;
      }
    }
  }
  return null;
}

/**
 * Entry point for Claude Code PreToolUse hooks.
 * Reads a HookInput and returns a GateResult.
 */
export async function evaluateHookInput(input: HookInput): Promise<GateResult> {
  const config = loadConfig(undefined, input);
  const result = await evaluate(input, config);

  // Post-verdict forbidden safeguard for Bash commands
  if (result.decision === 'allow' && input.tool_name === 'Bash') {
    const cmd = ((input.tool_input || {}).command as string) || '';
    if (cmd.trim()) {
      const blocked = checkForbiddenSafeguard(cmd, config, input.tool_name, cmd);
      if (blocked) return blocked;
    }
  }

  return result;
}
