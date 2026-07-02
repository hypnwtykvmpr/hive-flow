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
    calls: Record<'spawn' | 'task' | 'terminate' | 'taskResult', number>;
    lastSpawnInput?: Record<string, unknown>;
    lastTaskInput?: Record<string, unknown>;
    lastTerminateInput?: Record<string, unknown>;
    retryContextSymbol: symbol;
  } = {
    store: { agents: {}, version: '3.0.0' },
    calls: { spawn: 0, task: 0, terminate: 0, taskResult: 0 },
    retryContextSymbol: Symbol('hive-flow.agent-task.retry-context.mock'),
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
      handler: async (input: Record<string, unknown>, context: Record<string, unknown> = {}) => {
        mockAgentState.calls.spawn += 1;
        mockAgentState.lastSpawnInput = { ...input };
        const agentId = String(input.agentId ?? `worker-${mockAgentState.calls.spawn}`);
        mockAgentState.store.agents[agentId] = {
          ...makeAgent(agentId, String(input.agentType ?? 'worker')),
          ...(typeof input.session_id === 'string' ? { ownerSessionId: input.session_id } : {}),
          ...(typeof context.clientKind === 'string' ? { ownerClientKind: context.clientKind as AgentRecord['ownerClientKind'] } : {}),
          mode: typeof input.mode === 'string' ? input.mode as AgentRecord['mode'] : 'full',
          ...(typeof input.artifactDir === 'string' ? { artifactDir: input.artifactDir } : {}),
        };
        return {
          success: true,
          agentId,
          model: input.model,
          resolvedModel: input.model,
          ownerSessionId: input.session_id,
          ownerClientKind: context.clientKind,
          mode: input.mode,
          artifactDir: input.artifactDir,
        };
      },
    },
    {
      name: 'agent_task',
      handler: async (input: Record<string, unknown>) => {
        mockAgentState.calls.task += 1;
        mockAgentState.lastTaskInput = { ...input };
        if (!mockAgentState.store.agents[String(input.agentId)]) {
          return { success: false, error: `Agent '${String(input.agentId)}' not found` };
        }
        return { success: true, taskId: `task-${mockAgentState.calls.task}`, agentId: input.agentId, status: 'running' };
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
        mockAgentState.lastTerminateInput = { ...input };
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
    AGENT_TASK_RETRY_CONTEXT: mockAgentState.retryContextSymbol,
    withStoreLock: async (scopeOrFn: string | (() => unknown), maybeFn?: () => unknown) => {
      const fn = typeof scopeOrFn === 'function' ? scopeOrFn : maybeFn!;
      return fn();
    },
    resolveProjectRootFromInput: (input: Record<string, unknown> | null | undefined) => ({
      ok: true,
      projectRoot: String(input?.projectRoot ?? input?.cwd ?? process.cwd()),
    }),
    transitionAgent,
    propagateEnforcementToSubAgent: async () => undefined,
    resolveEffectiveAgentModeForSpawn: () => ({ ok: true, mode: 'full', parentMode: 'full', requestedMode: 'full' }),
  };
});

import { queenTools } from '../queen-tools.js';
import { hiveMindTools } from '../hive-mind-tools.js';
import { createHive, loadHive, saveHive } from '../hive-store.js';
import { checkMCPEnforcement, classifyTool, ToolRisk } from '../mcp-enforcement-gate.js';

const originalCwd = process.cwd();
const cliPackageRoot = join(__dirname, '..', '..', '..');
const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
const originalHiveFlowHome = process.env.HIVE_FLOW_HOME;
let root: string;
let hiveHome: string;

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
  mockAgentState.calls = { spawn: 0, task: 0, terminate: 0, taskResult: 0 };
  delete mockAgentState.lastSpawnInput;
  delete mockAgentState.lastTaskInput;
  delete mockAgentState.lastTerminateInput;
}

// Persist the shared HMAC key once per sandbox so repeated writeSignedState()
// calls re-sign with a stable key (the gate reads <hiveHome>/enforcement/.hmac-key).
let sandboxKey: string;

