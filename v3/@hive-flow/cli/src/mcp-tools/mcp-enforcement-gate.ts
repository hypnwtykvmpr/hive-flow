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
  'queen_spawn_worker', 'queen_mission_assign',
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

const AGENT_SPAWN_TOOLS = new Set(['agent_spawn', 'agent_task', 'queen_spawn_worker', 'queen_mission_assign']);

// FIX-S5: Unicode-hyphen variants (U+2010 ‐, U+2011 ‑, U+2012 ‒, U+2013 –,
// U+2014 —, U+2015 ―, U+2212 −, U+FE63 ﹣, U+FF0D －) lowercase to themselves,
// not to ASCII U+002D. Without normalization, `'codex‐cli'.toLowerCase()`
// fails the strict equality check `=== 'codex-cli'` and falls through to
// allow. NFKC compatibility folding + an explicit replace covers both
// canonical-equivalent and homoglyph cases.
function normalizeProviderModel(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  return s
    .normalize('NFKC')
    .replace(/[‐‑‒–—―−﹣－]/g, '-')
    .trim()
    .toLowerCase();
}

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

  // FIX-C1 (G1 + G2): Normalize provider and model strings at gate entry to
  // defeat case-folding and whitespace-padding bypasses.
  // FIX-S5: Also normalize Unicode-hyphen variants (e.g. U+2010 ‐) to ASCII
  // `-` so `'codex‐cli'` cannot bypass strict equality with `'codex-cli'`.
  // The `correctedInput` returned must be based on the ORIGINAL `input` —
  // downstream callers may rely on exact case being preserved for the actual
  // spawn. Only gate decisions use the normalized values.
  const providerNormalized = normalizeProviderModel(input.provider) as string | undefined;
  const modelNormalized = normalizeProviderModel(input.model) as string | undefined;
  const normInput: ModelEnforcementInput = {
    ...input,
    provider: providerNormalized,
    model: modelNormalized,
  };

  // Rule 1: haiku alias is universally prohibited for agent tasks.
  // Use sonnet or opus instead.
  if (normInput.model === 'haiku') {
    return {
      allowed: false,
      reason: 'MODEL ENFORCEMENT: haiku model prohibited for agent tasks. Use sonnet, opus, or mini.',
    };
  }

  // FIX-C2 (G4): Empty string is NOT a valid alias.
  // Empty model defaults are handled explicitly by Rules 4/5/6 below using `!input.model`,
  // which is truthy for both `undefined` and `''`. So removing `''` from the alias
  // set only changes the behavior of providers that lack a default rule
  // (e.g. gemini-cli, codex-cli, cursor-cli) — for those, an empty string now
  // correctly falls through to the per-provider top-tier check and is blocked.
  const ALLOWED_ALIASES = new Set(['opus', 'sonnet', 'mini', 'inherit', undefined]);

  // Rule 2: gemini-cli requires gemini-3.5-flash (top tier) or an alias.
  if (
    normInput.provider === 'gemini-cli' &&
    normInput.model !== 'gemini-3.5-flash' &&
    !ALLOWED_ALIASES.has(normInput.model)
  ) {
    return {
      allowed: false,
      reason: 'MODEL ENFORCEMENT: gemini-cli requires gemini-3.5-flash (top tier).',
    };
  }

  // Rule 3: codex-cli requires gpt-5.5 (top tier) or an alias. No gpt-5.4 rollout exception.
  if (
    normInput.provider === 'codex-cli' &&
    normInput.model !== 'gpt-5.5' &&
    !ALLOWED_ALIASES.has(normInput.model)
  ) {
    return {
      allowed: false,
      reason: 'MODEL ENFORCEMENT: codex-cli requires gpt-5.5 (top tier).',
    };
  }

  // deepseek → default (no explicit model) maps to deepseek-v4-pro via resolver
  if (normInput.provider === 'deepseek' && !normInput.model) {
    return { allowed: true, correctedInput: { ...input, model: 'deepseek-v4-pro' } };
  }

  // openrouter → requires an explicit model or tier alias
  if (normInput.provider === 'openrouter') {
    if (!normInput.model) {
      return {
        allowed: false,
        reason: 'MODEL ENFORCEMENT: openrouter requires an explicit model or tier (opus/sonnet/mini/inherit).',
      };
    }
    // Any model is allowed — the resolver checks the allowlist
    return { allowed: true };
  }

  // anthropic-cli (or unspecified provider) without explicit model → default to sonnet
  const isClaudeProvider =
    !normInput.provider ||
    normInput.provider === 'anthropic-cli' ||
    normInput.provider === 'claude';
  if (isClaudeProvider && !normInput.model) {
    return {
      allowed: true,
      correctedInput: { ...input, model: 'sonnet' },
    };
  }

  // All alias names pass through — resolver handles mapping
  if (ALLOWED_ALIASES.has(normInput.model as string)) {
    return { allowed: true };
  }

  return { allowed: true };
}
