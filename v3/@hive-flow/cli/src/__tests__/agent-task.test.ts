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

// Mock node:child_process — controls spawn (used for bridge) and execFile (used elsewhere)
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
import { execFile, spawn } from 'node:child_process';
import { agentTools } from '../mcp-tools/agent-tools.js';
import { EventEmitter } from 'node:events';

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

/**
 * Create a mock child process for spawn().
 * The bridge invocation now uses spawn + stdin pipe instead of execFile.
 * This helper returns a mock child with controllable stdout/stderr/stdin
 * and an emit('close', code) to simulate process completion.
 */
function createMockChild(stdoutData: string, stderrData: string, exitCode: number | null = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  // Schedule data emission and close asynchronously (microtask)
  queueMicrotask(() => {
    if (stdoutData) child.stdout.emit('data', Buffer.from(stdoutData));
    if (stderrData) child.stderr.emit('data', Buffer.from(stderrData));
    child.emit('close', exitCode);
  });

  return child;
}

/**
 * Mock spawn to return a child that emits given stdout/stderr and exits with given code.
 */
function mockSpawnSuccess(stdoutData: string = '{"success":true}', stderrData: string = '', exitCode: number | null = 0) {
  (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
    return createMockChild(stdoutData, stderrData, exitCode);
  });
}

/**
 * Extract the [args, opts] pair from the first spawn call.
 * spawn is called as: spawn('node', [bridgePath, ...args], { stdio, timeout })
 */
