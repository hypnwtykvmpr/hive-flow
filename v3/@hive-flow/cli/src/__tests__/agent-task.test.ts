import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (must be hoisted before imports) ──────────────────────────

// Mock node:fs — controls existsSync, readFileSync, writeFileSync, mkdirSync, renameSync
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

// Mock node:child_process — controls spawn (used for bridge)
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
vi.mock('@hive-flow/providers', () => ({
  resolveProviderModel: vi.fn((provider: string, model: string | undefined) => {
    if (provider === 'openrouter') {
      if (model === 'xiaomi/mimo-v2.5-pro') return 'xiaomi/mimo-v2.5-pro';
      if (model === 'mini' || model === 'sonnet') return 'moonshotai/kimi-k2.6';
      return undefined;
    }
    if (provider === 'codex-cli') return 'gpt-5.5';
    if (provider === 'gemini-cli') return 'gemini-3.5-flash';
    if (provider === 'cursor-cli') return 'auto';
    if (provider === 'deepseek') return model === 'mini' ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
    if (provider === 'anthropic-cli') return model === 'mini' || model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-8';
    return model;
  }),
  resolveProviderModelOrOpus: vi.fn((provider: string, model: string | undefined) => {
    if (provider === 'openrouter') {
      if (model === 'xiaomi/mimo-v2.5-pro') return 'xiaomi/mimo-v2.5-pro';
      if (model === 'mini' || model === 'sonnet') return 'moonshotai/kimi-k2.6';
      return 'moonshotai/kimi-k2.6';
    }
    if (provider === 'codex-cli') return 'gpt-5.5';
    if (provider === 'gemini-cli') return 'gemini-3.5-flash';
    if (provider === 'cursor-cli') return 'auto';
    if (provider === 'deepseek') return model === 'mini' ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
    if (provider === 'anthropic-cli') return model === 'mini' || model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-8';
    return model;
  }),
}));
vi.mock('../mcp-tools/provider-key-preflight.js', () => ({
  providerKeyPreflight: vi.fn(async () => ({ ok: true })),
}));

import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { agentTools, transitionAgent } from '../mcp-tools/agent-tools.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Find the agent_task tool handler from the exported array */
const agentSpawnTool = agentTools.find((t) => t.name === 'agent_spawn')!;
const agentTaskTool = agentTools.find((t) => t.name === 'agent_task')!;
const spawnHandler = agentSpawnTool.handler;
const handler = agentTaskTool.handler;

/** The bridge path that the handler will compute from the mocked fileURLToPath */
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
  resolvedModel?: string;
  currentTaskPid?: number;
  ownerSessionId?: string;
  ownerClientKind?: string;
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'test-agent-1',
    agentType: 'implementer',
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
 * and saveAgentStore() is a no-op.
 */
function setupStoreMocks(initialStore: ReturnType<typeof makeStore>) {
  let currentStore = JSON.parse(JSON.stringify(initialStore));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) return true;
    if (p === EXPECTED_BRIDGE_PATH) return true;
    if (p === '/tmp/hive-flow-test-holder.sock') return true;
    return false;
  });

  (lstatSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (p === '/tmp/hive-flow-test-holder.sock') {
      return {
        isSocket: () => true,
        uid: process.getuid?.() ?? 501,
        mode: 0o600,
      };
    }
    throw new Error('unexpected lstatSync path');
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
    return JSON.stringify(currentStore);
  });

  const tmpWrites = new Map<string, string>();

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (path: string, data: string) => {
      if (typeof path === 'string' && path.includes('.tmp.')) {
        tmpWrites.set(path, data);
      } else if (typeof path === 'string' && path.endsWith('store.json')) {
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

/** Union of possible shapes returned by the agent_task handler (now async/non-blocking). */
interface AgentTaskResult {
  success: boolean;
  taskId?: string;
  agentId?: string;
  status?: string;
  pid?: number;
  error?: string;
}

/**
 * Mock spawn to return a detached-style child with only pid and unref()
 * (agent_task now uses detached: true, stdio: 'ignore' — no stdin/stdout/stderr).
 */
function mockDetachedSpawn(pid: number = 12345) {
  (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    pid,
    on: vi.fn(),
    unref: vi.fn(),
  }));
}

/**
 * Extract the [args, opts] pair from the first spawn call.
 * spawn is called as: spawn('node', [bridgePath, ...args], { detached, stdio, ... })
 */
