/**
 * Agent MCP Tools for CLI
 *
 * Tool definitions for agent lifecycle management with file persistence.
 * Includes model routing integration for intelligent model selection.
 */

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmdirSync, rmSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { MCPTool } from './types.js';
import { sanitizePathId } from '@hive-flow/shared';

// Storage paths
const STORAGE_DIR = '.hive-flow';
const AGENT_DIR = 'agents';
const AGENT_FILE = 'store.json';

// Model tier aliases — map to provider-native models via resolveProviderModel()
type AgentModel = 'sonnet' | 'opus' | 'inherit';

// First-class providers: Cursor, Codex, Gemini alongside Anthropic
export type AgentProvider = 'anthropic' | 'anthropic-cli' | 'gemini-cli' | 'codex-cli' | 'cursor-cli' | 'deepseek';

export interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'spawning' | 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  domain?: string;
  model?: AgentModel;  // Model tier assigned to this agent
  provider?: AgentProvider;  // LLM provider (anthropic, gemini-cli, codex-cli, cursor-cli)
  resolvedModel?: string;  // Provider-native model name (e.g. gemini-3.1-pro-preview, gpt-5.4)
  modelRoutedBy?: 'explicit' | 'router' | 'agent-booster' | 'default';  // How model was determined (ADR-026)
}

