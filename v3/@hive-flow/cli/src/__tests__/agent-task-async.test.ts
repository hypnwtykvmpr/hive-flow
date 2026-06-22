import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (must be hoisted before imports) ──────────────────────────

// Mock node:fs — controls existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync
vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmdirSync: vi.fn(),
  rmSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock node:child_process — controls spawn (used for async bridge)
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// Mock node:url — fileURLToPath returns a deterministic directory
vi.mock('node:url', () => ({
  fileURLToPath: vi.fn(() => '/fake/dist/src/mcp-tools/agent-tools.js'),
}));

// Stub out the model-router dynamic imports so agent_spawn doesn't break
vi.mock('../hivector/model-router.js', () => ({
  getModelRouter: () => null,
}));
vi.mock('../hivector/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: () => ({
    route: async () => ({ model: 'sonnet', tier: 3, canSkipLLM: false }),
  }),
}));

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmdirSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { agentTools } from '../mcp-tools/agent-tools.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Bridge path computed from the mocked fileURLToPath */
// fileURLToPath returns '/fake/dist/src/mcp-tools/agent-tools.js'
// dirname  => '/fake/dist/src/mcp-tools'
// join('/fake/dist/src/mcp-tools', '..', '..', '..', '..', 'providers', 'scripts', 'provider-agent-bridge.mjs')
// => '/providers/scripts/provider-agent-bridge.mjs'
const EXPECTED_BRIDGE_PATH = '/providers/scripts/provider-agent-bridge.mjs';

interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  idleSince?: string;
  terminatedAt?: string;
  provider?: string;
  model?: string;
  ownerSessionId?: string;
  ownerClientKind?: string;
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'test-agent-1',
    agentType: 'coder',
    status: 'idle',
    health: 1.0,
    taskCount: 0,
    config: {},
    createdAt: new Date().toISOString(),
    provider: 'gemini-cli',
    model: 'sonnet',
    ownerSessionId: 'owner-session',
    ownerClientKind: 'codex',
    ...overrides,
  };
}

function makeStore(agents: Record<string, AgentRecord> = {}) {
  return { agents, version: '3.0.0' };
}

/**
 * Configure the fs mocks so that loadAgentStore() returns the given store
 * and saveAgentStore() is a no-op, with atomic-write support.
 */
function setupStoreMocks(initialStore: ReturnType<typeof makeStore>) {
  let currentStore = JSON.parse(JSON.stringify(initialStore));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) return true;
    if (p === EXPECTED_BRIDGE_PATH) return true;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
    return JSON.stringify(currentStore);
  });

  const tmpWrites = new Map<string, string>();

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (path: string, data: string) => {
      if (typeof path === 'string' && path.includes('.tmp.')) {
        tmpWrites.set(path, data);
      } else {
        // Ignore non-JSON data (e.g. task file writes)
        try { currentStore = JSON.parse(data); } catch { /* not the store */ }
      }
    },
  );

  (renameSync as ReturnType<typeof vi.fn>).mockImplementation(
    (src: string, _dest: string) => {
      const data = tmpWrites.get(src);
      if (data) {
        currentStore = JSON.parse(data);
        tmpWrites.delete(src);
      }
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedStore: () => currentStore as ReturnType<typeof makeStore>,
  };
}

/** Find tool handlers */
const asyncTool = agentTools.find((t) => t.name === 'agent_task_async')!;
const resultTool = agentTools.find((t) => t.name === 'agent_task_result')!;
const terminateTool = agentTools.find((t) => t.name === 'agent_terminate')!;

const asyncHandler = asyncTool.handler;
const resultHandler = resultTool.handler;
const terminateHandler = terminateTool.handler;

/**
 * Mock spawn to return a detached-style child with only pid and unref()
 * (agent_task_async uses detached: true, stdio: 'ignore' — no stdin/stdout/stderr).
 */
