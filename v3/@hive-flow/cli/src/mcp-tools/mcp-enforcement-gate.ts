/**
 * MCP Enforcement Gate — Risk classification and blocking for MCP tools.
 * Called from callMCPTool() in mcp-client.ts to enforce tool restrictions.
 */

import { existsSync, readFileSync } from 'fs';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export enum ToolRisk {
  CRITICAL = 3,
  HIGH = 2,
  MEDIUM = 1,
  LOW = 0,
}

// Risk classification table
const CRITICAL_TOOLS = new Set([
  'agent_spawn', 'agent_task',
  'queen_spawn_worker',
  'workflow_enforcer_override',
  'browser_eval',
  'config_import',
  'system_reset',
]);

const HIGH_TOOLS = new Set([
  'agent_update', 'agent_terminate',
  'config_set', 'config_reset',
  'terminal_execute', 'terminal_create',
  'browser_open', 'browser_click', 'browser_fill',
  'swarm_init',
  'hive-mind_init', 'hive-mind_spawn',
  'claims_claim', 'claims_steal',
  'session_delete',
  'memory_delete',
  'workflow_create', 'workflow_execute',
  'daa_agent_create', 'daa_workflow_execute',
  // 12.8: filesystem tools that can write to protected paths
  'filesystem__write_file', 'filesystem__edit_file', 'filesystem__move_file',
]);

const MEDIUM_TOOLS = new Set([
  'memory_store', 'memory_migrate',
]);

// Everything else is LOW risk

export interface EnforcementResult {
  allowed: boolean;
  risk: ToolRisk;
  reason?: string;
}

export function classifyTool(toolName: string): ToolRisk {
  // Strip mcp__hive-flow__ or mcp__filesystem__ prefix
  const shortName = toolName
    .replace(/^mcp__hive-flow__/, '')
    .replace(/^mcp__filesystem__/, 'filesystem__')
    .replace(/^mcp__playwright__browser_/, 'browser_');

  if (CRITICAL_TOOLS.has(shortName)) return ToolRisk.CRITICAL;
  if (HIGH_TOOLS.has(shortName)) return ToolRisk.HIGH;
  if (MEDIUM_TOOLS.has(shortName)) return ToolRisk.MEDIUM;
  return ToolRisk.LOW;
}

function resolveProjectDir(): string {
  // Priority 1: explicit env var (safe for MCP servers)
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }

  // Priority 2: ESM import.meta.url (dirname/fileURLToPath imported at top level)
  // Compiled layout: dist/src/mcp-tools/ → 5 levels up to project root
  try {
    const metaUrl = (import.meta as { url?: string })?.url;
    if (metaUrl) {
      const thisDir = dirname(fileURLToPath(metaUrl));
      return resolve(thisDir, '..', '..', '..', '..', '..');
    }
  } catch {
    // Not in ESM context — fall through to CJS
  }

  // Priority 3: CJS __dirname traversal
  try {
    return resolve(__dirname, '..', '..', '..', '..', '..');
  } catch {
    // __dirname undefined in ESM — fall through
  }

  // Priority 4: cwd fallback
  return process.cwd();
}

// Highest enforcement level — used for fail-closed behavior on any error.
const LEVEL_HALTED = 3;

function getOrReadHmacKey(enforcementDir: string): string | null {
  try {
    const keyFile = join(enforcementDir, '.hmac-key');
    if (existsSync(keyFile)) {
      return readFileSync(keyFile, 'utf8').trim();
    }
  } catch {
    // Cannot read key — treat as unavailable
  }
  return null;
}

function verifyEnvelopeHmac(envelope: { state: unknown; hmac: string }, key: string): boolean {
  try {
    const expected = createHmac('sha256', key)
      .update(JSON.stringify(envelope.state))
      .digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(envelope.hmac, 'hex');
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

export function getEnforcementLevel(): number {
  try {
    const projectDir = resolveProjectDir();
    const enforcementDir = join(projectDir, '.hive-flow', 'enforcement');
    const stateFile = join(enforcementDir, 'state.json');

    // SEC-008: fail-CLOSED when state file is missing — treat as HALTED
    if (!existsSync(stateFile)) return LEVEL_HALTED;

    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));

    // SEC-009: HMAC verification before trusting the level.
    // Only the signed envelope format is accepted. Legacy plain-state files are
    // rejected (fail-closed) because their integrity cannot be verified.
    if (raw?.state !== undefined && typeof raw?.hmac === 'string') {
      const key = getOrReadHmacKey(enforcementDir);
      if (key === null) {
        // Cannot verify — fail-closed
        return LEVEL_HALTED;
      }
      if (!verifyEnvelopeHmac(raw as { state: unknown; hmac: string }, key)) {
        // HMAC mismatch — state tampered, fail-closed
        return LEVEL_HALTED;
      }
      const state = raw.state as Record<string, unknown>;
      return typeof state?.level === 'number' ? state.level : LEVEL_HALTED;
    }

    // No HMAC envelope present — unsigned state, fail-closed
    return LEVEL_HALTED;
  } catch {
    // SEC-008: fail-CLOSED on any error reading state
    return LEVEL_HALTED;
  }
}

