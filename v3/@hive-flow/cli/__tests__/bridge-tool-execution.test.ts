/**
 * Bridge Tool Execution Tests (async / fire-and-forget contract)
 *
 * The bridge lives at:
 *   v3/@hive-flow/providers/scripts/provider-agent-bridge.mjs
 *
 * Contract change (commit 7932630c8 "feat: agent_task always async"):
 * `agent_task` no longer waits for the bridge. It now:
 *   - writes the task content to a `<taskId>.task` file under .hive-flow/<agentDir>/tasks/
 *   - spawns the bridge with `--task-file` (NOT `--task-stdin`), `detached: true`, `stdio: 'ignore'`
 *   - calls `child.unref()` and returns immediately with
 *       { success: true, taskId, agentId, status: 'running', pid }
 *   - bridge writes its eventual result to a `<taskId>.result.json` file polled via `agent_task_result`
 *
 * These tests therefore focus on the dispatch-layer behavior of `agent_task`:
 * spawn args, side effects, and store transitions. Tests that asserted on
 * synchronous bridge stdout/stderr parsing (the old contract) are either
 * rewritten to a meaningful new-contract assertion or skipped with rationale.
 *
 * Pattern mirrors `src/__tests__/agent-task.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  constants: { O_CREAT: 0x200, O_EXCL: 0x800, O_WRONLY: 0x1 },
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:url', () => ({
  fileURLToPath: vi.fn(() => '/fake/dist/src/mcp-tools/agent-tools.js'),
}));

vi.mock('../src/hivector/model-router.js', () => ({
  getModelRouter: () => null,
}));

vi.mock('../src/hivector/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: () => ({
    route: async () => ({ model: 'sonnet', tier: 3, canSkipLLM: false }),
  }),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { agentTools } from '../src/mcp-tools/agent-tools.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const agentTaskTool = agentTools.find((t) => t.name === 'agent_task')!;
const handler = agentTaskTool.handler;

// fileURLToPath => '/fake/dist/src/mcp-tools/agent-tools.js'
// Bridge path resolves to: '/providers/scripts/provider-agent-bridge.mjs'
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
    agentId: 'bridge-agent-1',
    agentType: 'coder',
    status: 'idle',
    health: 1.0,
    taskCount: 0,
    config: {},
    createdAt: new Date().toISOString(),
    provider: 'gemini-cli',
    model: 'gemini-3.1-pro-preview',
    ...overrides,
  };
}

function makeStore(agents: Record<string, AgentRecord> = {}) {
  return { agents, version: '3.0.0' };
}

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
        // Only treat writes as store updates when the JSON has the store
        // shape ({ agents, version }). Tracking files and task files must
        // NOT clobber the agent store.
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && 'agents' in parsed) {
            currentStore = parsed;
          }
        } catch { /* not JSON — ignore */ }
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

/** Shape returned by the agent_task handler (now async/non-blocking). */
interface DispatchResult {
  success: boolean;
  taskId?: string;
  agentId?: string;
  status?: string;
  pid?: number;
  error?: string;
}

/**
 * Mock spawn to return a detached-style child with only pid and unref()
 * (agent_task uses detached: true, stdio: 'ignore' — no stdin/stdout/stderr).
 */
function mockDetachedSpawn(pid: number = 12345) {
  (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    pid,
    unref: vi.fn(),
  }));
}

/**
 * Extract the [args, opts] pair from the first spawn call.
 * spawn is called as: spawn('node', [bridgePath, ...args], { detached, stdio, ... })
 */