function mockDetachedSpawn(pid: number = 12345) {
  (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    pid,
    on: vi.fn(),
    unref: vi.fn(),
  }));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('agent_task_async handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // 1. Happy path: returns success with taskId, agentId, status, pid
  // ------------------------------------------------------------------
  it('returns success with taskId, agentId, status:running, and pid on happy path', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));
    mockDetachedSpawn(12345);

    const result = await asyncHandler({ agentId: agent.agentId, task: 'do some work' }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(typeof result.taskId).toBe('string');
    expect((result.taskId as string).startsWith('task-')).toBe(true);
    expect(result.agentId).toBe(agent.agentId);
    expect(result.status).toBe('running');
    expect(result.pid).toBe(12345);
  });

  // ------------------------------------------------------------------
  // 2. Agent is set to busy during dispatch
  // ------------------------------------------------------------------
  it('sets agent status to busy when task is dispatched', async () => {
    const agent = makeAgent({ status: 'idle' });
    const { getPersistedStore } = setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    let statusDuringSpawn: string | undefined;
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      statusDuringSpawn = getPersistedStore().agents[agent.agentId].status;
      return { pid: 12345, on: vi.fn(), unref: vi.fn() };
    });

    await asyncHandler({ agentId: agent.agentId, task: 'background work' });

    expect(statusDuringSpawn).toBe('busy');
  });

  // ------------------------------------------------------------------
  // 3. Rejects agent that is already busy
  // ------------------------------------------------------------------
  it('returns error when agent is already busy', async () => {
    const agent = makeAgent({ status: 'busy' });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const result = await asyncHandler({ agentId: agent.agentId, task: 'another task' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.agentId).toBe(agent.agentId);
    expect(result.error).toMatch(/cannot accept tasks in current state/i);
  });

  // ------------------------------------------------------------------
  // 4. Creates .task file and .json tracking file
  // ------------------------------------------------------------------
  it('writes a .task file and a .json tracking file', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));
    mockDetachedSpawn(99);

    await asyncHandler({ agentId: agent.agentId, task: 'the task text' });

    const writeCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls;

    // At least one call with a .task path
    const taskFileCall = writeCalls.find(([p]: [string]) => typeof p === 'string' && p.endsWith('.task'));
    expect(taskFileCall).toBeDefined();
    expect(taskFileCall![1]).toBe('the task text');

    // At least one call with a .json path (tracking file)
    const trackingCall = writeCalls.find(([p]: [string]) => typeof p === 'string' && p.endsWith('.json') && !p.endsWith('store.json') && !p.includes('.tmp.'));
    expect(trackingCall).toBeDefined();
    const tracking = JSON.parse(trackingCall![1]);
    expect(tracking.status).toBe('running');
    expect(tracking.agentId).toBe(agent.agentId);
    expect(typeof tracking.taskId).toBe('string');
    expect(tracking.ownerSessionId).toBe(agent.ownerSessionId);
    expect(tracking.ownerClientKind).toBe(agent.ownerClientKind);
    expect(tracking.pid).toBe(99);
  });

  it('passes --agent-token from the stored spawn token to the bridge process', async () => {
    const agent = makeAgent({
      config: { _spawnToken: 'spawn-token-123' },
    });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));
    mockDetachedSpawn(12345);

    await asyncHandler({ agentId: agent.agentId, task: 'do some work' });

    const [, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const tokenArgIndex = args.indexOf('--agent-token');

    expect(tokenArgIndex).toBeGreaterThan(-1);
    expect(args[tokenArgIndex + 1]).toBe('spawn-token-123');
  });

  it('passes persisted owner session and client kind to the bridge process env', async () => {
    const agent = makeAgent({
      ownerSessionId: 'codex-owner-session',
      ownerClientKind: 'codex',
    });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));
    mockDetachedSpawn(12345);
    process.env.CLAUDE_SESSION_ID = 'wrong-claude-session';
    process.env.HIVE_FLOW_CLIENT_KIND = 'claude-code';

    try {
      const result = await asyncHandler({ agentId: agent.agentId, task: 'do some work' }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      const [, , options] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(options.env.HIVE_FLOW_SESSION_ID).toBe('codex-owner-session');
      expect(options.env.HIVE_FLOW_CLIENT_KIND).toBe('codex');
      expect(options.env.CODEX_SESSION_ID).toBe('codex-owner-session');
      expect(options.env.CLAUDE_SESSION_ID).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.HIVE_FLOW_CLIENT_KIND;
    }
  });

  it('refuses to dispatch legacy ownerless agents before spawning the bridge', async () => {
    const agent = makeAgent({ ownerSessionId: undefined });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const result = await asyncHandler({ agentId: agent.agentId, task: 'do some work' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringMatching(/missing ownerSessionId/i),
    });
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('refuses to dispatch agents without an owner client kind before spawning the bridge', async () => {
    const agent = makeAgent({ ownerClientKind: undefined });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const result = await asyncHandler({ agentId: agent.agentId, task: 'do some work' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringMatching(/missing ownerClientKind/i),
    });
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // 5. Rejects when agent does not exist
  // ------------------------------------------------------------------
  it('returns error when agent is not found', async () => {
    setupStoreMocks(makeStore({}));

    const result = await asyncHandler({ agentId: 'nonexistent-agent', task: 'do work' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.agentId).toBe('nonexistent-agent');
    expect(result.error).toBe('Agent not found');
  });

  // ------------------------------------------------------------------
  // 6. Rejects agent with no provider
  // ------------------------------------------------------------------
  it('returns error when agent has no provider', async () => {
    const agent = makeAgent({ provider: undefined });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const result = await asyncHandler({ agentId: agent.agentId, task: 'do work' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.agentId).toBe(agent.agentId);
    expect(result.error).toMatch(/no provider/i);
  });

  // ------------------------------------------------------------------
  // 7. spawn is called with detached:true
  // ------------------------------------------------------------------
  it('invokes spawn with detached:true and calls unref() on the child', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const mockUnref = vi.fn();
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      pid: 42,
      on: vi.fn(),
      unref: mockUnref,
    }));

    await asyncHandler({ agentId: agent.agentId, task: 'detached task' });

    const spawnCalls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(spawnCalls.length).toBeGreaterThan(0);
    const opts = spawnCalls[0][2] as Record<string, unknown>;
    expect(opts.detached).toBe(true);
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // AL3: Defense-in-depth — re-validate persisted agent.model at dispatch
  // ------------------------------------------------------------------
  it('rejects an agent with legacy persisted model "haiku" before bridge dispatch', async () => {
    // Spec: checkModelEnforcement at agent_spawn blocks haiku, but a legacy
    // persisted agent record with model: 'haiku' would otherwise slip through
    // to the bridge. agent_task must re-validate at task dispatch time.
    const agent = makeAgent({
      status: 'idle',
      // Cast: 'haiku' is not in the typed AgentModel union, but persisted
      // legacy/out-of-band records can carry it.
      model: 'haiku' as unknown as AgentRecord['model'],
    });
    const { getPersistedStore } = setupStoreMocks(makeStore({ [agent.agentId]: agent }));
    mockDetachedSpawn(12345);

    const result = await asyncHandler({ agentId: agent.agentId, task: 'haiku-banned' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.agentId).toBe(agent.agentId);
    expect(typeof result.error).toBe('string');
    expect(result.error as string).toMatch(/legacy persisted model "haiku"/i);

    // Agent must remain idle (no busy transition for a rejected task).
    expect(getPersistedStore().agents[agent.agentId].status).toBe('idle');

    // Bridge must never have been spawned.
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('restores idleSince when bridge spawn fails after the busy transition', async () => {
    const agent = makeAgent({ status: 'idle' });
    const { getPersistedStore } = setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = await asyncHandler({ agentId: agent.agentId, task: 'spawn failure' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/spawn failed/i);
    expect(getPersistedStore().agents[agent.agentId].status).toBe('idle');
    expect(getPersistedStore().agents[agent.agentId].idleSince).toBeDefined();
  });
});

// ── agent_task_result tests ─────────────────────────────────────────────────

describe('agent_task_result handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Shared tracking for result tests
  const TASK_ID = 'task-1700000000000-abc123';
  const AGENT_ID = 'test-agent-result';
  const LIVE_PID = 55555;

  /** Base existsSync: store.json exists; nothing else by default */
  function baseExistsMock(extraPaths: string[] = []) {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return true;
      if (extraPaths.some((ep) => p.endsWith(ep))) return true;
      return false;
    });
  }

  /** Base readFileSync: returns the store for store.json, and tracking JSON for tracking path */
  function baseReadMock(
    store: ReturnType<typeof makeStore>,
    tracking: Record<string, unknown>,
    resultData?: Record<string, unknown>,
  ) {
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return JSON.stringify(store);
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.json`)) return JSON.stringify(tracking);
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.result.json`) && resultData) {
        return JSON.stringify(resultData);
      }
      return JSON.stringify({});
    });
  }

  function baseWriteMock() {
    (appendFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (unlinkSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  }

  // ------------------------------------------------------------------
  // 8. Returns 'running' when no result file and PID is alive
  // ------------------------------------------------------------------
  it('returns status:running when no result file exists and PID is alive', async () => {
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: LIVE_PID };

    // Only tracking file exists; no result file
    baseExistsMock([`${TASK_ID}.json`]);
    baseReadMock(makeStore({ [AGENT_ID]: agent }), tracking);
    baseWriteMock();

    // process.kill(pid, 0) with a live PID should not throw
    const origKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, sig: number | NodeJS.Signals) => {
      if (pid === LIVE_PID && sig === 0) return true;
      return origKill(pid, sig as NodeJS.Signals);
    });

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('running');
    expect(result.taskId).toBe(TASK_ID);
    expect(result.agentId).toBe(AGENT_ID);

    killSpy.mockRestore();
  });

  // ------------------------------------------------------------------
  // 9. Returns 'completed' when result file exists
  // ------------------------------------------------------------------
  it('returns status:completed with result when result file exists', async () => {
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: LIVE_PID };
    const resultData = { success: true, response: 'Task output here' };

    // Both tracking and result files exist
    baseExistsMock([`${TASK_ID}.json`, `${TASK_ID}.result.json`]);
    baseReadMock(makeStore({ [AGENT_ID]: agent }), tracking, resultData);
    baseWriteMock();

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.taskId).toBe(TASK_ID);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.result).toEqual(resultData);
  });

  it('does not read the observability journal to decide terminal result authority', async () => {
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: LIVE_PID };
    const resultData = { success: true, response: 'result json remains the authority' };

    baseExistsMock([`${TASK_ID}.json`, `${TASK_ID}.result.json`, `${TASK_ID}.events.jsonl`]);
    baseReadMock(makeStore({ [AGENT_ID]: agent }), tracking, resultData);
    baseWriteMock();

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      taskId: TASK_ID,
      agentId: AGENT_ID,
      status: 'completed',
      result: resultData,
    });
    expect((readFileSync as ReturnType<typeof vi.fn>).mock.calls.some(([path]) =>
      typeof path === 'string' && path.endsWith(`${TASK_ID}.events.jsonl`),
    )).toBe(false);
  });

  it('returns completed/alreadyConsumed when tracking was deleted but result file remains', async () => {
    const resultData = { success: true, response: 'cached terminal payload' };

    baseExistsMock([`${TASK_ID}.result.json`]);
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return JSON.stringify(makeStore({}));
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.result.json`)) return JSON.stringify(resultData);
      return JSON.stringify({});
    });
    baseWriteMock();

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      taskId: TASK_ID,
      status: 'completed',
      alreadyConsumed: true,
      result: resultData,
    });
  });

  it('marks a genuinely unknown taskId terminal so monitors stop polling', async () => {
    baseExistsMock([]);
    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return JSON.stringify(makeStore({}));
      return JSON.stringify({});
    });
    baseWriteMock();

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toBe(`Task not found: ${TASK_ID}`);
    expect(result.terminal).toBe(true);
  });

  it('first completed poll deletes tracking and second poll replays the terminal result', async () => {
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: LIVE_PID };
    const resultData = { success: true, response: 'done once, readable forever' };
    let currentStore = makeStore({ [AGENT_ID]: agent });
    const presentSuffixes = new Set([`${TASK_ID}.task`, `${TASK_ID}.json`, `${TASK_ID}.result.json`]);

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return true;
      return typeof p === 'string' && [...presentSuffixes].some((suffix) => p.endsWith(suffix));
    });

    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return JSON.stringify(currentStore);
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.json`)) return JSON.stringify(tracking);
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.result.json`)) return JSON.stringify(resultData);
      return JSON.stringify({});
    });

    const tmpWrites = new Map<string, string>();
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string, data: string) => {
      if (typeof p === 'string' && p.includes('.tmp.')) {
        tmpWrites.set(p, data);
      }
    });
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation((src: string) => {
      const data = tmpWrites.get(src);
      if (data) {
        currentStore = JSON.parse(data);
        tmpWrites.delete(src);
      }
    });
    (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (unlinkSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      for (const suffix of [...presentSuffixes]) {
        if (typeof p === 'string' && p.endsWith(suffix)) {
          presentSuffixes.delete(suffix);
        }
      }
    });

    const first = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;
    const second = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(first).toMatchObject({
      success: true,
      taskId: TASK_ID,
      agentId: AGENT_ID,
      status: 'completed',
      result: resultData,
    });
    expect(currentStore.agents[AGENT_ID].status).toBe('idle');
    expect(presentSuffixes.has(`${TASK_ID}.json`)).toBe(false);
    expect(presentSuffixes.has(`${TASK_ID}.task`)).toBe(false);
    expect(presentSuffixes.has(`${TASK_ID}.result.json`)).toBe(true);
    expect(second).toMatchObject({
      success: true,
      taskId: TASK_ID,
      status: 'completed',
      alreadyConsumed: true,
      result: resultData,
    });
  });

  // ------------------------------------------------------------------
  // 10. Returns 'failed' when PID is dead and no result file
  // ------------------------------------------------------------------
  it('returns status:failed when PID is dead and no result file', async () => {
    const DEAD_PID = 99999;
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: DEAD_PID };

    // Only tracking file exists; no result file
    baseExistsMock([`${TASK_ID}.json`]);
    baseReadMock(makeStore({ [AGENT_ID]: agent }), tracking);
    baseWriteMock();

    // Simulate dead PID: process.kill(pid, 0) throws
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, _sig: number | NodeJS.Signals) => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.taskId).toBe(TASK_ID);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.error).toMatch(/Process exited without producing a result/i);

    killSpy.mockRestore();
  });

  it('treats EPERM liveness as running instead of failing the task', async () => {
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: LIVE_PID };

    baseExistsMock([`${TASK_ID}.json`]);
    baseReadMock(makeStore({ [AGENT_ID]: agent }), tracking);
    baseWriteMock();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, _sig: number | NodeJS.Signals) => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      taskId: TASK_ID,
      agentId: AGENT_ID,
      status: 'running',
    });
    expect(writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining(`${TASK_ID}.json`),
      expect.stringContaining('"failed"'),
      expect.anything(),
    );

    killSpy.mockRestore();
  });

  it('treats ambiguous non-ESRCH liveness errors as running fail-safe', async () => {
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: LIVE_PID };

    baseExistsMock([`${TASK_ID}.json`]);
    baseReadMock(makeStore({ [AGENT_ID]: agent }), tracking);
    baseWriteMock();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, _sig: number | NodeJS.Signals) => {
      throw Object.assign(new Error('invalid signal target'), { code: 'EINVAL' });
    });

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      taskId: TASK_ID,
      agentId: AGENT_ID,
      status: 'running',
    });
    expect(writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining(`${TASK_ID}.json`),
      expect.stringContaining('"failed"'),
      expect.anything(),
    );

    killSpy.mockRestore();
  });

  // ------------------------------------------------------------------
  // 11. Resets agent to idle on completion
  // ------------------------------------------------------------------
  it('resets agent to idle when task is completed', async () => {
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const store = makeStore({ [AGENT_ID]: agent });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: LIVE_PID };
    const resultData = { success: true, response: 'done' };

    let currentStore = JSON.parse(JSON.stringify(store));

    baseExistsMock([`${TASK_ID}.json`, `${TASK_ID}.result.json`]);

    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return JSON.stringify(currentStore);
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.json`)) return JSON.stringify(tracking);
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.result.json`)) return JSON.stringify(resultData);
      return JSON.stringify({});
    });

    const tmpWrites = new Map<string, string>();
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string, data: string) => {
      if (typeof p === 'string' && p.includes('.tmp.')) {
        tmpWrites.set(p, data);
      }
      // ignore non-store writes
    });
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation((src: string) => {
      const data = tmpWrites.get(src);
      if (data) {
        try { currentStore = JSON.parse(data); } catch { /* skip */ }
        tmpWrites.delete(src);
      }
    });
    (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    await resultHandler({ taskId: TASK_ID });

    expect(currentStore.agents[AGENT_ID].status).toBe('idle');
    expect(currentStore.agents[AGENT_ID].idleSince).toBeDefined();
  });

  it('sets idleSince when a dead worker is reset back to idle', async () => {
    const DEAD_PID = 99999;
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    let currentStore = makeStore({ [AGENT_ID]: agent });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: DEAD_PID };

    baseExistsMock([`${TASK_ID}.json`]);

    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return JSON.stringify(currentStore);
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.json`)) return JSON.stringify(tracking);
      return JSON.stringify({});
    });

    const tmpWrites = new Map<string, string>();
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string, data: string) => {
      if (typeof p === 'string' && p.includes('.tmp.')) {
        tmpWrites.set(p, data);
      }
    });
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation((src: string) => {
      const data = tmpWrites.get(src);
      if (data) {
        currentStore = JSON.parse(data);
        tmpWrites.delete(src);
      }
    });
    (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, _sig: number | NodeJS.Signals) => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    await resultHandler({ taskId: TASK_ID });

    expect(currentStore.agents[AGENT_ID].status).toBe('idle');
    expect(currentStore.agents[AGENT_ID].idleSince).toBeDefined();

    killSpy.mockRestore();
  });

  it('preserves the malformed result-file contents in rawOutput for diagnostics', async () => {
    // Spec: when the bridge crashes and writes non-JSON output to the result file,
    // agent_task_result must preserve the raw contents (truncated to 2048 bytes)
    // so operators can triage segfaults, panics, or stack traces. Without this,
    // bridge crashes become opaque failures.
    const malformed = 'Segmentation fault (core dumped)\n<core trace>\n';
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    const tracking = { status: 'running', taskId: TASK_ID, agentId: AGENT_ID, startedAt: new Date().toISOString(), pid: LIVE_PID };

    // Both tracking and result files exist; result file contains malformed (non-JSON) bytes.
    baseExistsMock([`${TASK_ID}.json`, `${TASK_ID}.result.json`]);

    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return JSON.stringify(makeStore({ [AGENT_ID]: agent }));
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.result.json`)) return malformed;
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.json`)) return JSON.stringify(tracking);
      return JSON.stringify({});
    });
    baseWriteMock();

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/parse result file/i);
    expect(typeof result.rawOutput).toBe('string');
    expect(result.rawOutput).toContain('Segmentation fault');
    // Truncation enforced
    expect((result.rawOutput as string).length).toBeLessThanOrEqual(2048);
  });

  // ------------------------------------------------------------------
  // 12. Sanitizes taskId (path traversal prevention)
  // ------------------------------------------------------------------
  it('returns error for a path-traversal taskId without reading any file', async () => {
    // sanitizePathId replaces unsafe chars (/, ., \x00) with '_' and trims edges.
    // The resulting sanitized IDs will never match the tracking files that the
    // handler looks up — so existsSync returns false and the handler returns
    // { success: false, error: 'Task not found: ...' }.
    //
    // Special case: if the sanitized result is empty (all chars stripped) the
    // handler returns { success: false, error: 'Invalid taskId' } immediately.
    //
    // Either way, success must be false.
    const maliciousIds = ['../../../etc/passwd', 'task-\x00injected', '/absolute/path'];

    for (const badId of maliciousIds) {
      vi.clearAllMocks();

      // store.json exists so loadAgentStore works; tracking file does NOT exist
      // (the sanitized version of the bad ID won't match any tracked file)
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('store.json')) return true;
        return false; // no tracking file for sanitized ID
      });
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(makeStore({})));
      (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (renameSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      const result = await resultHandler({ taskId: badId }) as Record<string, unknown>;

      // Either 'Invalid taskId' (empty after sanitization) or 'Task not found'
      // (sanitized to a non-empty string that doesn't match any file)
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
    }
  });
});

