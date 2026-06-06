import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:url', () => ({
  fileURLToPath: vi.fn(() => '/fake/dist/src/mcp-tools/agent-tools.js'),
}));

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
      if (model === 'mini' || model === 'sonnet') return 'moonshotai/kimi-k2.6';
      if (model === 'xiaomi/mimo-v2.5-pro') return 'xiaomi/mimo-v2.5-pro';
      return undefined;
    }
    if (provider === 'deepseek') return model === 'mini' ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
    return model;
  }),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { providerKeyPreflight } from '../mcp-tools/provider-key-preflight.js';
import { agentTools } from '../mcp-tools/agent-tools.js';

const agentSpawnTool = agentTools.find((tool) => tool.name === 'agent_spawn')!;
const agentTaskTool = agentTools.find((tool) => tool.name === 'agent_task')!;
const EXPECTED_BRIDGE_PATH = '/providers/scripts/provider-agent-bridge.mjs';

interface AgentRecord {
  agentId: string;
  agentType: string;
  status: 'spawning' | 'idle' | 'busy' | 'terminated';
  health: number;
  taskCount: number;
  config: Record<string, unknown>;
  createdAt: string;
  provider?: string;
  model?: string;
  resolvedModel?: string;
}

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'test-openrouter-agent',
    agentType: 'coder',
    status: 'idle',
    health: 1,
    taskCount: 0,
    config: {},
    createdAt: new Date().toISOString(),
    provider: 'openrouter',
    model: 'inherit',
    resolvedModel: 'moonshotai/kimi-k2.6',
    ...overrides,
  };
}

function makeStore(agents: Record<string, AgentRecord> = {}) {
  return { agents, version: '3.0.0' };
}

function setupStoreMocks(initialStore: ReturnType<typeof makeStore>) {
  let currentStore = JSON.parse(JSON.stringify(initialStore));
  const tmpWrites = new Map<string, string>();

  vi.mocked(existsSync).mockImplementation((path: string) => {
    if (typeof path === 'string' && path.endsWith('store.json')) return true;
    if (path === EXPECTED_BRIDGE_PATH) return true;
    return false;
  });

  vi.mocked(readFileSync).mockImplementation(() => JSON.stringify(currentStore));
  vi.mocked(writeFileSync).mockImplementation((path: string, data: string) => {
    if (typeof path === 'string' && path.includes('.tmp.')) {
      tmpWrites.set(path, data);
      return;
    }
    try {
      currentStore = JSON.parse(data);
    } catch {
      // task/result artifacts are tracked by the test via mock calls.
    }
  });
  vi.mocked(renameSync).mockImplementation((src: string) => {
    const data = tmpWrites.get(src);
    if (!data) return;
    currentStore = JSON.parse(data);
    tmpWrites.delete(src);
  });
  vi.mocked(mkdirSync).mockImplementation(() => undefined);

  return {
    getPersistedStore: () => currentStore as ReturnType<typeof makeStore>,
  };
}

function withoutProviderKeys() {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
}

describe('PH-B8 provider-key preflight', () => {
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    withoutProviderKeys();
  });

  afterEach(() => {
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey;
  });

  it('blocks openrouter when OPENROUTER_API_KEY is missing', () => {
    const result = providerKeyPreflight('openrouter', {});

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/OPENROUTER_API_KEY/);
  });

  it('lets deepseek degrade when DEEPSEEK_API_KEY is missing', () => {
    const result = providerKeyPreflight('deepseek', {});

    expect(result).toMatchObject({
      ok: true,
      degraded: true,
    });
    expect(result.warning).toMatch(/DEEPSEEK_API_KEY/);
  });

  it('allows openrouter when OPENROUTER_API_KEY is present', () => {
    const result = providerKeyPreflight('openrouter', {
      OPENROUTER_API_KEY: 'test-openrouter-key',
    });

    expect(result).toEqual({ ok: true });
  });

  it('uses only the injected env object, not ambient process.env', () => {
    process.env.OPENROUTER_API_KEY = 'ambient-openrouter-key';

    const result = providerKeyPreflight('openrouter', {});

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/OPENROUTER_API_KEY/);
  });

  it('keeps openrouter preflight pure across arbitrary injected env objects', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[A-Z_][A-Z0-9_]*$/),
          fc.oneof(fc.string(), fc.constant(undefined)),
        ),
        (env) => {
          const before = { ...env };

          const result = providerKeyPreflight('openrouter', env);

          expect(env).toEqual(before);
          const hasKey = typeof env.OPENROUTER_API_KEY === 'string'
            && env.OPENROUTER_API_KEY.trim().length > 0;
          expect(result.ok).toBe(hasKey);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('fails fast at agent_spawn for openrouter without creating a persisted agent', async () => {
    const { getPersistedStore } = setupStoreMocks(makeStore());

    const result = await agentSpawnTool.handler({
      agentType: 'reviewer',
      provider: 'openrouter',
      model: 'mini',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/OPENROUTER_API_KEY/),
    });
    expect(Object.keys(getPersistedStore().agents)).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails fast at agent_task before spawning the provider bridge for a legacy openrouter agent without a key', async () => {
    const agent = makeAgent();
    setupStoreMocks(makeStore({ [agent.agentId]: agent }));

    const result = await agentTaskTool.handler({
      agentId: agent.agentId,
      task: 'write code',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: false,
      agentId: agent.agentId,
      error: expect.stringMatching(/OPENROUTER_API_KEY/),
    });
    expect(spawn).not.toHaveBeenCalled();

    const writes = vi.mocked(writeFileSync).mock.calls;
    expect(writes.some(([path]) => typeof path === 'string' && path.endsWith('.task'))).toBe(false);
    expect(writes.some(([path]) => typeof path === 'string' && path.endsWith('.result.json'))).toBe(false);
    expect(writes.some(([path]) => typeof path === 'string' && path.includes('--store-dir'))).toBe(false);
  });
});
