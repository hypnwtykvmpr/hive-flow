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

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
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
} from './types.js';
import { deepInspect } from './deep-inspect.js';
import { evaluateInlineJury } from './jury-evaluator.js';
import { classifyCommand } from './risk-classifier.js';
import { mergeWithDefaults } from './default-config.js';
import { evaluateSelfProtection } from './self-protection.js';

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
  '^rm\\b', '^chmod\\b', '^chown\\b', '^killall\\b',
  '^docker\\s+rm\\b', '^docker\\s+rmi\\b',
  '^git\\s+push\\s+--force', '^git\\s+push\\s+-f\\b',
  '^git\\s+reset\\s+--hard',
];

const HOME = homedir();
const CONFIG_DIR = join(HOME, '.hive-flow', 'permission-guard');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const CONTEXT_DIR = join(HOME, '.claude', 'hooks', 'escalation_context');
const VERDICT_FILE = join(CONTEXT_DIR, 'last_verdict.json');
const VERDICT_STALENESS = 120.0; // seconds

const LOG_INPUT_SUMMARY_MAX = 200;
const TOOL_INPUT_VALUE_MAX = 500;
const DEFAULT_INPUT_SUMMARY_MAX = 100;
const SANITIZE_MAX_LENGTH = 500;

// ---------------------------------------------------------------------------
// Config cache (mtime-based)
// ---------------------------------------------------------------------------

let configCache: PermissionConfig | null = null;
let configMtime = 0;
let configCachePath = '';

export function loadConfig(overridePath?: string): Partial<PermissionConfig> {
  const cfgPath = overridePath || CONFIG_PATH;

  try {
    const currentMtime = statSync(cfgPath).mtimeMs;
    if (configCache !== null && cfgPath === configCachePath && currentMtime === configMtime) {
      return configCache;
    }

    const data = mergeWithDefaults(JSON.parse(readFileSync(cfgPath, 'utf-8')));
    configCache = data;
    configMtime = currentMtime;
    configCachePath = cfgPath;
    return data;
  } catch {
    return mergeWithDefaults({});
  }
}