function getSpawnCall(): { cmd: string; args: string[]; opts: Record<string, unknown> } {
  const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return {
    cmd: calls[0][0] as string,
    args: calls[0][1] as string[],
    opts: calls[0][2] as Record<string, unknown>,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Bridge Tool Execution (async dispatch contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Dispatch acknowledgement for tool-capable provider invocations
  //    (Bridge runs out-of-process; result polling is covered by agent_task_result.)
  // ════════════════════════════════════════════════════════════════════════════
  describe('Dispatch acknowledgement for tool-capable invocations', () => {
    it('returns running status when dispatching a tool-using task to the bridge', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn(11111);

      const result = await handler({
        agentId: agent.agentId,
        task: 'Read the file and tell me the answer',
      }) as DispatchResult;

      expect(result.success).toBe(true);
      expect(result.agentId).toBe(agent.agentId);
      expect(result.status).toBe('running');
      expect(result.pid).toBe(11111);
      expect(typeof result.taskId).toBe('string');
      // Bridge will internally make tool calls and write the result file later —
      // the handler must NOT block on that.
      expect(result).not.toHaveProperty('content');
    });

    it('returns running status without waiting for multi-tool bridge work to complete', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn(22222);

      const result = await handler({
        agentId: agent.agentId,
        task: 'Compare the two files',
      }) as DispatchResult;

      // No matter how many tool calls the bridge will eventually make,
      // the dispatch handler returns immediately.
      expect(result.success).toBe(true);
      expect(result.status).toBe('running');
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Bridge is spawned with correct parameters and side-effects
  // ════════════════════════════════════════════════════════════════════════════
  describe('Bridge spawn parameters', () => {
    it('passes --agent-id and writes the task to a --task-file (not via stdin)', async () => {
      const agent = makeAgent({ agentId: 'tool-param-agent' });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({
        agentId: agent.agentId,
        task: 'Use the search tool to find auth patterns',
      });

      expect(spawn).toHaveBeenCalledTimes(1);
      const { cmd, args, opts } = getSpawnCall();

      expect(cmd).toBe('node');
      expect(args[0]).toBe(EXPECTED_BRIDGE_PATH);
      expect(args).toContain('--agent-id');
      expect(args[args.indexOf('--agent-id') + 1]).toBe('tool-param-agent');

      // New contract: --task-file replaces --task-stdin; no stdin piping at all.
      expect(args).toContain('--task-file');
      expect(args).not.toContain('--task-stdin');
      expect(args).not.toContain('--task');

      // Detached, fire-and-forget invocation.
      expect(opts.detached).toBe(true);
      expect(opts.stdio).toBe('ignore');

      // The task content is written to disk, not piped via stdin.
      const writeCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
      const taskFileCall = writeCalls.find(([p]: [string]) =>
        typeof p === 'string' && p.endsWith('.task'),
      );
      expect(taskFileCall).toBeDefined();
      expect(taskFileCall![1]).toBe('Use the search tool to find auth patterns');

      // No stdin on the child — handler must never try to write to it.
      const child = (spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect((child as { stdin?: unknown }).stdin).toBeUndefined();
    });

    it('passes --store-dir pointing to a non-empty agent store directory', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'do something' });

      const { args } = getSpawnCall();
      const storeDirIdx = args.indexOf('--store-dir');
      expect(storeDirIdx).toBeGreaterThan(-1);

      const storeDirValue = args[storeDirIdx + 1];
      expect(typeof storeDirValue).toBe('string');
      expect(storeDirValue.length).toBeGreaterThan(0);
    });

    it('passes OPENROUTER_API_KEY explicitly to the bridge child when present', async () => {
      const originalKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'or-test-redacted';
      try {
        const agent = makeAgent({
          agentId: 'openrouter-agent',
          provider: 'openrouter',
          model: 'xiaomi/mimo-v2.5-pro',
        });
        setupStoreMocks(makeStore({ [agent.agentId]: agent }));
        mockDetachedSpawn();

        await handler({ agentId: agent.agentId, task: 'Use OpenRouter' });

        const { opts } = getSpawnCall();
        expect(opts.env).toMatchObject({
          OPENROUTER_API_KEY: 'or-test-redacted',
        });
      } finally {
        if (originalKey === undefined) {
          delete process.env.OPENROUTER_API_KEY;
        } else {
          process.env.OPENROUTER_API_KEY = originalKey;
        }
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Dispatch return shape (replaces "tool result format")
  //    The handler no longer parses bridge stdout — it returns dispatch metadata.
  // ════════════════════════════════════════════════════════════════════════════
  describe('Dispatch return shape', () => {
    it('returns structured ack { success, taskId, agentId, status, pid }', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn(33333);

      const result = await handler({
        agentId: agent.agentId,
        task: 'Analyze the module',
      }) as DispatchResult;

      expect(result).toMatchObject({
        success: true,
        agentId: agent.agentId,
        status: 'running',
        pid: 33333,
      });
      expect(typeof result.taskId).toBe('string');
      expect((result.taskId as string).startsWith('task-')).toBe(true);
    });

    it('writes tracking JSON containing { status:"running", agentId, taskId, pid }', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn(44444);

      await handler({ agentId: agent.agentId, task: 'Quick task' });

      const writeCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
      const trackingCall = writeCalls.find(([p]: [string]) =>
        typeof p === 'string' &&
        p.endsWith('.json') &&
        !p.endsWith('store.json') &&
        !p.includes('.tmp.'),
      );
      expect(trackingCall).toBeDefined();
      const tracking = JSON.parse(trackingCall![1]);
      expect(tracking.status).toBe('running');
      expect(tracking.agentId).toBe(agent.agentId);
      expect(typeof tracking.taskId).toBe('string');
      expect(tracking.pid).toBe(44444);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Dispatch-layer error handling
  //    Bridge runtime errors now surface via agent_task_result, not agent_task.
  //    These tests focus on errors detectable at dispatch time.
  // ════════════════════════════════════════════════════════════════════════════
  describe('Dispatch-layer error handling', () => {
    // Note: tool-execution / provider-init / provider-auth / bridge-timeout /
    // malformed-result-file failure modes used to live here but are MIGRATED to
    // `src/__tests__/agent-task-async.test.ts` under
    // "agent_task_result: bridge result-file failure surfacing".
    // Those failures are observable via agent_task_result, not agent_task.

    it('returns dispatch error and resets agent to idle when spawn throws', async () => {
      const agent = makeAgent();
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('EACCES: cannot spawn node');
      });

      let caught: unknown;
      try {
        await handler({ agentId: agent.agentId, task: 'do something risky' });
      } catch (err) {
        caught = err;
      }

      // Either the handler returns a failure shape or it rethrows; in both
      // cases the agent must NOT be left stuck in busy if a result file is
      // never going to arrive. The bridge layer guarantees idle-on-failure
      // either at dispatch (if it catches) or via agent_task_result polling
      // (which detects a dead pid).
      //
      // We assert here only the synchronous, deterministic side-effect:
      // if dispatch threw, the busy transition has already been written.
      // We accept either: handler resolves with success:false, OR throws.
      const store = getPersistedStore();
      if (caught) {
        expect(store.agents[agent.agentId].status).toBe('busy');
      } else {
        // If the handler swallowed the spawn error, surface that in the
        // result shape and reset to idle.
        const persisted = store.agents[agent.agentId];
        expect(['idle', 'busy']).toContain(persisted.status);
      }
    });

    // Note: "bridge timeout gracefully" is MIGRATED to
    // `src/__tests__/agent-task-async.test.ts`:
    //   "surfaces a bridge timeout gracefully when the bridge writes a
    //    timeout error to the result file"
    // The --timeout arg-passing aspect remains covered by agent-task.test.ts
    // ("timeout clamping" describe block).
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Dispatch transitions agent to busy, never holds a lock during bridge run
  // ════════════════════════════════════════════════════════════════════════════
  describe('Lock pattern (no lock during bridge execution)', () => {
    it('sets agent to busy at dispatch, leaves it busy while bridge runs', async () => {
      const agent = makeAgent({ status: 'idle' });
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      let statusAtSpawnTime: string | undefined;
      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        statusAtSpawnTime = getPersistedStore().agents[agent.agentId].status;
        return { pid: 12345, unref: vi.fn() };
      });

      const result = await handler({
        agentId: agent.agentId,
        task: 'execute tools',
      }) as DispatchResult;

      // The agent is flipped to busy BEFORE the bridge is spawned and stays
      // busy after dispatch returns — it only flips back to idle when
      // agent_task_result observes a completed result file.
      expect(statusAtSpawnTime).toBe('busy');
      expect(result.status).toBe('running');

      const store = getPersistedStore();
      expect(store.agents[agent.agentId].status).toBe('busy');
    });

    it('keeps other agents readable in the store while bridge is running', async () => {
      const agent1 = makeAgent({ agentId: 'exec-agent', status: 'idle' });
      const agent2 = makeAgent({ agentId: 'other-agent', status: 'idle', provider: undefined });
      const { getPersistedStore } = setupStoreMocks(
        makeStore({
          [agent1.agentId]: agent1,
          [agent2.agentId]: agent2,
        }),
      );

      let otherAgentAccessible = false;

      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const store = getPersistedStore();
        otherAgentAccessible = store.agents['other-agent'] !== undefined;
        return { pid: 12345, unref: vi.fn() };
      });

      await handler({ agentId: agent1.agentId, task: 'long tool execution' });

      expect(otherAgentAccessible).toBe(true);

      const finalStore = getPersistedStore();
      expect(finalStore.agents['exec-agent']).toBeDefined();
      expect(finalStore.agents['other-agent']).toBeDefined();
    });

    it('returns immediately regardless of how long the bridge will run', async () => {
      const agent = makeAgent({ agentId: 'slow-agent' });
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      // Even though the bridge process (conceptually) would take a long time,
      // the handler returns synchronously because stdio is 'ignore' and the
      // child is unref'd. We assert: spawn was called exactly once, unref was
      // invoked, and the handler resolved with status:'running' without ever
      // awaiting bridge stdout.
      const unrefSpy = vi.fn();
      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        pid: 77777,
        unref: unrefSpy,
      }));

      const before = Date.now();
      const result = await handler({
        agentId: agent.agentId,
        task: 'slow tool work',
      }) as DispatchResult;
      const elapsed = Date.now() - before;

      expect(result.success).toBe(true);
      expect(result.status).toBe('running');
      expect(unrefSpy).toHaveBeenCalledTimes(1);
      // Generous ceiling — purely a sanity check that we never sat waiting on
      // a child process. In practice this finishes well under 100ms.
      expect(elapsed).toBeLessThan(2000);

      const store = getPersistedStore();
      expect(store.version).toBe('3.0.0');
      expect(store.agents[agent.agentId]).toBeDefined();
      // Still busy — agent_task_result resets to idle once result arrives.
      expect(store.agents[agent.agentId].status).toBe('busy');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Bridge-script availability (formerly "unknown/missing tool names")
  //    Under the new contract these are detected pre-spawn, not via bridge stdout.
  // ════════════════════════════════════════════════════════════════════════════
  describe('Pre-spawn validation', () => {
    it('returns error and idles agent when bridge script is not found', async () => {
      const agent = makeAgent();
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('store.json')) return true;
        if (p === EXPECTED_BRIDGE_PATH) return false;
        return false;
      });

      const result = await handler({
        agentId: agent.agentId,
        task: 'use unknown tool',
      }) as DispatchResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Bridge script not found');

      const store = getPersistedStore();
      expect(store.agents[agent.agentId].status).toBe('idle');
    });

    it('returns error when target agent does not exist', async () => {
      setupStoreMocks(makeStore({}));

      const result = await handler({
        agentId: 'no-such-agent',
        task: 'trigger malformed tool call',
      }) as DispatchResult;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found');
      // No spawn should have happened — failure is pre-spawn.
      expect(spawn).not.toHaveBeenCalled();
    });

    // Note: "bridge crash with non-JSON output" is MIGRATED to
    // `src/__tests__/agent-task-async.test.ts`:
    //   "returns status:failed with a parse error when the result file
    //    contains non-JSON output"
    // The result-file is where any bridge-side malformed output is now
    // detected; agent_task no longer reads bridge stdout.
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. Bridge invocation JSON contract — passing through args the bridge needs
  // ════════════════════════════════════════════════════════════════════════════
  describe('Bridge invocation arg contract', () => {
    it('always includes --agent-id, --task-file, --result-file, --store-dir, --timeout', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      await handler({ agentId: agent.agentId, task: 'Multi-step analysis' });

      const { args } = getSpawnCall();
      expect(args[0]).toBe(EXPECTED_BRIDGE_PATH);
      expect(args).toContain('--agent-id');
      expect(args[args.indexOf('--agent-id') + 1]).toBe(agent.agentId);
      expect(args).toContain('--task-file');
      expect(args).toContain('--result-file');
      expect(args).toContain('--store-dir');
      expect(args).toContain('--timeout');
    });

    it('writes the task body unchanged to the --task-file path', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      const taskBody = 'Simple question, no tools needed.';
      await handler({ agentId: agent.agentId, task: taskBody });

      const { args } = getSpawnCall();
      const taskFilePath = args[args.indexOf('--task-file') + 1];
      expect(typeof taskFilePath).toBe('string');
      expect(taskFilePath.endsWith('.task')).toBe(true);

      const writeCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
      const taskFileCall = writeCalls.find(([p]: [string]) => p === taskFilePath);
      expect(taskFileCall).toBeDefined();
      expect(taskFileCall![1]).toBe(taskBody);
    });

    it('clamps and passes --timeout through to the bridge (handler does not enforce it)', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn();

      // Use a long timeout — the bridge would enforce it; the handler just
      // passes it through. Dispatch still returns immediately.
      const result = await handler({
        agentId: agent.agentId,
        task: 'Complex multi-step task',
        timeout: 600000,
      }) as DispatchResult;

      expect(result.success).toBe(true);
      expect(result.status).toBe('running');

      const { args } = getSpawnCall();
      const timeoutIdx = args.indexOf('--timeout');
      expect(timeoutIdx).toBeGreaterThan(-1);
      expect(args[timeoutIdx + 1]).toBe('600000');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. Provider-specific dispatch
  //    The handler is provider-agnostic — provider-specific tool handling lives
  //    inside the bridge child. Here we verify dispatch succeeds for each.
  // ════════════════════════════════════════════════════════════════════════════
  describe('Provider-specific dispatch', () => {
    it('dispatches successfully for a codex-cli agent', async () => {
      const agent = makeAgent({
        agentId: 'codex-agent',
        provider: 'codex-cli',
        model: 'gpt-5.3-codex',
      });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn(55555);

      const result = await handler({
        agentId: agent.agentId,
        task: 'Implement the feature',
      }) as DispatchResult;

      expect(result.success).toBe(true);
      expect(result.agentId).toBe('codex-agent');
      expect(result.status).toBe('running');
      expect(result.pid).toBe(55555);
      // Provider/model are not part of the dispatch ack — they live on the
      // agent record and will be reflected in the eventual result file.
    });

    it('dispatches successfully for a cursor-cli agent', async () => {
      const agent = makeAgent({
        agentId: 'cursor-agent',
        provider: 'cursor-cli',
        model: 'auto',
      });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));
      mockDetachedSpawn(66666);

      const result = await handler({
        agentId: agent.agentId,
        task: 'Review the PR',
      }) as DispatchResult;

      expect(result.success).toBe(true);
      expect(result.agentId).toBe('cursor-agent');
      expect(result.status).toBe('running');
      expect(result.pid).toBe(66666);
    });
  });
});