// ── Parallel dispatch tests ─────────────────────────────────────────────────

describe('parallel dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // 13. 5 agents tasked simultaneously all get unique taskIds
  // ------------------------------------------------------------------
  it('assigns unique taskIds when 5 agents are dispatched concurrently', async () => {
    // Create 5 distinct idle agents
    const agents: Record<string, ReturnType<typeof makeAgent>> = {};
    for (let i = 1; i <= 5; i++) {
      const a = makeAgent({ agentId: `agent-${i}`, status: 'idle' });
      agents[a.agentId] = a;
    }

    // Shared mutable store — each agent's status must be tracked independently
    let currentStore = makeStore(agents);

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return true;
      if (p === EXPECTED_BRIDGE_PATH) return true;
      return false;
    });

    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => JSON.stringify(currentStore));

    const tmpWrites = new Map<string, string>();
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string, data: string) => {
      if (typeof p === 'string' && p.includes('.tmp.')) {
        tmpWrites.set(p, data);
      }
      // Task file and tracking file writes are ignored for the store
    });
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation((src: string) => {
      const data = tmpWrites.get(src);
      if (data) {
        try { currentStore = JSON.parse(data); } catch { /* skip */ }
        tmpWrites.delete(src);
      }
    });
    (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    let pidCounter = 10000;
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      pid: ++pidCounter,
      on: vi.fn(),
      unref: vi.fn(),
    }));

    // Dispatch all 5 concurrently
    const results = await Promise.all(
      Object.keys(agents).map((agentId) =>
        asyncHandler({ agentId, task: `task for ${agentId}` }) as Promise<Record<string, unknown>>,
      ),
    );

    // All should succeed
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.status).toBe('running');
    }

    // All taskIds must be unique strings
    const taskIds = results.map((r) => r.taskId as string);
    const unique = new Set(taskIds);
    expect(unique.size).toBe(5);

    // Each taskId must start with 'task-'
    for (const id of taskIds) {
      expect(id.startsWith('task-')).toBe(true);
    }
  });
});

