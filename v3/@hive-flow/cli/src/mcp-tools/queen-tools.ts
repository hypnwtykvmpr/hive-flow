/**
 * Queen Protocol MCP Tools
 *
 * Seven tools implementing the Advocate → Queen → Worker hierarchy:
 *   1. queen_mission_assign  — Advocate assigns a mission to a queen
 *   2. queen_spawn_worker    — Queen spawns a worker (internally calls agent_spawn)
 *   3. queen_task_worker     — Queen sends a task to a worker (wraps agent_task)
 *   4. queen_collect_results — Queen reads all worker task results
 *   5. queen_report          — Queen submits synthesized findings to advocate
 *   6. hive_status           — Advocate reads all hive records
 *   7. hive_terminate        — Advocate cascade-kills queen + all workers
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPTool } from './types.js';
import type { AgentProvider } from './agent-tools.js';
import { sanitizePathId } from '../shared/index.js';
import {
  transitionAgent,
  propagateEnforcementToSubAgent,
  loadAgentStore,
  saveAgentStore,
  withStoreLock,
} from './agent-tools.js';
import {
  type HiveRecord,
  type HiveMission,
  type HiveWorkerRecord,
  type HiveBudget,
  type ModuleHiveConfig,
  withHiveLock,
  createHive,
  loadHive,
  saveHive,
  listHives,
  appendHiveAudit,
  isHiveStale,
  findStaleHives,
  recomputeDelegationMetrics,
} from './hive-store.js';
import { getWorkflowHookDispatcher } from './workflow-executor.js';
import { normalizeClientKind, resolveOwnerStampOrError, sanitizeSessionId, type OwnerStampError } from './session-id.js';

// ---------------------------------------------------------------------------
// Workflow hooks (fire-and-forget)
// ---------------------------------------------------------------------------

function fireHiveSpawnedHook(context: Record<string, unknown>): void {
  const dispatcher = getWorkflowHookDispatcher();
  if (!dispatcher) return;
  void dispatcher.dispatch('hive-spawned', context).catch(() => {});
}

function fireQueenReportHook(context: Record<string, unknown>): void {
  const dispatcher = getWorkflowHookDispatcher();
  if (!dispatcher) return;
  void dispatcher.dispatch('queen-report', context).catch(() => {});
}

function fireHiveCompleteHook(context: Record<string, unknown>): void {
  const dispatcher = getWorkflowHookDispatcher();
  if (!dispatcher) return;
  void dispatcher.dispatch('hive-complete', context).catch(() => {});
}

async function fireHiveTerminatedHook(context: Record<string, unknown>): Promise<void> {
  try {
    const { getWorkflowHookDispatcher: getDispatcher } = await import('./workflow-executor.js');
    const dispatch = getDispatcher();
    if (dispatch) void dispatch.dispatch('hive-terminated', context).catch(() => {});
  } catch {}
}

// ---------------------------------------------------------------------------
// HMAC signing — lazy import to avoid circular deps with workflow-enforcer
// ---------------------------------------------------------------------------

async function signHiveState(record: HiveRecord): Promise<string> {
  try {
    const { getOrCreateHmacKey, signPayload } = await import('./workflow-enforcer.js');
    const key = getOrCreateHmacKey();
    return signPayload(record, key);
  } catch {
    return ''; // HMAC not available — skip signing
  }
}

async function readVerifiedQueenDirectWorkCount(queenId: string): Promise<number> {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { createHmac, timingSafeEqual } = await import('node:crypto');
    // A10: Use shared sanitizePathId utility
    const sanitized = sanitizePathId(queenId, 64);
    if (!sanitized) return 0;
    const roleFile = join(process.cwd(), '.hive-flow', 'enforcement', 'agents', sanitized, 'role.json');
    const hmacKeyFile = join(process.cwd(), '.hive-flow', 'enforcement', '.hmac-key');
    if (!existsSync(roleFile) || !existsSync(hmacKeyFile)) return 0;
    const raw = JSON.parse(readFileSync(roleFile, 'utf8')) as { state?: { directWorkCount?: number }; hmac?: string };
    if (!raw?.state || !raw?.hmac) return 0;
    const key = readFileSync(hmacKeyFile, 'utf8').trim();
    const expected = createHmac('sha256', key).update(JSON.stringify(raw.state)).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(raw.hmac, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 0;
    return typeof raw.state.directWorkCount === 'number' ? raw.state.directWorkCount : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Helper: invoke agent_spawn handler via dynamic import (avoid circular)
// ---------------------------------------------------------------------------

async function callAgentSpawn(
  input: Record<string, unknown>,
  context?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // FIX-C4 (G3, N1 gate): defense-in-depth — the public MCP gate enforces on
  // top-level calls, but queen-internal callers must also be validated to
  // prevent per-worker bypass of model policy (e.g. queen_mission_assign's
  // workers[] array, or queen_spawn_worker invoking callAgentSpawn).
  const { checkModelEnforcement, assertDispatchAllowed } = await import('./mcp-enforcement-gate.js');
  const enforcement = checkModelEnforcement(
    'agent_spawn',
    input as { model?: string; provider?: string },
  );
  if (!enforcement.allowed) {
    return { success: false, error: enforcement.reason };
  }
  const effectiveInput = enforcement.correctedInput
    ? { ...input, ...enforcement.correctedInput }
    : input;
  const dispatchGate = assertDispatchAllowed('agent_spawn');
  if (!dispatchGate.allowed) {
    return { success: false, error: dispatchGate.reason };
  }

  // Lazy import to avoid circular dependency (queen-tools → agent-tools → queen-tools)
  const { agentTools } = await import('./agent-tools.js');
  const spawnTool = agentTools.find(t => t.name === 'agent_spawn');
  if (!spawnTool) throw new Error('agent_spawn tool not found');
  return spawnTool.handler(effectiveInput, context) as Promise<Record<string, unknown>>;
}

function ownerSpawnContext(
  ownerSessionId: unknown,
  ownerClientKind: unknown,
  surface: string,
): ({ success: true; input: { session_id: string }; context: { sessionId: string; clientKind: string } } | OwnerStampError) {
  const sessionId = sanitizeSessionId(ownerSessionId);
  if (!sessionId) {
    return {
      success: false,
      code: 'missing-owner-session',
      error: `${surface} requires a persisted hive owner session before spawning workers.`,
    };
  }
  const clientKind = normalizeClientKind(ownerClientKind);
  if (clientKind === 'unknown') {
    return {
      success: false,
      code: 'missing-owner-client-kind',
      error: `${surface} requires a persisted hive owner client kind before spawning workers.`,
    };
  }
  return {
    success: true,
    input: { session_id: sessionId },
    context: { sessionId, clientKind },
  };
}

async function callAgentTask(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { assertDispatchAllowed } = await import('./mcp-enforcement-gate.js');
  const gate = assertDispatchAllowed('agent_task');
  if (!gate.allowed) return { success: false, error: gate.reason };
  const { agentTools } = await import('./agent-tools.js');
  const taskTool = agentTools.find(t => t.name === 'agent_task');
  if (!taskTool) throw new Error('agent_task tool not found');
  return taskTool.handler(input) as Promise<Record<string, unknown>>;
}

async function callAgentTerminate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { assertDispatchAllowed } = await import('./mcp-enforcement-gate.js');
  const gate = assertDispatchAllowed('agent_terminate');
  if (!gate.allowed) return { success: false, error: gate.reason };
  const { agentTools } = await import('./agent-tools.js');
  const terminateTool = agentTools.find(t => t.name === 'agent_terminate');
  if (!terminateTool) throw new Error('agent_terminate tool not found');
  return terminateTool.handler(input) as Promise<Record<string, unknown>>;
}

async function callAgentTaskAsync(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { assertDispatchAllowed } = await import('./mcp-enforcement-gate.js');
  const gate = assertDispatchAllowed('agent_task');
  if (!gate.allowed) return { success: false, error: gate.reason };
  const { agentTools } = await import('./agent-tools.js');
  const asyncTool = agentTools.find(t => t.name === 'agent_task_async');
  if (!asyncTool) throw new Error('agent_task_async tool not found');
  return asyncTool.handler(input) as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Tool 1: queen_mission_assign
// ---------------------------------------------------------------------------

const missionAssignTool: MCPTool = {
  name: 'queen_mission_assign',
  description: 'Assign a mission to a queen agent. Creates hive record with scope, format, worker budget, and providers.',
  category: 'queen',
  tags: ['hive', 'queen', 'mission'],
  inputSchema: {
    type: 'object',
    properties: {
      queenId: { type: 'string', description: 'Agent ID of the queen (must be spawned via agent_spawn first)' },
      scope: { type: 'string', description: 'Mission scope description' },
      description: { type: 'string', description: 'Detailed mission description' },
      format: { type: 'string', description: 'Expected report format (e.g., "markdown", "json", "structured")' },
      maxWorkers: { type: 'number', description: 'Maximum number of workers the queen can spawn (default: 20)' },
      maxCost: { type: 'number', description: 'Maximum cost budget (informational)' },
      providers: {
        type: 'array',
        description: 'Allowed providers for workers (e.g., ["codex-cli", "gemini-cli"])',
      },
      workerDependencies: {
        type: 'object',
        description: 'Role-based dependency graph. Keys are role names (not worker IDs), values are arrays of role names that must complete first.',
      },
      stalenessTimeout: { type: 'number', description: 'Timeout in ms before hive is considered stale (default: 3600000)' },
      session_id: { type: 'string', description: 'Optional launching operator session id for multi-session ownership routing' },
      sessionId: { type: 'string', description: 'Optional launching operator session id fallback for multi-session ownership routing' },
      ownerTmuxPane: { type: 'string', description: 'Deprecated legacy pane field; accepted for compatibility and ignored' },
      tmuxPane: { type: 'string', description: 'Deprecated legacy pane field; accepted for compatibility and ignored' },
      workers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', description: 'Worker role (e.g., "coder", "reviewer", "tester")' },
            provider: { type: 'string', description: 'LLM provider (e.g., "gemini-cli", "codex-cli", "openrouter")' },
            model: { type: 'string', description: 'Model alias (opus/sonnet/mini/inherit) or provider-native model. OpenRouter direct models must be allowed by config.' },
            task: { type: 'string', description: 'Task prompt to dispatch immediately after spawn' },
            mode: {
              type: 'string',
              enum: ['full', 'default', 'read-only', 'read-only-with-artifacts'],
              description: 'Requested worker tool mode; parent floor still applies.',
            },
            artifactDir: {
              type: 'string',
              description: 'Existing artifact directory for read-only-with-artifacts workers.',
            },
          },
        },
        description: 'Worker definitions — auto-spawned and tasked in parallel',
      },
    },
    required: ['queenId', 'scope', 'description'],
  },
  handler: async (input, context) => {
    const queenId = input.queenId as string;
    const scope = input.scope as string;
    const description = input.description as string;
    const format = input.format as string | undefined;
    const maxWorkers = (input.maxWorkers as number) ?? 20;
    const maxCost = input.maxCost as number | undefined;
    const providers = input.providers as string[] | undefined;
    const workerDependencies = input.workerDependencies as Record<string, string[]> | undefined;
    const stalenessTimeout = input.stalenessTimeout as number | undefined;
    const workerDefs = input.workers as Array<{ role?: string; provider?: string; model?: string; task?: string; mode?: string; artifactDir?: string }> | undefined;
    const ownerStamp = resolveOwnerStampOrError(input as Record<string, unknown>, process.env, context, 'queen_mission_assign');
    if (!ownerStamp.success) return ownerStamp;
    const { ownerSessionId, ownerClientKind } = ownerStamp;

    // (1) Hard minimum of 5 workers
    if (maxWorkers < 5) {
      return { success: false, error: `[COMPOSITION_ERROR] maxWorkers must be >= 5 (got ${maxWorkers}). Hives require 1 queen + 5 workers minimum.` };
    }

    // (2) If maxWorkers < 6, snap to 6, and if maxWorkers > 25, snap to 25
    let enforcedMaxWorkers = maxWorkers;
    if (maxWorkers < 6) {
      enforcedMaxWorkers = 6;
    } else if (maxWorkers > 25) {
      enforcedMaxWorkers = 25;
    }

    // (3) Return error if fewer than 5 workers are provided in the workers array
    if (workerDefs && workerDefs.length > 0 && workerDefs.length < 5) {
      return { success: false, error: `[COMPOSITION_ERROR] Minimum 5 workers required in workers array (got ${workerDefs.length}).` };
    }

    // Verify queen exists and is alive
    const store = loadAgentStore();
    const queen = store.agents[queenId];
    if (!queen) {
      return { success: false, error: `Queen agent '${queenId}' not found. Spawn it first via agent_spawn.` };
    }
    if (queen.status === 'terminated') {
      return { success: false, error: `Queen agent '${queenId}' is terminated.` };
    }

    // Create hive record (use enforcedMaxWorkers for budget)
    const budget: Partial<HiveBudget> = { maxWorkers: enforcedMaxWorkers, maxCost };
    const config: ModuleHiveConfig = {};
    if (workerDependencies) config.workerDependencies = workerDependencies;
    if (stalenessTimeout) config.stalenessTimeout = stalenessTimeout;
    if (providers && providers.length > 0) config.defaultProvider = providers[0];

    const hive = createHive(
      queenId,
      budget,
      Object.keys(config).length > 0 ? config : undefined,
      { ownerSessionId, ownerClientKind },
    );

    // Assign mission
    const mission: HiveMission = {
      hiveId: hive.hiveId,
      scope,
      description,
      format,
      assignedAt: new Date().toISOString(),
      assignedBy: 'advocate',
      providers,
    };

    await withHiveLock(hive.hiveId, async () => {
      const record = loadHive(hive.hiveId);
      if (!record) throw new Error('Hive record disappeared after creation');
      record.ownerSessionId = ownerSessionId;
      record.ownerClientKind = ownerClientKind;
      record.mission = mission;
      record.status = 'active';
      appendHiveAudit(record, {
        event: 'mission-assigned',
        detail: `Mission assigned: ${scope}`,
      });
      // Sign inside the same lock to avoid TOCTOU race
      record.signature = await signHiveState(record);
      saveHive(hive.hiveId, record);
    });

    // Create role.json for queen enforcement
    try {
      const { existsSync: roleExists, mkdirSync: roleMkdir, writeFileSync: roleWrite, readFileSync: roleRead } = await import('node:fs');
      const { join: roleJoin } = await import('node:path');
      const { createHmac: roleCreateHmac } = await import('node:crypto');

      // Sanitize queen ID for filesystem path
      const sanitizedQueenId = sanitizePathId(queenId, 64);
      if (sanitizedQueenId) {
        const roleDir = roleJoin(process.cwd(), '.hive-flow', 'enforcement', 'agents', sanitizedQueenId);
        roleMkdir(roleDir, { recursive: true });

        const roleState = {
          type: 'queen' as const,
          assignedAt: new Date().toISOString(),
          assignedBy: 'advocate',
          hiveId: hive.hiveId,
          directWorkCount: 0,
        };

        // Read HMAC key from enforcement directory (same key as enforcement.cjs uses)
        const hmacKeyFile = roleJoin(process.cwd(), '.hive-flow', 'enforcement', '.hmac-key');
        if (roleExists(hmacKeyFile)) {
          const hmacKey = roleRead(hmacKeyFile, 'utf8').trim();
          const hmac = roleCreateHmac('sha256', hmacKey).update(JSON.stringify(roleState)).digest('hex');
          roleWrite(
            roleJoin(roleDir, 'role.json'),
            JSON.stringify({ state: roleState, hmac }, null, 2),
            'utf8'
          );
        }
      }
    } catch {
      // Role file creation is best-effort — don't block mission assignment
    }

    fireHiveSpawnedHook({
      hiveId: hive.hiveId,
      queenId,
      scope,
      description,
      maxWorkers: enforcedMaxWorkers,
      providers,
    });

    // -----------------------------------------------------------------------
    // Auto-spawn and task workers in parallel when `workers` array is provided
    // -----------------------------------------------------------------------
    interface WorkerSpawnResult {
      role: string;
      workerId?: string;
      agentId?: string;
      taskId?: string;
      taskStatus?: string;
      provider?: string;
      model?: string;
      resolvedModel?: string;
      error?: string;
    }
    const workerResults: WorkerSpawnResult[] = [];

    if (workerDefs && workerDefs.length > 0) {
      const inheritedOwner = ownerSpawnContext(ownerSessionId, ownerClientKind, 'queen_mission_assign worker spawn');
      if (!inheritedOwner.success) return inheritedOwner;

      // Enforce maxWorkers budget
      const effectiveDefs = workerDefs.slice(0, enforcedMaxWorkers);

      const spawnAndTask = async (def: { role?: string; provider?: string; model?: string; task?: string; mode?: string; artifactDir?: string }): Promise<WorkerSpawnResult> => {
        const role = def.role || 'coder';
        const workerProvider = (def.provider as AgentProvider) || (providers && providers.length > 0 ? providers[0] as AgentProvider : 'anthropic');
        const workerModel = def.model;
        const workerTask = def.task;

        // Step 1: Spawn via queen_spawn_worker logic (inline to avoid double-locking)
        const workerId = `worker-${randomUUID()}`;
        let spawnResult: Record<string, unknown>;
        try {
          spawnResult = await callAgentSpawn({
            agentType: role,
            agentId: workerId,
            ...inheritedOwner.input,
            provider: workerProvider,
            model: workerModel,
            task: workerTask,
            mode: def.mode,
            artifactDir: def.artifactDir,
            config: {
              hiveId: hive.hiveId,
              parentAgentId: queenId,
              role,
            },
          }, inheritedOwner.context);
        } catch (e) {
          return { role, error: `Spawn failed: ${(e as Error).message}` };
        }

        if (!spawnResult.success) {
          return { role, error: `Spawn failed: ${spawnResult.error as string}` };
        }

        const agentId = spawnResult.agentId as string;

        // Step 2 task dispatch — capture taskId to write into worker record
        let pendingTaskId: string | undefined;

        // Record worker in hive (under lock)
        await withHiveLock(hive.hiveId, () => {
          const freshHive = loadHive(hive.hiveId);
          if (!freshHive) return;
          const workerRecord: HiveWorkerRecord = {
            workerId,
            agentId,
            ownerSessionId: spawnResult.ownerSessionId as string,
            ownerClientKind: spawnResult.ownerClientKind as string,
            role,
            provider: workerProvider,
            status: 'idle',
            spawnedAt: new Date().toISOString(),
          };
          freshHive.workers.push(workerRecord);
          freshHive.budget.workersAllocated = freshHive.workers.filter(w => w.status !== 'terminated').length;
          appendHiveAudit(freshHive, {
            event: 'worker-spawned',
            detail: `Worker '${role}' auto-spawned as ${workerId} via ${workerProvider}`,
            agentId,
            workerId,
          });
          saveHive(hive.hiveId, freshHive);
        });

        // Step 2: If task provided, dispatch async
        if (workerTask) {
          try {
            // Log the task in hive audit (same pattern as queen_task_worker)
            await withHiveLock(hive.hiveId, () => {
              const freshHive = loadHive(hive.hiveId);
              if (freshHive) {
                appendHiveAudit(freshHive, {
                  event: 'worker-tasked',
                  detail: `Task sent to worker '${workerId}': ${workerTask.slice(0, 200)}`,
                  agentId,
                  workerId,
                });
                if (!freshHive.delegationMetrics) {
                  freshHive.delegationMetrics = { taskedCount: 0, directWorkCount: 0, delegationRate: 1 };
                }
                freshHive.delegationMetrics.taskedCount = (freshHive.delegationMetrics.taskedCount ?? 0) + 1;
                recomputeDelegationMetrics(freshHive);
                saveHive(hive.hiveId, freshHive);
              }
            });

            const asyncResult = await callAgentTaskAsync({
              agentId,
              task: workerTask,
            });
            pendingTaskId = asyncResult.taskId as string | undefined;

            // Write taskId back to the worker record in the hive
            if (pendingTaskId) {
              await withHiveLock(hive.hiveId, () => {
                const freshHive = loadHive(hive.hiveId);
                if (freshHive) {
                  const wr = freshHive.workers.find(w => w.workerId === workerId);
                  if (wr) wr.taskId = pendingTaskId;
                  saveHive(hive.hiveId, freshHive);
                }
              });
            }

            return {
              role,
              workerId,
              agentId,
              taskId: pendingTaskId,
              taskStatus: asyncResult.status as string | undefined,
              provider: workerProvider,
              model: spawnResult.model as string | undefined,
              resolvedModel: spawnResult.resolvedModel as string | undefined,
            };
          } catch (e) {
            return {
              role,
              workerId,
              agentId,
              provider: workerProvider,
              error: `Spawned but task dispatch failed: ${(e as Error).message}`,
            };
          }
        }

        return {
          role,
          workerId,
          agentId,
          provider: workerProvider,
          model: spawnResult.model as string | undefined,
          resolvedModel: spawnResult.resolvedModel as string | undefined,
        };
      };

      // Fire all spawns in parallel
      const settled = await Promise.allSettled(effectiveDefs.map(spawnAndTask));
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          workerResults.push(result.value);
        } else {
          workerResults.push({ role: 'unknown', error: `Promise rejected: ${result.reason}` });
        }
      }
    }

    return {
      success: true,
      hiveId: hive.hiveId,
      queenId,
      mission: {
        scope,
        description,
        format,
        providers,
      },
      budget: { maxWorkers, maxCost },
      status: 'active',
      ...(workerResults.length > 0 ? {
        workers: workerResults,
        workersSpawned: workerResults.filter(w => !w.error).length,
        workersErrored: workerResults.filter(w => !!w.error).length,
      } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 2: queen_spawn_worker
// ---------------------------------------------------------------------------

const spawnWorkerTool: MCPTool = {
  name: 'queen_spawn_worker',
  description: 'Queen spawns a worker within its hive. Internally calls agent_spawn with hive metadata. Enforces maxWorkers budget.',
  category: 'queen',
  tags: ['hive', 'queen', 'worker', 'spawn'],
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'ID of the hive' },
      queenId: { type: 'string', description: 'Agent ID of the queen (for authorization)' },
      role: { type: 'string', description: 'Worker role (e.g., "coder", "reviewer", "tester")' },
      provider: {
        type: 'string',
        enum: ['anthropic', 'anthropic-cli', 'gemini-cli', 'codex-cli', 'cursor-cli', 'deepseek', 'openrouter'],
        description: 'LLM provider for the worker',
      },
      model: {
        type: 'string',
        description: 'Model alias (opus/sonnet/mini/inherit) or provider-native model. OpenRouter direct models must be allowed by config.',
      },
      task: { type: 'string', description: 'Initial task description for model routing' },
      mode: {
        type: 'string',
        enum: ['full', 'default', 'read-only', 'read-only-with-artifacts'],
        description: 'Requested worker tool mode; parent floor still applies.',
      },
      artifactDir: {
        type: 'string',
        description: 'Existing artifact directory for read-only-with-artifacts workers.',
      },
      budgetAllocation: { type: 'number', description: 'Budget allocation for this worker' },
      config: { type: 'object', description: 'Additional worker configuration' },
    },
    required: ['hiveId', 'queenId', 'role'],
  },
  handler: async (input, context) => {
    const hiveId = input.hiveId as string;
    const queenId = input.queenId as string;
    const role = input.role as string;
    const provider = (input.provider as AgentProvider) || 'anthropic';
    const model = input.model as string | undefined;
    const task = input.task as string | undefined;
    const mode = input.mode as string | undefined;
    const artifactDir = input.artifactDir as string | undefined;
    const budgetAllocation = input.budgetAllocation as number | undefined;
    const config = (input.config as Record<string, unknown>) || {};

    // Lock the hive for the entire spawn operation (Condition 3)
    return withHiveLock(hiveId, async () => {
      const hive = loadHive(hiveId);
      if (!hive) {
        return { success: false, error: `Hive '${hiveId}' not found.` };
      }

      // Verify queen ownership
      if (hive.queenId !== queenId) {
        return { success: false, error: `Queen '${queenId}' does not own hive '${hiveId}'.` };
      }

      // Check hive is active
      if (hive.status !== 'active') {
        return { success: false, error: `Hive '${hiveId}' is not active (status: ${hive.status}).` };
      }
      const inheritedOwner = ownerSpawnContext(hive.ownerSessionId, hive.ownerClientKind, 'queen_spawn_worker');
      if (!inheritedOwner.success) return inheritedOwner;

      // Reconcile worker statuses against the agent store to clear stale
      // entries from previous sessions (e.g. workers stuck in 'spawning' or
      // 'error' whose underlying agent has been terminated or no longer exists).
      const agentStore = loadAgentStore();
      let reconciled = false;
      for (const worker of hive.workers) {
        if (worker.status === 'terminated') continue;
        const agent = agentStore.agents[worker.agentId];
        if (!agent || agent.status === 'terminated') {
          worker.status = 'terminated';
          worker.terminatedAt = worker.terminatedAt || new Date().toISOString();
          reconciled = true;
        }
      }
      if (reconciled) {
        hive.budget.workersAllocated = hive.workers.filter(w => w.status !== 'terminated').length;
        appendHiveAudit(hive, {
          event: 'worker-spawned', // closest existing event type for bookkeeping
          detail: 'Reconciled stale workers: marked dead/missing agents as terminated',
        });
        saveHive(hiveId, hive);
      }

      // Enforce maxWorkers hard limit (HiveBudget enforcement)
      const liveWorkers = hive.workers.filter(w => w.status !== 'terminated');
      if (liveWorkers.length >= hive.budget.maxWorkers) {
        return {
          success: false,
          error: `Worker budget exhausted: ${liveWorkers.length}/${hive.budget.maxWorkers} workers allocated. Terminate existing workers or increase budget.`,
        };
      }

      // Call agent_spawn with hive metadata
      const workerId = `worker-${randomUUID()}`;
      const spawnResult = await callAgentSpawn({
        agentType: role,
        agentId: workerId,
        ...inheritedOwner.input,
        provider,
        model,
        task,
        mode,
        artifactDir,
        config: {
          ...config,
          hiveId,
          parentAgentId: queenId,
          role,
          budgetAllocation,
        },
      }, inheritedOwner.context);

      if (!spawnResult.success) {
        return { success: false, error: `Failed to spawn worker: ${spawnResult.error}` };
      }

      // Record worker in hive
      const workerRecord: HiveWorkerRecord = {
        workerId,
        agentId: spawnResult.agentId as string,
        ownerSessionId: spawnResult.ownerSessionId as string,
        ownerClientKind: spawnResult.ownerClientKind as string,
        role,
        provider,
        status: 'idle',
        spawnedAt: new Date().toISOString(),
        budgetAllocation,
      };

      hive.workers.push(workerRecord);
      hive.budget.workersAllocated = hive.workers.filter(w => w.status !== 'terminated').length;

      appendHiveAudit(hive, {
        event: 'worker-spawned',
        detail: `Worker '${role}' spawned as ${workerId} via ${provider}`,
        agentId: spawnResult.agentId as string,
        workerId,
      });

      saveHive(hiveId, hive);

      return {
        success: true,
        hiveId,
        workerId,
        agentId: spawnResult.agentId,
        role,
        provider,
        model: spawnResult.model,
        resolvedModel: spawnResult.resolvedModel,
        modelRoutedBy: spawnResult.modelRoutedBy,
        budgetRemaining: hive.budget.maxWorkers - hive.budget.workersAllocated,
      };
    });
  },
};

// ---------------------------------------------------------------------------
// Tool 3: queen_task_worker
// ---------------------------------------------------------------------------

const taskWorkerTool: MCPTool = {
  name: 'queen_task_worker',
  description: 'Queen sends a task to a worker. Wraps agent_task with hive audit logging.',
  category: 'queen',
  tags: ['hive', 'queen', 'worker', 'task'],
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'ID of the hive' },
      workerId: { type: 'string', description: 'Worker ID (from queen_spawn_worker)' },
      task: { type: 'string', description: 'Task prompt to send to the worker' },
      timeout: { type: 'number', description: 'Timeout in ms (default: 120000)' },
    },
    required: ['hiveId', 'workerId', 'task'],
  },
  handler: async (input) => {
    const hiveId = input.hiveId as string;
    const workerId = input.workerId as string;
    const task = input.task as string;
    const timeout = input.timeout as number | undefined;

    const dispatchContext = await withHiveLock(hiveId, () => {
      const freshHive = loadHive(hiveId);
      if (!freshHive) {
        return { success: false as const, error: `Hive '${hiveId}' not found.` };
      }

      const worker = freshHive.workers.find(w => w.workerId === workerId);
      if (!worker) {
        return { success: false as const, error: `Worker '${workerId}' not found in hive '${hiveId}'.` };
      }

      if (worker.status === 'terminated') {
        return { success: false as const, error: `Worker '${workerId}' is terminated.` };
      }

      appendHiveAudit(freshHive, {
        event: 'worker-tasked',
        detail: `Task sent to worker '${workerId}': ${task.slice(0, 200)}`,
        agentId: worker.agentId,
        workerId,
      });
      if (!freshHive.delegationMetrics) {
        freshHive.delegationMetrics = { taskedCount: 0, directWorkCount: 0, delegationRate: 1 };
      }
      freshHive.delegationMetrics.taskedCount = (freshHive.delegationMetrics.taskedCount ?? 0) + 1;
      recomputeDelegationMetrics(freshHive);
      saveHive(hiveId, freshHive);

      return {
        success: true as const,
        agentId: worker.agentId,
      };
    });

    if (!dispatchContext.success) {
      return dispatchContext;
    }

    const taskInput: Record<string, unknown> = {
      agentId: dispatchContext.agentId,
      task,
    };
    if (timeout) taskInput.timeout = timeout;

    const result = await callAgentTask(taskInput);

    // Update worker status based on result
    await withHiveLock(hiveId, () => {
      const freshHive = loadHive(hiveId);
      if (freshHive) {
        const freshWorker = freshHive.workers.find(w => w.workerId === workerId);
        if (freshWorker) {
          freshWorker.status = result.success ? 'busy' : 'error'; // Mark busy on success (async work in progress), error on failure
          if (freshWorker.status === 'busy') {
            delete freshWorker.idleSince;
          }
        }
        saveHive(hiveId, freshHive);
      }
    });

    return {
      success: result.success,
      hiveId,
      workerId,
      agentId: dispatchContext.agentId,
      result,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 4: queen_collect_results
// ---------------------------------------------------------------------------

const collectResultsTool: MCPTool = {
  name: 'queen_collect_results',
  description: 'Queen reads all worker task results for synthesis.',
  category: 'queen',
  tags: ['hive', 'queen', 'results'],
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'ID of the hive' },
      queenId: { type: 'string', description: 'Agent ID of the queen (for authorization)' },
    },
    required: ['hiveId', 'queenId'],
  },
  handler: async (input) => {
    const hiveId = input.hiveId as string;
    const queenId = input.queenId as string;

    const hive = loadHive(hiveId);
    if (!hive) {
      return { success: false, error: `Hive '${hiveId}' not found.` };
    }

    if (hive.queenId !== queenId) {
      return { success: false, error: `Queen '${queenId}' does not own hive '${hiveId}'.` };
    }

    const liveWorkers = hive.workers.filter(w => w.status !== 'terminated');
    if (liveWorkers.length < 5) {
      return { success: false, error: `[COMPOSITION_ERROR] Cannot collect results. Found ${liveWorkers.length} live workers, minimum 5 required.` };
    }

    // Collect agent status for each worker
    const store = loadAgentStore();
    const tasksDir = join(process.cwd(), '.hive-flow', 'tasks');
    const readDurableTaskResult = (taskId: unknown): unknown | undefined => {
      const safeTaskId = sanitizePathId(taskId);
      if (!safeTaskId) return undefined;
      const resultPath = join(tasksDir, `${safeTaskId}.result.json`);
      if (!existsSync(resultPath)) return undefined;
      try {
        return JSON.parse(readFileSync(resultPath, 'utf-8'));
      } catch {
        return { error: 'Failed to parse task result file', taskId: safeTaskId };
      }
    };
    const workerResults: Array<{
      workerId: string;
      agentId: string;
      role: string;
      provider: string;
      status: string;
      taskCount: number;
      taskId?: string;
      lastResult?: unknown;
    }> = [];

    for (const worker of liveWorkers) {
      const agent = store.agents[worker.agentId];
      const taskResult = readDurableTaskResult(worker.taskId);
      const lastResult = (agent as unknown as Record<string, unknown> | undefined)?.lastResult ?? taskResult;
      workerResults.push({
        workerId: worker.workerId,
        agentId: worker.agentId,
        role: worker.role,
        provider: worker.provider,
        status: agent?.status ?? (taskResult !== undefined ? 'completed' : worker.status),
        taskCount: Math.max(agent?.taskCount ?? 0, taskResult !== undefined ? 1 : 0),
        ...(typeof worker.taskId === 'string' ? { taskId: worker.taskId } : {}),
        ...(lastResult !== undefined ? { lastResult } : {}),
      });
    }

    // Log collection in audit
    await withHiveLock(hiveId, () => {
      const freshHive = loadHive(hiveId);
      if (freshHive) {
        appendHiveAudit(freshHive, {
          event: 'results-collected',
          detail: `Collected results from ${workerResults.length} workers`,
        });
        saveHive(hiveId, freshHive);
      }
    });

    return {
      success: true,
      hiveId,
      queenId,
      workerCount: workerResults.length,
      workers: workerResults,
      audit: hive.audit.filter(e => e.event === 'worker-tasked'),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 5: queen_report
// ---------------------------------------------------------------------------

const reportTool: MCPTool = {
  name: 'queen_report',
  description: 'Queen submits synthesized findings to the advocate. Creates report.json in hive directory.',
  category: 'queen',
  tags: ['hive', 'queen', 'report'],
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'ID of the hive' },
      queenId: { type: 'string', description: 'Agent ID of the queen' },
      report: { type: 'string', description: 'Synthesized report content' },
      status: {
        type: 'string',
        enum: ['completed', 'failed'],
        description: 'Final hive status',
      },
      error: { type: 'string', description: 'Error message if status is failed (Condition 4)' },
    },
    required: ['hiveId', 'queenId', 'report'],
  },
  handler: async (input) => {
    const hiveId = input.hiveId as string;
    const queenId = input.queenId as string;
    const report = input.report as string;
    const status = (input.status as 'completed' | 'failed') || 'completed';
    const error = input.error as string | undefined;

    let liveWorkerCount = 0;

    const result = await withHiveLock(hiveId, async () => {
      const hive = loadHive(hiveId);
      if (!hive) {
        return { success: false, error: `Hive '${hiveId}' not found.` };
      }

      if (hive.queenId !== queenId) {
        return { success: false, error: `Queen '${queenId}' does not own hive '${hiveId}'.` };
      }

      // Composition check: require minimum 5 live workers before accepting report
      const liveWorkers = hive.workers.filter(w => w.status !== 'terminated');
      liveWorkerCount = liveWorkers.length;
      if (liveWorkerCount < 5) {
        return { success: false, error: `[COMPOSITION_ERROR] Queen report blocked. Found ${liveWorkerCount} live workers, minimum 5 required.` };
      }

      const directWork = await readVerifiedQueenDirectWorkCount(queenId);
      if (!hive.delegationMetrics) {
        hive.delegationMetrics = { taskedCount: 0, directWorkCount: 0, delegationRate: 1 };
      }
      hive.delegationMetrics.directWorkCount = directWork;
      const delegationMetrics = recomputeDelegationMetrics(hive);
      const totalActions = delegationMetrics.taskedCount + delegationMetrics.directWorkCount;
      if (totalActions > 0 && delegationMetrics.delegationRate < 0.5) {
        return {
          success: false,
          error: `[DELEGATION_ERROR] queen_report blocked: delegation rate ${delegationMetrics.delegationRate.toFixed(3)} < 0.5 (taskedCount=${delegationMetrics.taskedCount}, directWorkCount=${delegationMetrics.directWorkCount}). Delegate more via queen_task_worker before reporting.`,
          delegationMetrics,
        };
      }

      // Update hive status
      hive.status = status;
      hive.report = report;
      hive.completedAt = new Date().toISOString();
      if (status === 'failed' && error) {
        hive.error = error; // Condition 4: populate error field for failed state
      }

      appendHiveAudit(hive, {
        event: 'report-submitted',
        detail: `Report submitted (status: ${status})${error ? `: ${error}` : ''}`,
      });

      // Sign the final state
      hive.signature = await signHiveState(hive);

      saveHive(hiveId, hive);

      return {
        success: true,
        hiveId,
        queenId,
        status,
        completedAt: hive.completedAt,
        reportLength: report.length,
        workerCount: hive.workers.length,
        auditEntryCount: hive.audit.length,
        delegationMetrics: hive.delegationMetrics,
      };
    });

    if (result.success) {
      fireQueenReportHook({
        hiveId,
        queenId,
        status,
        reportLength: report.length,
        workerCount: liveWorkerCount,
        delegationMetrics: result.delegationMetrics,
      });

      fireHiveCompleteHook({
        hiveId,
        queenId,
        status,
        completedAt: result.completedAt,
        reportLength: report.length,
        workerCount: result.workerCount,
        auditEntryCount: result.auditEntryCount,
        delegationMetrics: result.delegationMetrics,
      });
    }

    return result;
  },
};

// ---------------------------------------------------------------------------
// Tool 6: hive_status
// ---------------------------------------------------------------------------

const hiveStatusTool: MCPTool = {
  name: 'hive_status',
  description: 'Advocate reads all hive records. Shows active, completed, failed, and stale hives.',
  category: 'queen',
  tags: ['hive', 'status'],
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'Specific hive ID to check (optional — omit for all hives)' },
      statusFilter: {
        type: 'string',
        enum: ['pending', 'active', 'completed', 'failed', 'terminated'],
        description: 'Filter by hive status',
      },
      includeStale: { type: 'boolean', description: 'Include staleness check (default: true)' },
    },
  },
  handler: async (input) => {
    const hiveId = input.hiveId as string | undefined;
    const statusFilter = input.statusFilter as HiveRecord['status'] | undefined;
    const includeStale = (input.includeStale as boolean) ?? true;

    // Single hive lookup
    if (hiveId) {
      const hive = loadHive(hiveId);
      if (!hive) {
        return { success: false, error: `Hive '${hiveId}' not found.` };
      }
      return {
        success: true,
        hive: {
          ...hive,
          stale: includeStale ? isHiveStale(hive) : undefined,
        },
        delegationMetrics: hive.delegationMetrics,
      };
    }

    // List all hives
    const hives = listHives(statusFilter);
    const staleHives = includeStale ? findStaleHives() : [];

    return {
      success: true,
      total: hives.length,
      staleCount: staleHives.length,
      hives: hives.map(h => ({
        hiveId: h.hiveId,
        queenId: h.queenId,
        status: h.status,
        error: h.error,
        workerCount: h.workers.length,
        liveWorkers: h.workers.filter(w => w.status !== 'terminated').length,
        missionScope: h.mission?.scope,
        createdAt: h.createdAt,
        updatedAt: h.updatedAt,
        completedAt: h.completedAt,
        stale: includeStale ? isHiveStale(h) : undefined,
        delegationMetrics: h.delegationMetrics,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 7: hive_terminate
// ---------------------------------------------------------------------------

const hiveTerminateTool: MCPTool = {
  name: 'hive_terminate',
  description: 'Advocate cascade-kills a hive: terminates queen + all workers via agent_terminate.',
  category: 'queen',
  tags: ['hive', 'terminate', 'cascade'],
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'ID of the hive to terminate' },
      reason: { type: 'string', description: 'Reason for termination' },
    },
    required: ['hiveId'],
  },
  handler: async (input) => {
    const hiveId = input.hiveId as string;
    const reason = (input.reason as string) || 'Advocate-initiated termination';

    return withHiveLock(hiveId, async () => {
      const hive = loadHive(hiveId);
      if (!hive) {
        return { success: false, error: `Hive '${hiveId}' not found.` };
      }

      // Already terminated — idempotent
      if (hive.status === 'terminated') {
        return { success: true, hiveId, alreadyTerminated: true };
      }

      const terminated: string[] = [];
      const errors: string[] = [];

      // Condition 2: Terminate all workers (non-terminal status only)
      for (const worker of hive.workers) {
        if (worker.status !== 'terminated') {
          try {
            const terminateResult = await callAgentTerminate({ agentId: worker.agentId, force: true });
            if (!terminateResult.success) {
              const error = String(terminateResult.error || 'agent_terminate failed');
              if (error.includes('[MCP ENFORCEMENT]')) {
                // Persist any worker mutations already applied before returning
                // so the store stays consistent with the in-memory hive record.
                saveHive(hiveId, hive);
                return { success: false, hiveId, error, status: hive.status };
              }
              errors.push(`Failed to terminate worker ${worker.workerId}: ${error}`);
              continue;
            }
            worker.status = 'terminated';
            worker.terminatedAt = new Date().toISOString();
            terminated.push(worker.workerId);
          } catch (e) {
            errors.push(`Failed to terminate worker ${worker.workerId}: ${(e as Error).message}`);
          }
        }
      }

      // Condition 2: Terminate the queen.
      // Queens do NOT have config.hiveId at spawn time — they only get linked
      // to a hive after queen_mission_assign. So we use hive.queenId directly.
      try {
        const queenTerminateResult = await callAgentTerminate({ agentId: hive.queenId, force: true });
        if (!queenTerminateResult.success) {
          const error = String(queenTerminateResult.error || 'agent_terminate failed');
          if (error.includes('[MCP ENFORCEMENT]')) {
            // Persist any worker mutations already applied before returning.
            saveHive(hiveId, hive);
            return { success: false, hiveId, error, status: hive.status };
          }
          errors.push(`Failed to terminate queen ${hive.queenId}: ${error}`);
        } else {
          terminated.push(hive.queenId);
        }
      } catch (e) {
        errors.push(`Failed to terminate queen ${hive.queenId}: ${(e as Error).message}`);
      }

      // Update hive record
      hive.status = 'terminated';
      hive.completedAt = new Date().toISOString();

      appendHiveAudit(hive, {
        event: 'hive-terminated',
        detail: `Hive terminated: ${reason}. Terminated ${terminated.length} agents.`,
      });

      // Fire hive-terminated hook (fire-and-forget)
      void fireHiveTerminatedHook({
        hiveId,
        queenId: hive.queenId,
        workerCount: terminated.length,
        reason: 'terminated',
      });

      // Sign the final state
      hive.signature = await signHiveState(hive);

      saveHive(hiveId, hive);

      return {
        success: true,
        hiveId,
        reason,
        terminated,
        errors: errors.length > 0 ? errors : undefined,
        status: 'terminated',
      };
    });
  },
};

// ---------------------------------------------------------------------------
// Tool 8: hive_validate_composition
// ---------------------------------------------------------------------------

const hiveValidateCompositionTool: MCPTool = {
  name: 'hive_validate_composition',
  description: 'Validate hive composition: checks live/dead worker counts, roles, and staleness. Returns PASS/FAIL.',
  category: 'queen',
  tags: ['hive', 'composition', 'validate'],
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'ID of the hive to validate' },
    },
    required: ['hiveId'],
  },
  handler: async (input) => {
    const hiveId = input.hiveId as string;

    const hive = loadHive(hiveId);
    if (!hive) {
      return { success: false, error: `Hive '${hiveId}' not found.` };
    }

    // Cross-reference the agent store for accurate live/dead status
    const store = loadAgentStore();
    let liveWorkerCount = 0;
    let deadWorkerCount = 0;
    const roles: Record<string, number> = {};

    for (const worker of hive.workers) {
      const agent = store.agents[worker.agentId];
      const effectiveStatus =
        worker.status === 'terminated' || !agent || agent.status === 'terminated'
          ? 'terminated'
          : worker.status;

      if (effectiveStatus === 'terminated') {
        deadWorkerCount++;
      } else {
        liveWorkerCount++;
        roles[worker.role] = (roles[worker.role] || 0) + 1;
      }
    }

    const stale = isHiveStale(hive);
    const pass = liveWorkerCount >= 5 && !stale;

    return {
      success: true,
      hiveId,
      result: pass ? 'PASS' : 'FAIL',
      liveWorkerCount,
      deadWorkerCount,
      roles,
      stale,
      ...(liveWorkerCount < 5
        ? { reason: `Insufficient live workers: ${liveWorkerCount}/5 minimum` }
        : stale
          ? { reason: 'Hive is stale (exceeded staleness timeout)' }
          : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 9: hive_poll_workers
// ---------------------------------------------------------------------------

const hivePollWorkersTool: MCPTool = {
  name: 'hive_poll_workers',
  description: 'Poll all workers in a hive for task completion status. Checks result files and PID liveness (same logic as agent_task_result). Auto-collects results into hive audit when all workers complete.',
  category: 'queen',
  tags: ['hive', 'poll', 'workers', 'observability'],
  inputSchema: {
    type: 'object',
    properties: {
      hiveId: { type: 'string', description: 'ID of the hive to poll' },
    },
    required: ['hiveId'],
  },
  handler: async (input) => {
    const { existsSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const hiveId = input.hiveId as string;

    const hive = loadHive(hiveId);
    if (!hive) {
      console.error(`[hive_poll_workers] hive=${hiveId} not found, returning error`);
      return { success: false, error: `Hive '${hiveId}' not found.` };
    }

    const STORAGE_DIR = '.hive-flow';
    const tasksDir = join(process.cwd(), STORAGE_DIR, 'tasks');

    // Build a map of agentId -> tracking entries from the tasks directory
    const agentTaskMap = new Map<string, Array<{
      taskId: string;
      trackingPath: string;
      resultPath: string;
      tracking: { status: string; taskId: string; agentId: string; startedAt: string; pid?: number };
    }>>();

    if (existsSync(tasksDir)) {
      let files: string[];
      try {
        files = readdirSync(tasksDir).filter(
          (f: string) => f.endsWith('.json') && !f.endsWith('.result.json'),
        );
      } catch {
        files = [];
      }
      for (const file of files) {
        const trackingPath = join(tasksDir, file);
        try {
          const tracking = JSON.parse(readFileSync(trackingPath, 'utf-8')) as {
            status: string; taskId: string; agentId: string; startedAt: string; pid?: number;
          };
          if (!tracking.agentId || !tracking.taskId) continue;
          if (!agentTaskMap.has(tracking.agentId)) {
            agentTaskMap.set(tracking.agentId, []);
          }
          const taskId = tracking.taskId;
          const resultPath = join(tasksDir, `${taskId}.result.json`);
          agentTaskMap.get(tracking.agentId)!.push({ taskId, trackingPath, resultPath, tracking });
        } catch {
          // Skip unparseable tracking files
        }
      }
    }

    const workerStatuses: Array<{
      workerId: string;
      agentId: string;
      role: string;
      status: 'completed' | 'running' | 'failed' | 'idle' | 'terminated';
      taskId?: string;
      result?: unknown;
    }> = [];

    let completedCount = 0;
    let runningCount = 0;
    let failedCount = 0;
    let idleCount = 0;
    let terminatedCount = 0;

    for (const worker of hive.workers) {
      if (worker.status === 'terminated') {
        workerStatuses.push({
          workerId: worker.workerId,
          agentId: worker.agentId,
          role: worker.role,
          status: 'terminated',
        });
        terminatedCount++;
        continue;
      }

      // Find the most recent tracking entry for this worker's agent
      const tasks = agentTaskMap.get(worker.agentId);
      if (!tasks || tasks.length === 0) {
        workerStatuses.push({
          workerId: worker.workerId,
          agentId: worker.agentId,
          role: worker.role,
          status: 'idle',
        });
        idleCount++;
        continue;
      }

      // Use the most recent task (by startedAt)
      const sorted = tasks.sort(
        (a, b) => new Date(b.tracking.startedAt).getTime() - new Date(a.tracking.startedAt).getTime(),
      );
      const latest = sorted[0];

      // Check if result file exists (same logic as agent_task_result)
      if (existsSync(latest.resultPath)) {
        let result: unknown;
        try {
          result = JSON.parse(readFileSync(latest.resultPath, 'utf-8'));
        } catch {
          result = { error: 'Failed to parse result file' };
        }

        // Update tracking status if still marked running
        if (latest.tracking.status === 'running') {
          latest.tracking.status = 'completed';
          try {
            writeFileSync(latest.trackingPath, JSON.stringify(latest.tracking, null, 2), 'utf-8');
          } catch { /* best-effort */ }
        }

        workerStatuses.push({
          workerId: worker.workerId,
          agentId: worker.agentId,
          role: worker.role,
          status: 'completed',
          taskId: latest.taskId,
          result,
        });
        completedCount++;
        continue;
      }

      // No result file — check PID liveness
      if (latest.tracking.pid) {
        try {
          process.kill(latest.tracking.pid, 0); // signal 0 = existence check
          workerStatuses.push({
            workerId: worker.workerId,
            agentId: worker.agentId,
            role: worker.role,
            status: 'running',
            taskId: latest.taskId,
          });
          runningCount++;
          continue;
        } catch {
          // Process exited without writing a result — failed
          latest.tracking.status = 'failed';
          try {
            writeFileSync(latest.trackingPath, JSON.stringify(latest.tracking, null, 2), 'utf-8');
          } catch { /* best-effort */ }

          workerStatuses.push({
            workerId: worker.workerId,
            agentId: worker.agentId,
            role: worker.role,
            status: 'failed',
            taskId: latest.taskId,
          });
          failedCount++;
          continue;
        }
      }

      // No PID — fall back to tracking status
      const mappedStatus = latest.tracking.status === 'completed' ? 'completed' as const
        : latest.tracking.status === 'failed' ? 'failed' as const
        : 'running' as const;

      workerStatuses.push({
        workerId: worker.workerId,
        agentId: worker.agentId,
        role: worker.role,
        status: mappedStatus,
        taskId: latest.taskId,
      });

      if (mappedStatus === 'completed') completedCount++;
      else if (mappedStatus === 'failed') failedCount++;
      else runningCount++;
    }

    // Ground truth for "tasked": worker-tasked audit entries (mirrors role-enforcement.cjs).
    const tasked = new Set<string>();
    for (const e of hive.audit ?? []) {
      if (e && e.event === 'worker-tasked' && e.workerId) tasked.add(e.workerId);
    }
    const STARTUP_GRACE_MS = Number(process.env.HIVE_FLOW_SETTLE_GRACE_MS) > 0
      ? Number(process.env.HIVE_FLOW_SETTLE_GRACE_MS) : 120_000;
    const now = Date.now();
    const startupWindowOpen = hive.workers.some(w => {
      if (w.status === 'terminated') return false;
      if (tasked.has(w.workerId)) return false;
      const isIdleish = (() => {
        const ws = workerStatuses.find(s => s.workerId === w.workerId);
        return !ws || ws.status === 'idle';
      })();
      if (!isIdleish) return false;
      const spawnedAt = new Date(w.spawnedAt).getTime();
      return Number.isFinite(spawnedAt) && (now - spawnedAt) < STARTUP_GRACE_MS;
    });

    const taskedCount = completedCount + runningCount + failedCount;
    const allComplete = runningCount === 0 && !startupWindowOpen;
    console.error(`[hive_poll_workers] hive=${hiveId} taskedCount=${taskedCount} startupWindowOpen=${startupWindowOpen} runningCount=${runningCount} completedCount=${completedCount} failedCount=${failedCount} allComplete=${allComplete}`);

    // Auto-collect results into hive audit when all complete
    if (allComplete) {
      await withHiveLock(hiveId, () => {
        const freshHive = loadHive(hiveId);
        if (freshHive) {
          appendHiveAudit(freshHive, {
            event: 'results-collected',
            detail: `Auto-collected via hive_poll_workers: ${completedCount} completed, ${failedCount} failed, ${idleCount} idle, ${terminatedCount} terminated`,
          });
          saveHive(hiveId, freshHive);
        }
      });

      const freshStatus = loadHive(hiveId)?.status;
      if (freshStatus !== 'active') {
        return {
          success: true,
          hiveId,
          workers: workerStatuses,
          allComplete,
          allWorkersSettled: allComplete,
          readyForReport: allComplete,
          completedCount,
          runningCount,
          failedCount,
          idleCount,
          terminatedCount,
        };
      }

      // Write hive-all-complete event to activity.jsonl
      try {
        const { appendFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        mkdirSync(join(process.cwd(), '.hive-flow', 'logs'), { recursive: true });
        const activityFile = join(process.cwd(), '.hive-flow', 'logs', 'activity.jsonl');
        

        const event = {
          ts: new Date().toISOString(),
          event: 'hive-all-complete',
          hiveId,
          queenId: hive.queenId,
          completedCount,
          failedCount,
          idleCount,
          terminatedCount,
        };
        appendFileSync(activityFile, JSON.stringify(event) + '\n', 'utf-8');
      } catch {
        // Best-effort activity logging
      }

    }

    // Auto-transition hive to completed when all workers settled
    // This enables the MCP server polling to detect completion and fire notifications
    if (allComplete) {
      try {
        const outcomeStatus: 'completed' | 'failed' = completedCount > 0 ? 'completed' : 'failed';
        await withHiveLock(hiveId, () => {
          const freshHive = loadHive(hiveId);
          if (freshHive && freshHive.status === 'active') {
            console.error(`[hive_poll_workers] hive=${hiveId} auto-transitioning to ${outcomeStatus}`);
            freshHive.status = outcomeStatus;
            if (outcomeStatus === 'failed' && !freshHive.error) {
              freshHive.error = `Hive settled with no completed workers (completed=${completedCount}, failed=${failedCount}, tasked=${taskedCount})`;
            }
            freshHive.completedAt = new Date().toISOString();
            appendHiveAudit(freshHive, {
              event: 'results-collected',
              detail: `Auto-${outcomeStatus}: ${completedCount} completed, ${failedCount} failed, ${idleCount} idle`,
            });
            saveHive(hiveId, freshHive);
          }
        });
      } catch { /* best-effort transition */ }
    }

    return {
      success: true,
      hiveId,
      workers: workerStatuses,
      allComplete,
      allWorkersSettled: allComplete,
      readyForReport: allComplete,
      completedCount,
      runningCount,
      failedCount,
      idleCount,
      terminatedCount,
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const queenTools: MCPTool[] = [
  missionAssignTool,
  spawnWorkerTool,
  taskWorkerTool,
  collectResultsTool,
  reportTool,
  hiveStatusTool,
  hiveTerminateTool,
  hiveValidateCompositionTool,
  hivePollWorkersTool,
];