function getSpawnCall(): { args: string[]; opts: Record<string, unknown> } {
  const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return { args: calls[0][1] as string[], opts: calls[0][2] as Record<string, unknown> };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('agent_spawn handler model normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses an OpenRouter direct model input for resolvedModel instead of routing it away', async () => {
    const originalHolderSocket = process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET;
    process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET = '/tmp/hive-flow-test-holder.sock';
    const { getPersistedStore } = setupStoreMocks(makeStore());

    try {
      const result = await spawnHandler({
        agentType: 'verifier',
        provider: ' OpenRouter ',
        model: ' Xiaomi/MIMO-V2.5-PRO ',
      }) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.provider).toBe('openrouter');
      expect(result.resolvedModel).toBe('xiaomi/mimo-v2.5-pro');
      const persisted = Object.values(getPersistedStore().agents)[0] as AgentRecord;
      expect(persisted.provider).toBe('openrouter');
      expect(persisted.resolvedModel).toBe('xiaomi/mimo-v2.5-pro');
      expect(persisted.model).toBe('inherit');
    } finally {
      if (originalHolderSocket === undefined) delete process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET;
      else process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET = originalHolderSocket;
    }
  });

  it('normalizes provider and alias case before persisting runtime state', async () => {
    const { getPersistedStore } = setupStoreMocks(makeStore());

    const result = await spawnHandler({
      agentType: 'implementer',
      provider: 'CODEX-CLI',
      model: 'OPUS',
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.provider).toBe('codex-cli');
    expect(result.resolvedModel).toBe('gpt-5.5');
    const persisted = Object.values(getPersistedStore().agents)[0] as AgentRecord;
    expect(persisted.provider).toBe('codex-cli');
    expect(persisted.model).toBe('opus');
    expect(persisted.resolvedModel).toBe('gpt-5.5');
  });
});

