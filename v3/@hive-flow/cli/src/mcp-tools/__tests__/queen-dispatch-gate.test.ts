import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { AgentRecord, AgentStore } from '../agent-tools.js';
import type { HiveRecord } from '../hive-store.js';

const mockAgentState = vi.hoisted(() => {
  const state: {
    store: AgentStore;
    calls: Record<'spawn' | 'task' | 'asyncTask' | 'terminate' | 'taskResult', number>;
  } = {
    store: { agents: {}, version: '3.0.0' },
    calls: { spawn: 0, task: 0, asyncTask: 0, terminate: 0, taskResult: 0 },
  };
  return state;
});

vi.mock('../agent-tools.js', () => {
  const transitionAgent = (agent: AgentRecord, status: AgentRecord['status']): boolean => {
    agent.status = status;
    return true;
  };

  const agentTools = [
    {
      name: 'agent_spawn',
      handler: async (input: Record<string, unknown>) => {
        mockAgentState.calls.spawn += 1;
        const agentId = String(input.agentId ?? 'spawned-agent');
        mockAgentState.store.agents[agentId] = makeAgent(agentId, String(input.agentType ?? 'worker'));
        return { success: true, agentId, model: input.model, resolvedModel: input.model };
      },
    },
    {
      name: 'agent_task',
      handler: async (input: Record<string, unknown>) => {
        mockAgentState.calls.task += 1;
        return { success: true, taskId: `task-${mockAgentState.calls.task}`, agentId: input.agentId, status: 'running' };
      },
    },
    {
      name: 'agent_task_async',
      handler: async (input: Record<string, unknown>) => {
        mockAgentState.calls.asyncTask += 1;
        return { success: true, taskId: `async-task-${mockAgentState.calls.asyncTask}`, agentId: input.agentId, status: 'running' };
      },
    },
    {
      name: 'agent_task_result',
      handler: async (input: Record<string, unknown>) => {
        mockAgentState.calls.taskResult += 1;
        return {
          success: true,
          taskId: input.taskId,
          status: 'completed',
          result: { vote: 'approve', text: 'approved by mock provider' },
        };
      },
    },
    {
      name: 'agent_terminate',
      handler: async (input: Record<string, unknown>) => {
        mockAgentState.calls.terminate += 1;
        const agentId = String(input.agentId);
        if (mockAgentState.store.agents[agentId]) {
          mockAgentState.store.agents[agentId].status = 'terminated';
        }
        return { success: true, agentId, terminated: true };
      },
    },
  ];

  function makeAgent(agentId: string, agentType = 'worker'): AgentRecord {
    return {
      agentId,
      agentType,
      status: 'idle',
      health: 100,
      taskCount: 0,
      config: {},
      createdAt: new Date(0).toISOString(),
      provider: 'codex-cli',
      model: 'sonnet',
    };
  }

  return {
    agentTools,
    loadAgentStore: () => mockAgentState.store,
    saveAgentStore: (store: AgentStore) => { mockAgentState.store = store; },
    withStoreLock: async (scopeOrFn: string | (() => unknown), maybeFn?: () => unknown) => {
      const fn = typeof scopeOrFn === 'function' ? scopeOrFn : maybeFn!;
      return fn();
    },
    transitionAgent,
    propagateEnforcementToSubAgent: async () => undefined,
  };
});

import { queenTools } from '../queen-tools.js';
import { hiveMindTools } from '../hive-mind-tools.js';
import { createHive, saveHive } from '../hive-store.js';
import { checkMCPEnforcement, classifyTool, ToolRisk } from '../mcp-enforcement-gate.js';

const originalCwd = process.cwd();
const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
let root: string;

function makeAgent(agentId: string, agentType = 'worker'): AgentRecord {
  return {
    agentId,
    agentType,
    status: 'idle',
    health: 100,
    taskCount: 0,
    config: {},
    createdAt: new Date(0).toISOString(),
    provider: 'codex-cli',
    model: 'sonnet',
  };
}

function resetAgentMocks(): void {
  mockAgentState.store = {
    version: '3.0.0',
    agents: {
      'queen-1': makeAgent('queen-1', 'queen'),
      'worker-agent-1': makeAgent('worker-agent-1', 'worker'),
    },
  };
  mockAgentState.calls = { spawn: 0, task: 0, asyncTask: 0, terminate: 0, taskResult: 0 };
}

