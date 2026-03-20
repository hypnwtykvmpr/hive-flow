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
import type { MCPTool } from './types.js';
import type { AgentProvider } from './agent-tools.js';
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
    const sanitized = queenId.replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
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

async function callAgentSpawn(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Lazy import to avoid circular dependency (queen-tools → agent-tools → queen-tools)
  const { agentTools } = await import('./agent-tools.js');
  const spawnTool = agentTools.find(t => t.name === 'agent_spawn');
  if (!spawnTool) throw new Error('agent_spawn tool not found');
  return spawnTool.handler(input) as Promise<Record<string, unknown>>;
}

async function callAgentTask(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { agentTools } = await import('./agent-tools.js');
  const taskTool = agentTools.find(t => t.name === 'agent_task');
  if (!taskTool) throw new Error('agent_task tool not found');
  return taskTool.handler(input) as Promise<Record<string, unknown>>;
}

async function callAgentTerminate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { agentTools } = await import('./agent-tools.js');
  const terminateTool = agentTools.find(t => t.name === 'agent_terminate');
  if (!terminateTool) throw new Error('agent_terminate tool not found');
  return terminateTool.handler(input) as Promise<Record<string, unknown>>;
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
    },
    required: ['queenId', 'scope', 'description'],
  },
  handler: async (input) => {
    const queenId = input.queenId as string;
    const scope = input.scope as string;
    const description = input.description as string;
    const format = input.format as string | undefined;
    const maxWorkers = (input.maxWorkers as number) ?? 20;
    const maxCost = input.maxCost as number | undefined;
    const providers = input.providers as string[] | undefined;
    const workerDependencies = input.workerDependencies as Record<string, string[]> | undefined;
    const stalenessTimeout = input.stalenessTimeout as number | undefined;

    if (maxWorkers < 5) {
      return { success: false, error: `[COMPOSITION_ERROR] maxWorkers must be >= 5 (got ${maxWorkers}). Hives below minimum composition cannot pass report gates.` };
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

    // Create hive record
    const budget: Partial<HiveBudget> = { maxWorkers, maxCost };
    const config: ModuleHiveConfig = {};
    if (workerDependencies) config.workerDependencies = workerDependencies;
    if (stalenessTimeout) config.stalenessTimeout = stalenessTimeout;
    if (providers && providers.length > 0) config.defaultProvider = providers[0];

    const hive = createHive(queenId, budget, Object.keys(config).length > 0 ? config : undefined);

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
      const sanitizedQueenId = queenId.replace(/[\/\\\.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
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
      maxWorkers,
      providers,
    });

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
        enum: ['anthropic', 'anthropic-cli', 'gemini-cli', 'codex-cli', 'cursor-cli', 'deepseek'],
        description: 'LLM provider for the worker',
      },
      model: {
        type: 'string',
        enum: ['sonnet', 'opus', 'inherit'],
        description: 'Model tier for the worker',
      },
      task: { type: 'string', description: 'Initial task description for model routing' },
      budgetAllocation: { type: 'number', description: 'Budget allocation for this worker' },
      config: { type: 'object', description: 'Additional worker configuration' },
    },
    required: ['hiveId', 'queenId', 'role'],
  },
  handler: async (input) => {
    const hiveId = input.hiveId as string;
    const queenId = input.queenId as string;
    const role = input.role as string;
    const provider = (input.provider as AgentProvider) || 'anthropic';
    const model = input.model as string | undefined;
    const task = input.task as string | undefined;
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
        provider,
        model,
        task,
        config: {
          ...config,
          hiveId,
          parentAgentId: queenId,
          role,
          budgetAllocation,
        },
      });

      if (!spawnResult.success) {
        return { success: false, error: `Failed to spawn worker: ${spawnResult.error}` };
      }

      // Record worker in hive
      const workerRecord: HiveWorkerRecord = {
        workerId,
        agentId: spawnResult.agentId as string,
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

    // Validate hive and worker
    const hive = loadHive(hiveId);
    if (!hive) {
      return { success: false, error: `Hive '${hiveId}' not found.` };
    }

    const worker = hive.workers.find(w => w.workerId === workerId);
    if (!worker) {
      return { success: false, error: `Worker '${workerId}' not found in hive '${hiveId}'.` };
    }

    if (worker.status === 'terminated') {
      return { success: false, error: `Worker '${workerId}' is terminated.` };
    }

    // Log the task in hive audit
    await withHiveLock(hiveId, () => {
      const freshHive = loadHive(hiveId);
      if (freshHive) {
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
      }
    });

    // Call agent_task with the worker's agentId
    const taskInput: Record<string, unknown> = {
      agentId: worker.agentId,
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
          freshWorker.status = result.success ? 'idle' : 'error'; // Reset to idle on success, error on failure
        }
        saveHive(hiveId, freshHive);
      }
    });

    return {
      success: result.success,
      hiveId,
      workerId,
      agentId: worker.agentId,
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
    if (liveWorkers.length < 4) {
      return { success: false, error: `[COMPOSITION_ERROR] Cannot collect results. Found ${liveWorkers.length} live workers, minimum 4 required.` };
    }

    // Collect agent status for each worker
    const store = loadAgentStore();
    const workerResults: Array<{
      workerId: string;
      agentId: string;
      role: string;
      provider: string;
      status: string;
      taskCount: number;
      lastResult?: unknown;
    }> = [];

    for (const worker of hive.workers) {
      const agent = store.agents[worker.agentId];
      workerResults.push({
        workerId: worker.workerId,
        agentId: worker.agentId,
        role: worker.role,
        provider: worker.provider,
        status: agent?.status ?? worker.status,
        taskCount: agent?.taskCount ?? 0,
        lastResult: (agent as unknown as Record<string, unknown>)?.lastResult,
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

    return withHiveLock(hiveId, async () => {
      const hive = loadHive(hiveId);
      if (!hive) {
        return { success: false, error: `Hive '${hiveId}' not found.` };
      }

      if (hive.queenId !== queenId) {
        return { success: false, error: `Queen '${queenId}' does not own hive '${hiveId}'.` };
      }

      // Composition check: require minimum 4 live workers before accepting report
      const liveWorkers = hive.workers.filter(w => w.status !== 'terminated');
      if (liveWorkers.length < 4) {
        return { success: false, error: `[COMPOSITION_ERROR] Queen report blocked. Found ${liveWorkers.length} live workers, minimum 4 required.` };
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

      fireQueenReportHook({
        hiveId,
        queenId,
        status,
        reportLength: report.length,
        workerCount: liveWorkers.length,
        delegationMetrics: hive.delegationMetrics,
      });

      fireHiveCompleteHook({
        hiveId,
        queenId,
        status,
        completedAt: hive.completedAt,
        reportLength: report.length,
        workerCount: hive.workers.length,
        auditEntryCount: hive.audit.length,
        delegationMetrics: hive.delegationMetrics,
      });

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
            await callAgentTerminate({ agentId: worker.agentId, force: true });
            worker.status = 'terminated';
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
        await callAgentTerminate({ agentId: hive.queenId, force: true });
        terminated.push(hive.queenId);
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
    const pass = liveWorkerCount >= 4 && !stale;

    return {
      success: true,
      hiveId,
      result: pass ? 'PASS' : 'FAIL',
      liveWorkerCount,
      deadWorkerCount,
      roles,
      stale,
      ...(liveWorkerCount < 4
        ? { reason: `Insufficient live workers: ${liveWorkerCount}/4 minimum` }
        : stale
          ? { reason: 'Hive is stale (exceeded staleness timeout)' }
          : {}),
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
];