function getSpawnCall(): { args: string[]; opts: Record<string, unknown> } {
  const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return { args: calls[0][1] as string[], opts: calls[0][2] as Record<string, unknown> };
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

    mockSpawnSuccess(bridgeOutput);

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

    mockSpawnSuccess(errorJson, 'some stderr', 1);

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

    mockSpawnSuccess('not json', '', 1);

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringContaining('Bridge exited with code 1'),
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

    // Track the store state at the time spawn is called
    let statusDuringExec: string | undefined;

    (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // At this point, the handler has already saved the agent as 'busy'
      statusDuringExec = getPersistedStore().agents[agent.agentId].status;
      return createMockChild(JSON.stringify({ success: true }), '', 0);
    });

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

    mockSpawnSuccess('this is not json at all', '', 0);

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
  // 10. spawn passes correct arguments (bridge path, agent-id, --task-stdin, store-dir)
  //     Task is piped via stdin instead of CLI args to avoid shell parsing issues.
  // ------------------------------------------------------------------
  it('passes correct arguments to spawn and pipes task via stdin', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    mockSpawnSuccess();

    await handler({ agentId: agent.agentId, task: 'my task', timeout: 60000 });

    expect(spawn).toHaveBeenCalledTimes(1);
    const { args, opts } = getSpawnCall();
    const [cmd] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(cmd).toBe('node');
    expect(args[0]).toBe(EXPECTED_BRIDGE_PATH);
    expect(args).toContain('--agent-id');
    expect(args).toContain(agent.agentId);
    // Task is piped via stdin, not passed as --task arg
    expect(args).toContain('--task-stdin');
    expect(args).not.toContain('--task');
    expect(args).not.toContain('my task');
    expect(args).toContain('--store-dir');
    expect(opts.timeout).toBe(60000);

    // Verify task was written to stdin
    const child = (spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(child.stdin.write).toHaveBeenCalledWith('my task');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 11. Default timeout is 120000ms
  // ------------------------------------------------------------------
  it('uses default timeout of 120000ms when not specified', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    mockSpawnSuccess();

    await handler({ agentId: agent.agentId, task: 'do something' });

    const { opts } = getSpawnCall();
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

    // spawn returns child that emits 'error' instead of 'close'
    (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      queueMicrotask(() => {
        child.emit('error', new Error('spawn ENOENT'));
      });

      return child;
    });

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

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

    mockSpawnSuccess('', '', 1);

    const result = await handler({ agentId: agent.agentId, task: 'do something' });

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringContaining('Bridge exited with code 1'),
    });
    // stderr should be undefined when empty
    expect((result as AgentTaskResult).stderr).toBeUndefined();
  });

  // ====================================================================
  // Timeout clamping (SEC / timeout propagation fix)
  // ====================================================================

  describe('timeout clamping', () => {
    // ------------------------------------------------------------------
    // 14. Default timeout: no input.timeout → 120000
    // ------------------------------------------------------------------
    it('uses 120000ms timeout when input.timeout is not provided', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'do something' });

      const { args, opts } = getSpawnCall();
      expect(opts.timeout).toBe(120000);
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('120000');
    });

    // ------------------------------------------------------------------
    // 15. Custom timeout: input.timeout = 600000 → 600000 (within range)
    // ------------------------------------------------------------------
    it('passes through a custom timeout within the valid range unchanged', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: 600000 });

      const { args, opts } = getSpawnCall();
      expect(opts.timeout).toBe(600000);
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('600000');
    });

    // ------------------------------------------------------------------
    // 16. Below minimum: input.timeout = 5000 → clamped to 10000
    // ------------------------------------------------------------------
    it('clamps timeout to minimum 10000ms when input is below threshold', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: 5000 });

      const { args, opts } = getSpawnCall();
      expect(opts.timeout).toBe(10000);
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('10000');
    });

    // ------------------------------------------------------------------
    // 17. Above maximum: input.timeout = 7200000 → clamped to 3600000
    // ------------------------------------------------------------------
    it('clamps timeout to maximum 3600000ms when input exceeds the ceiling', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: 7200000 });

      const { args, opts } = getSpawnCall();
      expect(opts.timeout).toBe(3600000);
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('3600000');
    });

    // ------------------------------------------------------------------
    // 18. Zero: input.timeout = 0 → fallback to 120000, then clamped
    //     rawTimeout = (0 || 120000) = 120000 → clamped = 120000
    // ------------------------------------------------------------------
    it('falls back to 120000ms when input.timeout is zero', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: 0 });

      const { args, opts } = getSpawnCall();
      expect(opts.timeout).toBe(120000);
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('120000');
    });

    // ------------------------------------------------------------------
    // 19. Negative: input.timeout = -1 → clamped to 10000
    //     rawTimeout = (-1 || 120000) = 120000? No: -1 is truthy.
    //     rawTimeout = -1, Math.max(10000, Math.min(3600000, -1)) = 10000
    // ------------------------------------------------------------------
    it('clamps timeout to minimum 10000ms when input is negative', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: -1 });

      const { args, opts } = getSpawnCall();
      expect(opts.timeout).toBe(10000);
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('10000');
    });

    // ------------------------------------------------------------------
    // 20. NaN: input.timeout = NaN → fallback to 120000
    //     rawTimeout = (NaN || 120000) = 120000 → clamped = 120000
    // ------------------------------------------------------------------
    it('falls back to 120000ms when input.timeout is NaN', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'do something', timeout: NaN });

      const { args, opts } = getSpawnCall();
      expect(opts.timeout).toBe(120000);
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).not.toBe(-1);
      expect(args[timeoutIdx + 1]).toBe('120000');
    });

    // ------------------------------------------------------------------
    // 21. Args array structure: includes --agent-id, --task-stdin, --store-dir, --timeout
    //     Task text is piped via stdin, not passed as --task arg.
    // ------------------------------------------------------------------
    it('includes all required args in spawn call: --agent-id, --task-stdin, --store-dir, --timeout', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'specific task', timeout: 30000 });

      const { args } = getSpawnCall();

      // Bridge path is first
      expect(args[0]).toBe(EXPECTED_BRIDGE_PATH);

      // All required named args present
      expect(args).toContain('--agent-id');
      expect(args[args.indexOf('--agent-id') + 1]).toBe(agent.agentId);

      // Task is piped via stdin, signaled by --task-stdin flag
      expect(args).toContain('--task-stdin');
      expect(args).not.toContain('--task');

      expect(args).toContain('--store-dir');
      // store-dir is a non-empty string
      expect(args[args.indexOf('--store-dir') + 1].length).toBeGreaterThan(0);

      expect(args).toContain('--timeout');
      // timeout = 30000 (within range, no clamping)
      expect(args[args.indexOf('--timeout') + 1]).toBe('30000');

      // Verify task was written to stdin
      const child = (spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(child.stdin.write).toHaveBeenCalledWith('specific task');
      expect(child.stdin.end).toHaveBeenCalled();
    });
  });

  // ====================================================================
  // Bridge createProviderConfig timeout logic (tested via handler integration)
  // ====================================================================

  describe('bridge createProviderConfig timeout propagation', () => {
    /**
     * These tests verify that the timeout value written into spawn opts
     * matches what the bridge would receive via --timeout and use in
     * createProviderConfig. The bridge sets config.timeout = timeoutMs || 120000,
     * so the value passed in --timeout must be the clamped value.
     */

    // ------------------------------------------------------------------
    // 22. parseArgs --timeout: bridge receives the clamped value
    // ------------------------------------------------------------------
    it('passes clamped timeout to bridge via --timeout arg as a string integer', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'task', timeout: 250000 });

      const { args } = getSpawnCall();
      const idx = args.indexOf('--timeout');
      expect(idx).not.toBe(-1);
      // Must be a numeric string (parseInt-able)
      const parsed = parseInt(args[idx + 1], 10);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBe(250000);
    });

    // ------------------------------------------------------------------
    // 23. createProviderConfig with timeout = 0 defaults to 120000
    //     The handler maps timeout:0 → rawTimeout=120000 → clamped=120000.
    //     The bridge arg is '120000'; bridge createProviderConfig: 120000 || 120000 = 120000.
    // ------------------------------------------------------------------
    it('bridge receives 120000 when caller provides timeout=0 (fallback chain)', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'task', timeout: 0 });

      const { args, opts } = getSpawnCall();

      // spawn opts.timeout (used as process kill timeout) = 120000
      expect(opts.timeout).toBe(120000);

      // bridge --timeout arg = '120000'
      const idx = args.indexOf('--timeout');
      expect(idx).not.toBe(-1);
      expect(args[idx + 1]).toBe('120000');
    });

    // ------------------------------------------------------------------
    // 24. createProviderConfig with a valid custom timeout
    //     timeout=45000 → rawTimeout=45000 → clamped=45000 (above min, below max)
    //     bridge receives --timeout 45000; config.timeout = 45000 || 120000 = 45000
    // ------------------------------------------------------------------
    it('bridge receives exact custom timeout when within valid range', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockSpawnSuccess();

      await handler({ agentId: agent.agentId, task: 'task', timeout: 45000 });

      const { args, opts } = getSpawnCall();

      expect(opts.timeout).toBe(45000);
      const idx = args.indexOf('--timeout');
      expect(idx).not.toBe(-1);
      expect(args[idx + 1]).toBe('45000');
    });
  });
});