/** Reset config cache (for testing). */
export function resetConfigCache(): void {
  configCache = null;
  configMtime = 0;
  configCachePath = '';
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

function resolvePathVar(pattern: string, cwd: string): string {
  return pattern.replace('${HOME}', HOME).replace('${CWD}', cwd);
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

/**
 * Anchor a pattern to the start of the string if it isn't already.
 * Patterns that start with ^ are used as-is. Otherwise they're wrapped
 * in ^(?:...) so glob-like patterns (e.g. "rm *") only match when "rm"
 * is the leading command, not when it appears inside arguments.
 */
function anchorPattern(pattern: string): string {
  return pattern.startsWith('^') ? pattern : `^(?:${pattern})`;
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
      if (new RegExp(anchorPattern(pattern), 'i').test(stripped)) {
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
      if (new RegExp(anchorPattern(entry), 'i').test(stripped)) return true;
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

export function isPathAllowed(filePath: string, allowedPaths: string[], cwd: string): boolean {
  if (!filePath) return false;

  let target: string;
  try {
    target = resolve(filePath);
  } catch {
    return false;
  }

  for (const pattern of allowedPaths) {
    const resolved = resolvePathVar(pattern, cwd);
    try {
      const allowedDir = resolve(resolved);
      // Check if target is within or equal to the allowed directory
      const rel = relative(allowedDir, target);
      // target is within allowedDir if the relative path doesn't escape upward
      if (!rel.startsWith('..') && !rel.startsWith('/')) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
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

  // mcp__filesystem__create_directory → Bash (mkdir -p)
  if (mcpToolName === 'mcp__filesystem__create_directory') {
    const dirPath = (toolInput.path as string) || '';
    return {
      toolName: 'Bash',
      toolInput: { command: `mkdir -p "${dirPath}"` },
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

  // -- MCP tool normalization --
  // Normalize MCP tool calls to their native Claude Code equivalents so they
  // flow through the same permission pipeline (self-protection, path checks, etc.)
  if (toolName.startsWith('mcp__')) {
    const normalized = normalizeMcpTool(toolName, toolInput, cwd);
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
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Bash') {
    const selfProtection = evaluateSelfProtection(toolName, toolInput, cwd);
    if (selfProtection && selfProtection.blocked) {
      logDecision(config, toolName, inputSummary, 'deny', 'self-protection', selfProtection.reason);
      return { decision: 'deny', reason: selfProtection.reason };
    }
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
        const juryCtx = {
          toolName: hookInput.tool_name,
          toolInput: Object.fromEntries(Object.entries(hookInput.tool_input).map(([k, v]) => [k, String(v)])),
          cwd: hookInput.cwd || process.cwd(),
          filePath: String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || ''),
        };
        const juryResult = evaluateInlineJury(juryCtx);
        if (juryResult.verdict === 'APPROVED') {
          logDecision(config, toolName, inputSummary, 'allow', 'inline-jury', `MCP escalation prefix '${prefix}' — jury approved: ${juryResult.reason}`);
          return { decision: 'allow', reason: `[Jury] ${juryResult.reason}` };
        }
        logDecision(config, toolName, inputSummary, 'deny', 'inline-jury', `MCP escalation prefix '${prefix}' — jury denied: ${juryResult.reason}`);
        return { decision: 'deny', reason: `[Jury] ${juryResult.reason}`, additionalContext: `Tool '${toolName}' matched escalation prefix '${prefix}'. ${juryResult.reason}` };
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
      const juryCtx = {
        toolName: hookInput.tool_name,
        toolInput: Object.fromEntries(Object.entries(hookInput.tool_input).map(([k, v]) => [k, String(v)])),
        cwd: hookInput.cwd || process.cwd(),
        filePath: String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || ''),
      };
      const juryResult = evaluateInlineJury(juryCtx);
      if (juryResult.verdict === 'APPROVED') {
        logDecision(config, toolName, inputSummary, 'allow', 'inline-jury', `MCP default escalation — jury approved: ${juryResult.reason}`);
        return { decision: 'allow', reason: `[Jury] ${juryResult.reason}` };
      }
      logDecision(config, toolName, inputSummary, 'deny', 'inline-jury', `MCP default escalation — jury denied: ${juryResult.reason}`);
      return { decision: 'deny', reason: `[Jury] ${juryResult.reason}`, additionalContext: `MCP tool '${toolName}' requires jury approval. ${juryResult.reason}` };
    }
  }

  // -- Write/Edit path check --
  if (toolName === 'Write' || toolName === 'Edit') {
    const filePath = (toolInput.file_path as string) || '';
    const allowedPaths = config.allowed_write_paths || ['${CWD}', '${HOME}/.claude/'];
    if (isPathAllowed(filePath, allowedPaths, cwd)) {
      logDecision(config, toolName, inputSummary, 'allow', 'deterministic', 'within allowed write path');
      return { decision: 'allow' };
    } else if (config.allow_paths_outside_working_directory) {
      // Write outside allowed paths — inline jury decides instead of human
      const juryCtx = {
        toolName: hookInput.tool_name,
        toolInput: Object.fromEntries(Object.entries(hookInput.tool_input).map(([k, v]) => [k, String(v)])),
        cwd: hookInput.cwd || process.cwd(),
        filePath,
      };
      const juryResult = evaluateInlineJury(juryCtx);
      if (juryResult.verdict === 'APPROVED') {
        logDecision(config, toolName, inputSummary, 'allow', 'inline-jury', `write outside allowed paths — jury approved: ${juryResult.reason}`);
        return { decision: 'allow', reason: `[Jury] ${juryResult.reason}` };
      }
      logDecision(config, toolName, inputSummary, 'deny', 'inline-jury', `write outside allowed paths — jury denied: ${juryResult.reason}`);
      return { decision: 'deny', reason: `[Jury] ${juryResult.reason}`, additionalContext: `Write to '${filePath}' is outside allowed paths. ${juryResult.reason}` };
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

    // 4) Dangerous-command patterns — auto-deny with actionable feedback
    const escalationPatterns = config.jury_escalation_bash_patterns || [];
    const escalationFeedback = checkBashPatterns(cmd, escalationPatterns);
    if (escalationFeedback) {
      logDecision(config, toolName, inputSummary, 'deny', 'auto-deny', 'matched dangerous-command pattern');
      return { decision: 'deny', reason: escalationFeedback };
    }

    // 5) Allow patterns
    const allowPatterns = config.always_allow_bash_patterns || [];
    if (checkBashAllow(cmd, allowPatterns)) {
      logDecision(config, toolName, inputSummary, 'allow', 'deterministic', 'matched allow pattern');
      return { decision: 'allow' };
    }

    // 5b) Check learned patterns
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

    // 6) Not matched — inline jury evaluation instead of human escalation
    {
      const juryCtx = {
        toolName: hookInput.tool_name,
        toolInput: Object.fromEntries(Object.entries(hookInput.tool_input).map(([k, v]) => [k, String(v)])),
        cwd: hookInput.cwd || process.cwd(),
        filePath: String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || ''),
      };
      const juryResult = evaluateInlineJury(juryCtx);
      if (juryResult.verdict === 'APPROVED') {
        logDecision(config, toolName, inputSummary, 'allow', 'inline-jury', juryResult.reason);
        return { decision: 'allow', reason: `[Inline Jury] ${juryResult.reason}` };
      }
      logDecision(config, toolName, inputSummary, 'deny', 'inline-jury', juryResult.reason);
      return { decision: 'deny', reason: `[Inline Jury] ${juryResult.reason}` };
    }
  }

  // -- Unrecognized tool: inline jury evaluation --
  {
    const juryCtx = {
      toolName: hookInput.tool_name,
      toolInput: Object.fromEntries(Object.entries(hookInput.tool_input).map(([k, v]) => [k, String(v)])),
      cwd: hookInput.cwd || process.cwd(),
      filePath: String(hookInput.tool_input.file_path || hookInput.tool_input.filePath || ''),
    };
    const juryResult = evaluateInlineJury(juryCtx);
    if (juryResult.verdict === 'APPROVED') {
      logDecision(config, toolName, inputSummary, 'allow', 'inline-jury', juryResult.reason);
      return { decision: 'allow', reason: `[Inline Jury] ${juryResult.reason}` };
    }
    logDecision(config, toolName, inputSummary, 'deny', 'inline-jury', juryResult.reason);
    return { decision: 'deny', reason: `[Inline Jury] ${juryResult.reason}` };
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

    // Check direct match against FORBIDDEN_PATTERNS
    for (const fp of FORBIDDEN_PATTERNS) {
      try {
        if (new RegExp(fp, 'i').test(stripped)) {
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
  const config = loadConfig();
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
