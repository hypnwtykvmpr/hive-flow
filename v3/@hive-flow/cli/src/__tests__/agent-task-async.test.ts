import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (must be hoisted before imports) ──────────────────────────

// Mock node:fs — controls existsSync, readFileSync, writeFileSync, mkdirSync, renameSync
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
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
vi.mock('../ruvector/model-router.js', () => ({
  getModelRouter: () => null,
}));
vi.mock('../ruvector/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: () => ({
    route: async () => ({ model: 'sonnet', tier: 3, canSkipLLM: false }),
  }),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
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
  provider?: string;
  model?: string;
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

const asyncHandler = asyncTool.handler;
const resultHandler = resultTool.handler;

/**
 * Mock spawn to return a detached-style child with only pid and unref()
 * (agent_task_async uses detached: true, stdio: 'ignore' — no stdin/stdout/stderr).
 */
function mockDetachedSpawn(pid: number = 12345) {
  (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    pid,
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
      return { pid: 12345, unref: vi.fn() };
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
    expect(tracking.pid).toBe(99);
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
      unref: mockUnref,
    }));

    await asyncHandler({ agentId: agent.agentId, task: 'detached task' });

    const spawnCalls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(spawnCalls.length).toBeGreaterThan(0);
    const opts = spawnCalls[0][2] as Record<string, unknown>;
    expect(opts.detached).toBe(true);
    expect(mockUnref).toHaveBeenCalledTimes(1);
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
    (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (renameSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
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
      throw new Error('ESRCH');
    });

    const result = await resultHandler({ taskId: TASK_ID }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.taskId).toBe(TASK_ID);
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.error).toMatch(/Process exited without producing a result/i);

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
