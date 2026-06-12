/**
 * Agent MCP Tools for CLI
 *
 * Tool definitions for agent lifecycle management with file persistence.
 * Includes model routing integration for intelligent model selection.
 */

import { randomUUID, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmdirSync, rmSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MCPTool } from './types.js';
import { sanitizePathId } from '@hive-flow/shared';
import { DEFAULT_MAX_AGENTS, DEFAULT_QUEUE_DEPTH } from '@hive-flow/shared/core/config/defaults';
import {
  recordMcpAgentSpawn,
  recordMcpCallStart,
  recordMcpCallComplete,
  recordMcpCallFailed,
} from './scoreboard-instrumentation.js';
import { assertSubagentIdentityMarker } from './subagent-markers.js';
import { providerKeyPreflight } from './provider-key-preflight.js';
import { isEnvOnlyCliProvider } from '../credential-store/strict-api-provider.js';
import {
  CANONICAL_AGENT_TYPES,
  DEFAULT_CANONICAL_AGENT_TYPE,
  canonicalAgentTypesDescription,
  isCanonicalAgentType,
  type CanonicalAgentType,
} from '../agents/roster.js';

// Storage paths
const STORAGE_DIR = '.hive-flow';
const AGENT_DIR = 'agents';
const AGENT_FILE = 'store.json';

// Model tier aliases — map to provider-native models via resolveProviderModel()
type AgentModel = 'sonnet' | 'opus' | 'mini' | 'inherit';

// First-class providers: Cursor, Codex, Gemini alongside Anthropic
export type AgentProvider = 'anthropic' | 'anthropic-cli' | 'gemini-cli' | 'codex-cli' | 'cursor-cli' | 'deepseek' | 'openrouter';
const AGENT_PROVIDERS = new Set<AgentProvider>(['anthropic', 'anthropic-cli', 'gemini-cli', 'codex-cli', 'cursor-cli', 'deepseek', 'openrouter']);
const AGENT_MODEL_ALIASES = new Set<AgentModel>(['sonnet', 'opus', 'mini', 'inherit']);

export interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'spawning' | 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  idleSince?: string;
  terminatedAt?: string;
  domain?: string;
  model?: AgentModel;  // Model tier assigned to this agent
  provider?: AgentProvider;  // LLM provider (anthropic, gemini-cli, codex-cli, cursor-cli)
  resolvedModel?: string;  // Provider-native model name (e.g. gemini-3.5-flash, gpt-5.5)
  modelRoutedBy?: 'explicit' | 'router' | 'agent-booster' | 'default';  // How model was determined (ADR-026)
}

export interface AgentStore {
  agents: Record<string, AgentRecord>;
  version: string;
}

function normalizeProviderModelString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .normalize('NFKC')
    .replace(/[‐‑‒–—―−﹣－]/g, '-')
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : '';
}

function normalizeAgentProvider(value: unknown): AgentProvider | undefined {
  const normalized = normalizeProviderModelString(value);
  if (!normalized) return undefined;
  return AGENT_PROVIDERS.has(normalized as AgentProvider)
    ? normalized as AgentProvider
    : undefined;
}

function isAgentModelAlias(value: unknown): value is AgentModel {
  return typeof value === 'string' && AGENT_MODEL_ALIASES.has(value as AgentModel);
}

// Valid state transitions — 'terminated' is a terminal state
const VALID_TRANSITIONS: Record<string, string[]> = {
  'spawning': ['idle', 'terminated'],
  'idle': ['busy', 'terminated'],
  'busy': ['idle', 'terminated'],
  'terminated': [], // terminal state — no transitions out
};

/**
 * Guard: attempt to transition an agent to a new status.
 * Returns true if the transition is valid and was applied, false otherwise.
 * Unknown/missing statuses are treated as 'idle' for backward compatibility.
 */
export function transitionAgent(agent: AgentRecord, newStatus: AgentRecord['status']): boolean {
  const currentStatus = agent.status && VALID_TRANSITIONS[agent.status] ? agent.status : 'idle';
  const validNext = VALID_TRANSITIONS[currentStatus];
  if (!validNext || !validNext.includes(newStatus)) {
    return false;
  }
  agent.status = newStatus;
  if (newStatus === 'idle') {
    agent.idleSince = new Date().toISOString();
  } else if (newStatus === 'busy') {
    delete agent.idleSince;
  } else if (newStatus === 'terminated') {
    agent.terminatedAt = new Date().toISOString();
    delete agent.idleSince;
  }
  return true;
}

function getAgentDir(): string {
  return join(process.cwd(), STORAGE_DIR, AGENT_DIR);
}

function getAgentPath(): string {
  return join(getAgentDir(), AGENT_FILE);
}

function ensureAgentDir(): void {
  const dir = getAgentDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadAgentStore(): AgentStore {
  const path = getAgentPath();
  const bakPath = path + '.bak';
  try {
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    process.stderr.write(`[agent-store] Failed to parse store.json: ${(err as Error).message}. Attempting .bak restore.\n`);
    // Try backup
    try {
      if (existsSync(bakPath)) {
        const bakData = readFileSync(bakPath, 'utf-8');
        const restored = JSON.parse(bakData);
        process.stderr.write('[agent-store] Restored from .bak backup.\n');
        return restored;
      }
    } catch (bakErr) {
      process.stderr.write(`[agent-store] .bak restore also failed: ${(bakErr as Error).message}. Returning empty store.\n`);
    }
  }
  return { agents: {}, version: '3.0.0' };
}

export function saveAgentStore(store: AgentStore): void {
  ensureAgentDir();
  const targetPath = getAgentPath();
  const bakPath = targetPath + '.bak';
  const tmpPath = targetPath + '.tmp.' + process.pid;
  // Write .bak copy of the current file before overwriting
  try {
    if (existsSync(targetPath)) {
      writeFileSync(bakPath, readFileSync(targetPath, 'utf-8'), 'utf-8');
    }
  } catch {
    // Best-effort — do not block save if .bak write fails
  }
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmpPath, targetPath);
}

/**
 * Executes a function while holding an exclusive file lock on the agent store.
 * Prevents race conditions when multiple processes read-modify-write store.json.
 *
 * This is a SINGLE store-level lock (not per-agent) since store.json is shared.
 * - Uses O_CREAT | O_EXCL for atomic lock acquisition
 * - Retries with jittered backoff up to 10s timeout
 * - Detects and removes stale locks older than 30s (crashed processes)
 */
export async function withStoreLock<T>(fn: () => T): Promise<T>;
export async function withStoreLock<T>(scope: string, fn: () => T): Promise<T>;
export async function withStoreLock<T>(fnOrScope: string | (() => T), maybeFn?: () => T): Promise<T> {
  const fn = typeof fnOrScope === 'function' ? fnOrScope : maybeFn!;
  const lockPath = join(getAgentDir(), '.store.lock');
  ensureAgentDir();
  const maxWait = 10000; // 10s timeout
  const start = Date.now();
  let acquired = false;

  // Acquire lock with retry — uses mkdirSync (same mechanism as bridge's withFileLock)
  while (Date.now() - start < maxWait) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      break;
    } catch {
      // Check for stale lock (older than 30s)
      try {
        const lockStat = statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30000) {
          try { rmdirSync(lockPath); } catch { /* race with another cleaner */ }
          continue;
        }
      } catch {
        // Lock dir gone, retry
        continue;
      }
      await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    }
  }

  if (!acquired) {
    throw new Error('Failed to acquire store lock within 10s');
  }

  try {
    return fn();
  } finally {
    try { rmdirSync(lockPath); } catch { /* ignore */ }
  }
}