/**
 * Check if an MCP tool is allowed at the current enforcement level.
 *
 * Enforcement logic by level:
 *   NORMAL (0)     — All allowed. CRITICAL tools produce audit log entry.
 *   WARNED (1)     — CRITICAL blocked. HIGH allowed with audit.
 *   RESTRICTED (2) — CRITICAL + HIGH blocked. MEDIUM allowed with audit.
 *   HALTED (3)     — All non-LOW blocked.
 */
export function checkMCPEnforcement(toolName: string): EnforcementResult {
  const risk = classifyTool(toolName);
  const level = getEnforcementLevel();

  if (level === 0) {
    return { allowed: true, risk };
  }

  if (level >= 1 && risk >= ToolRisk.CRITICAL) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (CRITICAL risk) blocked at enforcement level ${level}.`,
    };
  }

  if (level >= 2 && risk >= ToolRisk.HIGH) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (HIGH risk) blocked at enforcement level ${level}.`,
    };
  }

  if (level >= 3 && risk >= ToolRisk.MEDIUM) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (MEDIUM risk) blocked at enforcement level ${level}.`,
    };
  }

  return { allowed: true, risk };
}

/**
 * Model enforcement for agent spawning tools (PreToolUse gate).
 *
 * Blocks haiku for all agent tasks, enforces top-tier models for external
 * providers, and defaults Claude provider to sonnet when no model is specified.
 */
export interface ModelEnforcementInput {
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface ModelEnforcementResult {
  allowed: boolean;
  reason?: string;
  /** When the input is mutated (e.g. default model applied), the corrected input is returned. */
  correctedInput?: ModelEnforcementInput;
}

const AGENT_SPAWN_TOOLS = new Set(['agent_spawn', 'queen_spawn_worker']);

export function checkModelEnforcement(
  toolName: string,
  input: ModelEnforcementInput,
): ModelEnforcementResult {
  const shortName = toolName
    .replace(/^mcp__hive-flow__/, '')
    .replace(/^mcp__filesystem__/, 'filesystem__')
    .replace(/^mcp__playwright__browser_/, 'browser_');

  if (!AGENT_SPAWN_TOOLS.has(shortName)) {
    return { allowed: true };
  }

  // Rule 1: haiku is always prohibited for agent tasks
  if (input.model === 'haiku') {
    return {
      allowed: false,
      reason: 'MODEL ENFORCEMENT: haiku prohibited for agent tasks. Use sonnet or opus.',
    };
  }

  // Rule 2: gemini-cli requires gemini-3.1-pro-preview (top tier)
  // Allow alias names (opus, sonnet, inherit) — the alias resolver maps them to the correct native model
  const CLAUDE_ALIASES = ['opus', 'sonnet', 'inherit', undefined, ''];
  if (
    input.provider === 'gemini-cli' &&
    input.model !== 'gemini-3.1-pro-preview' &&
    !CLAUDE_ALIASES.includes(input.model as string)
  ) {
    return {
      allowed: false,
      reason: 'MODEL ENFORCEMENT: gemini-cli requires gemini-3.1-pro-preview (top tier).',
    };
  }

  // Rule 3: codex-cli requires gpt-5.4 (top tier)
  if (
    input.provider === 'codex-cli' &&
    input.model !== 'gpt-5.4' &&
    !CLAUDE_ALIASES.includes(input.model as string)
  ) {
    return {
      allowed: false,
      reason: 'MODEL ENFORCEMENT: codex-cli requires gpt-5.4 (top tier).',
    };
  }

  // Rule 5: deepseek provider without explicit model → default to deepseek-reasoner
  if (input.provider === 'deepseek' && !input.model) {
    return { allowed: true, correctedInput: { ...input, model: 'deepseek-reasoner' } };
  }

  // Rule 6: cursor-cli provider without explicit model → default to 'auto'
  if (input.provider === 'cursor-cli' && !input.model) {
    return { allowed: true, correctedInput: { ...input, model: 'auto' } };
  }

  // Rule 7: openrouter requires an explicit model (no model content enforcement)
  if (input.provider === 'openrouter') {
    if (!input.model) {
      return {
        allowed: false,
        reason: 'MODEL ENFORCEMENT: openrouter requires an explicit model or tier (opus/sonnet/haiku).',
      };
    }
    return { allowed: true };
  }

  // Rule 4: Claude provider (anthropic-cli or unspecified) without explicit model → default to sonnet
  const isClaudeProvider =
    !input.provider ||
    input.provider === 'anthropic-cli' ||
    input.provider === 'claude';
  if (isClaudeProvider && !input.model) {
    return {
      allowed: true,
      correctedInput: { ...input, model: 'sonnet' },
    };
  }

  return { allowed: true };
}