describe('agent_task handler (non-blocking)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // 1. Agent not found
  // ------------------------------------------------------------------
  it('returns error when agent is not found', async () => {
    setupStoreMocks(makeStore({}));

    const result = await handler({ agentId: 'nonexistent', task: 'do something' });

    expect(result).toEqual({
      success: false,
      agentId: 'nonexistent',
      error: 'Agent not found',
    });
  });

  // ------------------------------------------------------------------
  // 2. Agent has no provider
  // ------------------------------------------------------------------
  it('returns error when agent has no provider', async () => {
    const agent = makeAgent({ provider: undefined });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringContaining('no provider'),
    });
  });

  // ------------------------------------------------------------------
  // 3. Agent is terminated
  // ------------------------------------------------------------------
  it('returns error when agent is terminated', async () => {
    const agent = makeAgent({ status: 'terminated' });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringContaining('terminated'),
    });
  });

  // ------------------------------------------------------------------
  // 4. Bridge script not found
  // ------------------------------------------------------------------
  it('returns error and resets status to idle when bridge script is not found', async () => {
    const agent = makeAgent();
    const { getPersistedStore } = setupStoreMocks(
      makeStore({ [agent.agentId]: agent }),
    );

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('store.json')) return true;
      if (p === EXPECTED_BRIDGE_PATH) return false;
      return false;
    });

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringContaining('Bridge script not found'),
    });

    const store = getPersistedStore();
    expect(store.agents[agent.agentId].status).toBe('idle');
  });

  // ------------------------------------------------------------------
  // 5. Happy path: returns immediately with taskId, status:running, pid
  // ------------------------------------------------------------------
  it('returns success with taskId, agentId, status:running, and pid on happy path', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));
    mockDetachedSpawn(12345);

    const result = await handler({ agentId: agent.agentId, task: 'write code' }) as AgentTaskResult;

    expect(result.success).toBe(true);
    expect(typeof result.taskId).toBe('string');
    expect((result.taskId as string).startsWith('task-')).toBe(true);
    expect(result.agentId).toBe(agent.agentId);
    expect(result.status).toBe('running');
    expect(result.pid).toBe(12345);
  });

  // ------------------------------------------------------------------
  // 6. Agent is set to busy during dispatch
  // ------------------------------------------------------------------
  it('sets agent status to busy when task is dispatched', async () => {
    const agent = makeAgent({ status: 'idle' });
    const { getPersistedStore } = setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    mockDetachedSpawn(12345);

    await handler({ agentId: agent.agentId, task: 'background work' });

    expect(getPersistedStore().agents[agent.agentId].status).toBe('busy');
    expect(getPersistedStore().agents[agent.agentId].currentTaskPid).toBe(12345);
  });

  it('clears currentTaskPid when a busy agent transitions back to idle', () => {
    const agent = makeAgent({ status: 'busy', currentTaskPid: 12345 });

    const changed = transitionAgent(agent, 'idle');

    expect(changed).toBe(true);
    expect(agent.status).toBe('idle');
    expect(agent.currentTaskPid).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // 7. Creates .task file and .json tracking file
  // ------------------------------------------------------------------
  it('writes a .task file and a .json tracking file', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));
    mockDetachedSpawn(99);

    await handler({ agentId: agent.agentId, task: 'the task text' });

    const writeCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls;

    const taskFileCall = writeCalls.find(([p]: [string]) => typeof p === 'string' && p.endsWith('.task'));
    expect(taskFileCall).toBeDefined();
    expect(taskFileCall![1]).toBe('the task text');

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

  // ------------------------------------------------------------------
  // 8. spawn is called with detached:true
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

    await handler({ agentId: agent.agentId, task: 'detached task' });

    const spawnCalls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    expect(spawnCalls.length).toBeGreaterThan(0);
    const opts = spawnCalls[0][2] as Record<string, unknown>;
    expect(opts.detached).toBe(true);
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('passes subagent identity markers to the provider bridge child env', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));
    mockDetachedSpawn();

    await handler({ agentId: agent.agentId, task: 'marked task' });

    const { opts } = getSpawnCall();
    const env = opts.env as Record<string, string>;
    expect(env.HIVE_FLOW_AGENT_ID).toBe(agent.agentId);
    expect(env.CLAUDE_AGENT_ID).toBe(agent.agentId);
  });

  // ------------------------------------------------------------------
  // 9. Rejects agent that is already busy
  // ------------------------------------------------------------------
  it('returns error when agent is already busy', async () => {
    const agent = makeAgent({ status: 'busy' });
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const result = await handler({ agentId: agent.agentId, task: 'another task' }) as AgentTaskResult;

    expect(result.success).toBe(false);
    expect(result.agentId).toBe(agent.agentId);
    expect(result.error).toMatch(/cannot accept tasks in current state/i);
  });

  // ====================================================================
  // Timeout clamping
  // ====================================================================

  describe('timeout clamping', () => {
    it('passes the stored spawn token to the bridge as --agent-token when present', async () => {
      const agent = makeAgent({
        config: { _spawnToken: 'spawn-token-123' },
      });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something' });

      const { args } = getSpawnCall();
      const tokenIdx = args.indexOf('--agent-token');
      expect(tokenIdx).not.toBe(-1);
      expect(args[tokenIdx + 1]).toBe('spawn-token-123');
    });

    it('uses 300000ms timeout when input.timeout is not provided', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something' });

      const { args } = getSpawnCall();
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('300000');
    });

    it('passes through a custom timeout within the valid range unchanged', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: 600000 });

      const { args } = getSpawnCall();
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('600000');
    });

    it('clamps timeout to minimum 10000ms when input is below threshold', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: 5000 });

      const { args } = getSpawnCall();
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('10000');
    });

    it('clamps timeout to maximum 3600000ms when input exceeds the ceiling', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: 7200000 });

      const { args } = getSpawnCall();
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('3600000');
    });

    it('falls back to 300000ms when input.timeout is zero', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: 0 });

      const { args } = getSpawnCall();
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('300000');
    });

    it('clamps timeout to minimum 10000ms when input is negative', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: -1 });

      const { args } = getSpawnCall();
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('10000');
    });

    it('falls back to 300000ms when input.timeout is NaN', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: NaN });

      const { args } = getSpawnCall();
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('300000');
    });

    it('includes all required args in spawn call: --agent-id, --task-file, --result-file, --store-dir, --timeout', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'specific task', timeout: 30000 });

      const { args } = getSpawnCall();

      expect(args[0]).toBe(EXPECTED_BRIDGE_PATH);
      expect(args).toContain('--agent-id');
      expect(args[args.indexOf('--agent-id') + 1]).toBe(agent.agentId);
      expect(args).toContain('--task-file');
      expect(args).toContain('--result-file');
      expect(args).toContain('--store-dir');
      expect(args[args.indexOf('--store-dir') + 1].length).toBeGreaterThan(0);
      expect(args).toContain('--timeout');
      expect(args[args.indexOf('--timeout') + 1]).toBe('30000');
    });
  });
});