// Alias for bridge-handler coordination — same lock, just accepts agentId for error messages
async function withBridgeLock<T>(agentId: string, fn: () => T | Promise<T>): Promise<T> {
  return withStoreLock(agentId, async () => fn());
}

/**
 * Defense-in-depth: re-validate a persisted agent.model against project policy
 * at task dispatch time. The MCP enforcement gate (`checkModelEnforcement`) only
 * fires at agent_spawn / queen_spawn_worker. A legacy persisted record with
 * agent.model === 'haiku' would otherwise slip through to the provider bridge,
 * bypassing the haiku ban via storage. This helper closes that gap.
 */
function validateAgentModelForTask(agent: AgentRecord): { ok: boolean; error?: string } {
  // Cast to string for comparison: 'haiku' is not in the AgentModel union, but
  // legacy / out-of-band-edited persisted state may contain it.
  if ((agent.model as string | undefined) === 'haiku') {
    return {
      ok: false,
      error: 'AGENT MODEL ENFORCEMENT: agent has legacy persisted model "haiku" which is prohibited. Re-spawn with sonnet/opus/mini.',
    };
  }
  // Future: enforce other persisted-state policies here
  return { ok: true };
}

// Default model mappings for agent types (can be overridden)
export const AGENT_TYPE_MODEL_DEFAULTS: Record<CanonicalAgentType, AgentModel> = {
  investigator: 'sonnet',
  researcher: 'sonnet',
  verifier: 'opus',
  architect: 'opus',
  planner: 'opus',
  implementer: 'sonnet',
  tester: 'sonnet',
  auditor: 'opus',
  'bug-hunter': 'sonnet',
  debugger: 'sonnet',
  'security-architect': 'opus',
  'security-reviewer': 'opus',
  'red-team': 'opus',
  'blue-team': 'opus',
  'performance-engineer': 'sonnet',
  'memory-specialist': 'opus',
  documenter: 'sonnet',
  coordinator: 'sonnet',
};

// Lazy-loaded model router
let modelRouterInstance: Awaited<ReturnType<typeof import('../hivector/model-router.js').getModelRouter>> | null = null;

async function getModelRouter() {
  if (!modelRouterInstance) {
    try {
      const { getModelRouter } = await import('../hivector/model-router.js');
      modelRouterInstance = getModelRouter();
    } catch (e) {
      // Log but don't fail - model router is optional
      console.error('[agent-tools] Model router load failed:', (e as Error).message);
    }
  }
  return modelRouterInstance;
}

/**
 * Determine model for agent based on (ADR-026 3-tier routing):
 * 1. Explicit model in config
 * 2. Enhanced task-based routing with Agent Booster AST (if task provided)
 * 3. Agent type defaults
 * 4. Fallback to sonnet
 */
async function determineAgentModel(
  agentType: string,
  config: Record<string, unknown>,
  task?: string
): Promise<{
  model: AgentModel;
  routedBy: 'explicit' | 'router' | 'agent-booster' | 'default';
  canSkipLLM?: boolean;
  agentBoosterIntent?: string;
  tier?: 1 | 2 | 3;
}> {
  // 1. Explicit model in config
  if (config.model && ['sonnet', 'opus', 'mini', 'inherit'].includes(config.model as string)) {
    return { model: config.model as AgentModel, routedBy: 'explicit' };
  }

  // 2. Enhanced task-based routing with Agent Booster AST
  if (task) {
    try {
      // Try enhanced router first (includes Agent Booster detection)
      const { getEnhancedModelRouter } = await import('../hivector/enhanced-model-router.js');
      const enhancedRouter = getEnhancedModelRouter();
      const routeResult = await enhancedRouter.route(task, { filePath: config.filePath as string });

      if (routeResult.tier === 1 && routeResult.canSkipLLM) {
        // Agent Booster can handle this task
        return {
          model: 'sonnet', // Use sonnet as fallback if AB fails
          routedBy: 'agent-booster',
          canSkipLLM: true,
          agentBoosterIntent: routeResult.agentBoosterIntent?.type,
          tier: 1,
        };
      }

      return {
        model: routeResult.model!,
        routedBy: 'router',
        tier: routeResult.tier,
      };
    } catch {
      // Enhanced router not available, try basic router
      const router = await getModelRouter();
      if (router) {
        try {
          const result = await router.route(task);
          return { model: result.model, routedBy: 'router' };
        } catch {
          // Fall through to defaults on router error
        }
      }
    }
  }

  // 3. Agent type defaults
  const defaultModel = isCanonicalAgentType(agentType) ? AGENT_TYPE_MODEL_DEFAULTS[agentType] : undefined;
  if (defaultModel) {
    return { model: defaultModel, routedBy: 'default' };
  }

  // 4. Fallback to sonnet (balanced)
  return { model: 'sonnet', routedBy: 'default' };
}

// ---------------------------------------------------------------------------
// Enforcement level propagation (LOGIC-012)
// When a sub-agent is spawned, inherit the parent's enforcement level rather
// than defaulting to NORMAL. This prevents sub-agents from bypassing the
// escalation ladder established by the parent session.
// ---------------------------------------------------------------------------

const ENFORCEMENT_DIR = join(process.cwd(), '.hive-flow', 'enforcement');
const PROJECT_ENFORCEMENT_ID = `project-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}`;

function readSignedEnforcementLevel(stateFile: string): number | undefined {
  try {
    if (!existsSync(stateFile)) return undefined;
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));

    // A4: Read HMAC key for signature verification
    const keyFile = join(ENFORCEMENT_DIR, '.hmac-key');
    let hmacKey: string | null = null;
    try {
      if (existsSync(keyFile)) {
        hmacKey = readFileSync(keyFile, 'utf8').trim();
      }
    } catch { /* key unreadable */ }

    // Handles { state, hmac } envelope (enforcement.cjs)
    if (raw?.state !== undefined && typeof raw?.hmac === 'string') {
      // A4: Verify HMAC before trusting level
      if (!hmacKey) return 1; // Fail-closed: no key means can't verify — WARNED
      const expected = createHmac('sha256', hmacKey).update(JSON.stringify(raw.state)).digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(String(raw.hmac), 'hex');
      if (expectedBuf.length !== actualBuf.length) return 1; // WARNED

      if (!timingSafeEqual(expectedBuf, actualBuf)) return 1; // WARNED — tampered
      return typeof (raw.state as Record<string, unknown>)?.level === 'number'
        ? (raw.state as Record<string, unknown>).level as number
        : undefined;
    }
    // Handles { payload, signature } envelope (workflow-enforcer.ts)
    if (raw?.payload !== undefined && typeof raw?.signature === 'string') {
      // A4: Verify HMAC before trusting level
      if (!hmacKey) return 1; // Fail-closed: WARNED
      const expected = createHmac('sha256', hmacKey).update(JSON.stringify(raw.payload)).digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(String(raw.signature), 'hex');
      if (expectedBuf.length !== actualBuf.length) return 1;

      if (!timingSafeEqual(expectedBuf, actualBuf)) return 1;
      return typeof (raw.payload as Record<string, unknown>)?.level === 'number'
        ? (raw.payload as Record<string, unknown>).level as number
        : undefined;
    }
    // Unsigned envelope — fail-closed (A4: reject unsigned state)
    return 1; // WARNED
  } catch {
    return 1; // A4: Fail-closed: can't read parent state, treat as WARNED (not NORMAL)
  }
}