export interface AgentStore {
  agents: Record<string, AgentRecord>;
  version: string;
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

// Default model mappings for agent types (can be overridden)
const AGENT_TYPE_MODEL_DEFAULTS: Record<string, AgentModel> = {
  // Complex agents → opus
  'architect': 'opus',
  'security-architect': 'opus',
  'system-architect': 'opus',
  'core-architect': 'opus',
  // Medium complexity → sonnet
  'coder': 'sonnet',
  'reviewer': 'sonnet',
  'researcher': 'sonnet',
  'tester': 'sonnet',
  'analyst': 'sonnet',
  // Simple/fast agents → sonnet
  'formatter': 'sonnet',
  'linter': 'sonnet',
  'documenter': 'sonnet',
};

// Lazy-loaded model router
let modelRouterInstance: Awaited<ReturnType<typeof import('../ruvector/model-router.js').getModelRouter>> | null = null;

async function getModelRouter() {
  if (!modelRouterInstance) {
    try {
      const { getModelRouter } = await import('../ruvector/model-router.js');
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
  if (config.model && ['sonnet', 'opus', 'inherit'].includes(config.model as string)) {
    return { model: config.model as AgentModel, routedBy: 'explicit' };
  }

  // 2. Enhanced task-based routing with Agent Booster AST
  if (task) {
    try {
      // Try enhanced router first (includes Agent Booster detection)
      const { getEnhancedModelRouter } = await import('../ruvector/enhanced-model-router.js');
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
  const defaultModel = AGENT_TYPE_MODEL_DEFAULTS[agentType];
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

function readParentEnforcementLevel(): number {
  try {
    const stateFile = join(ENFORCEMENT_DIR, 'state.json');
    if (!existsSync(stateFile)) return 0; // NORMAL — no state means unrestricted
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
        : 0;
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
        : 0;
    }
    // Unsigned envelope — fail-closed (A4: reject unsigned state)
    return 1; // WARNED
  } catch {
    return 1; // A4: Fail-closed: can't read parent state, treat as WARNED (not NORMAL)
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
        agentType: { type: 'string', description: 'Type of agent to spawn' },
        agentId: { type: 'string', description: 'Optional custom agent ID' },
        config: { type: 'object', description: 'Agent configuration' },
        domain: { type: 'string', description: 'Agent domain' },
        provider: {
          type: 'string',
          enum: ['anthropic', 'anthropic-cli', 'gemini-cli', 'codex-cli', 'cursor-cli', 'deepseek'],
          description: 'LLM provider (default: anthropic). anthropic-cli, Codex, Gemini, Cursor are first-class CLI providers.',
        },
        model: {
          type: 'string',
          enum: ['sonnet', 'opus', 'inherit'],
          description: 'Model tier (maps to provider-native model via alias resolver)',
        },
        task: { type: 'string', description: 'Task description for intelligent model routing' },
      },
      required: ['agentType'],
    },
    handler: async (input) => {
      const agentId = (input.agentId as string) || `agent-${randomUUID()}`;
      const agentType = input.agentType as string;
      const config = (input.config as Record<string, unknown>) || {};

      // Add explicit model to config if provided
      if (input.model) {
        config.model = input.model;
      }

      // Get task from either top-level or config (CLI passes it in config.task)
      const task = (input.task as string) || (config.task as string) || undefined;

      // Determine model using ADR-026 3-tier routing logic
      const routingResult = await determineAgentModel(
        agentType,
        config,
        task
      );

      // Resolve provider and provider-native model name
      const provider = (input.provider as AgentProvider) || 'anthropic';
      let resolvedModel: string | undefined;
      if (provider !== 'anthropic') {
        try {
          const { resolveProviderModel } = await import('@hive-flow/providers');
          resolvedModel = resolveProviderModel(provider, routingResult.model);
        } catch {
          // Provider package not available — fall through without resolved model
        }
      }

      // SEC-011: Generate spawn-origin token for identity hardening.
      // Stored in agent record and propagated as env var HIVE_FLOW_AGENT_TOKEN
      // to prevent env-var spoofing of agent identity.
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
        model: routingResult.model,
        provider,
        resolvedModel,
        modelRoutedBy: routingResult.routedBy,
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

      // SEC-011: Set spawn-origin token in process env so child processes inherit it.
      // role-enforcement.cjs verifies this token matches the stored value.
      process.env.HIVE_FLOW_AGENT_TOKEN = spawnToken;

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

      // Cursor-CLI sanity guard: warn if only IDE launcher exists (no headless binary)
      if (provider === 'cursor-cli') {
        try {
          const { execFileSync } = await import('node:child_process');
          try { execFileSync('which', ['cursor-agent'], { stdio: 'pipe' }); } catch {
            try { execFileSync('which', ['cursor'], { stdio: 'pipe' });
              response.warning = 'Only Cursor IDE launcher found (not cursor-agent). The \'agent\' subcommand will be prepended automatically, but installing cursor-agent is recommended for reliable headless execution. See: https://docs.cursor.com/agent';
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
              terminatedAt: new Date().toISOString(),
            };
          }
          saveAgentStore(store);
          return {
            success: true,
            agentId,
            terminated: true,
            terminatedAt: new Date().toISOString(),
          };
        }

        return {
          success: false,
          agentId,
          error: 'Agent not found',
        };
      });

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
      const store = loadAgentStore();
      const agentId = input.agentId as string;
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
        agentType: { type: 'string', description: 'Agent type filter' },
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
        const agentType = (input.agentType as string) || 'worker';

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
              freshStore.agents[a.agentId].status = 'terminated';
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
                freshStore.agents[a.agentId].status = 'terminated';
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
    description: 'Send a task to a provider-backed agent for execution',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of the agent (must be spawned first via agent_spawn)' },
        task: { type: 'string', description: 'Task prompt to send to the agent' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 120000)' },
      },
      required: ['agentId', 'task'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;
      const task = input.task as string;
      const rawTimeout = (input.timeout as number) || 120000;
      const MIN_TIMEOUT = 10000;    // 10 seconds
      const MAX_TIMEOUT = 3600000;  // 60 minutes
      const timeout = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, rawTimeout));

      // RC-2: Lock → fresh read → validate → set busy → save → unlock
      // Uses bridge-compatible per-agent lock to coordinate with bridge subprocess.
      const validationError = await withBridgeLock(agentId, () => {
        const store = loadAgentStore();
        const agent = store.agents[agentId];
        if (!agent) {
          return 'Agent not found';
        }
        if (!agent.provider) {
          return 'Agent has no provider — use agent_spawn with a provider first';
        }
        if (agent.provider === 'anthropic') {
          return "Use 'anthropic-cli' for Claude subprocess workers, not 'anthropic'. The agent_task bridge supports providers: anthropic-cli, gemini-cli, codex-cli, cursor-cli, deepseek. Use Claude Code Task tool for native anthropic agents.";
        }
        if (!transitionAgent(agent, 'busy')) {
          return `Agent cannot accept tasks in current state: '${agent.status}'`;
        }
        saveAgentStore(store);
        return null; // success
      });

      if (validationError) {
        return { success: false, agentId, error: validationError };
      }

      // Resolve bridge script path relative to compiled output location
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const bridgePath = join(thisDir, '..', '..', '..', '..', 'providers', 'scripts', 'provider-agent-bridge.mjs');

      if (!existsSync(bridgePath)) {
        // RC-2: Lock → fresh read → reset status only → save → unlock
        await withBridgeLock(agentId, () => {
          const s = loadAgentStore();
          const a = s.agents[agentId];
          if (a && a.status === 'busy') {
            a.status = 'idle';
            saveAgentStore(s);
          }
        });
        return { success: false, agentId, error: `Bridge script not found at ${bridgePath}` };
      }

      const agentDir = getAgentDir();
      // Pass task via stdin (--task-stdin) to avoid shell parsing issues with
      // special characters (colons, quotes, pipes, etc.) and ARG_MAX limits.
      const args = ['--agent-id', agentId, '--task-stdin', '--store-dir', agentDir, '--timeout', String(timeout)];

      // RC-2 helper: bridge-compatible lock → fresh read → reset status to idle
      // if still busy → save → unlock. Only touches status — never overwrites
      // conversation history, taskCount, lastResult, or other bridge-written fields.
      const resetStatusToIdle = async (): Promise<void> => {
        await withBridgeLock(agentId, () => {
          const freshStore = loadAgentStore();
          const freshAgent = freshStore.agents[agentId];
          if (freshAgent && freshAgent.status === 'busy') {
            freshAgent.status = 'idle';
            saveAgentStore(freshStore);
          }
        });
      };

      return new Promise((resolve) => {
        // Use spawn (not execFile) so we can pipe the task via stdin.
        // This avoids all shell-parsing issues with special characters in task text
        // and bypasses OS ARG_MAX limits for very long prompts.
        const child = spawn('node', [bridgePath, ...args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout,
        });

        // Pipe task text via stdin — the bridge reads it when --task-stdin is set
        child.stdin.on('error', () => { /* ignore EPIPE if bridge exits early */ });
        child.stdin.write(task);
        child.stdin.end();

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
          // Safety: cap stdout collection at maxBuffer equivalent (10MB)
          if (stdout.length > 10 * 1024 * 1024) {
            child.kill('SIGKILL');
          }
        });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        child.on('close', (code: number | null) => {
          const handleResult = () => {
            if (code !== 0) {
              // Try to parse error JSON from stdout (bridge writes errors there)
              // Providers may leak log lines to stdout; extract JSON robustly
              let parsed: Record<string, unknown> | undefined;
              try { parsed = JSON.parse(stdout); } catch {
                const js = stdout.indexOf('{');
                const je = stdout.lastIndexOf('}');
                if (js !== -1 && je > js) {
                  try { parsed = JSON.parse(stdout.slice(js, je + 1)); } catch { /* not JSON */ }
                }
              }
              if (parsed && parsed.error) {
                resolve({ success: false, agentId, error: parsed.error, stderr: stderr || undefined });
              } else {
                const errMsg = code === null ? 'Bridge process killed (timeout or signal)' : `Bridge exited with code ${code}`;
                resolve({ success: false, agentId, error: errMsg, stderr: stderr || undefined });
              }
              return;
            }

            // Parse bridge JSON output
            // Providers may leak log lines to stdout; extract the JSON object robustly
            let result: Record<string, unknown>;
            try {
              result = JSON.parse(stdout);
            } catch {
              // Fallback: find the first top-level JSON object in stdout
              const jsonStart = stdout.indexOf('{');
              const jsonEnd = stdout.lastIndexOf('}');
              if (jsonStart !== -1 && jsonEnd > jsonStart) {
                try {
                  result = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
                } catch {
                  resolve({ success: false, agentId, error: 'Failed to parse bridge output', rawOutput: stdout.slice(0, 2000) });
                  return;
                }
              } else {
                resolve({ success: false, agentId, error: 'Failed to parse bridge output', rawOutput: stdout.slice(0, 2000) });
                return;
              }
            }

            // RC-2: Bridge already saved updated agent state (history, taskCount, lastResult).
            resolve(result);
          };

          // RC-2: Lock → fresh read → reset status to idle ONLY if still busy → save → unlock.
          // This ensures we never overwrite bridge-written fields.
          resetStatusToIdle().then(handleResult).catch(handleResult);
        });

        child.on('error', (spawnErr) => {
          // RC-2: Lock → fresh read → reset status only → save → unlock
          resetStatusToIdle().then(() => {
            resolve({ success: false, agentId, error: `Failed to spawn bridge: ${spawnErr.message}` });
          }).catch(() => {
            resolve({ success: false, agentId, error: `Failed to spawn bridge: ${spawnErr.message}` });
          });
        });
      });
    },
  },
  {
    name: 'agent_task_async',
    description: 'Dispatch a task to a provider-backed agent without waiting for the result (non-blocking). Poll with agent_task_result.',
    category: 'agent',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of the agent (must be spawned first via agent_spawn)' },
        task: { type: 'string', description: 'Task prompt to send to the agent' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 120000)' },
      },
      required: ['agentId', 'task'],
    },
    handler: async (input) => {
      const agentId = input.agentId as string;
      const task = input.task as string;
      const rawTimeout = (input.timeout as number) || 120000;
      const MIN_TIMEOUT = 10000;    // 10 seconds
      const MAX_TIMEOUT = 3600000;  // 60 minutes
      const timeout = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, rawTimeout));

      const taskId = `task-${randomUUID()}`;

      // Validate agent and set busy — same pattern as agent_task
      const validationError = await withBridgeLock(agentId, () => {
        const store = loadAgentStore();
        const agent = store.agents[agentId];
        if (!agent) {
          return 'Agent not found';
        }
        if (!agent.provider) {
          return 'Agent has no provider — use agent_spawn with a provider first';
        }
        if (agent.provider === 'anthropic') {
          return "Use 'anthropic-cli' for Claude subprocess workers, not 'anthropic'. The agent_task bridge supports providers: anthropic-cli, gemini-cli, codex-cli, cursor-cli, deepseek. Use Claude Code Task tool for native anthropic agents.";
        }
        if (!transitionAgent(agent, 'busy')) {
          return `Agent cannot accept tasks in current state: '${agent.status}'`;
        }
        saveAgentStore(store);
        return null; // success
      });

      if (validationError) {
        return { success: false, agentId, error: validationError };
      }

      // Resolve bridge script path relative to compiled output location
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const bridgePath = join(thisDir, '..', '..', '..', '..', 'providers', 'scripts', 'provider-agent-bridge.mjs');

      if (!existsSync(bridgePath)) {
        await withBridgeLock(agentId, () => {
          const s = loadAgentStore();
          const a = s.agents[agentId];
          if (a && a.status === 'busy') {
            a.status = 'idle';
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
      const child = spawn('node', [
        bridgePath,
        '--agent-id', agentId,
        '--task-file', taskFilePath,
        '--result-file', resultFilePath,
        '--store-dir', agentDir,
        '--timeout', String(timeout),
      ], { detached: true, stdio: 'ignore' });

      child.unref();

      // Write tracking metadata
      const trackingPath = join(tasksDir, `${taskId}.json`);
      writeFileSync(trackingPath, JSON.stringify({
        status: 'running',
        taskId,
        agentId,
        startedAt: new Date().toISOString(),
        pid: child.pid,
      }, null, 2), 'utf-8');

      return { success: true, taskId, agentId, status: 'running', pid: child.pid };
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

      let tracking: { status: string; taskId: string; agentId: string; startedAt: string; pid?: number };
      try {
        tracking = JSON.parse(readFileSync(trackingPath, 'utf-8'));
      } catch {
        return { success: false, error: `Failed to read task tracking file for ${taskId}` };
      }

      const resultFilePath = join(tasksDir, `${taskId}.result.json`);

      if (existsSync(resultFilePath)) {
        // Result file exists — task completed
        let result: Record<string, unknown>;
        try {
          result = JSON.parse(readFileSync(resultFilePath, 'utf-8'));
        } catch {
          return { success: false, taskId, agentId: tracking.agentId, status: 'failed', error: 'Failed to parse result file' };
        }

        // Update tracking status
        tracking.status = 'completed';
        writeFileSync(trackingPath, JSON.stringify(tracking, null, 2), 'utf-8');

        // Reset agent to idle
        await withBridgeLock(tracking.agentId, () => {
          const store = loadAgentStore();
          const agent = store.agents[tracking.agentId];
          if (agent && agent.status === 'busy') {
            agent.status = 'idle';
            saveAgentStore(store);
          }
        });

        // W3: Delete the 3 task files after successfully reading completed result
        try { unlinkSync(join(tasksDir, `${taskId}.task`)); } catch { /* ignore */ }
        try { unlinkSync(resultFilePath); } catch { /* ignore */ }
        try { unlinkSync(trackingPath); } catch { /* ignore */ }

        return { success: true, taskId, agentId: tracking.agentId, status: 'completed', result };
      }

      // No result file yet — check if process is still running
      if (tracking.pid) {
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
              agent.status = 'idle';
              saveAgentStore(store);
            }
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