// ── agent_terminate cleanup liveness tests ──────────────────────────────────

describe('agent_terminate cleanup liveness', () => {
  const TASK_ID = 'task-terminate-liveness';
  const AGENT_ID = 'terminate-agent';
  const PID = 77777;

  beforeEach(() => {
    vi.clearAllMocks();
    (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (rmdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (rmSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (unlinkSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([`${TASK_ID}.json`]);
  });

  function setupTerminateStore(options: {
    resultAppearsAfterChecks?: number;
  } = {}) {
    const agent = makeAgent({ agentId: AGENT_ID, status: 'busy' });
    let currentStore = makeStore({ [AGENT_ID]: agent });
    let resultChecks = 0;
    const resultAppearsAfterChecks = options.resultAppearsAfterChecks ?? Number.POSITIVE_INFINITY;
    const tracking = {
      status: 'running',
      taskId: TASK_ID,
      agentId: AGENT_ID,
      pid: PID,
    };

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p !== 'string') return false;
      if (p.endsWith('store.json')) return true;
      if (p.endsWith('.hive-flow/tasks')) return true;
      if (p.endsWith(`${TASK_ID}.result.json`)) {
        resultChecks += 1;
        return resultChecks >= resultAppearsAfterChecks;
      }
      return false;
    });

    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return JSON.stringify(currentStore);
      if (typeof p === 'string' && p.endsWith(`${TASK_ID}.json`)) return JSON.stringify(tracking);
      return JSON.stringify({});
    });

    const tmpWrites = new Map<string, string>();
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string, data: string) => {
      if (typeof p === 'string' && p.includes('.tmp.')) {
        tmpWrites.set(p, data);
      }
    });
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation((src: string) => {
      const data = tmpWrites.get(src);
      if (data) {
        currentStore = JSON.parse(data);
        tmpWrites.delete(src);
      }
    });

    return {
      getResultChecks: () => resultChecks,
      getStore: () => currentStore,
    };
  }

  it('breaks termination cleanup wait when PID is proven dead by ESRCH', async () => {
    const fixture = setupTerminateStore();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, _sig: number | NodeJS.Signals) => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    const timeoutSpy = vi.spyOn(global, 'setTimeout');

    const result = await terminateHandler({ agentId: AGENT_ID }) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, agentId: AGENT_ID, terminated: true });
    expect(killSpy).toHaveBeenCalledWith(PID, 0);
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(fixture.getResultChecks()).toBe(1);
    expect(fixture.getStore().agents[AGENT_ID].status).toBe('terminated');
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining(`${TASK_ID}.json`));
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining(`${TASK_ID}.task`));

    killSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('continues termination cleanup wait on EPERM until the result appears', async () => {
    const fixture = setupTerminateStore({ resultAppearsAfterChecks: 2 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, _sig: number | NodeJS.Signals) => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    const timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 0 as unknown as NodeJS.Timeout;
    });

    const result = await terminateHandler({ agentId: AGENT_ID }) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, agentId: AGENT_ID, terminated: true });
    expect(killSpy).toHaveBeenCalledWith(PID, 0);
    expect(timeoutSpy).toHaveBeenCalled();
    expect(fixture.getResultChecks()).toBe(2);
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining(`${TASK_ID}.json`));
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining(`${TASK_ID}.task`));

    killSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('continues termination cleanup wait on ambiguous non-ESRCH errors until the result appears', async () => {
    const fixture = setupTerminateStore({ resultAppearsAfterChecks: 2 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, _sig: number | NodeJS.Signals) => {
      throw Object.assign(new Error('invalid target'), { code: 'EINVAL' });
    });
    const timeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 0 as unknown as NodeJS.Timeout;
    });

    const result = await terminateHandler({ agentId: AGENT_ID }) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, agentId: AGENT_ID, terminated: true });
    expect(killSpy).toHaveBeenCalledWith(PID, 0);
    expect(timeoutSpy).toHaveBeenCalled();
    expect(fixture.getResultChecks()).toBe(2);

    killSpy.mockRestore();
    timeoutSpy.mockRestore();
  });
});