function readParentEnforcementLevel(): number {
  const globalLevel = readSignedEnforcementLevel(join(ENFORCEMENT_DIR, 'state.json')) ?? 0;
  const projectLevel = readSignedEnforcementLevel(join(ENFORCEMENT_DIR, 'projects', PROJECT_ENFORCEMENT_ID, 'state.json')) ?? 0;
  const callerAgentId = sanitizePathId(process.env.AGENTIC_FLOW_AGENT_ID || process.env.CLAUDE_AGENT_ID || '', 64);
  const agentLevel = callerAgentId
    ? (readSignedEnforcementLevel(join(ENFORCEMENT_DIR, 'agents', callerAgentId, 'state.json')) ?? 0)
    : 0;
  const hiveId = sanitizePathId(process.env.HIVE_FLOW_HIVE_ID || '', 64);
  const hiveLevel = hiveId
    ? (readSignedEnforcementLevel(join(ENFORCEMENT_DIR, 'hives', hiveId, 'state.json')) ?? 0)
    : 0;
  return Math.max(globalLevel, projectLevel, agentLevel, hiveLevel);
}

const BRIDGE_BASE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NODE_OPTIONS',
  'NPM_CONFIG_CACHE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'CLAUDE_PROJECT_DIR',
  'HIVE_FLOW_CONFIG',
  'HIVE_FLOW_LOG_LEVEL',
]);

function isDeniedBridgeEnvKey(key: string): boolean {
  return key === 'HIVE_FLOW_DEV_OVERRIDE_TOKEN'
    || key === 'HIVE_FLOW_DEV_OVERRIDE'
    || key === 'HIVE_FLOW_ENFORCEMENT_DISABLED'
    || key === 'HIVE_FLOW_PIPELINE_OVERRIDE';
}