function writeSignedState(level: number): void {
  const enforcementDir = join(root, '.hive-flow', 'enforcement');
  mkdirSync(enforcementDir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(join(enforcementDir, '.hmac-key'), `${key}\n`);
  const state = {
    level,
    consecutiveDenials: 0,
    lastActivity: new Date(0).toISOString(),
    history: [],
    resetAt: null,
    integrityCompromised: false,
  };
  const hmac = createHmac('sha256', key).update(JSON.stringify(state)).digest('hex');
  writeFileSync(join(enforcementDir, 'state.json'), JSON.stringify({ state, hmac }, null, 2));
}

function getQueenTool(name: string) {
  const tool = queenTools.find(t => t.name === name);
  if (!tool) throw new Error(`Missing queen tool ${name}`);
  return tool;
}

function getHiveMindTool(name: string) {
  const tool = hiveMindTools.find(t => t.name === name);
  if (!tool) throw new Error(`Missing hive-mind tool ${name}`);
  return tool;
}

function createActiveHive(): HiveRecord {
  const hive = createHive('queen-1', { maxWorkers: 6 });
  hive.status = 'active';
  hive.workers.push({
    workerId: 'worker-1',
    agentId: 'worker-agent-1',
    role: 'coder',
    provider: 'codex-cli',
    status: 'idle',
    spawnedAt: new Date(0).toISOString(),
  });
  hive.budget.workersAllocated = 1;
  saveHive(hive.hiveId, hive);
  return hive;
}

function writeHiveMindConsensusState(): void {
  const now = new Date(0).toISOString();
  const dir = join(root, '.hive-flow', 'hive-mind');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    initialized: true,
    topology: 'mesh',
    workers: [
      { agentId: 'worker-agent-1', provider: 'codex-cli', model: 'sonnet', role: 'reviewer', joinedAt: now, status: 'idle' },
    ],
    consensus: {
      pending: [
        { proposalId: 'proposal-1', type: 'review', value: 'ship?', proposedBy: 'queen-1', proposedAt: now, votes: {}, status: 'pending' },
      ],
      history: [],
    },
    sharedMemory: {},
    createdAt: now,
    updatedAt: now,
  }, null, 2));
}

