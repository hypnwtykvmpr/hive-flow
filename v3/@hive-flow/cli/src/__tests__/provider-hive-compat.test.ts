import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock agent-tools to control loadAgentStore, saveAgentStore, withStoreLock, and agentTools
vi.mock('../mcp-tools/agent-tools.js', () => ({
  loadAgentStore: vi.fn(),
  saveAgentStore: vi.fn(),
  withStoreLock: vi.fn(async (fnOrScope: unknown, maybeFn?: unknown) => {
    const fn = typeof fnOrScope === 'function' ? fnOrScope : maybeFn;
    return (fn as () => unknown)();
  }),
  agentTools: [] as Array<{ name: string; handler: (input: Record<string, unknown>) => unknown }>,
}));

vi.mock('../mcp-tools/mcp-enforcement-gate.js', () => ({
  assertDispatchAllowed: vi.fn(() => ({ allowed: true, risk: 3 })),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadAgentStore, saveAgentStore, agentTools } from '../mcp-tools/agent-tools.js';
import { hiveMindTools } from '../mcp-tools/hive-mind-tools.js';

// ── Helpers ──────────────────────────────────────────────────────────────

type AnyResult = Record<string, unknown>;

/** Shape of a HiveWorker in status output. */
interface HiveWorkerView {
  id: string;
  provider?: string;
  model?: string;
  role?: string;
  status?: string;
}

/** Shape of a consensus execution result entry. */
interface ConsensusResultEntry {
  provider?: string;
  status?: string;
  error?: string;
  vote?: boolean;
}

/** Shape of a consensus proposal stored in state. */
interface ConsensusProposal {
  proposalId: string;
  type: string;
  value: Record<string, unknown>;
  proposedBy: string;
  proposedAt: string;
  votes: Record<string, unknown>;
  status: string;
}

/** Shape of a tool entry in agentTools. */
interface AgentToolEntry {
  name: string;
  handler: (input: Record<string, unknown>) => unknown;
}

/** Find a tool by name from the hiveMindTools array. */
function getTool(name: string) {
  const tool = hiveMindTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in hiveMindTools`);
  return tool;
}

/** Default empty hive state (not initialized). */
function makeDefaultHiveState() {
  return {
    initialized: false,
    topology: 'mesh',
    workers: [] as unknown[],
    consensus: { pending: [] as ConsensusProposal[], history: [] as ConsensusProposal[] },
    sharedMemory: {},
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

/** Initialized hive state with optional overrides. */
function makeHiveState(overrides: Record<string, unknown> = {}) {
  return {
    ...makeDefaultHiveState(),
    initialized: true,
    queen: { agentId: 'queen-1', electedAt: '2025-01-01T00:00:00.000Z', term: 1 },
    ...overrides,
  };
}

/**
 * Set up fs mocks so loadHiveState reads from / saveHiveState writes to
 * a captured state object. Also sets up agent store mocks.
 */
function setupFsMocks(
  hiveState: Record<string, unknown> | null = null,
  agentStoreData: Record<string, unknown> = { agents: {}, version: '3.0.0' },
) {
  let currentHiveState = hiveState ? JSON.parse(JSON.stringify(hiveState)) : null;
  const capturedAgentStore = JSON.parse(JSON.stringify(agentStoreData));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.includes('hive-mind') && p.endsWith('state.json')) {
      return currentHiveState !== null;
    }
    if (typeof p === 'string' && p.includes('agents') && p.endsWith('store.json')) {
      return true;
    }
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.includes('hive-mind') && p.endsWith('state.json')) {
      return JSON.stringify(currentHiveState);
    }
    throw new Error(`ENOENT: no such file '${p}'`);
  });

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      if (typeof _path === 'string' && _path.includes('state.json')) {
        currentHiveState = JSON.parse(data);
      }
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  // Agent store mocks
  (loadAgentStore as ReturnType<typeof vi.fn>).mockReturnValue(capturedAgentStore);
  (saveAgentStore as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getHiveState: () => currentHiveState,
    getAgentStore: () => capturedAgentStore,
    getSaveAgentStoreCalls: () => (saveAgentStore as ReturnType<typeof vi.fn>).mock.calls,
  };
}

/**
 * Set the agentTools array to include mock agent_task (dispatch) and
 * agent_task_result (poll) handlers that together simulate the non-blocking
 * dispatch + poll pattern used by hive-mind consensus execute.
 *
 * The `resultFactory` is called with the dispatched input to produce the
 * completed result, exactly as the old synchronous handler would have returned.
 */
let _dispatchCallTracker: ReturnType<typeof vi.fn> | null = null;

function setMockAgentTask(resultFactory: (input: Record<string, unknown>) => unknown) {
  // Wrap resultFactory in a vi.fn so tests can assert call counts / args
  const dispatchSpy = vi.fn();
  _dispatchCallTracker = dispatchSpy;

  // Pending completed results keyed by taskId
  const completedResults = new Map<string, unknown>();
  let taskCounter = 0;

  (agentTools as AgentToolEntry[]).length = 0;

  // agent_task: non-blocking dispatch — returns immediately with taskId
  (agentTools as AgentToolEntry[]).push({
    name: 'agent_task',
    handler: async (input: Record<string, unknown>) => {
      dispatchSpy(input);
      const taskId = `mock-task-${++taskCounter}`;
      // Resolve the result immediately (simulates bridge completing before poll)
      try {
        const result = await Promise.resolve(resultFactory(input));
        completedResults.set(taskId, result);
      } catch (err) {
        // Dispatch itself failed — return failure so hive-mind sees it as dispatch error
        return { success: false, agentId: input.agentId, error: String((err as Error).message ?? err) };
      }
      return { success: true, taskId, agentId: input.agentId, status: 'running', pid: 99999 };
    },
  });

  // agent_task_result: returns the pre-computed result
  (agentTools as AgentToolEntry[]).push({
    name: 'agent_task_result',
    handler: async (input: Record<string, unknown>) => {
      const taskId = input.taskId as string;
      const result = completedResults.get(taskId);
      if (result !== undefined) {
        return { success: true, taskId, status: 'completed', result };
      }
      return { success: true, taskId, status: 'running' };
    },
  });
}

function clearMockAgentTask() {
  (agentTools as AgentToolEntry[]).length = 0;
  _dispatchCallTracker = null;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Provider-Hive Compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockAgentTask();
  });

  // ====================================================================
  // 1. Agent store unification
  // ====================================================================

  describe('Agent store unification', () => {
    it('hive-mind spawn writes to canonical store (agents/store.json)', async () => {
      const { getSaveAgentStoreCalls } = setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      await spawnTool.handler({ count: 1, agentType: 'implementer', prefix: 'test' });

      expect(saveAgentStore).toHaveBeenCalled();
      const calls = getSaveAgentStoreCalls();
      expect(calls.length).toBe(1);
      const store = calls[0][0];
      const agentIds = Object.keys(store.agents);
      expect(agentIds.length).toBe(1);
      expect(agentIds[0]).toMatch(/^test-/);
      expect(store.agents[agentIds[0]].agentType).toBe('implementer');
    });

    it('hive-mind spawn rejects removed agent aliases before writing the canonical store', async () => {
      const { getSaveAgentStoreCalls } = setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({ count: 1, agentType: 'worker', prefix: 'test' }) as AnyResult;

      expect(result).toMatchObject({
        success: false,
        code: 'invalid-agent-type',
      });
      expect(String(result.error)).toContain('Valid agent types:');
      expect(getSaveAgentStoreCalls()).toHaveLength(0);
    });

    it('consensus execute finds provider metadata in canonical store', async () => {
      const state = makeHiveState({
        workers: [
          { agentId: 'agent-gemini-1', provider: 'gemini-cli', model: 'gemini-3.1-pro-preview', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
        consensus: {
          pending: [
            { proposalId: 'prop-1', type: 'review', value: {}, proposedBy: 'system', proposedAt: '2025-01-01T00:00:00.000Z', votes: {}, status: 'pending' },
          ],
          history: [],
        },
      });

      setupFsMocks(state, {
        agents: {
          'agent-gemini-1': { agentId: 'agent-gemini-1', provider: 'gemini-cli', resolvedModel: 'gemini-3.1-pro-preview', status: 'idle' },
        },
        version: '3.0.0',
      });

      setMockAgentTask(async () => ({ success: true, content: 'I approve this change. LGTM.' }));

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute',
        proposalId: 'prop-1',
        task: 'Review the code',
      }) as AnyResult;

      expect(result.evaluated).toBe(1);
      const results = result.results as ConsensusResultEntry[];
      expect(results[0].provider).toBe('gemini-cli');
    });
  });

  // ====================================================================
  // 2. HiveWorker migration
  // ====================================================================

  describe('HiveWorker migration', () => {
    it('migrates pure string[] to HiveWorker[]', async () => {
      const state = makeHiveState({
        workers: ['agent-1', 'agent-2'],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(2);
      expect(workers[0].id).toBe('agent-1');
      expect(workers[1].id).toBe('agent-2');
    });

    it('preserves pure HiveWorker[] unchanged', async () => {
      const state = makeHiveState({
        workers: [
          { agentId: 'w1', provider: 'gemini-cli', model: 'gemini-3.1-pro-preview', role: 'specialist', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
          { agentId: 'w2', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'busy' },
        ],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(2);
      expect(workers[0].id).toBe('w1');
      expect(workers[0].provider).toBe('gemini-cli');
      expect(workers[0].model).toBe('gemini-3.1-pro-preview');
      expect(workers[1].id).toBe('w2');
    });

    it('handles mixed array (strings + objects)', async () => {
      const state = makeHiveState({
        workers: [
          'string-agent',
          { agentId: 'obj-agent', role: 'specialist', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(2);
      expect(workers[0].id).toBe('string-agent');
      expect(workers[1].id).toBe('obj-agent');
      expect(workers[1].role).toBe('specialist');
    });

    it('filters empty/whitespace strings', async () => {
      const state = makeHiveState({
        workers: ['', '  ', 'valid-agent', '\t'],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(1);
      expect(workers[0].id).toBe('valid-agent');
    });

    it('deduplicates by agentId', async () => {
      const state = makeHiveState({
        workers: ['agent-dup', 'agent-dup', 'agent-unique'],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(2);
      const ids = workers.map((w) => w.id);
      expect(ids).toContain('agent-dup');
      expect(ids).toContain('agent-unique');
    });

    it('skips null/number/malformed elements', async () => {
      const state = makeHiveState({
        workers: [null, 42, true, 'valid-agent', undefined],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(1);
      expect(workers[0].id).toBe('valid-agent');
    });

    it('skips objects without agentId', async () => {
      const state = makeHiveState({
        workers: [
          { role: 'worker', status: 'idle' },
          { agentId: 'real-agent', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(1);
      expect(workers[0].id).toBe('real-agent');
    });

    it('preserves provider/model on existing HiveWorker objects', async () => {
      const state = makeHiveState({
        workers: [
          { agentId: 'cursor-w', provider: 'cursor-cli', model: 'auto', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers[0].provider).toBe('cursor-cli');
      expect(workers[0].model).toBe('auto');
    });

    it('idempotent (migrating twice = same result)', async () => {
      const state = makeHiveState({
        workers: ['agent-a', { agentId: 'agent-b', role: 'scout', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' }],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');

      // First load triggers migration
      const result1 = await statusTool.handler({}) as AnyResult;
      const workers1 = result1.workers as HiveWorkerView[];

      // Second load reads already-migrated data (via the saved state)
      const result2 = await statusTool.handler({}) as AnyResult;
      const workers2 = result2.workers as HiveWorkerView[];

      expect(workers1).toHaveLength(workers2.length);
      expect(workers1.map((w) => w.id)).toEqual(workers2.map((w) => w.id));
    });

    it('handles empty array', async () => {
      const state = makeHiveState({ workers: [] });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({}) as AnyResult;

      expect((result.workers as HiveWorkerView[]).length).toBe(0);
    });
  });

  // ====================================================================
  // 3. Provider-aware spawn
  // ====================================================================

  describe('Provider-aware spawn', () => {
    it('spawns with gemini-cli provider', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 1, agentType: 'verifier', prefix: 'gem',
        provider: 'gemini-cli', model: 'gemini-3.1-pro-preview',
      }) as AnyResult;

      expect(result.success).toBe(true);
      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(1);
      expect(workers[0].provider).toBe('gemini-cli');
      expect(workers[0].model).toBe('gemini-3.1-pro-preview');
    });

    it('spawns with codex-cli provider', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 1, agentType: 'implementer', prefix: 'codex',
        provider: 'codex-cli', model: 'gpt-5.5',
      }) as AnyResult;

      expect(result.success).toBe(true);
      const workers = result.workers as HiveWorkerView[];
      expect(workers[0].provider).toBe('codex-cli');
      expect(workers[0].model).toBe('gpt-5.5');
    });

    it('spawns with cursor-cli provider', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 1, agentType: 'verifier', prefix: 'cur',
        provider: 'cursor-cli', model: 'auto',
      }) as AnyResult;

      expect(result.success).toBe(true);
      const workers = result.workers as HiveWorkerView[];
      expect(workers[0].provider).toBe('cursor-cli');
      expect(workers[0].model).toBe('auto');
    });

    it('spawns with deepseek provider', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 1, agentType: 'researcher', prefix: 'deepseek',
        provider: 'deepseek', model: 'deepseek-v4-pro',
      }) as AnyResult;

      expect(result.success).toBe(true);
      const workers = result.workers as HiveWorkerView[];
      expect(workers[0].provider).toBe('deepseek');
      expect(workers[0].model).toBe('deepseek-v4-pro');
    });

    it('spawns without provider (backward compat)', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 1, agentType: 'implementer', prefix: 'local',
      }) as AnyResult;

      expect(result.success).toBe(true);
      const workers = result.workers as HiveWorkerView[];
      expect(workers[0].provider).toBeUndefined();
      expect(workers[0].model).toBeUndefined();
    });
  });

  // ====================================================================
  // 4. Provider-aware join
  // ====================================================================

  describe('Provider-aware join', () => {
    it('join with explicit provider stores in HiveWorker', async () => {
      setupFsMocks(makeHiveState());
      const joinTool = getTool('hive-mind_join');

      const result = await joinTool.handler({
        agentId: 'ext-agent-1',
        provider: 'gemini-cli',
        model: 'gemini-3.1-pro-preview',
        role: 'specialist',
      }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.provider).toBe('gemini-cli');
      expect(result.model).toBe('gemini-3.1-pro-preview');
      expect(result.role).toBe('specialist');
    });

    it('join without provider auto-lookups from agent store', async () => {
      setupFsMocks(makeHiveState(), {
        agents: {
          'stored-agent': {
            agentId: 'stored-agent',
            provider: 'codex-cli',
            resolvedModel: 'gpt-5.5',
            status: 'idle',
          },
        },
        version: '3.0.0',
      });
      const joinTool = getTool('hive-mind_join');

      const result = await joinTool.handler({
        agentId: 'stored-agent',
      }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.provider).toBe('codex-cli');
      expect(result.model).toBe('gpt-5.5');
    });

    it('join without provider or store record creates bare HiveWorker', async () => {
      setupFsMocks(makeHiveState(), { agents: {}, version: '3.0.0' });
      const joinTool = getTool('hive-mind_join');

      const result = await joinTool.handler({
        agentId: 'bare-agent',
      }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.provider).toBeUndefined();
      expect(result.model).toBeUndefined();
    });

    it('duplicate join is idempotent', async () => {
      setupFsMocks(makeHiveState());
      const joinTool = getTool('hive-mind_join');

      const result1 = await joinTool.handler({
        agentId: 'dup-agent', provider: 'gemini-cli',
      }) as AnyResult;
      const result2 = await joinTool.handler({
        agentId: 'dup-agent', provider: 'gemini-cli',
      }) as AnyResult;

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result2.totalWorkers).toBe(1);
    });
  });

  // ====================================================================
  // 5. Pure provider hives
  // ====================================================================

  describe('Pure provider hives', () => {
    it('pure Cursor hive (2 workers)', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 2, agentType: 'verifier', prefix: 'cursor-w',
        provider: 'cursor-cli', model: 'auto',
      }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.spawned).toBe(2);
      expect(result.totalWorkers).toBe(2);
      const workers = result.workers as HiveWorkerView[];
      expect(workers.every((w) => w.provider === 'cursor-cli')).toBe(true);
    });

    it('pure Gemini hive (2 workers)', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 2, agentType: 'verifier', prefix: 'gemini-w',
        provider: 'gemini-cli', model: 'gemini-3.1-pro-preview',
      }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.spawned).toBe(2);
      const workers = result.workers as HiveWorkerView[];
      expect(workers.every((w) => w.provider === 'gemini-cli')).toBe(true);
      expect(workers.every((w) => w.model === 'gemini-3.1-pro-preview')).toBe(true);
    });

    it('pure Codex hive (2 workers)', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 2, agentType: 'implementer', prefix: 'codex-w',
        provider: 'codex-cli', model: 'gpt-5.5',
      }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.spawned).toBe(2);
      const workers = result.workers as HiveWorkerView[];
      expect(workers.every((w) => w.provider === 'codex-cli')).toBe(true);
    });

    it('pure DeepSeek hive (2 workers)', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      const result = await spawnTool.handler({
        count: 2, agentType: 'researcher', prefix: 'deepseek-w',
        provider: 'deepseek', model: 'deepseek-v4-pro',
      }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.spawned).toBe(2);
      const workers = result.workers as HiveWorkerView[];
      expect(workers.every((w) => w.provider === 'deepseek')).toBe(true);
    });
  });

  // ====================================================================
  // 6. Mixed provider hives
  // ====================================================================

  describe('Mixed provider hives', () => {
    it('sonnet + cursor mix', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      // Spawn anthropic worker
      await spawnTool.handler({ count: 1, prefix: 'sonnet', provider: 'anthropic', model: 'sonnet' });
      // Spawn cursor worker
      const result = await spawnTool.handler({ count: 1, prefix: 'cursor', provider: 'cursor-cli', model: 'auto' }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.totalWorkers).toBe(2);
    });

    it('sonnet + gemini mix', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      await spawnTool.handler({ count: 1, prefix: 'sonnet', provider: 'anthropic', model: 'sonnet' });
      const result = await spawnTool.handler({ count: 1, prefix: 'gemini', provider: 'gemini-cli', model: 'gemini-3.1-pro-preview' }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.totalWorkers).toBe(2);
    });

    it('sonnet + codex mix', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      await spawnTool.handler({ count: 1, prefix: 'sonnet', provider: 'anthropic', model: 'sonnet' });
      const result = await spawnTool.handler({ count: 1, prefix: 'codex', provider: 'codex-cli', model: 'gpt-5.5' }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.totalWorkers).toBe(2);
    });

    it('sonnet + deepseek mix', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      await spawnTool.handler({ count: 1, prefix: 'sonnet', provider: 'anthropic', model: 'sonnet' });
      const result = await spawnTool.handler({ count: 1, prefix: 'deepseek', provider: 'deepseek', model: 'deepseek-v4-pro' }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.totalWorkers).toBe(2);
    });

    it('all-provider hive (4 workers)', async () => {
      setupFsMocks(makeHiveState());
      const spawnTool = getTool('hive-mind_spawn');

      await spawnTool.handler({ count: 1, prefix: 'anthropic', provider: 'anthropic', model: 'sonnet' });
      await spawnTool.handler({ count: 1, prefix: 'cursor', provider: 'cursor-cli', model: 'auto' });
      await spawnTool.handler({ count: 1, prefix: 'gemini', provider: 'gemini-cli', model: 'gemini-3.1-pro-preview' });
      const result = await spawnTool.handler({ count: 1, prefix: 'codex', provider: 'codex-cli', model: 'gpt-5.5' }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.totalWorkers).toBe(4);
    });
  });

  // ====================================================================
  // 7. Consensus execute
  // ====================================================================

  describe('Consensus execute', () => {
    function makeExecuteState(workers: any[]) {
      return makeHiveState({
        workers,
        consensus: {
          pending: [
            {
              proposalId: 'exec-prop-1',
              type: 'code-review',
              value: { target: 'test.ts' },
              proposedBy: 'system',
              proposedAt: '2025-01-01T00:00:00.000Z',
              votes: {},
              status: 'pending',
            },
          ],
          history: [],
        },
      });
    }

    it('invokes agent_task for provider workers', async () => {
      setMockAgentTask(async () => ({ success: true, content: 'I approve.' }));

      const workers = [
        { agentId: 'prov-w1', provider: 'gemini-cli', model: 'gemini-3.1-pro-preview', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
      ];
      setupFsMocks(makeExecuteState(workers));

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'exec-prop-1', task: 'Review this code',
      }) as AnyResult;

      // The dispatch spy (_dispatchCallTracker) tracks agent_task calls
      expect(_dispatchCallTracker).toHaveBeenCalledTimes(1);
      expect(_dispatchCallTracker).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'prov-w1' }),
      );
      expect(result.evaluated).toBe(1);
    });

    it('auto-votes local workers as approve', async () => {
      setMockAgentTask(async () => ({ success: true, content: 'Approved.' }));

      const workers = [
        { agentId: 'local-w1', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        { agentId: 'prov-w1', provider: 'codex-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
      ];
      setupFsMocks(makeExecuteState(workers));

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'exec-prop-1', task: 'Review code',
      }) as AnyResult;

      // Local worker auto-approved + provider worker approved = 2 votes for
      expect(result.votesFor).toBe(2);
    });

    it('handles provider failure (skips, no vote)', async () => {
      setMockAgentTask(async () => { throw new Error('Provider timeout'); });

      const workers = [
        { agentId: 'fail-w1', provider: 'cursor-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
      ];
      setupFsMocks(makeExecuteState(workers));

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'exec-prop-1', task: 'Review code',
      }) as AnyResult;

      const results = result.results as ConsensusResultEntry[];
      expect(results[0].status).toBe('failed');
      expect(results[0].error).toContain('Provider timeout');
    });

    it('checks majority after all votes', async () => {
      setMockAgentTask(async () => ({ success: true, content: 'I approve.' }));

      // 3 workers: 2 local (auto-approve) + 1 provider (approve) = 3/3 approve
      const workers = [
        { agentId: 'local-1', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        { agentId: 'local-2', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        { agentId: 'prov-1', provider: 'gemini-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
      ];
      setupFsMocks(makeExecuteState(workers));

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'exec-prop-1', task: 'Review code',
      }) as AnyResult;

      expect(result.votesFor).toBe(3);
      expect(result.status).toBe('approved');
    });

    it('updates proposal status on rejection majority', async () => {
      setMockAgentTask(async () => ({ success: true, content: 'I reject this code. It has bugs.' }));

      // 3 workers: all provider, all reject = majority reject
      const workers = [
        { agentId: 'r1', provider: 'gemini-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        { agentId: 'r2', provider: 'codex-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        { agentId: 'r3', provider: 'cursor-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
      ];
      setupFsMocks(makeExecuteState(workers));

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'exec-prop-1', task: 'Review code',
      }) as AnyResult;

      expect(result.votesAgainst).toBe(3);
      expect(result.status).toBe('rejected');
    });

    it('zero-worker execute auto-approves with evaluated 0 (vacuous consensus)', async () => {
      const state = makeHiveState({
        workers: [],
        consensus: {
          pending: [
            { proposalId: 'zero-prop', type: 'review', value: {}, proposedBy: 'system', proposedAt: '2025-01-01T00:00:00.000Z', votes: {}, status: 'pending' },
          ],
          history: [],
        },
      });
      setupFsMocks(state);

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'zero-prop', task: 'Review code',
      }) as AnyResult;

      expect(result.evaluated).toBe(0);
      // getMajority(0) = 0, so votesFor(0) >= 0 is true → vacuous consensus = approved
      expect(result.status).toBe('approved');
    });

    it('returns error when agent_task tool is missing and provider workers exist', async () => {
      // Clear agent tools array to simulate missing agent_task
      (agentTools as AgentToolEntry[]).length = 0;

      const workers = [
        { agentId: 'no-tool-w1', provider: 'gemini-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
      ];
      setupFsMocks(makeExecuteState(workers));

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'exec-prop-1', task: 'Review code',
      }) as AnyResult;

      expect(result.error).toContain('agent_task');
    });
  });

  // ====================================================================
  // 8. Vote extraction -- Tier 1
  // ====================================================================

  describe('Vote extraction -- Tier 1', () => {
    // We test extractVoteFromResult indirectly through consensus execute
    // by controlling the mock agent_task response.

    async function executeWithResponse(response: Record<string, unknown>): Promise<boolean> {
      const taskHandler = vi.fn().mockResolvedValue(response);
      setMockAgentTask(taskHandler);

      const state = makeHiveState({
        workers: [
          { agentId: 'voter-1', provider: 'gemini-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
        consensus: {
          pending: [
            { proposalId: 'vote-test', type: 'review', value: {}, proposedBy: 'system', proposedAt: '2025-01-01T00:00:00.000Z', votes: {}, status: 'pending' },
          ],
          history: [],
        },
      });
      setupFsMocks(state);

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'vote-test', task: 'Vote',
      }) as AnyResult;

      const results = result.results as ConsensusResultEntry[];
      return results[0].vote as boolean;
    }

    it('{vote: true} -> true', async () => {
      const vote = await executeWithResponse({ vote: true });
      expect(vote).toBe(true);
    });

    it('{vote: false} -> false', async () => {
      const vote = await executeWithResponse({ vote: false });
      expect(vote).toBe(false);
    });

    it('{vote: "approve"} -> true', async () => {
      const vote = await executeWithResponse({ vote: 'approve' });
      expect(vote).toBe(true);
    });

    it('{vote: "reject"} -> false', async () => {
      const vote = await executeWithResponse({ vote: 'reject' });
      expect(vote).toBe(false);
    });

    it('nested {result: {vote: "approve"}} -> true', async () => {
      const vote = await executeWithResponse({ result: { vote: 'approve' } });
      expect(vote).toBe(true);
    });
  });

  // ====================================================================
  // 9. Vote extraction -- Tier 1.5
  // ====================================================================

  describe('Vote extraction -- Tier 1.5', () => {
    async function executeWithContent(content: string): Promise<boolean> {
      const taskHandler = vi.fn().mockResolvedValue({ success: true, content });
      setMockAgentTask(taskHandler);

      const state = makeHiveState({
        workers: [
          { agentId: 'voter-1', provider: 'codex-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
        consensus: {
          pending: [
            { proposalId: 'json-test', type: 'review', value: {}, proposedBy: 'system', proposedAt: '2025-01-01T00:00:00.000Z', votes: {}, status: 'pending' },
          ],
          history: [],
        },
      });
      setupFsMocks(state);

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'json-test', task: 'Vote',
      }) as AnyResult;

      const results = result.results as ConsensusResultEntry[];
      return results[0].vote as boolean;
    }

    it('JSON code block with approve -> true', async () => {
      const content = 'The code looks good.\n\n```json\n{"vote": "approve"}\n```';
      const vote = await executeWithContent(content);
      expect(vote).toBe(true);
    });

    it('JSON code block with reject -> false', async () => {
      const content = 'Found critical issues.\n\n```json\n{"vote": "reject"}\n```';
      const vote = await executeWithContent(content);
      expect(vote).toBe(false);
    });

    it('malformed JSON block falls through to Tier 2', async () => {
      // Malformed JSON, falls through to Tier 2 keyword matching -> "approve" keyword
      const content = 'I approve the changes.\n\n```json\n{invalid json here}\n```';
      const vote = await executeWithContent(content);
      expect(vote).toBe(true); // Falls to Tier 2, "approve" keyword matches
    });
  });

  // ====================================================================
  // 10. Vote extraction -- Tier 2
  // ====================================================================

  describe('Vote extraction -- Tier 2', () => {
    async function executeWithContent(content: string): Promise<boolean> {
      const taskHandler = vi.fn().mockResolvedValue({ success: true, content });
      setMockAgentTask(taskHandler);

      const state = makeHiveState({
        workers: [
          { agentId: 'voter-1', provider: 'cursor-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
        consensus: {
          pending: [
            { proposalId: 'kw-test', type: 'review', value: {}, proposedBy: 'system', proposedAt: '2025-01-01T00:00:00.000Z', votes: {}, status: 'pending' },
          ],
          history: [],
        },
      });
      setupFsMocks(state);

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'kw-test', task: 'Vote',
      }) as AnyResult;

      const results = result.results as ConsensusResultEntry[];
      return results[0].vote as boolean;
    }

    it('"I approve" -> true', async () => {
      const vote = await executeWithContent('I approve this implementation. Looks clean.');
      expect(vote).toBe(true);
    });

    it('"I reject" -> false', async () => {
      const vote = await executeWithContent('I reject this implementation. Too many issues.');
      expect(vote).toBe(false);
    });

    it('reject-first: both keywords -> false', async () => {
      // Both "approve" and "reject" present -> reject wins (reject-first precedence)
      const vote = await executeWithContent('I cannot approve this. I reject due to security issues.');
      expect(vote).toBe(false);
    });

    it('"LGTM" -> true', async () => {
      const vote = await executeWithContent('LGTM, ship it!');
      expect(vote).toBe(true);
    });

    it('word boundary: "passphrase" does NOT trigger approve', async () => {
      // "passphrase" contains "pass" but "pass" is excluded from keywords
      // The text has no approve/reject keywords, so defaults to true
      const vote = await executeWithContent('The passphrase handling needs a minor tweak.');
      expect(vote).toBe(true); // Default: approve (no keywords matched)
    });

    it('empty response -> true (default)', async () => {
      const vote = await executeWithContent('');
      expect(vote).toBe(true);
    });

    it('{success: false} -> failed (no vote)', async () => {
      setMockAgentTask(async () => ({ success: false, error: 'Provider down' }));

      const state = makeHiveState({
        workers: [
          { agentId: 'voter-1', provider: 'gemini-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
        consensus: {
          pending: [
            { proposalId: 'fail-test', type: 'review', value: {}, proposedBy: 'system', proposedAt: '2025-01-01T00:00:00.000Z', votes: {}, status: 'pending' },
          ],
          history: [],
        },
      });
      setupFsMocks(state);

      const consensusTool = getTool('hive-mind_consensus');
      const result = await consensusTool.handler({
        action: 'execute', proposalId: 'fail-test', task: 'Vote',
      }) as AnyResult;

      const results = result.results as ConsensusResultEntry[];
      expect(results[0].status).toBe('failed');
      expect(results[0].error).toContain('Provider down');
    });
  });

  // ====================================================================
  // 11. Status/shutdown with providers
  // ====================================================================

  describe('Status/shutdown with providers', () => {
    it('status includes provider per worker', async () => {
      const state = makeHiveState({
        workers: [
          { agentId: 'w1', provider: 'gemini-cli', model: 'gemini-3.1-pro-preview', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
          { agentId: 'w2', provider: 'codex-cli', model: 'gpt-5.5', role: 'specialist', joinedAt: '2025-01-01T00:00:00.000Z', status: 'busy' },
          { agentId: 'w3', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
      });
      setupFsMocks(state);

      const statusTool = getTool('hive-mind_status');
      const result = await statusTool.handler({ verbose: true }) as AnyResult;

      const workers = result.workers as HiveWorkerView[];
      expect(workers).toHaveLength(3);
      expect(workers[0].provider).toBe('gemini-cli');
      expect(workers[0].model).toBe('gemini-3.1-pro-preview');
      expect(workers[1].provider).toBe('codex-cli');
      expect(workers[1].model).toBe('gpt-5.5');
      expect(workers[2].provider).toBeUndefined();
    });

    it('shutdown cleans up from canonical store', async () => {
      const state = makeHiveState({
        workers: [
          { agentId: 'shut-w1', provider: 'gemini-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
          { agentId: 'shut-w2', provider: 'codex-cli', role: 'worker', joinedAt: '2025-01-01T00:00:00.000Z', status: 'idle' },
        ],
      });
      const { getAgentStore } = setupFsMocks(state, {
        agents: {
          'shut-w1': { agentId: 'shut-w1', provider: 'gemini-cli', status: 'idle' },
          'shut-w2': { agentId: 'shut-w2', provider: 'codex-cli', status: 'idle' },
          'other-agent': { agentId: 'other-agent', status: 'idle' },
        },
        version: '3.0.0',
      });

      const shutdownTool = getTool('hive-mind_shutdown');
      const result = await shutdownTool.handler({ force: true }) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.workersTerminated).toBe(2);

      // Canonical store should have hive workers deleted but keep other agents
      expect(saveAgentStore).toHaveBeenCalled();
      const storeArg = (saveAgentStore as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(storeArg.agents['shut-w1']).toBeUndefined();
      expect(storeArg.agents['shut-w2']).toBeUndefined();
      expect(storeArg.agents['other-agent']).toBeDefined();
    });
  });
});