function selectedProviderCredentialEnvKey(provider: AgentProvider): string | undefined {
  if (!isEnvOnlyCliProvider(provider)) return undefined;
  const candidates: Record<string, string[]> = {
    'gemini-cli': ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    'codex-cli': ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    'cursor-cli': ['CURSOR_API_KEY', 'CURSOR_TOKEN'],
    'anthropic-cli': ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  };
  return candidates[provider]?.find(key => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function buildProviderBridgeEnv(
  provider: AgentProvider,
  agentId: string,
  agentToken: string | undefined,
  agentRole: { type?: string; hiveId?: string } | null,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (isDeniedBridgeEnvKey(key)) continue;
    if (BRIDGE_BASE_ENV_KEYS.has(key)) {
      childEnv[key] = value;
    }
  }

  const selectedCredentialKey = selectedProviderCredentialEnvKey(provider);
  if (selectedCredentialKey) {
    childEnv[selectedCredentialKey] = process.env[selectedCredentialKey]!;
  }

  childEnv.AGENTIC_FLOW_AGENT_ID = agentId;
  childEnv.CLAUDE_AGENT_ID = agentId;
  if (agentToken) childEnv.HIVE_FLOW_AGENT_TOKEN = agentToken;
  if (agentRole?.hiveId) childEnv.HIVE_FLOW_HIVE_ID = agentRole.hiveId;
  if (agentRole?.type) childEnv.HIVE_FLOW_ROLE = agentRole.type;
  assertSubagentIdentityMarker(childEnv, `provider bridge agent ${agentId}`);
  return childEnv;
}

function readVerifiedAgentRole(agentId: string): { type?: string; hiveId?: string } | null {
  try {
    const sanitized = sanitizePathId(agentId, 64);
    if (!sanitized) return null;
    const roleFile = join(ENFORCEMENT_DIR, 'agents', sanitized, 'role.json');
    const keyFile = join(ENFORCEMENT_DIR, '.hmac-key');
    if (!existsSync(roleFile) || !existsSync(keyFile)) return null;
    const raw = JSON.parse(readFileSync(roleFile, 'utf8')) as { state?: Record<string, unknown>; hmac?: string };
    if (!raw?.state || typeof raw.hmac !== 'string') return null;
    const key = readFileSync(keyFile, 'utf8').trim();
    const expected = createHmac('sha256', key).update(JSON.stringify(raw.state)).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(raw.hmac, 'hex');
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return null;
    return {
      type: typeof raw.state.type === 'string' ? raw.state.type : undefined,
      hiveId: typeof raw.state.hiveId === 'string' ? raw.state.hiveId : undefined,
    };
  } catch {
    return null;
  }
}

/** Parse agent_activity time window: default 1h; accepts "1h"/"30m"/"2d" or hours as number. */
function parseActivityTimeRangeMs(input: Record<string, unknown>): number {
  const raw = input.timeRange ?? input.timeRangeHours;
  if (raw === undefined || raw === null) return 3600000;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw * 3600000;
  const s = String(raw).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(h|hour|hours|m|min|mins|minute|minutes|d|day|days)?$/.exec(s);
  if (m) {
    const n = parseFloat(m[1]!);
    if (!Number.isFinite(n) || n <= 0) return 3600000;
    const u = m[2] ?? 'h';
    if (u.startsWith('h')) return n * 3600000;
    if (u.startsWith('m')) return n * 60000;
    if (u.startsWith('d')) return n * 86400000;
  }
  return 3600000;
}

export function propagateEnforcementToSubAgent(agentId: string): void {
  try {
    const level = readParentEnforcementLevel();
    if (level === 0) return; // NORMAL — no propagation needed

    // A10: Use shared sanitizePathId utility
    const sanitized = sanitizePathId(agentId, 64);
    if (!sanitized) return;

    const agentEnfDir = join(ENFORCEMENT_DIR, 'agents', sanitized);
    mkdirSync(agentEnfDir, { recursive: true });

    // Read HMAC key (enforcement.cjs creates it; fall back to generating one)
    const keyFile = join(ENFORCEMENT_DIR, '.hmac-key');
    let key: string;
    if (existsSync(keyFile)) {
      key = readFileSync(keyFile, 'utf8').trim();
    } else {
      return; // Cannot sign without key — skip propagation rather than write unsigned state
    }

    const state = {
      level,
      violations: 0,
      consecutiveDenials: 0,
      lastActivity: new Date().toISOString(),
      restrictedGroups: [],
      history: [],
      resetAt: null,
      integrityCompromised: false,
      inheritedFromParent: true,
    };
    const hmac = createHmac('sha256', key).update(JSON.stringify(state)).digest('hex');
    const envelope = { state, hmac };

    const agentStateFile = join(agentEnfDir, 'state.json');
    const tmpPath = `${agentStateFile}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8');
    renameSync(tmpPath, agentStateFile);
  } catch {
    // Non-fatal: enforcement propagation is best-effort — log would be visible to attacker
  }
}

export const agentTools: MCPTool[] = [
  {
    name: 'agent_spawn',
    description: 'Spawn a new agent with intelligent model selection',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          enum: [...CANONICAL_AGENT_TYPES],
          description: `Canonical agent type to spawn. Valid agent types: ${canonicalAgentTypesDescription()}`,
        },
        agentId: { type: 'string', description: 'Optional custom agent ID' },
        config: { type: 'object', description: 'Agent configuration' },
        domain: { type: 'string', description: 'Agent domain' },
        provider: {
          type: 'string',
          enum: ['anthropic', 'anthropic-cli', 'gemini-cli', 'codex-cli', 'cursor-cli', 'deepseek', 'openrouter'],
          description: 'LLM provider (default: anthropic). anthropic-cli, Codex, Gemini, Cursor, OpenRouter are first-class CLI providers.',
        },
        model: {
          type: 'string',
          description: 'Model alias (opus/sonnet/mini/inherit) or provider-native model. OpenRouter direct models must be allowed by config.',
        },
        task: { type: 'string', description: 'Task description for intelligent model routing' },
      },
      required: ['agentType'],
    },
    handler: async (input) => {
      const agentId = (input.agentId as string) || `agent-${randomUUID()}`;
      const agentType = typeof input.agentType === 'string' ? input.agentType.trim() : '';
      const config = (input.config as Record<string, unknown>) || {};

      if (!isCanonicalAgentType(agentType)) {
        return {
          success: false,
          code: 'invalid-agent-type',
          error: `Invalid agentType '${String(input.agentType ?? '')}'. Valid agent types: ${canonicalAgentTypesDescription()}.`,
        };
      }

      // Global spawn hard-cap enforcement (DEFAULT_MAX_AGENTS + DEFAULT_QUEUE_DEPTH = 60).
      // The runbook specifies a 50 working + 10 queued cap; without a persistent
      // queue runner that promotes queued→working when slots free, a transient
      // requestSpawn() over a fresh empty queue cannot reach busy:queue-full
      // (Codex flagged this exact gap). The honest minimal enforcement is a
      // single hard cap at MAX + QUEUE_DEPTH total active agents; rejecting at
      // that boundary is reachable through normal sequential spawn calls.
      // The split queue semantics remain represented in src/swarm/intake.ts and
      // its tests for the future queue-runner workstream.
      //
      // Bypass: tests that mock the agent store (e.g., RC-4 UUID uniqueness)
      // need to spawn unbounded agents against a mock that doesn't propagate
      // live state. Vitest sets process.env.VITEST automatically; explicit
      // HIVE_FLOW_DISABLE_SPAWN_CAP also disables for ad-hoc bypass.
      const spawnCapDisabled = process.env.VITEST === 'true' || process.env.HIVE_FLOW_DISABLE_SPAWN_CAP === 'true';
      if (!spawnCapDisabled) try {
        const liveStore = loadAgentStore();
        const liveAgents = Object.values(liveStore.agents ?? {}) as AgentRecord[];
        const workingCount = liveAgents.filter(
          a => a.status === 'spawning' || a.status === 'idle' || a.status === 'busy',
        ).length;
        const hardCap = DEFAULT_MAX_AGENTS + DEFAULT_QUEUE_DEPTH;
        if (workingCount >= hardCap) {
          return {
            success: false,
            error: 'busy:queue-full',
            code: 'busy:queue-full',
            message:
              `Swarm hard-cap reached (${workingCount}/${hardCap} active agents = ` +
              `DEFAULT_MAX_AGENTS ${DEFAULT_MAX_AGENTS} + DEFAULT_QUEUE_DEPTH ${DEFAULT_QUEUE_DEPTH}). ` +
              `Spawn rejected. Wait for an existing agent to terminate before retrying.`,
            workingCount,
            capacity: hardCap,
          };
        }
      } catch {
        // Defensive: never block a spawn on intake bookkeeping errors.
      }

      const normalizedInputModel = normalizeProviderModelString(input.model);

      // Add explicit model to config if provided. Normalize aliases/direct slugs
      // before routing so case/whitespace variants cannot change runtime policy.
      if (normalizedInputModel !== undefined) {
        config.model = normalizedInputModel;
      }

      // Get task from either top-level or config. The CLI uses top-level fields;
      // config.task remains accepted for older callers.
      const task = (input.task as string) || (config.task as string) || undefined;

      // Determine model using ADR-026 3-tier routing logic
      const routingResult = await determineAgentModel(
        agentType,
        config,
        task
      );

      // Resolve provider and provider-native model name
      const normalizedProviderInput = normalizeProviderModelString(input.provider);
      const normalizedProvider = normalizeAgentProvider(input.provider);
      const provider = normalizedProvider || 'anthropic';
      if (input.provider !== undefined && normalizedProviderInput !== '' && !normalizedProvider) {
        return {
          success: false,
          error: `Unsupported provider '${String(input.provider)}'. Supported providers: ${Array.from(AGENT_PROVIDERS).join(', ')}`,
        };
      }
      const keyPreflight = await providerKeyPreflight(provider, process.env);
      if (!keyPreflight.ok) {
        return { success: false, error: keyPreflight.reason };
      }
      const modelForProviderResolution =
        normalizedInputModel !== undefined && normalizedInputModel !== ''
          ? normalizedInputModel
          : routingResult.model;
      let resolvedModel: string | undefined;
      if (provider !== 'anthropic') {
        try {
          const { resolveProviderModelOrOpus } = await import('@hive-flow/providers');
          // Never hard-fail on a blocked/unknown OpenRouter slug — degrade to the
          // opus class (operator-controlled tier pool, not gated by allowedModels).
          // Stays undefined only if the opus pool itself is empty (all mapped
          // models delisted) — the genuine "no model available" case.
          resolvedModel = resolveProviderModelOrOpus(provider, modelForProviderResolution);
        } catch {
          // Provider package not available — fall through without resolved model
        }
      }

      // OpenRouter: with opus-class fallback above, this only fires when the opus
      // tier pool is empty (every mapped model delisted) — a real config/availability
      // failure, not a blocked direct slug.
      if (provider === 'openrouter' && resolvedModel === undefined && normalizedInputModel) {
        return { success: false, error: `OpenRouter could not resolve a model for '${normalizedInputModel}' (opus tier pool empty — check .hive-flow/config.json openrouter.tiers.opus).` };
      }

      // SEC-011: Generate spawn-origin token for identity hardening.
      // Stored on the agent record so task bridges can pass it explicitly.
      const spawnToken = randomUUID();

      const agent: AgentRecord = {
        agentId,
        agentType,
        status: 'spawning',
        health: 1.0,
        taskCount: 0,
        config: { ...config, _spawnToken: spawnToken },
        createdAt: new Date().toISOString(),
        domain: input.domain as string,
        model: isAgentModelAlias(normalizedInputModel)
          ? normalizedInputModel
          : provider === 'openrouter' && normalizedInputModel
            ? 'inherit'
            : routingResult.model,
        provider,
        resolvedModel,
        modelRoutedBy: normalizedInputModel !== undefined && normalizedInputModel !== ''
          ? 'explicit'
          : routingResult.routedBy,
      };

      // Transition spawning → idle (setup complete)
      transitionAgent(agent, 'idle');

      await withStoreLock(() => {
        const store = loadAgentStore();
        store.agents[agentId] = agent;
        saveAgentStore(store);
      });

      // LOGIC-012: Propagate parent enforcement level to sub-agent state file.
      // Sub-agents start at the parent's enforcement level, not NORMAL.
      propagateEnforcementToSubAgent(agentId);

      // Phase 11.1: best-effort, NON-BLOCKING agent-spawn presence event.
      // Fire-and-forget: the recorders must never block or perturb the spawn
      // hot path (awaiting here reorders concurrent-spawn interleaving). The
      // wrapper swallows all errors internally, so this can never reject.
      void recordMcpAgentSpawn({ agentId, provider: agent.provider, model: agent.model });

      // Include Agent Booster routing info if applicable
      const response: Record<string, unknown> = {
        success: true,
        agentId,
        agentType: agent.agentType,
        model: agent.model,
        provider: agent.provider,
        resolvedModel: agent.resolvedModel,
        modelRoutedBy: routingResult.routedBy,
        status: 'spawned',
        createdAt: agent.createdAt,
      };

      // Add Agent Booster info if task can skip LLM
      if (routingResult.canSkipLLM) {
        response.canSkipLLM = true;
        response.agentBoosterIntent = routingResult.agentBoosterIntent;
        response.tier = routingResult.tier;
        response.note = `Agent Booster can handle "${routingResult.agentBoosterIntent}" - use agent_booster_edit_file MCP tool`;
      } else if (routingResult.tier) {
        response.tier = routingResult.tier;
      }
      if (keyPreflight.degraded) {
        response.warning = keyPreflight.warning;
      }

      // Cursor-CLI sanity guard: warn if only IDE launcher exists (no headless binary)
      if (provider === 'cursor-cli') {
        try {
          const { execFileSync } = await import('node:child_process');
          try { execFileSync('which', ['cursor-agent'], { stdio: 'pipe' }); } catch {
            try { execFileSync('which', ['cursor'], { stdio: 'pipe' });
              response.warning = 'Only Cursor IDE launcher found (not cursor-agent). The \'agent\' subcommand will be prepended automatically, but installing cursor-agent is recommended for reliable headless execution. See: Cursor Agent documentation';
            } catch { /* neither found — spawn already succeeded, don't add noise */ }
          }
        } catch { /* import failure — skip guard */ }
      }

      return response;
    },
  },
  {
    name: 'agent_terminate',
    description: 'Terminate an agent',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of agent to terminate' },
        force: { type: 'boolean', description: 'Force immediate termination' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;

      const result = await withStoreLock(() => {
        const store = loadAgentStore();

        if (store.agents[agentId]) {
          const agent = store.agents[agentId];
          if (!transitionAgent(agent, 'terminated')) {
            // Already terminated — idempotent success
            return {
              success: true,
              agentId,
              terminated: true,
              alreadyTerminated: true,
              terminatedAt: agent.terminatedAt,
            };
          }
          saveAgentStore(store);
          return {
            success: true,
            agentId,
            terminated: true,
            terminatedAt: agent.terminatedAt,
          };
        }

        return {
          success: false,
          agentId,
          error: 'Agent not found',
        };
      });

      if (result.success && result.terminated) {
        const tasksDir = join(process.cwd(), STORAGE_DIR, 'tasks');

        if (existsSync(tasksDir)) {
          let trackingFiles: string[] = [];
          const terminateMarker = join(tasksDir, `.bridge-terminate-${agentId}`);
          try {
            trackingFiles = readdirSync(tasksDir).filter(
              (file: string) => file.endsWith('.json') && !file.endsWith('.result.json'),
            );
          } catch {
            trackingFiles = [];
          }

          try {
            try {
              writeFileSync(terminateMarker, agentId, 'utf-8');
            } catch {
              // tasksDir may not exist if no task was ever dispatched — ignore
            }

            for (const file of trackingFiles) {
              const trackingPath = join(tasksDir, file);

              try {
                const tracking = JSON.parse(readFileSync(trackingPath, 'utf-8')) as {
                  status?: string;
                  taskId?: string;
                  agentId?: string;
                  pid?: number;
                };

                if (tracking.agentId !== agentId || tracking.status !== 'running') {
                  continue;
                }

                // Wait up to 10s for the bridge to notice and write its result file
                const waitStart = Date.now();
                const taskId = typeof tracking.taskId === 'string'
                  ? tracking.taskId
                  : file.replace(/\.json$/, '');
                const expectedResult = join(tasksDir, `${taskId}.result.json`);
                while (Date.now() - waitStart < 10_000) {
                  if (existsSync(expectedResult)) break;
                  // Also check if bridge already exited (PID no longer alive)
                  if (tracking.pid && tracking.pid > 0 && Number.isInteger(tracking.pid)) {
                    try {
                      process.kill(tracking.pid, 0);
                    } catch {
                      break; // Process already gone
                    }
                  } else {
                    break; // No valid PID to check
                  }
                  await new Promise(resolve => setTimeout(resolve, 500));
                }

                // Clean up task + tracking files
                try { unlinkSync(join(tasksDir, `${taskId}.task`)); } catch { /* best-effort */ }
                // Skip .result.json deletion — may still be needed by collect_results
                try { unlinkSync(trackingPath); } catch { /* best-effort */ }
              } catch {
                // Ignore unreadable tracking files during termination cleanup
              }
            }
          } finally {
            try {
              unlinkSync(terminateMarker);
            } catch {
              /* best-effort */
            }
          }
        }
      }

      // Clean up per-agent enforcement directory after successful termination
      if (result.success && result.terminated && !result.alreadyTerminated) {
        try {
          // A10: Use shared sanitizePathId utility
          const sanitized = sanitizePathId(agentId, 64);
          if (sanitized) {
            const agentEnfDir = join(process.cwd(), '.hive-flow', 'enforcement', 'agents', sanitized);
            if (existsSync(agentEnfDir)) {
              rmSync(agentEnfDir, { recursive: true, force: true });
            }
          }
        } catch { /* Non-fatal: enforcement cleanup is best-effort */ }
      }

      return result;
    },
  },
  {
    name: 'agent_status',
    description: 'Get agent status',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of agent' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;
      return withStoreLock(() => {
        const store = loadAgentStore();
        const agent = store.agents[agentId];

        if (agent) {
          return {
            agentId: agent.agentId,
            agentType: agent.agentType,
            status: agent.status,
            health: agent.health,
            taskCount: agent.taskCount,
            createdAt: agent.createdAt,
            domain: agent.domain,
            model: agent.model,
            provider: agent.provider,
            resolvedModel: agent.resolvedModel,
            modelRoutedBy: agent.modelRoutedBy,
          };
        }

        return {
          agentId,
          status: 'not_found',
          error: 'Agent not found',
        };
      });
    },
  },
  {
    name: 'agent_list',
    description: 'List all agents',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status' },
        domain: { type: 'string', description: 'Filter by domain' },
        includeTerminated: { type: 'boolean', description: 'Include terminated agents' },
      },
    },
    handler: async (input) => {
      const store = loadAgentStore();
      let agents = Object.values(store.agents);

      // Filter by status
      if (input.status) {
        agents = agents.filter(a => a.status === input.status);
      } else if (!input.includeTerminated) {
        agents = agents.filter(a => a.status !== 'terminated');
      }

      // Filter by domain
      if (input.domain) {
        agents = agents.filter(a => a.domain === input.domain);
      }

      return {
        agents: agents.map(a => ({
          agentId: a.agentId,
          agentType: a.agentType,
          status: a.status,
          health: a.health,
          taskCount: a.taskCount,
          createdAt: a.createdAt,
          domain: a.domain,
          model: a.model,
          provider: a.provider,
          resolvedModel: a.resolvedModel,
          modelRoutedBy: a.modelRoutedBy,
        })),
        total: agents.length,
        filters: {
          status: input.status,
          domain: input.domain,
          includeTerminated: input.includeTerminated,
        },
      };
    },
  },
  {
    name: 'agent_pool',
    description: 'Manage agent pool',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'scale', 'drain', 'fill'], description: 'Pool action' },
        targetSize: { type: 'number', description: 'Target pool size (for scale action)' },
        agentType: {
          type: 'string',
          enum: [...CANONICAL_AGENT_TYPES],
          description: `Agent type filter. Valid agent types: ${canonicalAgentTypesDescription()}.`,
          default: DEFAULT_CANONICAL_AGENT_TYPE,
        },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const store = loadAgentStore();
      const agents = Object.values(store.agents).filter(a => a.status !== 'terminated');
      const action = (input.action as string) || 'status';  // Default to status

      if (action === 'status') {
        const byType: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        for (const agent of agents) {
          byType[agent.agentType] = (byType[agent.agentType] || 0) + 1;
          byStatus[agent.status] = (byStatus[agent.status] || 0) + 1;
        }
        const idleAgents = agents.filter(a => a.status === 'idle').length;
        const busyAgents = agents.filter(a => a.status === 'busy').length;
        const utilization = agents.length > 0 ? busyAgents / agents.length : 0;
        return {
          action,
          // CLI expected fields
          poolId: 'agent-pool-default',
          currentSize: agents.length,
          minSize: (input.min as number) || 0,
          maxSize: (input.max as number) || 100,
          autoScale: (input.autoScale as boolean) ?? false,
          utilization,
          agents: agents.map(a => ({
            id: a.agentId,
            type: a.agentType,
            status: a.status,
          })),
          // Additional fields
          id: 'agent-pool-default',
          size: agents.length,
          totalAgents: agents.length,
          byType,
          byStatus,
          avgHealth: agents.length > 0 ? agents.reduce((sum, a) => sum + a.health, 0) / agents.length : 0,
        };
      }

      if (action === 'scale') {
        const targetSize = (input.targetSize as number) || 5;
        const agentType = typeof input.agentType === 'string' && input.agentType.trim()
          ? input.agentType.trim()
          : DEFAULT_CANONICAL_AGENT_TYPE;

        if (!isCanonicalAgentType(agentType)) {
          return {
            action,
            success: false,
            code: 'invalid-agent-type',
            error: `Invalid agentType '${String(input.agentType ?? '')}'. Valid agent types: ${canonicalAgentTypesDescription()}.`,
          };
        }

        return withStoreLock(() => {
          const freshStore = loadAgentStore();
          const liveAgents = Object.values(freshStore.agents).filter(a => a.status !== 'terminated');
          const currentSize = liveAgents.filter(a => a.agentType === agentType).length;
          const delta = targetSize - currentSize;
          const added: string[] = [];
          const removed: string[] = [];

          if (delta > 0) {
            for (let i = 0; i < delta; i++) {
              const agentId = `agent-${randomUUID()}`;
              freshStore.agents[agentId] = {
                agentId,
                agentType,
                status: 'idle',
                health: 1.0,
                taskCount: 0,
                config: {},
                createdAt: new Date().toISOString(),
              };
              added.push(agentId);
            }
          } else if (delta < 0) {
            const toRemove = liveAgents.filter(a => a.agentType === agentType && a.status === 'idle').slice(0, -delta);
            for (const a of toRemove) {
              transitionAgent(freshStore.agents[a.agentId], 'terminated');
              removed.push(a.agentId);
            }
          }

          saveAgentStore(freshStore);
          return {
            action,
            agentType,
            previousSize: currentSize,
            targetSize,
            newSize: currentSize + delta,
            added,
            removed,
          };
        });
      }

      if (action === 'drain') {
        const agentType = input.agentType as string;

        return withStoreLock(() => {
          const freshStore = loadAgentStore();
          const liveAgents = Object.values(freshStore.agents).filter(a => a.status !== 'terminated');
          let drained = 0;
          for (const a of liveAgents) {
            if (!agentType || a.agentType === agentType) {
              if (a.status === 'idle') {
                transitionAgent(freshStore.agents[a.agentId], 'terminated');
                drained++;
              }
            }
          }
          saveAgentStore(freshStore);
          return {
            action,
            agentType: agentType || 'all',
            drained,
            remaining: liveAgents.length - drained,
          };
        });
      }

      return { action, error: 'Unknown action' };
    },
  },
  {
    name: 'agent_task',
    description: 'Dispatch a task to a provider-backed agent (non-blocking). Returns immediately with taskId. Poll with agent_task_result.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of the agent (must be spawned first via agent_spawn)' },
        task: { type: 'string', description: 'Task prompt to send to the agent' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 300000)' },
      },
      required: ['agentId', 'task'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;
      const task = input.task as string;
      const rawTimeout = (input.timeout as number) || 300000;
      const MIN_TIMEOUT = 10000;    // 10 seconds
      const MAX_TIMEOUT = 3600000;  // 60 minutes
      const timeout = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, rawTimeout));

      const taskId = `task-${randomUUID()}`;

      // RC-2: Lock → fresh read → validate → set busy → save → unlock
      const validationResult = await withBridgeLock(agentId, async () => {
        const store = loadAgentStore();
        const agent = store.agents[agentId];
        if (!agent) {
          return { error: 'Agent not found' };
        }
        if (!agent.provider) {
          return { error: 'Agent has no provider — use agent_spawn with a provider first' };
        }
        if (agent.provider === 'anthropic') {
          return {
            error: "Use 'anthropic-cli' for Claude subprocess workers, not 'anthropic'. The agent_task bridge supports providers: anthropic-cli, gemini-cli, codex-cli, cursor-cli, deepseek, openrouter. Use Claude Code Task tool for native anthropic agents.",
          };
        }
        const keyPreflight = await providerKeyPreflight(agent.provider, process.env);
        if (!keyPreflight.ok) {
          return { error: keyPreflight.reason };
        }
        // Defense-in-depth: re-validate persisted agent.model against project policy.
        // The MCP enforcement gate only fires at spawn time; persisted legacy state
        // must be rejected at task dispatch to prevent gate bypass via storage.
        const modelCheck = validateAgentModelForTask(agent);
        if (!modelCheck.ok) {
          return { error: modelCheck.error };
        }
        if (!transitionAgent(agent, 'busy')) {
          return { error: `Agent cannot accept tasks in current state: '${agent.status}'` };
        }
        const agentToken = typeof agent.config?._spawnToken === 'string'
          ? agent.config._spawnToken
          : undefined;
        saveAgentStore(store);
        return { error: null, agentToken, provider: agent.provider, model: agent.model };
      });

      if (validationResult.error) {
        return { success: false, agentId, error: validationResult.error };
      }

      // Resolve bridge script path relative to compiled output location
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const bridgePath = join(thisDir, '..', '..', '..', '..', 'providers', 'scripts', 'provider-agent-bridge.mjs');

      if (!existsSync(bridgePath)) {
        await withBridgeLock(agentId, () => {
          const s = loadAgentStore();
          const a = s.agents[agentId];
          if (a && a.status === 'busy') {
            transitionAgent(a, 'idle');
            saveAgentStore(s);
          }
        });
        return { success: false, agentId, error: `Bridge script not found at ${bridgePath}` };
      }

      // Create task directory and files
      const tasksDir = join(process.cwd(), STORAGE_DIR, 'tasks');
      mkdirSync(tasksDir, { recursive: true });

      const taskFilePath = join(tasksDir, `${taskId}.task`);
      const resultFilePath = join(tasksDir, `${taskId}.result.json`);

      writeFileSync(taskFilePath, task, 'utf-8');

      const agentDir = getAgentDir();
      const agentRole = readVerifiedAgentRole(agentId);
      const childEnv = buildProviderBridgeEnv(
        validationResult.provider as AgentProvider,
        agentId,
        validationResult.agentToken,
        agentRole,
      );
      const child = spawn('node', [
        bridgePath,
        '--agent-id', agentId,
        ...(validationResult.agentToken ? ['--agent-token', validationResult.agentToken] : []),
        '--task-file', taskFilePath,
        '--result-file', resultFilePath,
        '--store-dir', agentDir,
        '--timeout', String(timeout),
      ], {
        detached: true,
        stdio: 'ignore',
        env: childEnv,
      });

      child.unref();

      // Write tracking metadata. `provider` is persisted so agent_task_result
      // can emit a terminal call event correlated by the same taskId without
      // re-reading the agent store (which may have changed by poll time).
      const trackingPath = join(tasksDir, `${taskId}.json`);
      writeFileSync(trackingPath, JSON.stringify({
        status: 'running',
        taskId,
        agentId,
        provider: validationResult.provider,
        startedAt: new Date().toISOString(),
        pid: child.pid,
      }, null, 2), 'utf-8');

      // Phase 11.1: best-effort, non-blocking call-start (eventId = taskId).
      void recordMcpCallStart({
        taskId,
        agentId,
        provider: validationResult.provider,
        model: validationResult.model,
      });

      return { success: true, taskId, agentId, status: 'running', pid: child.pid };
    },
  },
  {
    name: 'agent_task_async',
    description: 'Alias for agent_task (non-blocking). Dispatch a task to a provider-backed agent. Returns immediately with taskId. Poll with agent_task_result.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of the agent (must be spawned first via agent_spawn)' },
        task: { type: 'string', description: 'Task prompt to send to the agent' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 300000)' },
      },
      required: ['agentId', 'task'],
    },
    handler: async (input) => {
      // Delegate to agent_task — both are now identical (non-blocking)
      const agentTaskTool = agentTools.find(t => t.name === 'agent_task');
      if (!agentTaskTool) throw new Error('agent_task tool not found');
      return agentTaskTool.handler(input);
    },
  },
  {
    name: 'agent_task_result',
    description: 'Poll for the result of an async task dispatched via agent_task_async.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID returned by agent_task_async' },
      },
      required: ['taskId'],
    },
    handler: async (input) => {
      const rawTaskId = input.taskId as string;
      // A3+A10: Sanitize taskId using shared utility to prevent directory traversal
      const taskId = sanitizePathId(rawTaskId, 128);
      if (!taskId) {
        return { success: false, error: 'Invalid taskId' };
      }
      const tasksDir = join(process.cwd(), STORAGE_DIR, 'tasks');
      const trackingPath = join(tasksDir, `${taskId}.json`);

      if (!existsSync(trackingPath)) {
        return { success: false, error: `Task not found: ${taskId}` };
      }

      let tracking: { status: string; taskId: string; agentId: string; startedAt: string; pid?: number; provider?: string };
      try {
        tracking = JSON.parse(readFileSync(trackingPath, 'utf-8'));
      } catch {
        return { success: false, error: `Failed to read task tracking file for ${taskId}` };
      }

      const resultFilePath = join(tasksDir, `${taskId}.result.json`);

      if (existsSync(resultFilePath)) {
        // Result file exists — task completed
        let result: Record<string, unknown>;
        let rawContents = '';
        try {
          rawContents = readFileSync(resultFilePath, 'utf-8');
          result = JSON.parse(rawContents);
        } catch (err) {
          const errorDetail = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            taskId,
            agentId: tracking.agentId,
            status: 'failed',
            error: `Failed to parse result file: ${errorDetail}`,
            rawOutput: rawContents.slice(0, 2048),
          };
        }

        // Update tracking status
        tracking.status = 'completed';
        writeFileSync(trackingPath, JSON.stringify(tracking, null, 2), 'utf-8');

        // Reset agent to idle
        await withBridgeLock(tracking.agentId, () => {
          const store = loadAgentStore();
          const agent = store.agents[tracking.agentId];
          if (agent && agent.status === 'busy') {
            transitionAgent(agent, 'idle');
            saveAgentStore(store);
          }
        });

        // Also update hive worker record status
        try {
          const { loadHive, saveHive, withHiveLock } = await import('./hive-store.js');
          const { listHives } = await import('./hive-store.js');
          const hives = listHives('active');
          for (const hive of hives) {
            const worker = hive.workers?.find(w => w.agentId === tracking.agentId);
            if (worker && worker.status === 'busy') {
              await withHiveLock(hive.hiveId, () => {
                const fresh = loadHive(hive.hiveId);
                if (!fresh) return;
                const fw = fresh.workers?.find(w => w.agentId === tracking.agentId);
                if (fw && fw.status === 'busy') {
                  fw.status = 'idle';
                  fw.idleSince = new Date().toISOString();
                  saveHive(hive.hiveId, fresh);
                }
              });
              break;
            }
          }
        } catch { /* best-effort hive record sync */ }

        // Phase 11.1: best-effort, non-blocking terminal call-complete
        // (eventId = taskId). Provider is captured by value here, so the
        // tracking-file unlink below cannot race it.
        void recordMcpCallComplete({
          taskId,
          agentId: tracking.agentId,
          provider: tracking.provider,
        });

        // W3: Delete task + tracking files after successfully reading completed result
        // Keep .result.json alive — agent_terminate and hive-cleanup may still reference it
        try { unlinkSync(join(tasksDir, `${taskId}.task`)); } catch { /* ignore */ }
        try { unlinkSync(trackingPath); } catch { /* ignore */ }

        return { success: true, taskId, agentId: tracking.agentId, status: 'completed', result };
      }

      // No result file yet — check if process is still running (signal 0 liveness only)
      if (tracking.pid && tracking.pid > 0 && Number.isInteger(tracking.pid)) {
        try {
          process.kill(tracking.pid, 0); // signal 0 = existence check
          return { success: true, taskId, agentId: tracking.agentId, status: 'running' };
        } catch {
          // Process exited without writing a result
          tracking.status = 'failed';
          writeFileSync(trackingPath, JSON.stringify(tracking, null, 2), 'utf-8');

          // Reset agent to idle
          await withBridgeLock(tracking.agentId, () => {
            const store = loadAgentStore();
            const agent = store.agents[tracking.agentId];
            if (agent && agent.status === 'busy') {
              transitionAgent(agent, 'idle');
              saveAgentStore(store);
            }
          });

          // Also update hive worker record status
          try {
            const { loadHive, saveHive, withHiveLock } = await import('./hive-store.js');
            const { listHives } = await import('./hive-store.js');
            const hives = listHives('active');
            for (const hive of hives) {
              const worker = hive.workers?.find(w => w.agentId === tracking.agentId);
              if (worker && worker.status === 'busy') {
                await withHiveLock(hive.hiveId, () => {
                  const fresh = loadHive(hive.hiveId);
                  if (!fresh) return;
                  const fw = fresh.workers?.find(w => w.agentId === tracking.agentId);
                  if (fw && fw.status === 'busy') {
                    fw.status = 'idle';
                    fw.idleSince = new Date().toISOString();
                    saveHive(hive.hiveId, fresh);
                  }
                });
                break;
              }
            }
          } catch { /* best-effort hive record sync */ }

          // Phase 11.1: best-effort, non-blocking terminal call-failed.
          void recordMcpCallFailed({
            taskId,
            agentId: tracking.agentId,
            provider: tracking.provider,
          });

          return { success: false, taskId, agentId: tracking.agentId, status: 'failed', error: 'Process exited without producing a result' };
        }
      }

      // No pid recorded — treat as unknown
      return { success: true, taskId, agentId: tracking.agentId, status: tracking.status };
    },
  },
  {
    name: 'agent_health',
    description: 'Check agent health',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Specific agent ID (optional)' },
        threshold: { type: 'number', description: 'Health threshold (0-1)' },
      },
    },
    handler: async (input) => {
      const store = loadAgentStore();
      const agents = Object.values(store.agents).filter(a => a.status !== 'terminated');
      const threshold = (input.threshold as number) || 0.5;

      if (input.agentId) {
        const agent = store.agents[input.agentId as string];
        if (agent) {
          return {
            agentId: agent.agentId,
            health: agent.health,
            status: agent.status,
            healthy: agent.health >= threshold,
            taskCount: agent.taskCount,
            uptime: Date.now() - new Date(agent.createdAt).getTime(),
          };
        }
        return { agentId: input.agentId, error: 'Agent not found' };
      }

      const healthyAgents = agents.filter(a => a.health >= threshold);
      const degradedAgents = agents.filter(a => a.health >= 0.3 && a.health < threshold);
      const unhealthyAgents = agents.filter(a => a.health < 0.3);
      const avgHealth = agents.length > 0 ? agents.reduce((sum, a) => sum + a.health, 0) / agents.length : 1;
      const avgCpu = null; // Real process metrics require OS monitoring integration
      const avgMemory = null; // Real process metrics require OS monitoring integration

      return {
        // CLI expected fields
        agents: agents.map(a => {
          const uptime = Date.now() - new Date(a.createdAt).getTime();
          return {
            id: a.agentId,
            type: a.agentType,
            health: a.health >= threshold ? 'healthy' : (a.health >= 0.3 ? 'degraded' : 'unhealthy'),
            uptime,
            memory: null, // Real process metrics require OS monitoring integration
            cpu: null, // Real process metrics require OS monitoring integration
            tasks: { active: a.taskCount > 0 ? 1 : 0, queued: 0, completed: a.taskCount, failed: 0 },
            latency: null, // Real process metrics require OS monitoring integration
            errors: { count: a.health < threshold ? 1 : 0 },
          };
        }),
        overall: {
          healthy: healthyAgents.length,
          degraded: degradedAgents.length,
          unhealthy: unhealthyAgents.length,
          avgCpu,
          avgMemory,
          score: Math.round(avgHealth * 100),
          issues: unhealthyAgents.length,
        },
        // Additional fields
        total: agents.length,
        healthyCount: healthyAgents.length,
        unhealthyCount: unhealthyAgents.length,
        threshold,
        avgHealth,
        unhealthyAgents: unhealthyAgents.map(a => ({
          agentId: a.agentId,
          health: a.health,
          status: a.status,
        })),
      };
    },
  },
  {
    name: 'agent_update',
    description: 'Update agent status or config',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of agent' },
        status: { type: 'string', description: 'New status' },
        health: { type: 'number', description: 'Health value (0-1)' },
        taskCount: { type: 'number', description: 'Task count' },
        config: { type: 'object', description: 'Config updates' },
      },
      required: ['agentId'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;

      // A9: Block cross-agent mutations when enforcement level > 0
      const callerAgentId = process.env.AGENTIC_FLOW_AGENT_ID
        || process.env.CLAUDE_SESSION_ID
        || process.env.CLAUDE_AGENT_ID
        || null;
      if (callerAgentId && callerAgentId !== agentId) {
        const enforcementLevel = readParentEnforcementLevel();
        if (enforcementLevel > 0) {
          return {
            success: false,
            agentId,
            error: `[ENFORCEMENT] Cross-agent mutation blocked: caller '${callerAgentId}' cannot update agent '${agentId}' at enforcement level ${enforcementLevel}`,
          };
        }
      }

      return withStoreLock(() => {
        const store = loadAgentStore();
        const agent = store.agents[agentId];

        if (agent) {
          if (input.status) {
            const newStatus = input.status as AgentRecord['status'];
            if (!transitionAgent(agent, newStatus)) {
              return {
                success: false,
                agentId,
                error: `Invalid status transition: '${agent.status}' → '${newStatus}'`,
              };
            }
          }
          if (typeof input.health === 'number') agent.health = input.health as number;
          if (typeof input.taskCount === 'number') agent.taskCount = input.taskCount as number;
          if (input.config) {
            agent.config = { ...agent.config, ...(input.config as Record<string, unknown>) };
          }
          saveAgentStore(store);

          return {
            success: true,
            agentId,
            updated: true,
            agent: {
              agentId: agent.agentId,
              status: agent.status,
              health: agent.health,
              taskCount: agent.taskCount,
            },
          };
        }

        return {
          success: false,
          agentId,
          error: 'Agent not found',
        };
      });
    },
  },
  {
    name: 'agent_activity',
    description: 'Query recent per-tool activity from .hive-flow/logs/activity.jsonl (newest first).',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Filter by agent id' },
        hiveId: { type: 'string', description: 'Filter by hive id from role snapshot' },
        timeRange: {
          type: 'string',
          description: 'Time window (default 1h), e.g. 1h, 30m, 2d',
        },
        timeRangeHours: {
          type: 'number',
          description: 'Deprecated: hours of history; prefer timeRange string',
        },
        tool: { type: 'string', description: 'Substring match on tool name' },
        limit: { type: 'number', description: 'Max rows (default 100, max 1000)' },
      },
    },
    handler: async (input) => {
      const logFile = join(process.cwd(), STORAGE_DIR, 'logs', 'activity.jsonl');
      const windowMs = parseActivityTimeRangeMs(input as Record<string, unknown>);
      const limit = Math.min(1000, Math.max(1, (input.limit as number) || 100));
      const cutoff = Date.now() - windowMs;
      const filterAgent = input.agentId as string | undefined;
      const filterHive = input.hiveId as string | undefined;
      const toolNeedle = (input.tool as string | undefined)?.toLowerCase();

      if (!existsSync(logFile)) {
        return { success: true, entries: [], returned: 0, note: 'no activity log yet' };
      }

      let content = '';
      try {
        content = readFileSync(logFile, 'utf-8');
      } catch {
        return { success: false, error: 'Could not read activity log' };
      }

      const lines = content.split('\n').filter(Boolean);
      const entries: Record<string, unknown>[] = [];
      const scanCap = limit * 4;
      for (let i = lines.length - 1; i >= 0 && entries.length < scanCap; i--) {
        try {
          const row = JSON.parse(lines[i] as string) as Record<string, unknown>;
          const ts = new Date(String(row.ts ?? '')).getTime();
          if (Number.isNaN(ts) || ts < cutoff) continue;
          if (filterAgent && row.agentId !== filterAgent) continue;
          if (filterHive && row.hiveId !== filterHive) continue;
          if (toolNeedle && !String(row.tool ?? '').toLowerCase().includes(toolNeedle)) continue;
          entries.push(row);
        } catch { /* skip malformed */ }
      }

      const trimmed = entries.slice(0, limit);
      return {
        success: true,
        entries: trimmed,
        returned: trimmed.length,
        timeRangeMs: windowMs,
        limit,
      };
    },
  },
];