function writeSignedState(level: number): void {
  // Canonical hiveHome-rooted GLOBAL scope path that the corrected gate (and
  // enforcement.cjs getScopedStateFile('global')) reads:
  //   <hiveHome>/enforcement/global/state.json
  // signed by the single shared key at <hiveHome>/enforcement/.hmac-key.
  const enforcementDir = join(hiveHome, 'enforcement');
  const globalDir = join(enforcementDir, 'global');
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(enforcementDir, '.hmac-key'), `${sandboxKey}\n`);
  const state = {
    level,
    consecutiveDenials: 0,
    lastActivity: new Date(0).toISOString(),
    history: [],
    resetAt: null,
    integrityCompromised: false,
  };
  const hmac = createHmac('sha256', sandboxKey).update(JSON.stringify(state)).digest('hex');
  writeFileSync(join(globalDir, 'state.json'), JSON.stringify({ state, hmac }, null, 2));
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

function createActiveHive(
  owner: { ownerSessionId?: string; ownerClientKind?: string } = { ownerSessionId: 'hive-owner-session', ownerClientKind: 'codex' },
  projectRoot = root,
): HiveRecord {
  const hive = createHive('queen-1', { maxWorkers: 6 }, undefined, owner, projectRoot);
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
  saveHive(hive.hiveId, hive, projectRoot);
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
  // Isolated HIVE_FLOW_HOME so the gate's canonical scopes resolve inside the
  // sandbox and NEVER touch the real ~/.hive-flow operator state.
  hiveHome = join(root, 'hive-home');
  mkdirSync(hiveHome, { recursive: true });
  sandboxKey = randomBytes(32).toString('hex');
  process.chdir(root);
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.HIVE_FLOW_HOME = hiveHome;
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
  if (originalHiveFlowHome === undefined) {
    delete process.env.HIVE_FLOW_HOME;
  } else {
    process.env.HIVE_FLOW_HOME = originalHiveFlowHome;
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
    expect(mockAgentState.calls.task).toBe(0);
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

  it('passes requested mode and artifactDir from queen_spawn_worker through to agent_spawn', async () => {
    const hive = createActiveHive();
    const artifactDir = join(root, '.tmp-audit', 'queen-artifacts');
    mkdirSync(artifactDir, { recursive: true });

    const result = await getQueenTool('queen_spawn_worker').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      role: 'reviewer',
      provider: 'codex-cli',
      model: 'sonnet',
      mode: 'read-only-with-artifacts',
      artifactDir,
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(mockAgentState.calls.spawn).toBe(1);
    const agent = mockAgentState.store.agents[String(result.agentId)];
    expect(agent).toMatchObject({
      ownerSessionId: 'hive-owner-session',
      ownerClientKind: 'codex',
      mode: 'read-only-with-artifacts',
      artifactDir,
    });
  });

  it('queen_spawn_worker inherits the persisted hive owner instead of stale ambient context', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-hive-session', ownerClientKind: 'claude' });

    const result = await getQueenTool('queen_spawn_worker').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      role: 'reviewer',
      provider: 'codex-cli',
      model: 'sonnet',
    }, { sessionId: 'codex-transport-session', clientKind: 'codex' }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    const agent = mockAgentState.store.agents[String(result.agentId)];
    expect(agent).toMatchObject({
      ownerSessionId: 'claude-hive-session',
      ownerClientKind: 'claude',
    });
  });

  it('queen_spawn_worker fails closed when the hive owner stamp is incomplete', async () => {
    const hive = createActiveHive({ ownerSessionId: 'legacy-owner-session' });

    const result = await getQueenTool('queen_spawn_worker').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      role: 'reviewer',
      provider: 'codex-cli',
      model: 'sonnet',
    }, { sessionId: 'codex-transport-session', clientKind: 'codex' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: false,
      code: 'missing-owner-client-kind',
    });
    expect(mockAgentState.calls.spawn).toBe(0);
  });

  it('passes requested worker mode and artifactDir from queen_mission_assign through to agent_spawn', async () => {
    const artifactDir = join(root, '.tmp-audit', 'mission-artifacts');
    mkdirSync(artifactDir, { recursive: true });

    const result = await getQueenTool('queen_mission_assign').handler({
      queenId: 'queen-1',
      scope: 'mode pass-through mission',
      description: 'Verify worker mode forwarding',
      session_id: 'claude-mission-session',
      workers: Array.from({ length: 5 }, (_, index) => ({
        role: `reviewer-${index}`,
        provider: 'codex-cli',
        model: 'sonnet',
        mode: 'read-only-with-artifacts',
        artifactDir,
      })),
    }, { sessionId: 'claude-mission-session', clientKind: 'claude' }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.workersSpawned).toBeGreaterThan(0);
    expect(mockAgentState.calls.spawn).toBeGreaterThan(0);
    const workerIds = Object.keys(mockAgentState.store.agents).filter(agentId => agentId.startsWith('worker-'));
    expect(workerIds.length).toBeGreaterThanOrEqual(2);
    const spawned = workerIds
      .map(agentId => mockAgentState.store.agents[agentId])
      .find(agent => agent.mode === 'read-only-with-artifacts');
    expect(spawned).toMatchObject({
      ownerSessionId: 'claude-mission-session',
      ownerClientKind: 'claude',
      mode: 'read-only-with-artifacts',
      artifactDir,
    });
  });

  it('queen_mission_assign auto-spawns every parallel worker with the persisted hive owner', async () => {
    const roles = ['tester', 'verifier', 'researcher', 'auditor', 'bug-hunter'];
    const result = await getQueenTool('queen_mission_assign').handler({
      queenId: 'queen-1',
      scope: 'owner inheritance mission',
      description: 'Verify auto-spawn owner inheritance',
      session_id: 'claude-auto-session',
      workers: Array.from({ length: 5 }, (_, index) => ({
        role: roles[index],
        provider: 'codex-cli',
        model: 'sonnet',
      })),
    }, { sessionId: 'claude-auto-session', clientKind: 'claude' }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.workersSpawned).toBe(5);
    const resultWorkers = result.workers as Array<Record<string, unknown>>;
    expect(resultWorkers).toHaveLength(5);
    expect(new Set(resultWorkers.map(worker => worker.agentId)).size).toBe(5);
    const persistedHive = loadHive(String(result.hiveId));
    const spawnedWorkers = persistedHive?.workers.filter(worker => String(worker.agentId).startsWith('worker-')) ?? [];
    expect(spawnedWorkers).toHaveLength(5);
    expect(spawnedWorkers.every(worker => worker.ownerSessionId === 'claude-auto-session')).toBe(true);
    expect(spawnedWorkers.every(worker => worker.ownerClientKind === 'claude')).toBe(true);
  });

  it('queen_mission_assign persists the live queen pid onto the hive record', async () => {
    mockAgentState.store.agents['queen-1'].currentTaskPid = process.pid;

    const result = await getQueenTool('queen_mission_assign').handler({
      queenId: 'queen-1',
      scope: 'queen pid mission',
      description: 'Verify active quiescent queen visibility',
      session_id: 'claude-queen-pid-session',
    }, { sessionId: 'claude-queen-pid-session', clientKind: 'claude' }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    const persistedHive = loadHive(String(result.hiveId));
    expect(persistedHive?.queenPid).toBe(process.pid);
    expect(persistedHive?.ownerSessionId).toBe('claude-queen-pid-session');
  });

  it('queen_mission_assign creates and reads hive records under the explicit projectRoot', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'hive-flow-queen-project-root-'));
    try {
      const result = await getQueenTool('queen_mission_assign').handler({
        queenId: 'queen-1',
        scope: 'cross repo mission',
        description: 'Verify hive records are scoped to the requested project root',
        session_id: 'claude-cross-repo-session',
        projectRoot: otherRoot,
      }, { sessionId: 'claude-cross-repo-session', clientKind: 'claude' }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      const hiveId = String(result.hiveId);
      expect(existsSync(join(otherRoot, '.hive-flow', 'hives', hiveId, 'hive.json'))).toBe(true);
      expect(existsSync(join(root, '.hive-flow', 'hives', hiveId, 'hive.json'))).toBe(false);
      expect(loadHive(hiveId, otherRoot)?.ownerSessionId).toBe('claude-cross-repo-session');
      expect(loadHive(hiveId, root)).toBeNull();

      const statusResult = await getQueenTool('hive_status').handler({
        hiveId,
        projectRoot: otherRoot,
      }) as Record<string, unknown>;
      expect(statusResult.success).toBe(true);
      expect((statusResult.hive as HiveRecord).hiveId).toBe(hiveId);

      const wrongRootStatus = await getQueenTool('hive_status').handler({
        hiveId,
        projectRoot: root,
      }) as Record<string, unknown>;
      expect(wrongRootStatus.success).toBe(false);
      expect(String(wrongRootStatus.error)).toContain('not found');
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('queen_spawn_worker and queen_task_worker forward explicit projectRoot to delegated agent tools', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'hive-flow-queen-forward-root-'));
    try {
      const hive = createActiveHive({ ownerSessionId: 'claude-forward-session', ownerClientKind: 'claude' }, otherRoot);

      const spawnResult = await getQueenTool('queen_spawn_worker').handler({
        hiveId: hive.hiveId,
        queenId: hive.queenId,
        role: 'reviewer',
        provider: 'codex-cli',
        model: 'sonnet',
        projectRoot: otherRoot,
      }, { sessionId: 'wrong-ambient-session', clientKind: 'codex' }) as Record<string, unknown>;

      expect(spawnResult.success).toBe(true);
      expect(mockAgentState.lastSpawnInput?.projectRoot).toBe(otherRoot);

      const taskResult = await getQueenTool('queen_task_worker').handler({
        hiveId: hive.hiveId,
        workerId: String(spawnResult.workerId),
        task: 'inspect the target repo only',
        projectRoot: otherRoot,
      }) as Record<string, unknown>;

      expect(taskResult.success).toBe(true);
      expect(mockAgentState.lastTaskInput?.projectRoot).toBe(otherRoot);
      expect(loadHive(hive.hiveId, otherRoot)?.workers.find(worker => worker.workerId === spawnResult.workerId)?.status).toBe('busy');
      expect(loadHive(hive.hiveId, root)).toBeNull();
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('queen_collect_results reads durable task results for queen-owned workers before agent_task_result consumption', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-collect-session', ownerClientKind: 'claude' });
    const taskDir = join(root, '.hive-flow', 'tasks');
    mkdirSync(taskDir, { recursive: true });
    hive.workers = Array.from({ length: 5 }, (_, index) => {
      const workerId = `worker-${index + 1}`;
      const agentId = `collect-agent-${index + 1}`;
      const taskId = `task-collect-${index + 1}`;
      writeFileSync(join(taskDir, `${taskId}.result.json`), JSON.stringify({
        success: true,
        taskId,
        agentId,
        result: `worker result ${index + 1}`,
      }), 'utf8');
      mockAgentState.store.agents[agentId] = {
        ...makeAgent(agentId, 'tester'),
        ownerSessionId: 'claude-collect-session',
        ownerClientKind: 'claude',
        taskCount: 0,
      };
      return {
        workerId,
        agentId,
        taskId,
        ownerSessionId: 'claude-collect-session',
        ownerClientKind: 'claude',
        role: 'tester',
        provider: 'codex-cli',
        status: 'idle',
        spawnedAt: new Date(0).toISOString(),
      };
    });
    hive.budget.workersAllocated = 5;
    saveHive(hive.hiveId, hive);

    const result = await getQueenTool('queen_collect_results').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.workerCount).toBe(5);
    const workers = result.workers as Array<Record<string, unknown>>;
    expect(workers).toHaveLength(5);
    expect(workers.every(worker => worker.taskCount === 1)).toBe(true);
    expect(workers.map(worker => (worker.lastResult as Record<string, unknown>)?.result)).toEqual([
      'worker result 1',
      'worker result 2',
      'worker result 3',
      'worker result 4',
      'worker result 5',
    ]);
  });

  it('lets the owning queen review and redirect a worker permission request without waking the operator', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-permission-session', ownerClientKind: 'claude' });
    const requestLine = {
      kind: 'worker-permission-denial',
      requestId: 'permission-test-redirect',
      taskId: 'task-permission-redirect',
      ts: new Date(0).toISOString(),
      agentId: 'worker-agent-1',
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: "git subcommand 'mv' is not in the read-only allowlist",
      denyCode: 'read-only-command-denied',
    };
    writeFileSync(join(root, '.hive-flow', 'hives', hive.hiveId, 'permission-requests.jsonl'), `${JSON.stringify(requestLine)}\n`, 'utf8');

    const requestsResult = await getQueenTool('queen_permission_requests').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
    }) as Record<string, unknown>;

    expect(requestsResult.success).toBe(true);
    expect(requestsResult.pendingCount).toBe(1);
    const requests = requestsResult.requests as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: 'permission-test-redirect',
      workerId: 'worker-1',
      status: 'pending',
      tool: 'run_command',
    });

    const redirectResult = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-redirect',
      decision: 'redirect',
      reason: 'Use safe read-only inspection instead of moving files.',
      redirectTask: 'Inspect the file list with read_file/list_directory and summarize the required rename without mutating files.',
    }) as Record<string, unknown>;

    expect(redirectResult.success).toBe(true);
    expect(redirectResult.status).toBe('redirected');
    expect((redirectResult.redirectDispatch as Record<string, unknown>).success).toBe(true);
    expect(mockAgentState.calls.task).toBe(1);

    const persisted = loadHive(hive.hiveId)!;
    expect(persisted.permissionRequests?.[0]).toMatchObject({
      requestId: 'permission-test-redirect',
      status: 'redirected',
      decision: {
        decision: 'redirect',
        decidedBy: hive.queenId,
        redirectTask: 'Inspect the file list with read_file/list_directory and summarize the required rename without mutating files.',
      },
    });
    expect(persisted.workers[0].status).toBe('busy');
    expect(persisted.audit.some(entry => entry.event === 'permission-requested')).toBe(true);
    expect(persisted.audit.some(entry => entry.event === 'permission-reviewed')).toBe(true);
    expect(existsSync(join(root, '.hive-flow', 'data', 'pending-notifications.jsonl'))).toBe(false);
    expect(existsSync(join(hiveHome, 'wake'))).toBe(false);
  });

  // P2-SH7 (hive-flow-8119): deny must dispatch a resume/continue instruction to the
  // worker (previously deny only recorded guidance and the worker was left stuck).
  it('dispatches a worker resume instruction when the queen denies a permission request', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-permission-session', ownerClientKind: 'claude' });
    const requestLine = {
      kind: 'worker-permission-denial',
      requestId: 'permission-test-deny-resume',
      taskId: 'task-permission-deny-resume',
      ts: new Date(0).toISOString(),
      agentId: 'worker-agent-1',
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: "git subcommand 'mv' is not in the read-only allowlist",
      denyCode: 'read-only-command-denied',
    };
    writeFileSync(join(root, '.hive-flow', 'hives', hive.hiveId, 'permission-requests.jsonl'), `${JSON.stringify(requestLine)}\n`, 'utf8');

    const tasksBefore = mockAgentState.calls.task;
    const denyResult = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-deny-resume',
      decision: 'deny',
      reason: 'That mv is unsafe here.',
      guidance: 'Summarize the required rename in your report; do not mutate files.',
    }) as Record<string, unknown>;

    expect(denyResult.success).toBe(true);
    expect(denyResult.status).toBe('denied');
    // The worker was actually re-tasked (resumed), not just recorded.
    expect((denyResult.resumeDispatch as Record<string, unknown>).success).toBe(true);
    expect(denyResult.workerResumed).toBe(true);
    expect(mockAgentState.calls.task).toBe(tasksBefore + 1);

    const persisted = loadHive(hive.hiveId)!;
    expect(persisted.permissionRequests?.[0]).toMatchObject({
      requestId: 'permission-test-deny-resume',
      status: 'denied',
      decision: { decision: 'deny', resumeDispatched: true },
    });
    // worker stays live (resumed), not terminated.
    expect(persisted.workers[0].status).toBe('busy');
  });

  // P2-SH7 idempotency: a duplicate deny for the same request must NOT re-dispatch a
  // resume task or re-audit — decisions dedupe without spam.
  it('is idempotent on a duplicate deny: no second resume dispatch, no audit spam', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-permission-session', ownerClientKind: 'claude' });
    const requestLine = {
      kind: 'worker-permission-denial',
      requestId: 'permission-test-deny-idem',
      taskId: 'task-permission-deny-idem',
      ts: new Date(0).toISOString(),
      agentId: 'worker-agent-1',
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: "git subcommand 'mv' is not in the read-only allowlist",
      denyCode: 'read-only-command-denied',
    };
    writeFileSync(join(root, '.hive-flow', 'hives', hive.hiveId, 'permission-requests.jsonl'), `${JSON.stringify(requestLine)}\n`, 'utf8');

    const denyInput = {
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-deny-idem',
      decision: 'deny',
      reason: 'That mv is unsafe here.',
      guidance: 'Summarize the required rename; do not mutate files.',
    };

    const first = await getQueenTool('queen_permission_decide').handler({ ...denyInput }) as Record<string, unknown>;
    expect(first.success).toBe(true);
    expect(first.workerResumed).toBe(true);
    const tasksAfterFirst = mockAgentState.calls.task;
    expect(tasksAfterFirst).toBe(1);

    // Second identical deny — must dedupe: no new dispatch, no new audit.
    const second = await getQueenTool('queen_permission_decide').handler({ ...denyInput }) as Record<string, unknown>;
    expect(second.success).toBe(true);
    expect(second.status).toBe('denied');
    expect(second.alreadyDecided).toBe(true);
    expect(second.resumeDispatch).toBeUndefined();
    expect(mockAgentState.calls.task).toBe(tasksAfterFirst); // no second resume dispatch

    const persisted = loadHive(hive.hiveId)!;
    // Exactly one permission-reviewed audit entry for this request (no spam).
    const reviews = persisted.audit.filter(e => e.event === 'permission-reviewed' && e.detail.includes('permission-test-deny-idem'));
    expect(reviews).toHaveLength(1);
    expect(persisted.permissionRequests?.[0]).toMatchObject({
      requestId: 'permission-test-deny-idem',
      status: 'denied',
      decision: { decision: 'deny', resumeDispatched: true },
    });
  });

  it('keeps a permission request retryable when queen redirect dispatch fails', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-permission-session', ownerClientKind: 'claude' });
    const requestLine = {
      kind: 'worker-permission-denial',
      requestId: 'permission-test-redirect-fail',
      taskId: 'task-permission-redirect-fail',
      ts: new Date(0).toISOString(),
      agentId: 'worker-agent-1',
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: "git subcommand 'mv' is not in the read-only allowlist",
      denyCode: 'read-only-command-denied',
    };
    writeFileSync(join(root, '.hive-flow', 'hives', hive.hiveId, 'permission-requests.jsonl'), `${JSON.stringify(requestLine)}\n`, 'utf8');
    delete mockAgentState.store.agents['worker-agent-1'];

    const redirectResult = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-redirect-fail',
      decision: 'redirect',
      reason: 'Use safe read-only inspection instead of moving files.',
      redirectTask: 'Inspect the file list with read_file/list_directory and summarize the required rename without mutating files.',
    }) as Record<string, unknown>;

    expect(redirectResult.success).toBe(false);
    expect(redirectResult.status).toBe('redirect-failed');
    expect(redirectResult.error).toMatch(/Agent 'worker-agent-1' not found/);
    expect((redirectResult.redirectDispatch as Record<string, unknown>).success).toBe(false);
    expect(mockAgentState.calls.task).toBe(1);

    const persisted = loadHive(hive.hiveId)!;
    expect(persisted.permissionRequests?.[0]).toMatchObject({
      requestId: 'permission-test-redirect-fail',
      status: 'redirect-failed',
      decision: {
        decision: 'redirect',
        decidedBy: hive.queenId,
        redirectTask: 'Inspect the file list with read_file/list_directory and summarize the required rename without mutating files.',
        redirectError: "Agent 'worker-agent-1' not found",
      },
    });
    expect(persisted.workers[0].status).toBe('error');

    const retryResult = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-redirect-fail',
      decision: 'deny',
      reason: 'No live worker remains for redirect.',
      guidance: 'Record the failed redirect and synthesize from durable evidence instead of retrying the denied tool.',
    }) as Record<string, unknown>;
    expect(retryResult).toMatchObject({
      success: true,
      status: 'denied',
      guidance: 'Record the failed redirect and synthesize from durable evidence instead of retrying the denied tool.',
    });
  });

  it('deduplicates bridge-style permission requests by stable deny code', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-permission-session', ownerClientKind: 'claude' });
    const lines = [
      {
        kind: 'worker-permission-denial',
        requestId: 'permission-1111111111111111',
        taskId: 'task-stable-deny',
        ts: new Date(0).toISOString(),
        agentId: 'worker-agent-1',
        hiveId: hive.hiveId,
        queenId: hive.queenId,
        tool: 'run_command',
        denyReason: "git subcommand 'mv' is not in the read-only allowlist",
        denyCode: 'read-only-command-denied',
      },
      {
        kind: 'worker-permission-denial',
        requestId: 'permission-2222222222222222',
        taskId: 'task-stable-deny',
        ts: new Date(1).toISOString(),
        agentId: 'worker-agent-1',
        hiveId: hive.hiveId,
        queenId: hive.queenId,
        tool: 'run_command',
        denyReason: "git subcommand 'rm' is not in the read-only allowlist",
        denyCode: 'read-only-command-denied',
      },
      {
        kind: 'worker-permission-denial',
        requestId: 'permission-3333333333333333',
        taskId: 'task-stable-deny',
        ts: new Date(2).toISOString(),
        agentId: 'worker-agent-1',
        hiveId: hive.hiveId,
        queenId: hive.queenId,
        tool: 'run_command',
        denyReason: 'sandbox unavailable',
        denyCode: 'sandbox-unavailable',
      },
    ];
    writeFileSync(
      join(root, '.hive-flow', 'hives', hive.hiveId, 'permission-requests.jsonl'),
      `${lines.map(line => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    const requestsResult = await getQueenTool('queen_permission_requests').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      status: 'all',
    }) as Record<string, unknown>;

    expect(requestsResult.success).toBe(true);
    expect(requestsResult.requestCount).toBe(2);
    const requests = requestsResult.requests as Array<Record<string, unknown>>;
    const readOnlyRequests = requests.filter(request => request.denyCode === 'read-only-command-denied');
    expect(readOnlyRequests).toHaveLength(1);
    expect(readOnlyRequests[0].requestId).toBe('permission-1111111111111111');
    expect(requests.some(request => request.denyCode === 'sandbox-unavailable')).toBe(true);
  });

  it('lets the queen approve, deny, or halt permission requests through the same durable lifecycle', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-permission-session', ownerClientKind: 'claude' });
    hive.workers = ['approve', 'deny', 'halt'].map((suffix, index) => {
      const workerId = `permission-worker-${suffix}`;
      const agentId = `permission-agent-${suffix}`;
      mockAgentState.store.agents[agentId] = {
        ...makeAgent(agentId, 'worker'),
        ownerSessionId: 'claude-permission-session',
        ownerClientKind: 'claude',
      };
      return {
        workerId,
        agentId,
        role: `role-${index}`,
        provider: 'codex-cli',
        status: 'idle' as const,
        spawnedAt: new Date(0).toISOString(),
      };
    });
    hive.budget.workersAllocated = hive.workers.length;
    saveHive(hive.hiveId, hive);

    const lines = hive.workers.map(worker => JSON.stringify({
      kind: 'worker-permission-denial',
      requestId: `permission-test-${worker.role}`,
      taskId: `task-${worker.role}`,
      ts: new Date(0).toISOString(),
      agentId: worker.agentId,
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_shell',
      denyReason: 'sandbox-unavailable:no-verified-backend',
      denyCode: 'sandbox-unavailable',
    }));
    writeFileSync(join(root, '.hive-flow', 'hives', hive.hiveId, 'permission-requests.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    const listed = await getQueenTool('queen_permission_requests').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      status: 'all',
    }) as Record<string, unknown>;
    expect(listed.success).toBe(true);
    expect(listed.requestCount).toBe(3);

    const denyWithoutGuidance = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-role-1',
      decision: 'deny',
      reason: 'Use available read-only tools instead.',
    }) as Record<string, unknown>;
    expect(denyWithoutGuidance.success).toBe(false);
    expect(String(denyWithoutGuidance.error)).toContain('requires guidance');

    const approve = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-role-0',
      decision: 'approve',
      reason: 'Queen records approval, but does not bypass sandbox gates.',
    }) as Record<string, unknown>;
    expect(approve).toMatchObject({
      success: true,
      status: 'approved',
      approvalEffect: 'recorded; does not bypass sandbox, source, or control-plane gates',
    });

    const deny = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-role-1',
      decision: 'deny',
      reason: 'Use available read-only tools instead.',
      guidance: 'Continue with read_file/list_directory and report the blocked command as a limitation instead of retrying run_shell.',
    }) as Record<string, unknown>;
    expect(deny).toMatchObject({
      success: true,
      status: 'denied',
      guidance: 'Continue with read_file/list_directory and report the blocked command as a limitation instead of retrying run_shell.',
      redirectionInstructions: 'Continue with read_file/list_directory and report the blocked command as a limitation instead of retrying run_shell.',
      // P2-SH7 (hive-flow-8119): deny now RESUMES the live worker (continue without the action).
      workerResumed: true,
    });

    const halt = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      requestId: 'permission-test-role-2',
      decision: 'halt',
      reason: 'Repeated unsafe execution attempt.',
    }) as Record<string, unknown>;
    expect(halt).toMatchObject({ success: true, status: 'halted' });
    // deny dispatched exactly one worker-resume task; approve/halt dispatch none.
    expect(mockAgentState.calls.task).toBe(1);
    expect(mockAgentState.calls.terminate).toBe(1);

    const persisted = loadHive(hive.hiveId)!;
    const statuses = new Map(persisted.permissionRequests?.map(request => [request.requestId, request.status]));
    expect(statuses.get('permission-test-role-0')).toBe('approved');
    expect(statuses.get('permission-test-role-1')).toBe('denied');
    expect(statuses.get('permission-test-role-2')).toBe('halted');
    const denied = persisted.permissionRequests?.find(request => request.requestId === 'permission-test-role-1');
    expect(denied?.decision?.guidance).toBe('Continue with read_file/list_directory and report the blocked command as a limitation instead of retrying run_shell.');
    expect(persisted.workers.find(worker => worker.workerId === 'permission-worker-halt')?.status).toBe('terminated');
    expect(existsSync(join(root, '.hive-flow', 'data', 'pending-notifications.jsonl'))).toBe(false);
    expect(existsSync(join(hiveHome, 'wake'))).toBe(false);
  });

  it('rejects permission review or decisions from a non-owning queen', async () => {
    const hive = createActiveHive({ ownerSessionId: 'claude-permission-session', ownerClientKind: 'claude' });
    writeFileSync(join(root, '.hive-flow', 'hives', hive.hiveId, 'permission-requests.jsonl'), `${JSON.stringify({
      kind: 'worker-permission-denial',
      requestId: 'permission-cross-queen',
      taskId: 'task-cross-queen',
      ts: new Date(0).toISOString(),
      agentId: 'worker-agent-1',
      hiveId: hive.hiveId,
      queenId: hive.queenId,
      tool: 'run_command',
      denyReason: 'blocked',
      denyCode: 'blocked',
    })}\n`, 'utf8');

    const listResult = await getQueenTool('queen_permission_requests').handler({
      hiveId: hive.hiveId,
      queenId: 'wrong-queen',
    }) as Record<string, unknown>;
    expect(listResult.success).toBe(false);
    expect(String(listResult.error)).toContain("does not own hive");

    const decideResult = await getQueenTool('queen_permission_decide').handler({
      hiveId: hive.hiveId,
      queenId: 'wrong-queen',
      requestId: 'permission-cross-queen',
      decision: 'redirect',
      redirectTask: 'try something else',
    }) as Record<string, unknown>;
    expect(decideResult.success).toBe(false);
    expect(String(decideResult.error)).toContain("does not own hive");
    expect(mockAgentState.calls.task).toBe(0);
    expect(mockAgentState.calls.terminate).toBe(0);

    const persisted = loadHive(hive.hiveId)!;
    expect(persisted.permissionRequests).toBeUndefined();
    expect(existsSync(join(root, '.hive-flow', 'data', 'pending-notifications.jsonl'))).toBe(false);
    expect(existsSync(join(hiveHome, 'wake'))).toBe(false);
  });

  it('statically keeps every in-process dispatch sink behind assertDispatchAllowed', () => {
    const queenSource = readFileSync(join(cliPackageRoot, 'src/mcp-tools/queen-tools.ts'), 'utf8');
    const hiveMindSource = readFileSync(join(cliPackageRoot, 'src/mcp-tools/hive-mind-tools.ts'), 'utf8');
    const headlessWorkerSource = readFileSync(join(cliPackageRoot, 'src/services/headless-worker-executor.ts'), 'utf8');

    expect(queenSource).toMatch(/function callAgentSpawn[\s\S]*assertDispatchAllowed\('agent_spawn'\)[\s\S]*spawnTool\.handler/);
    expect(queenSource).toMatch(/function callAgentTask[\s\S]*assertDispatchAllowed\('agent_task'\)[\s\S]*taskTool\.handler/);
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
