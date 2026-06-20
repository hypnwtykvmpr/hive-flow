/**
 * MCP Enforcement Gate — Risk classification and blocking for MCP tools.
 * Called from callMCPTool() in mcp-client.ts to enforce tool restrictions.
 */

import { existsSync, readFileSync } from 'fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { resolveProjectRoot } from '../permission-guard/protected-paths.js';

export enum ToolRisk {
  CRITICAL = 3,
  HIGH = 2,
  MEDIUM = 1,
  LOW = 0,
}

// Risk classification table
const CRITICAL_TOOLS = new Set([
  'agent_spawn', 'agent_task', 'agent_task_async',
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
  'hooks_worker-dispatch', 'hooks_worker-detect',
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

function resolveGateSourceRoot(): string {
  // Compiled layout: dist/src/mcp-tools/ -> 5 levels up to project root.
  // Source layout under src/mcp-tools keeps the same relative root contract.
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

function resolveProjectDir(): string {
  // Keep MCP gating byte-identical to enforcement.cjs PROJECT_DIR selection.
  // The shared resolver honors HIVE_FLOW_PROJECT_ROOT before CLAUDE_PROJECT_DIR
  // and normalizes candidates through realpath when available. Do not replace
  // this with bespoke env/cwd logic; project-scope HMAC paths depend on the
  // exact sha256(projectRoot) match.
  return resolveProjectRoot({
    env: process.env,
    cwd: resolveGateSourceRoot(),
    fallbackRoot: process.cwd(),
  });
}

// Highest enforcement level — used for fail-closed behavior on any error.
const LEVEL_HALTED = 3;

/**
 * Read the FIRST present HMAC key from an ordered list of candidate paths.
 *
 * Mirrors `.claude/helpers/enforcement.cjs` `getOrCreateHmacKey()` (lines ~145-173):
 * the shared key at `<hiveHome>/enforcement/.hmac-key` is preferred, with the
 * legacy project-local key at `<projectDir>/.hive-flow/enforcement/.hmac-key`
 * as fallback. A SINGLE shared key signs EVERY hiveHome-rooted scope — there are
 * NO per-scope sibling keys (the previous gate wrongly assumed sibling keys).
 *
 * NOTE: the gate is read-only and never creates a key (unlike enforcement.cjs,
 * which would mint one). If neither key exists, callers fail-closed.
 */
function readFirstHmacKey(candidatePaths: string[]): string | null {
  for (const keyFile of candidatePaths) {
    try {
      if (existsSync(keyFile)) {
        const key = readFileSync(keyFile, 'utf8').trim();
        if (key) return key;
      }
    } catch {
      // Cannot read this candidate — try the next.
    }
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

/**
 * Resolve the hive home directory used for the global enforcement scope.
 * Mirrors `resolveHiveHome` semantics and `.claude/helpers/enforcement.cjs`:
 * an absolute HIVE_FLOW_HOME wins; otherwise default to `~/.hive-flow`.
 */
function resolveHiveHomeDir(): string {
  const configured = process.env.HIVE_FLOW_HOME;
  if (configured && isAbsolute(configured)) {
    return configured;
  }
  return join(homedir(), '.hive-flow');
}

/**
 * Sanitize a scope id, mirroring `.claude/helpers/enforcement.cjs` ->
 * `protected-paths.cjs` `sanitizeScopeId()` (maxLen 64). Non-string / empty
 * yields the provided fallback; otherwise non-[A-Za-z0-9_-] runs collapse to
 * `_`, leading/trailing `_` are stripped, and the result is truncated to 64.
 */
function sanitizeScopeId(id: unknown, fallback = ''): string {
  if (typeof id !== 'string' || !id.trim()) return fallback;
  const sanitized = id
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return sanitized || fallback;
}

/**
 * project scope id, mirroring enforcement.cjs `getProjectScopeId()` (line ~223):
 *   `project-${sha256(PROJECT_DIR).slice(0,16)}`
 */
function getProjectScopeId(projectDir: string): string {
  return `project-${createHash('sha256').update(projectDir).digest('hex').slice(0, 16)}`;
}

/**
 * Read and verify a SINGLE scope state file.
 *
 * Returns:
 *   - `null` when the scope file is ABSENT (this scope simply does not apply).
 *   - a numeric level when the file is PRESENT and its signed envelope verifies.
 *   - LEVEL_HALTED (fail-closed) when the file is PRESENT but tampered, unsigned,
 *     unreadable, or otherwise invalid — tamper handling must NOT be downgraded.
 *
 * `keyCandidates` is the ordered list of `.hmac-key` paths used to verify the
 * envelope (shared hiveHome key first, legacy project-local key as fallback) —
 * matching enforcement.cjs `getOrCreateHmacKey()`.
 */
function readScopeLevel(stateFile: string, keyCandidates: string[]): number | null {
  // ABSENT scope file — does not contribute a level. A missing scope file
  // must NOT, by itself, produce a phantom HALTED.
  if (!existsSync(stateFile)) return null;

  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));

    // SEC-009: HMAC verification before trusting the level.
    // Only the signed envelope format is accepted. Legacy plain-state files are
    // rejected (fail-closed) because their integrity cannot be verified.
    if (raw?.state !== undefined && typeof raw?.hmac === 'string') {
      const key = readFirstHmacKey(keyCandidates);
      if (key === null) {
        // Present but cannot verify — fail-closed
        return LEVEL_HALTED;
      }
      if (!verifyEnvelopeHmac(raw as { state: unknown; hmac: string }, key)) {
        // Present but HMAC mismatch — state tampered, fail-closed
        return LEVEL_HALTED;
      }
      const state = raw.state as Record<string, unknown>;
      return typeof state?.level === 'number' ? state.level : LEVEL_HALTED;
    }

    // Present but no HMAC envelope — unsigned state, fail-closed
    return LEVEL_HALTED;
  } catch {
    // Present but unreadable/unparseable — fail-closed
    return LEVEL_HALTED;
  }
}

/**
 * One enforcement scope: its primary state file at the canonical hiveHome path,
 * plus an optional legacy fallback path. enforcement.cjs `getScopedState()`
 * reads the primary file if present, else the legacy file (lines ~487-488).
 */
interface ScopeSpec {
  stateFile: string;
  legacyStateFile?: string;
}

export function getEnforcementLevel(): number {
  try {
    const hiveHome = resolveHiveHomeDir();
    const projectDir = resolveProjectDir();

    const enforcementDir = join(hiveHome, 'enforcement');
    const legacyEnforcementDir = join(projectDir, '.hive-flow', 'enforcement');

    // HMAC key resolution — mirrors enforcement.cjs `getOrCreateHmacKey()`
    // (lines ~145-173): the SINGLE shared key at <hiveHome>/enforcement/.hmac-key
    // signs ALL hiveHome-rooted scopes, with the legacy project-local key as
    // fallback. The previous gate wrongly used per-scope sibling keys.
    const keyCandidates = [
      join(enforcementDir, '.hmac-key'),
      join(legacyEnforcementDir, '.hmac-key'),
    ];

    const projectId = getProjectScopeId(projectDir);

    // Scope set + paths mirror enforcement.cjs:
    //   - getScopedStateFile() (lines ~259-268): canonical hiveHome paths
    //   - getLegacyScopedStateFile() (lines ~247-256): <projectDir>/.hive-flow legacy paths
    //   - loadEffectiveState() (lines ~736-748): the scopes MAXed over —
    //     agent, hive, session, project, global. enforcement.cjs gates the
    //     agent/hive/session scopes behind spawn-token identity trust; the
    //     read-only gate cannot replicate that, so it conservatively includes
    //     any of those scopes whose state file is PRESENT on disk at the correct
    //     hiveHome path (a present, signed, non-zero scope MUST still block).
    //
    // Scope ids come from the same env vars enforcement.cjs reads:
    //   agent   => HIVE_FLOW_AGENT_ID || CLAUDE_AGENT_ID
    //   hive    => HIVE_FLOW_HIVE_ID
    //   session => CLAUDE_SESSION_ID || HIVE_FLOW_SESSION_ID || HIVE_FLOW_SESSION_ID
    const agentId = sanitizeScopeId(
      process.env.HIVE_FLOW_AGENT_ID || process.env.CLAUDE_AGENT_ID || '',
    );
    const hiveId = sanitizeScopeId(process.env.HIVE_FLOW_HIVE_ID || '');
    const sessionId = sanitizeScopeId(
      process.env.CLAUDE_SESSION_ID ||
        process.env.HIVE_FLOW_SESSION_ID ||
        process.env.HIVE_FLOW_SESSION_ID ||
        '',
    );

    const scopes: ScopeSpec[] = [];

    if (agentId) {
      scopes.push({
        stateFile: join(enforcementDir, 'agents', agentId, 'state.json'),
        legacyStateFile: join(legacyEnforcementDir, 'agents', agentId, 'state.json'),
      });
    }
    if (hiveId) {
      scopes.push({
        stateFile: join(enforcementDir, 'hives', hiveId, 'state.json'),
        legacyStateFile: join(legacyEnforcementDir, 'hives', hiveId, 'state.json'),
      });
    }
    if (sessionId) {
      scopes.push({
        stateFile: join(enforcementDir, 'sessions', sessionId, 'state.json'),
        legacyStateFile: join(legacyEnforcementDir, 'sessions', sessionId, 'state.json'),
      });
    }
    // project scope — CORRECTED PATH. enforcement.cjs project state lives at
    // <hiveHome>/enforcement/projects/<project-id>/state.json (NOT at
    // <projectDir>/.hive-flow/enforcement/state.json, which the prior gate read
    // and which let a REAL project-scoped HALT slip through as 0). The legacy
    // project fallback is <projectDir>/.hive-flow/enforcement/projects/<id>/state.json.
    scopes.push({
      stateFile: join(enforcementDir, 'projects', projectId, 'state.json'),
      legacyStateFile: join(legacyEnforcementDir, 'projects', projectId, 'state.json'),
    });
    // global scope — <hiveHome>/enforcement/global/state.json. Legacy global
    // fallback is <projectDir>/.hive-flow/enforcement/state.json
    // (getLegacyScopedStateFile('global'), line ~248).
    scopes.push({
      stateFile: join(enforcementDir, 'global', 'state.json'),
      legacyStateFile: join(legacyEnforcementDir, 'state.json'),
    });

    // EFFECTIVE LEVEL = MAX over all PRESENT scopes (mirrors loadEffectiveState
    // MAX-walk, lines ~755-760). A real HALT(3)/RESTRICTED(2)/WARNED(1) in ANY
    // present scope still applies. If NO scope file is present at all, return 0
    // (NORMAL) — the system clean default. A present-but-tampered scope
    // contributes LEVEL_HALTED (fail-closed).
    let effective: number | null = null;
    for (const scope of scopes) {
      // Prefer the canonical hiveHome path; fall back to the legacy path only
      // when the canonical file is absent (enforcement.cjs getScopedState).
      const present = existsSync(scope.stateFile)
        ? scope.stateFile
        : scope.legacyStateFile && existsSync(scope.legacyStateFile)
        ? scope.legacyStateFile
        : null;
      if (present === null) continue; // absent scope — skip
      const level = readScopeLevel(present, keyCandidates);
      if (level === null) continue;
      effective = effective === null ? level : Math.max(effective, level);
    }

    return effective === null ? 0 : effective;
  } catch {
    // SEC-008: fail-CLOSED on any unexpected error in scope resolution
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
 * In-process dispatch level gate.
 *
 * Top-level MCP calls pass through callMCPTool(), but queen and hive-mind code
 * can dispatch by calling sibling tool handlers directly. Reuse the canonical
 * MCP enforcement policy here so those in-process dispatch paths obey the same
 * live signed enforcement state.
 */
export function assertDispatchAllowed(toolName: string): EnforcementResult {
  return checkMCPEnforcement(toolName);
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

const AGENT_SPAWN_TOOLS = new Set(['agent_spawn', 'agent_task', 'agent_task_async', 'queen_spawn_worker', 'queen_mission_assign']);

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
  // DO-NOT-REVERT (2026-06): The `gemini-cli` provider now drives Google's
  // ANTIGRAVITY CLI (`agy`), and `gemini-3.5-flash` is Antigravity's live base
  // model (confirmed: `agy models` lists "Gemini 3.5 Flash" and
  // `agy -p "..." --model gemini-3.5-flash` succeeds). This gate value is
  // therefore correct and must NOT be changed to a legacy/dead model id.
  if (
    normInput.provider === 'gemini-cli' &&
    normInput.model !== 'gemini-3.5-flash' &&
    !ALLOWED_ALIASES.has(normInput.model)
  ) {
    return {
      allowed: false,
      reason: 'MODEL ENFORCEMENT: gemini-cli requires gemini-3.5-flash (top tier, Antigravity base model).',
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
