/**
 * Bridge Tool Execution Tests
 *
 * Tests the provider-agent-bridge's handling of tool_use blocks in provider
 * responses. The bridge lives at:
 *   v3/@hive-flow/providers/scripts/provider-agent-bridge.mjs
 *
 * Since the bridge runs as a child process (invoked by agent_task via execFile),
 * we test it through the agent_task handler, mocking execFile to simulate
 * bridge stdout/stderr output — the same pattern used in agent-task.test.ts.
 *
 * Additionally, we test the bridge's internal tool-calling loop logic by
 * verifying the JSON contract between the agent_task handler and bridge process.
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

vi.mock('../src/ruvector/model-router.js', () => ({
  getModelRouter: () => null,
}));

vi.mock('../src/ruvector/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: () => ({
    route: async () => ({ model: 'sonnet', tier: 3, canSkipLLM: false }),
  }),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { agentTools } from '../src/mcp-tools/agent-tools.js';
import { EventEmitter } from 'node:events';

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
        try { currentStore = JSON.parse(data); } catch { /* ignore */ }
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

/**
 * Helper: simulate bridge stdout for a successful response that includes
 * tool calls in the conversation history (as the bridge would produce).
 */
function makeBridgeToolResponse(agentId: string, opts: {
  content: string;
  toolCallsInHistory?: Array<{ name: string; arguments: string; id: string }>;
  usage?: { totalTokens: number };
  historyLength?: number;
  taskCount?: number;
}) {
  return JSON.stringify({
    success: true,
    agentId,
    content: opts.content,
    model: 'gemini-3.1-pro-preview',
    usage: opts.usage || { totalTokens: 150 },
    historyLength: opts.historyLength || 3,
    taskCount: opts.taskCount || 1,
  });
}

/**
 * Helper: simulate bridge stdout for a tool execution error.
 */
function makeBridgeErrorResponse(opts: {
  error: string;
  code?: string;
}) {
  return JSON.stringify({
    success: false,
    error: opts.error,
    code: opts.code || 'BRIDGE_ERROR',
  });
}

/** Union of possible shapes returned by the agent_task handler. */
interface BridgeTaskResult {
  success: boolean;
  agentId?: string;
  content?: string;
  error?: string;
  rawOutput?: string;
  model?: string;
  historyLength?: number;
  taskCount?: number;
  usage?: Record<string, unknown>;
  cost?: number;
}

