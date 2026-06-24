import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import type { AgentRecord, AgentStore } from '../agent-tools.js';

const mockAgentState = vi.hoisted(() => {
  const state: { store: AgentStore } = {
    store: { agents: {}, version: '3.0.0' },
  };
  return state;
});

vi.mock('../agent-tools.js', () => {
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
    agentTools: [],
    loadAgentStore: () => mockAgentState.store,
    saveAgentStore: (store: AgentStore) => { mockAgentState.store = store; },
    withStoreLock: async (scopeOrFn: string | (() => unknown), maybeFn?: () => unknown) => {
      const fn = typeof scopeOrFn === 'function' ? scopeOrFn : maybeFn!;
      return fn();
    },
    transitionAgent: (agent: AgentRecord, status: AgentRecord['status']) => {
      agent.status = status;
      return true;
    },
    propagateEnforcementToSubAgent: async () => undefined,
    __makeAgent: makeAgent,
  };
});

import { queenTools } from '../queen-tools.js';
import { loadHive } from '../hive-store.js';
import { normalizeClientKind, resolveClientKind, resolveSessionId } from '../session-id.js';
import { setWorkflowHookDispatcher } from '../workflow-executor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../../../../..');
const requireFromHere = createRequire(import.meta.url);
const cjsSession = requireFromHere(join(repoRoot, '.claude/helpers/session-id.cjs')) as {
  resolveSessionId: (
    input?: Record<string, unknown> | null,
    env?: Record<string, string | undefined>,
    context?: Record<string, unknown> | null,
  ) => string | null;
};

const originalCwd = process.cwd();
const originalEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
  CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
  HIVE_FLOW_SESSION_ID: process.env.HIVE_FLOW_SESSION_ID,
  CURSOR_SESSION_ID: process.env.CURSOR_SESSION_ID,
  AGENT_SESSION_ID: process.env.AGENT_SESSION_ID,
  ANTIGRAVITY_SESSION_ID: process.env.ANTIGRAVITY_SESSION_ID,
  AGY_SESSION_ID: process.env.AGY_SESSION_ID,
  OPENCODE_SESSION_ID: process.env.OPENCODE_SESSION_ID,
  FORGECODE_SESSION_ID: process.env.FORGECODE_SESSION_ID,
  FORGE_SESSION_ID: process.env.FORGE_SESSION_ID,
};

let root = '';

function resetAgentStore(): void {
  mockAgentState.store = {
    version: '3.0.0',
    agents: {
      'queen-1': {
        agentId: 'queen-1',
        agentType: 'queen',
        status: 'idle',
        health: 100,
        taskCount: 0,
        config: {},
        createdAt: new Date(0).toISOString(),
        provider: 'codex-cli',
        model: 'sonnet',
      },
    },
  };
}

function getQueenTool(name: string) {
  const tool = queenTools.find(t => t.name === name);
  if (!tool) throw new Error(`Missing queen tool ${name}`);
  return tool;
}

function loadWatcherModule() {
  const script = join(repoRoot, 'scripts', 'hive-watcher.cjs');
  const source = readFileSync(script, 'utf8').replace(/\nmain\(\)\.catch\([\s\S]*$/, '\n');
  const module = { exports: {} as Record<string, unknown> };
  const context = {
    require: createRequire(pathToFileURL(script)),
    module,
    exports: module.exports,
    __filename: script,
    __dirname: dirname(script),
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(
    `${source}
module.exports = {
  parseArgs,
  getPaths,
  writeDoneMarker,
  appendPendingCompletion,
};
`,
    context,
    { filename: script },
  );

  return module.exports as {
    parseArgs: (argv?: string[], env?: Record<string, string | undefined>) => {
      hiveId: string | null;
      sessionId: string | null;
      tmuxPane: string | null;
      projectDir: string;
    };
    getPaths: (projectDir: string) => { dataDir: string };
    writeDoneMarker: (
      paths: { dataDir: string },
      hiveId: string,
      status: Record<string, unknown>,
      ownerSessionId?: string | null,
    ) => void;
    appendPendingCompletion: (
      paths: { dataDir: string },
      hiveId: string,
      status: Record<string, unknown>,
      summary: string,
      ownerSessionId?: string | null,
    ) => void;
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'r-sid-'));
  process.chdir(root);
  process.env.CLAUDE_PROJECT_DIR = root;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CURSOR_SESSION_ID;
  delete process.env.AGENT_SESSION_ID;
  delete process.env.ANTIGRAVITY_SESSION_ID;
  delete process.env.AGY_SESSION_ID;
  delete process.env.OPENCODE_SESSION_ID;
  delete process.env.FORGECODE_SESSION_ID;
  delete process.env.FORGE_SESSION_ID;
  process.env.CLAUDE_SESSION_ID = 'env-session';
  process.env.HIVE_FLOW_SESSION_ID = 'provider-session';
  resetAgentStore();
  setWorkflowHookDispatcher(null);
});