// ── Bridge result-file failure surfacing (migrated from bridge-tool-execution.test.ts)
//
// Contract: under fire-and-forget dispatch, agent_task no longer observes bridge
// runtime failures. The bridge writes a `<taskId>.result.json` file on every
// terminal outcome (success or failure). agent_task_result reads that file and
// surfaces the bridge's error payload to the caller verbatim under the
// `result` field with `status: 'completed'` (because the bridge produced a
// result), preserving the bridge's own success/error shape.
//
// These tests cover the failure modes that used to live in
// bridge-tool-execution.test.ts but are no longer observable from agent_task:
//   - tool execution failure inside the provider call
//   - provider initialization failure
//   - provider authentication failure
//   - bridge timeout (graceful, with result file written)
//   - bridge crash producing a malformed (non-JSON) result file
//
// For all the above except the malformed-file case, the bridge writes a
// well-formed `{ success: false, error, code }` JSON envelope. agent_task_result
// passes that through to the caller without re-classifying it.
// ────────────────────────────────────────────────────────────────────────────

describe('agent_task_result: bridge result-file failure surfacing', () => {
  const TASK_ID = 'task-1700000000001-failmode';
  const AGENT_ID = 'failmode-agent';
  const ALIVE_PID = 44444;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Configure mocks so that:
   *   - store.json returns a single busy agent
   *   - <TASK_ID>.json returns the tracking record
   *   - <TASK_ID>.result.json is either present (with `resultBody`) or absent
   *
   * If `resultBody === null`, the result file is treated as absent.
   * If `resultBody` is a string, it's returned raw (allows malformed JSON).
   * If `resultBody` is an object, it's JSON.stringify'd.
   */
  function setupResultFile(
    resultBody: string | Record<string, unknown> | null,
    overrides: { pid?: number; agentStatus?: 'busy' | 'idle' } = {},
  ) {
    const agent = makeAgent({
      agentId: AGENT_ID,
      status: overrides.agentStatus ?? 'busy',
    });
    let currentStore = makeStore({ [AGENT_ID]: agent });
    const tracking = {
      status: 'running',
      taskId: TASK_ID,
      agentId: AGENT_ID,
      startedAt: new Date().toISOString(),
      pid: overrides.pid ?? ALIVE_PID,
    };

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string') {
        if (p.endsWith('store.json')) return true;
        if (p.endsWith(`${TASK_ID}.json`) && !p.endsWith(`${TASK_ID}.result.json`)) return true;
        if (p.endsWith(`${TASK_ID}.result.json`)) return resultBody !== null;
      }
      return false;
    });

    (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string') {
        if (p.endsWith('store.json')) return JSON.stringify(currentStore);
        if (p.endsWith(`${TASK_ID}.result.json`)) {
          if (resultBody === null) throw new Error('ENOENT');
          if (typeof resultBody === 'string') return resultBody;
          return JSON.stringify(resultBody);
        }
        if (p.endsWith(`${TASK_ID}.json`)) return JSON.stringify(tracking);
      }
      return JSON.stringify({});
    });

    const tmpWrites = new Map<string, string>();
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string, data: string) => {
      if (typeof p === 'string' && p.includes('.tmp.')) {
        tmpWrites.set(p, data);
      }
    });
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation((src: string) => {
      const data = tmpWrites.get(src);
      if (data) {
        try { currentStore = JSON.parse(data); } catch { /* skip */ }
        tmpWrites.delete(src);
      }
    });
    (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

    return { getStore: () => currentStore };
  }

  it('surfaces a bridge tool-execution failure when bridge writes { success: false, error } to the result file', async () => {
    // Was: bridge-tool-execution.test.ts "should return error when bridge reports tool execution failure"
    // New layer: result-file polling
    const bridgeErrorPayload = {
      success: false,
      error: 'Tool execution failed: read_file ENOENT /missing.txt',
      code: 'BRIDGE_ERROR',
    };
    setupResultFile(bridgeErrorPayload);

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    // The handler treats result-file presence as terminal (status: completed),
    // and forwards the bridge's payload under `result` so the caller can
    // inspect success === false and the error message.
    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.taskId).toBe(TASK_ID);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.result).toEqual(bridgeErrorPayload);
    // Caller-side assertion: the inner payload signals failure.
    expect((result.result as Record<string, unknown>).success).toBe(false);
    expect((result.result as Record<string, unknown>).error)
      .toMatch(/Tool execution failed/i);
  });

  it('surfaces a provider initialization failure written by the bridge to the result file', async () => {
    // Was: bridge-tool-execution.test.ts "should return error when provider initialization fails"
    // Bridge wraps init errors as: "Provider <name> initialization failed: <msg>"
    // (see provider-agent-bridge.mjs line 1608)
    const initErrorPayload = {
      success: false,
      error: 'Provider gemini-cli initialization failed: missing API key',
      code: 'BRIDGE_ERROR',
    };
    setupResultFile(initErrorPayload);

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.agentId).toBe(AGENT_ID);
    const inner = result.result as Record<string, unknown>;
    expect(inner.success).toBe(false);
    expect(inner.error).toMatch(/initialization failed/i);
  });

  it('surfaces a provider authentication failure written by the bridge to the result file', async () => {
    // Was: bridge-tool-execution.test.ts "should return error when provider authentication fails"
    // Bridge classifyError() maps 401/unauthorized/invalid API key to 'provider_api'
    // (see provider-agent-bridge.mjs lines 155-158)
    const authErrorPayload = {
      success: false,
      error: 'API authentication failed: 401 Unauthorized — invalid api key',
      code: 'PROVIDER_AUTH_FAILED',
    };
    setupResultFile(authErrorPayload);

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.agentId).toBe(AGENT_ID);
    const inner = result.result as Record<string, unknown>;
    expect(inner.success).toBe(false);
    expect(inner.error).toMatch(/authentication|unauthorized|api key/i);
    expect(inner.code).toBe('PROVIDER_AUTH_FAILED');
  });

  it('surfaces a bridge timeout gracefully when the bridge writes a timeout error to the result file', async () => {
    // Was: bridge-tool-execution.test.ts "should handle bridge timeout gracefully"
    // The bridge enforces --timeout internally and writes an error result on
    // expiry. classifyError() maps timeout/timed out/ETIMEDOUT/SIGKILL to
    // 'timeout' (see provider-agent-bridge.mjs lines 149-151).
    const timeoutPayload = {
      success: false,
      error: 'Bridge task timed out after 30000ms (SIGKILL)',
      code: 'BRIDGE_TIMEOUT',
    };
    setupResultFile(timeoutPayload);

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.agentId).toBe(AGENT_ID);
    const inner = result.result as Record<string, unknown>;
    expect(inner.success).toBe(false);
    expect(inner.error).toMatch(/timed out|timeout/i);
  });

  it('returns status:failed with a parse error when the result file contains non-JSON output', async () => {
    // Was: bridge-tool-execution.test.ts "should handle bridge crash with non-JSON output gracefully"
    // agent_task_result wraps JSON.parse in a try/catch (see agent-tools.ts
    // lines 1071-1075) and returns:
    //   { success:false, taskId, agentId, status:'failed', error:'Failed to parse result file' }
    setupResultFile('not valid json at all <<<<');

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.taskId).toBe(TASK_ID);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.error).toMatch(/parse result file/i);
  });

  it('resets a busy agent to idle when surfacing a bridge failure result', async () => {
    // Sanity check: regardless of inner success/failure, the result file's
    // presence means the bridge has exited, so the agent must be released
    // back to idle. (Mirrors the happy-path "completed" test above.)
    const failurePayload = { success: false, error: 'tool exec blew up', code: 'BRIDGE_ERROR' };
    const { getStore } = setupResultFile(failurePayload);

    await resultHandler({ taskId: TASK_ID });

    expect(getStore().agents[AGENT_ID].status).toBe('idle');
  });
});
