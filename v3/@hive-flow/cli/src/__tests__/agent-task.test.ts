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

// Mock node:child_process — controls execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
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
import { execFile } from 'node:child_process';
import { agentTools } from '../mcp-tools/agent-tools.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Find the agent_task tool handler from the exported array */
const agentTaskTool = agentTools.find((t) => t.name === 'agent_task')!;
const handler = agentTaskTool.handler;

/** The bridge path that the handler will compute from the mocked fileURLToPath */
// fileURLToPath returns '/fake/dist/src/mcp-tools/agent-tools.js'
// dirname  => '/fake/dist/src/mcp-tools'
// join('/fake/dist/src/mcp-tools', '..', '..', '..', '..', 'providers', 'scripts', 'provider-agent-bridge.mjs')
// resolves up 4 levels: mcp-tools -> src -> dist -> fake -> /
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
 * and saveAgentStore() is a no-op.
 *
 * loadAgentStore does:
 *   const path = join(process.cwd(), '.hive-flow', 'agents', 'store.json');
 *   if (existsSync(path)) { return JSON.parse(readFileSync(path, 'utf-8')); }
 *
 * We make existsSync return true for the store path, and readFileSync return
 * the serialised store. We use mockImplementation so each call to loadAgentStore
 * (the handler calls it multiple times) gets the latest store state.
 */
function setupStoreMocks(initialStore: ReturnType<typeof makeStore>) {
  // Track the "persisted" store state — saveAgentStore writes to it
  let currentStore = JSON.parse(JSON.stringify(initialStore));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) return true;
    // Bridge script existence is controlled per-test
    if (p === EXPECTED_BRIDGE_PATH) return true;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
    return JSON.stringify(currentStore);
  });

  // Track pending tmp file writes for atomic save (writeFileSync → renameSync)
  const tmpWrites = new Map<string, string>();

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (path: string, data: string) => {
      if (typeof path === 'string' && path.includes('.tmp.')) {
        // Atomic save: buffer the tmp write until renameSync commits it
        tmpWrites.set(path, data);
      } else {
        // Legacy direct write (fallback)
        currentStore = JSON.parse(data);
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
    /** Read the latest "persisted" store state */
    getPersistedStore: () => currentStore as ReturnType<typeof makeStore>,
  };
}

/** Union of possible shapes returned by the agent_task handler. */
interface AgentTaskResult {
  success: boolean;
  agentId?: string;
  response?: string;
  error?: string;
  rawOutput?: string;
  stderr?: string;
  model?: string;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('agent_task handler', () => {
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

    // Override existsSync to return false for the bridge path
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

    // Agent should be reset to idle after the bridge-not-found error
    const store = getPersistedStore();
    expect(store.agents[agent.agentId].status).toBe('idle');
  });

  // ------------------------------------------------------------------
  // 5. Bridge returns valid JSON result
  // ------------------------------------------------------------------
  it('returns parsed result when bridge outputs valid JSON', async () => {
    const agent = makeAgent();
    const { getPersistedStore } = setupStoreMocks(
      makeStore({ [agent.agentId]: agent }),
    );

    const bridgeOutput = JSON.stringify({
      success: true,
      agentId: agent.agentId,
      response: 'Task completed successfully',
    });

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(null, bridgeOutput, '');
        return { on: vi.fn() };
      },
    );

    const result = await handler({ agentId: agent.agentId, task: 'write code' });

    expect(result).toEqual({
      success: true,
      agentId: agent.agentId,
      response: 'Task completed successfully',
    });