afterEach(() => {
  setWorkflowHookDispatcher(null);
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key as keyof typeof originalEnv];
    } else {
      process.env[key as keyof typeof originalEnv] = value;
    }
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('R-sid multi-session enabler', () => {
  it('keeps CJS and TS resolveSessionId behavior in parity', () => {
    const cases: Array<{
      input?: Record<string, unknown> | null;
      env?: Record<string, string | undefined>;
      context?: Record<string, unknown> | null;
      expected: string | null;
    }> = [
      {
        input: { session_id: 'payload-session' },
        env: { CODEX_SESSION_ID: 'codex-session', CLAUDE_SESSION_ID: 'env-session', HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'payload-session',
      },
      {
        input: {},
        env: { CODEX_SESSION_ID: 'codex-session', CODEX_THREAD_ID: 'codex-thread', CLAUDE_SESSION_ID: 'env-session', HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'codex-session',
      },
      {
        input: {},
        env: { CODEX_THREAD_ID: 'codex-thread', CLAUDE_SESSION_ID: 'env-session', HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'codex-thread',
      },
      {
        input: {},
        env: { CLAUDE_SESSION_ID: 'env-session', HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'env-session',
      },
      {
        input: {},
        env: { OPENCODE_SESSION_ID: 'opencode-parent-session', CLAUDE_SESSION_ID: 'claude-session' },
        context: { sessionId: 'context-session' },
        expected: 'opencode-parent-session',
      },
      {
        input: {},
        env: { AGENT_SESSION_ID: 'generic-agent-session', CLAUDE_SESSION_ID: 'claude-session' },
        context: { sessionId: 'context-session' },
        expected: 'claude-session',
      },
      {
        input: null,
        env: { HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'provider-session',
      },
      {
        input: {},
        env: { AGENT_SESSION_ID: 'cursor-parent-session', HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'cursor-parent-session',
      },
      {
        input: {},
        env: { AGY_SESSION_ID: 'antigravity-parent-session', HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'antigravity-parent-session',
      },
      {
        input: {},
        env: { OPENCODE_SESSION_ID: 'opencode-parent-session', HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'opencode-parent-session',
      },
      {
        input: {},
        env: { FORGE_SESSION_ID: 'forge-parent-session', HIVE_FLOW_SESSION_ID: 'provider-session' },
        context: { sessionId: 'context-session' },
        expected: 'forge-parent-session',
      },
      {
        input: {},
        env: {},
        context: { sessionId: 'context-session' },
        expected: 'context-session',
      },
      {
        input: {},
        env: {},
        context: { sessionId: 'mcp-1790000000000-deadbeef' },
        expected: null,
      },
      {
        input: { session_id: '../bad.session' },
        env: { CLAUDE_SESSION_ID: 'ignored' },
        context: { sessionId: 'context-session' },
        expected: 'bad_session',
      },
      {
        input: {},
        env: {},
        expected: null,
      },
    ];

    for (const testCase of cases) {
      expect(resolveSessionId(testCase.input, testCase.env, testCase.context)).toBe(testCase.expected);
      expect(cjsSession.resolveSessionId(testCase.input, testCase.env, testCase.context)).toBe(testCase.expected);
    }
  });

  it('resolves operator client kind from explicit input, MCP context, then environment markers', () => {
    expect(normalizeClientKind('claude-code')).toBe('claude');
    expect(normalizeClientKind('codex-cli')).toBe('codex');
    expect(normalizeClientKind('gemini-cli')).toBe('gemini');
    expect(normalizeClientKind('cursor-agent')).toBe('cursor');
    expect(normalizeClientKind('agent')).toBe('cursor');
    expect(normalizeClientKind('agy')).toBe('antigravity');
    expect(normalizeClientKind('antigravity-cli')).toBe('antigravity');
    expect(normalizeClientKind('open-code')).toBe('opencode');
    expect(normalizeClientKind('forge')).toBe('forgecode');
    expect(normalizeClientKind('not-a-client')).toBe('unknown');

    expect(resolveClientKind(
      { client_kind: 'codex' },
      { HIVE_FLOW_CLIENT_KIND: 'claude-code', CLAUDE_SESSION_ID: 'claude-session' },
      { clientKind: 'cursor' },
    )).toBe('codex');

    expect(resolveClientKind(
      {},
      { HIVE_FLOW_CLIENT_KIND: 'claude-code', CLAUDE_SESSION_ID: 'claude-session' },
      { clientKind: 'cursor' },
    )).toBe('cursor');

    expect(resolveClientKind(
      {},
      { HIVE_FLOW_CLIENT_KIND: 'gemini' },
      {},
    )).toBe('gemini');

    expect(resolveClientKind(
      {},
      { CODEX_THREAD_ID: 'codex-thread', CLAUDE_SESSION_ID: 'claude-session' },
      {},
    )).toBe('codex');

    expect(resolveClientKind(
      {},
      { CURSOR_SESSION_ID: 'cursor-session', CLAUDE_SESSION_ID: 'claude-session' },
      {},
    )).toBe('cursor');

    expect(resolveClientKind(
      {},
      { AGENT_SESSION_ID: 'generic-agent-session', CLAUDE_SESSION_ID: 'claude-session' },
      {},
    )).toBe('claude');

    expect(resolveClientKind(
      {},
      { AGY_SESSION_ID: 'antigravity-session', CLAUDE_SESSION_ID: 'claude-session' },
      {},
    )).toBe('antigravity');

    expect(resolveClientKind(
      {},
      { OPENCODE_SESSION_ID: 'opencode-session', CLAUDE_SESSION_ID: 'claude-session' },
      {},
    )).toBe('opencode');

    expect(resolveClientKind(
      {},
      { FORGE_SESSION_ID: 'forge-session', CLAUDE_SESSION_ID: 'claude-session' },
      {},
    )).toBe('forgecode');

    expect(resolveClientKind(
      {},
      { CLAUDE_PROJECT_DIR: '/repo' },
      {},
    )).toBe('claude');

    expect(resolveClientKind({}, {}, {})).toBe('unknown');
  });

  it('stamps ownerSessionId and ignores deprecated pane inputs during queen_mission_assign', async () => {
    const result = await getQueenTool('queen_mission_assign').handler({
      queenId: 'queen-1',
      scope: 'R-sid mission',
      description: 'Verify owner session stamping',
      session_id: 'payload-session',
      ownerTmuxPane: '%42',
      tmuxPane: '%43',
    }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    const hive = loadHive(String(result.hiveId));
    expect(hive?.ownerSessionId).toBe('payload-session');
    expect(hive).not.toHaveProperty('ownerTmuxPane');
  });

  it('stamps ownerSessionId from MCP context when queen_mission_assign has no caller session env', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const result = await getQueenTool('queen_mission_assign').handler({
      queenId: 'queen-1',
      scope: 'R-sid context mission',
      description: 'Verify context owner session fallback',
    }, { sessionId: 'context-session' }) as Record<string, unknown>;

    expect(result.success).toBe(true);
    const hive = loadHive(String(result.hiveId));
    expect(hive?.ownerSessionId).toBe('context-session');
  });

  it('refuses generated MCP transport ids as queen_mission_assign owner identity', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const result = await getQueenTool('queen_mission_assign').handler({
      queenId: 'queen-1',
      scope: 'ownerless transport mission',
      description: 'Verify generated mcp ids do not become hive owners',
    }, { sessionId: 'mcp-1790000000000-deadbeef' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('owner session');
  });

  it('refuses queen_mission_assign when no owner session can be resolved', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const result = await getQueenTool('queen_mission_assign').handler({
      queenId: 'queen-1',
      scope: 'ownerless mission',
      description: 'Verify ownerless hives cannot be created',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('owner session');
    expect(result.hiveId).toBeUndefined();
  });

  it('threads watcher --sessionId into parsed config and completion payloads while preserving null fallback', () => {
    const watcher = loadWatcherModule();
    const parsed = watcher.parseArgs(
      ['hive-owned', '--project-dir', root, '--sessionId', '../watcher.session', '--queenId', 'queen-1'],
      {},
    );
    expect(parsed.hiveId).toBe('hive-owned');
    expect(parsed.sessionId).toBe('watcher_session');

    const fallback = watcher.parseArgs(['hive-owned', '--project-dir', root], {});
    expect(fallback.sessionId).toBe(null);

    const paths = watcher.getPaths(root);
    watcher.writeDoneMarker(paths, 'hive-owned', {
      completedCount: 1,
      failedCount: 0,
    }, parsed.sessionId);
    const done = JSON.parse(readFileSync(join(paths.dataDir, 'hive-hive-owned.done'), 'utf8'));
    expect(done.ownerSessionId).toBe('watcher_session');

    watcher.appendPendingCompletion(paths, 'hive-pending', {
      completedCount: 1,
      failedCount: 0,
      idleCount: 0,
      terminatedCount: 0,
    }, 'completed=1 failed=0', parsed.sessionId);
    const pending = readFileSync(join(paths.dataDir, 'pending-notifications.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(pending[pending.length - 1]).toMatchObject({
      kind: 'hive',
      hiveId: 'hive-pending',
      ownerSessionId: 'watcher_session',
    });
  });
});