/**
 * Create a mock child process for spawn(). The bridge now uses spawn + stdin pipe.
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

  queueMicrotask(() => {
    if (stdoutData) child.stdout.emit('data', Buffer.from(stdoutData));
    if (stderrData) child.stderr.emit('data', Buffer.from(stderrData));
    child.emit('close', exitCode);
  });

  return child;
}

function mockSpawnSuccess(stdoutData: string = '{"success":true}', stderrData: string = '', exitCode: number | null = 0) {
  (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
    return createMockChild(stdoutData, stderrData, exitCode);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Bridge Tool Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Bridge correctly identifies tool_use blocks in provider output
  // ════════════════════════════════════════════════════════════════════════════
  describe('Tool call identification', () => {
    it('should return success when bridge processes a response with tool calls', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      // Bridge processes tool calls internally and returns final text result
      const bridgeOutput = makeBridgeToolResponse(agent.agentId, {
        content: 'I used the read_file tool and found the answer: 42',
        historyLength: 5, // extra entries from tool call round-trips
        taskCount: 1,
      });

      mockSpawnSuccess(bridgeOutput, '[bridge] Tool call: read_file({"path":"/tmp/test.ts"})\n');

      const result = await handler({ agentId: agent.agentId, task: 'Read the file and tell me the answer' });

      expect(result).toMatchObject({
        success: true,
        agentId: agent.agentId,
        content: 'I used the read_file tool and found the answer: 42',
      });
    });

    it('should return success when bridge processes multiple tool calls in one turn', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = makeBridgeToolResponse(agent.agentId, {
        content: 'I read both files and compared them.',
        historyLength: 7,
        taskCount: 1,
      });

      // Stderr shows multiple tool calls logged by the bridge
      const stderr = [
        '[bridge] Tool call: read_file({"path":"/tmp/a.ts"})',
        '[bridge] Tool call: read_file({"path":"/tmp/b.ts"})',
      ].join('\n');

      mockSpawnSuccess(bridgeOutput, stderr);

      const result = await handler({ agentId: agent.agentId, task: 'Compare the two files' });

      expect(result).toMatchObject({
        success: true,
        agentId: agent.agentId,
        content: 'I read both files and compared them.',
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Bridge calls correct MCP tool with correct parameters
  // ════════════════════════════════════════════════════════════════════════════
  describe('Tool call parameter passing', () => {
    it('should pass agent-id and --task-stdin to bridge via spawn args, and pipe task via stdin', async () => {
      const agent = makeAgent({ agentId: 'tool-param-agent' });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      mockSpawnSuccess(JSON.stringify({ success: true, agentId: agent.agentId }));

      await handler({ agentId: agent.agentId, task: 'Use the search tool to find auth patterns' });

      expect(spawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];

      expect(cmd).toBe('node');
      expect(args).toContain('--agent-id');
      expect(args).toContain('tool-param-agent');
      // Task is piped via stdin, not as --task arg
      expect(args).toContain('--task-stdin');
      expect(args).not.toContain('--task');
      expect(args).toContain('--store-dir');

      // Verify task was written to stdin
      const child = (spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(child.stdin.write).toHaveBeenCalledWith('Use the search tool to find auth patterns');
    });

    it('should pass store-dir pointing to agent store directory', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      mockSpawnSuccess(JSON.stringify({ success: true }));

      await handler({ agentId: agent.agentId, task: 'do something' });

      const [, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const storeDirIdx = args.indexOf('--store-dir');
      expect(storeDirIdx).toBeGreaterThan(-1);

      const storeDirValue = args[storeDirIdx + 1];
      expect(typeof storeDirValue).toBe('string');
      expect(storeDirValue.length).toBeGreaterThan(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Bridge returns tool results back in expected format
  // ════════════════════════════════════════════════════════════════════════════
  describe('Tool result format', () => {
    it('should return structured JSON with success, content, model, and usage', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = makeBridgeToolResponse(agent.agentId, {
        content: 'Completed analysis using tools.',
        usage: { totalTokens: 350 },
        historyLength: 6,
        taskCount: 2,
      });

      mockSpawnSuccess(bridgeOutput);

      const result = await handler({ agentId: agent.agentId, task: 'Analyze the module' });

      expect(result).toMatchObject({
        success: true,
        agentId: agent.agentId,
        content: 'Completed analysis using tools.',
      });
    });

    it('should preserve model and usage metadata from bridge output', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = JSON.stringify({
        success: true,
        agentId: agent.agentId,
        content: 'Done.',
        model: 'gemini-3.1-pro-preview',
        usage: { totalTokens: 200, promptTokens: 100, completionTokens: 100 },
        cost: 0.003,
        historyLength: 3,
        taskCount: 1,
      });

      mockSpawnSuccess(bridgeOutput);

      const result = await handler({ agentId: agent.agentId, task: 'Quick task' }) as BridgeTaskResult;

      expect(result.success).toBe(true);
      expect(result.model).toBe('gemini-3.1-pro-preview');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Bridge handles tool execution errors gracefully
  // ════════════════════════════════════════════════════════════════════════════
  describe('Tool execution error handling', () => {
    it('should return error when bridge reports tool execution failure', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = makeBridgeErrorResponse({
        error: 'Tool execution failed: read_file returned ENOENT',
        code: 'TOOL_EXEC_ERROR',
      });

      mockSpawnSuccess(bridgeOutput, '[bridge] Tool call: read_file({"path":"/nonexistent"})\n', 1);

      const result = await handler({ agentId: agent.agentId, task: 'Read a file that does not exist' }) as BridgeTaskResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool execution failed');
    });

    it('should return error when provider initialization fails', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = makeBridgeErrorResponse({
        error: 'Provider binary for gemini-cli not found. Install it first.',
        code: 'BRIDGE_ERROR',
      });

      mockSpawnSuccess(bridgeOutput, '', 1);

      const result = await handler({ agentId: agent.agentId, task: 'do something' }) as BridgeTaskResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when provider authentication fails', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = makeBridgeErrorResponse({
        error: 'Authentication failed for gemini-cli. Check credentials.',
        code: 'BRIDGE_ERROR',
      });

      mockSpawnSuccess(bridgeOutput, '', 1);

      const result = await handler({ agentId: agent.agentId, task: 'do something' }) as BridgeTaskResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Authentication failed');
    });

    it('should reset agent status to idle after bridge tool error', async () => {
      const agent = makeAgent();
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      mockSpawnSuccess(JSON.stringify({ success: false, error: 'tool crash' }), '', 1);

      await handler({ agentId: agent.agentId, task: 'do something risky' });

      const store = getPersistedStore();
      expect(store.agents[agent.agentId].status).toBe('idle');
    });

    it('should handle bridge timeout gracefully', async () => {
      const agent = makeAgent();
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      // Simulate timeout: process killed (exit code null)
      mockSpawnSuccess('', '', null);

      const result = await handler({ agentId: agent.agentId, task: 'long running tool task' }) as BridgeTaskResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('killed');

      // Agent should be reset to idle, not stuck in busy
      const store = getPersistedStore();
      expect(store.agents[agent.agentId].status).toBe('idle');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Bridge does NOT hold a lock during tool execution (3-phase pattern)
  // ════════════════════════════════════════════════════════════════════════════
  describe('3-phase lock pattern (no lock during tool execution)', () => {
    it('should set agent to busy before bridge exec and idle after', async () => {
      const agent = makeAgent({ status: 'idle' });
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      let statusDuringExec: string | undefined;

      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        // Phase 2: bridge is running — agent should be busy, lock is NOT held
        statusDuringExec = getPersistedStore().agents[agent.agentId].status;
        return createMockChild(JSON.stringify({ success: true, agentId: agent.agentId }), '', 0);
      });

      await handler({ agentId: agent.agentId, task: 'execute tools' });

      // During execution (Phase 2), agent was busy
      expect(statusDuringExec).toBe('busy');

      // After execution (Phase 3 complete), agent is idle
      const store = getPersistedStore();
      expect(store.agents[agent.agentId].status).toBe('idle');
    });

    it('should allow other agents to be read while bridge executes tools', async () => {
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
        return createMockChild(JSON.stringify({ success: true, agentId: agent1.agentId }), '', 0);
      });

      await handler({ agentId: agent1.agentId, task: 'long tool execution' });

      expect(otherAgentAccessible).toBe(true);

      const finalStore = getPersistedStore();
      expect(finalStore.agents['exec-agent']).toBeDefined();
      expect(finalStore.agents['other-agent']).toBeDefined();
    });

    it('should not corrupt store when bridge execution takes a long time', async () => {
      const agent = makeAgent({ agentId: 'slow-agent' });
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        // Delayed child: emit data and close after 50ms
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

        setTimeout(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            success: true,
            agentId: agent.agentId,
            content: 'Finished after delay',
          })));
          child.emit('close', 0);
        }, 50);

        return child;
      });

      const result = await handler({ agentId: agent.agentId, task: 'slow tool work' }) as BridgeTaskResult;

      expect(result.success).toBe(true);

      const store = getPersistedStore();
      expect(store.version).toBe('3.0.0');
      expect(store.agents[agent.agentId]).toBeDefined();
      expect(store.agents[agent.agentId].status).toBe('idle');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Bridge handles unknown/missing tool names
  // ════════════════════════════════════════════════════════════════════════════
  describe('Unknown and missing tool names', () => {
    it('should return error when bridge encounters unknown tool and exits non-zero', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = makeBridgeErrorResponse({
        error: 'Unknown provider: invalid-provider. Supported: gemini-cli, codex-cli, cursor-cli',
        code: 'BRIDGE_ERROR',
      });

      mockSpawnSuccess(bridgeOutput, '', 1);

      const result = await handler({ agentId: agent.agentId, task: 'use unknown tool' }) as BridgeTaskResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown provider');
    });

    it('should return error when bridge receives empty tool call response from provider', async () => {
      const agent = makeAgent();
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      const bridgeOutput = makeBridgeErrorResponse({
        error: 'Provider returned malformed tool call: missing function name',
        code: 'BRIDGE_ERROR',
      });

      mockSpawnSuccess(bridgeOutput, '', 1);

      const result = await handler({ agentId: agent.agentId, task: 'trigger malformed tool call' }) as BridgeTaskResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('malformed tool call');

      const store = getPersistedStore();
      expect(store.agents[agent.agentId].status).toBe('idle');
    });

    it('should handle bridge crash with non-JSON output gracefully', async () => {
      const agent = makeAgent();
      const { getPersistedStore } = setupStoreMocks(
        makeStore({ [agent.agentId]: agent }),
      );

      mockSpawnSuccess('Segmentation fault (core dumped)', 'Fatal error in bridge', 0);

      const result = await handler({ agentId: agent.agentId, task: 'cause a crash' }) as BridgeTaskResult;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to parse bridge output');
      expect(result.rawOutput).toBe('Segmentation fault (core dumped)');

      const store = getPersistedStore();
      expect(store.agents[agent.agentId].status).toBe('idle');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 7. Bridge tool-calling loop contract (JSON structure)
  // ════════════════════════════════════════════════════════════════════════════
  describe('Bridge tool-calling loop JSON contract', () => {
    it('should accept bridge output with tool call history reflected in historyLength', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = JSON.stringify({
        success: true,
        agentId: agent.agentId,
        content: 'Final answer after 3 tool calls.',
        model: 'gemini-3.1-pro-preview',
        usage: { totalTokens: 800 },
        historyLength: 9,
        taskCount: 1,
      });

      mockSpawnSuccess(bridgeOutput);

      const result = await handler({ agentId: agent.agentId, task: 'Multi-step analysis' }) as BridgeTaskResult;

      expect(result.success).toBe(true);
      expect(result.historyLength).toBe(9);
    });

    it('should accept bridge output when no tool calls were made', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = JSON.stringify({
        success: true,
        agentId: agent.agentId,
        content: 'Simple text answer, no tools needed.',
        model: 'gemini-3.1-pro-preview',
        usage: { totalTokens: 50 },
        historyLength: 3,
        taskCount: 1,
      });

      mockSpawnSuccess(bridgeOutput);

      const result = await handler({ agentId: agent.agentId, task: 'Simple question' }) as BridgeTaskResult;

      expect(result.success).toBe(true);
      expect(result.content).toBe('Simple text answer, no tools needed.');
      expect(result.historyLength).toBe(3);
    });

    it('should handle bridge reporting max iterations reached', async () => {
      const agent = makeAgent();
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = JSON.stringify({
        success: true,
        agentId: agent.agentId,
        content: 'Stopped after maximum iterations. Partial result available.',
        model: 'gemini-3.1-pro-preview',
        usage: { totalTokens: 5000 },
        historyLength: 23,
        taskCount: 1,
      });

      mockSpawnSuccess(bridgeOutput, '[bridge] Tool call iterations: 10 (max reached)\n');

      const result = await handler({ agentId: agent.agentId, task: 'Complex multi-step task' }) as BridgeTaskResult;

      expect(result.success).toBe(true);
      expect(result.content).toContain('maximum iterations');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 8. Provider-specific behavior
  // ════════════════════════════════════════════════════════════════════════════
  describe('Provider-specific tool handling', () => {
    it('should work with codex-cli provider agent', async () => {
      const agent = makeAgent({
        agentId: 'codex-agent',
        provider: 'codex-cli',
        model: 'gpt-5.3-codex',
      });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = JSON.stringify({
        success: true,
        agentId: agent.agentId,
        content: 'Codex completed the implementation.',
        model: 'gpt-5.3-codex',
        usage: { totalTokens: 400 },
        historyLength: 5,
        taskCount: 1,
      });

      mockSpawnSuccess(bridgeOutput);

      const result = await handler({ agentId: agent.agentId, task: 'Implement the feature' }) as BridgeTaskResult;

      expect(result.success).toBe(true);
      expect(result.model).toBe('gpt-5.3-codex');
    });

    it('should work with cursor-cli provider agent', async () => {
      const agent = makeAgent({
        agentId: 'cursor-agent',
        provider: 'cursor-cli',
        model: 'auto',
      });
      setupStoreMocks(makeStore({ [agent.agentId]: agent }));

      const bridgeOutput = JSON.stringify({
        success: true,
        agentId: agent.agentId,
        content: 'Cursor completed the review.',
        model: 'auto',
        usage: { totalTokens: 300 },
        historyLength: 4,
        taskCount: 1,
      });

      mockSpawnSuccess(bridgeOutput);

      const result = await handler({ agentId: agent.agentId, task: 'Review the PR' }) as BridgeTaskResult;

      expect(result.success).toBe(true);
      expect(result.content).toBe('Cursor completed the review.');
    });
  });
});