    // Agent should be reset to idle after successful execution
    const store = getPersistedStore();
    expect(store.agents[agent.agentId].status).toBe('idle');
  });

  // ------------------------------------------------------------------
  // 6. Bridge returns error JSON (via stdout) on exec error
  // ------------------------------------------------------------------
  it('returns error details when bridge outputs error JSON on failure', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const errorJson = JSON.stringify({ error: 'Provider authentication failed' });
    const execError = new Error('Process exited with code 1');

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(execError, errorJson, 'some stderr');
        return { on: vi.fn() };
      },
    );

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: 'Provider authentication failed',
      stderr: 'some stderr',
    });
  });

  // ------------------------------------------------------------------
  // 7. Bridge exec error with non-JSON stdout
  // ------------------------------------------------------------------
  it('returns exec error message when bridge stdout is not JSON on failure', async () => {
    const agent = makeAgent();
    const { getPersistedStore } = setupStoreMocks(
      makeStore({ [agent.agentId]: agent }),
    );

    const execError = new Error('Command timed out');

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(execError, 'not json', '');
        return { on: vi.fn() };
      },
    );

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: 'Command timed out',
    });

    // Agent should be reset to idle
    const store = getPersistedStore();
    expect(store.agents[agent.agentId].status).toBe('idle');
  });

  // ------------------------------------------------------------------
  // 8. Agent status set to busy during execution, idle after
  // ------------------------------------------------------------------
  it('sets agent status to busy before execution and idle after', async () => {
    const agent = makeAgent({ status: 'idle' });
    const { getPersistedStore } = setupStoreMocks(
      makeStore({ [agent.agentId]: agent }),
    );

    // Track the store state at the time execFile is called
    let statusDuringExec: string | undefined;

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        // At this point, the handler has already saved the agent as 'busy'
        statusDuringExec = getPersistedStore().agents[agent.agentId].status;
        // Return success
        callback(null, JSON.stringify({ success: true }), '');
        return { on: vi.fn() };
      },
    );

    await handler({ agentId: agent.agentId, task: 'write code' });

    // During execution, agent was busy
    expect(statusDuringExec).toBe('busy');

    // After execution, agent is idle
    const store = getPersistedStore();
    expect(store.agents[agent.agentId].status).toBe('idle');
  });

  // ------------------------------------------------------------------
  // 9. Bridge stdout not valid JSON (no exec error)
  // ------------------------------------------------------------------
  it('returns parse error when bridge stdout is not valid JSON on success', async () => {
    const agent = makeAgent();
    const { getPersistedStore } = setupStoreMocks(
      makeStore({ [agent.agentId]: agent }),
    );

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(null, 'this is not json at all', '');
        return { on: vi.fn() };
      },
    );

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: 'Failed to parse bridge output',
    });
    expect((result as AgentTaskResult).rawOutput).toBe('this is not json at all');

    // Agent should be reset to idle
    const store = getPersistedStore();
    expect(store.agents[agent.agentId].status).toBe('idle');
  });

  // ------------------------------------------------------------------
  // 10. execFile passes correct arguments (bridge path, agent-id, task, store-dir)
  // ------------------------------------------------------------------
  it('passes correct arguments to execFile', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(null, JSON.stringify({ success: true }), '');
        return { on: vi.fn() };
      },
    );

    await handler({ agentId: agent.agentId, task: 'my task', timeout: 60000 });

    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(cmd).toBe('node');
    expect(args[0]).toBe(EXPECTED_BRIDGE_PATH);
    expect(args).toContain('--agent-id');
    expect(args).toContain(agent.agentId);
    expect(args).toContain('--task');
    expect(args).toContain('my task');
    expect(args).toContain('--store-dir');
    expect(opts.timeout).toBe(60000);
    expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
  });

  // ------------------------------------------------------------------
  // 11. Default timeout is 120000ms
  // ------------------------------------------------------------------
  it('uses default timeout of 120000ms when not specified', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(null, JSON.stringify({ success: true }), '');
        return { on: vi.fn() };
      },
    );

    await handler({ agentId: agent.agentId, task: 'do something' });

    const [, , opts] = (execFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.timeout).toBe(120000);
  });

  // ------------------------------------------------------------------
  // 12. Child 'error' event (spawn failure)
  // ------------------------------------------------------------------
  it('returns error and resets status on child process spawn error', async () => {
    const agent = makeAgent();
    const { getPersistedStore } = setupStoreMocks(
      makeStore({ [agent.agentId]: agent }),
    );

    // execFile callback is NOT called; instead the child emits 'error'
    let errorListener: ((err: Error) => void) | undefined;

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, _callback: Function) => {
        return {
          on: vi.fn((event: string, listener: (err: Error) => void) => {
            if (event === 'error') {
              errorListener = listener;
            }
          }),
        };
      },
    );

    const resultPromise = handler({ agentId: agent.agentId, task: 'do something' });

    // Simulate async spawn error
    await new Promise((r) => setTimeout(r, 10));
    errorListener!(new Error('spawn ENOENT'));

    const result = await resultPromise;

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringContaining('Failed to spawn bridge'),
    });
    expect((result as AgentTaskResult).error).toContain('ENOENT');

    const store = getPersistedStore();
    expect(store.agents[agent.agentId].status).toBe('idle');
  });

  // ------------------------------------------------------------------
  // 13. Empty stderr is omitted from error response
  // ------------------------------------------------------------------
  it('omits stderr from error response when stderr is empty', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const execError = new Error('exit code 1');

    (execFile as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, callback: Function) => {
        callback(execError, '', '');
        return { on: vi.fn() };
      },
    );

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: 'exit code 1',
    });
    // stderr should be undefined, not empty string
    expect((result as AgentTaskResult).stderr).toBeUndefined();
  });
});