function expectMcpDeny(value: unknown): void {
  expect(String(value)).toContain('[MCP ENFORCEMENT]');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hive-flow-queen-dispatch-gate-'));
  process.chdir(root);
  process.env.CLAUDE_PROJECT_DIR = root;
  resetAgentMocks();
  writeSignedState(0);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  }
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('D-32: queen in-process dispatch gate', () => {
  it('HALTED blocks queen_task_worker and queen_mission_assign auto-dispatch before agent handlers run', async () => {
    writeSignedState(3);
    const hive = createActiveHive();

    const taskResult = await getQueenTool('queen_task_worker').handler({
      hiveId: hive.hiveId,
      workerId: 'worker-1',
      task: 'do blocked work',
    }) as Record<string, unknown>;

    expect(taskResult.success).toBe(false);
    expectMcpDeny((taskResult.result as Record<string, unknown>).error);
    expect(mockAgentState.calls.task).toBe(0);

    const missionResult = await getQueenTool('queen_mission_assign').handler({
      queenId: 'queen-1',
      scope: 'blocked mission',
      description: 'blocked mission',
      maxWorkers: 5,
      workers: Array.from({ length: 5 }, (_, index) => ({
        role: `worker-${index}`,
        provider: 'codex-cli',
        model: 'sonnet',
        task: 'blocked worker task',
      })),
    }) as Record<string, unknown>;

    const workers = missionResult.workers as Array<{ error?: string }>;
    expect(workers).toHaveLength(5);
    expect(workers.every(w => String(w.error).includes('[MCP ENFORCEMENT]'))).toBe(true);
    expect(missionResult.workersErrored).toBe(5);
    expect(mockAgentState.calls.spawn).toBe(0);
    expect(mockAgentState.calls.asyncTask).toBe(0);
  });

  it('RESTRICTED blocks dispatch and terminate, while WARNED still allows terminate', async () => {
    writeSignedState(2);
    const restrictedHive = createActiveHive();

    const dispatchResult = await getQueenTool('queen_task_worker').handler({
      hiveId: restrictedHive.hiveId,
      workerId: 'worker-1',
      task: 'restricted work',
    }) as Record<string, unknown>;

    expect(dispatchResult.success).toBe(false);
    expectMcpDeny((dispatchResult.result as Record<string, unknown>).error);
    expect(mockAgentState.calls.task).toBe(0);

    const restrictedTerminate = await getQueenTool('hive_terminate').handler({
      hiveId: restrictedHive.hiveId,
      reason: 'restricted teardown',
    }) as Record<string, unknown>;

    expect(restrictedTerminate.success).toBe(false);
    expectMcpDeny(restrictedTerminate.error);
    expect(mockAgentState.calls.terminate).toBe(0);

    writeSignedState(1);
    const warnedHive = createActiveHive();
    const warnedTerminate = await getQueenTool('hive_terminate').handler({
      hiveId: warnedHive.hiveId,
      reason: 'warned teardown',
    }) as Record<string, unknown>;

    expect(warnedTerminate.success).toBe(true);
    expect(mockAgentState.calls.terminate).toBeGreaterThan(0);
  });

  it('HALTED blocks hive-mind consensus execute fan-out before agent_task runs', async () => {
    writeSignedState(3);
    writeHiveMindConsensusState();

    const result = await getHiveMindTool('hive-mind_consensus').handler({
      action: 'execute',
      proposalId: 'proposal-1',
      task: 'vote on this blocked proposal',
      timeout: 10,
    }) as Record<string, unknown>;

    expect(result.action).toBe('execute');
    expectMcpDeny(result.error);
    expect(mockAgentState.calls.task).toBe(0);
  });

  it('statically keeps every in-process dispatch sink behind assertDispatchAllowed', () => {
    const queenSource = readFileSync(join(originalCwd, 'src/mcp-tools/queen-tools.ts'), 'utf8');
    const hiveMindSource = readFileSync(join(originalCwd, 'src/mcp-tools/hive-mind-tools.ts'), 'utf8');
    const headlessWorkerSource = readFileSync(join(originalCwd, 'src/services/headless-worker-executor.ts'), 'utf8');

    expect(queenSource).toMatch(/function callAgentSpawn[\s\S]*assertDispatchAllowed\('agent_spawn'\)[\s\S]*spawnTool\.handler/);
    expect(queenSource).toMatch(/function callAgentTask[\s\S]*assertDispatchAllowed\('agent_task'\)[\s\S]*taskTool\.handler/);
    expect(queenSource).toMatch(/function callAgentTaskAsync[\s\S]*assertDispatchAllowed\('agent_task'\)[\s\S]*asyncTool\.handler/);
    expect(queenSource).toMatch(/function callAgentTerminate[\s\S]*assertDispatchAllowed\('agent_terminate'\)[\s\S]*terminateTool\.handler/);
    expect(hiveMindSource).toMatch(/assertDispatchAllowed\('agent_task'\)[\s\S]*Promise\.allSettled/);
    expect(headlessWorkerSource).toMatch(/assertDispatchAllowed\('hooks_worker-dispatch'\)[\s\S]*spawn\('claude'/);
  });

  it('classifies headless worker dispatch as HIGH and blocks it at RESTRICTED+', () => {
    expect(classifyTool('hooks_worker-dispatch')).toBe(ToolRisk.HIGH);
    expect(classifyTool('hooks_worker-detect')).toBe(ToolRisk.HIGH);

    writeSignedState(1);
    expect(checkMCPEnforcement('hooks_worker-dispatch').allowed).toBe(true);

    writeSignedState(2);
    const restricted = checkMCPEnforcement('hooks_worker-dispatch');
    expect(restricted.allowed).toBe(false);
    expectMcpDeny(restricted.reason);

    writeSignedState(3);
    const halted = checkMCPEnforcement('hooks_worker-dispatch');
    expect(halted.allowed).toBe(false);
    expectMcpDeny(halted.reason);
  });
});
