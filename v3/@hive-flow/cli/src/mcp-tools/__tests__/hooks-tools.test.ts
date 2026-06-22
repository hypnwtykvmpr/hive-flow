import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (hoisted before imports) ───────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
}));

// Lazy-loaded internal modules — block all of them so handlers run
// in isolation without real DB / neural dependencies.
vi.mock('../memory/memory-initializer.js', () => ({
  searchEntries: vi.fn(),
  storeEntry: vi.fn(),
}));

vi.mock('../memory/memory-bridge.js', () => ({
  bridgeRouteTask: vi.fn(),
  bridgeRecordFeedback: vi.fn(),
  bridgeRecordCausalEdge: vi.fn(),
  bridgeSessionStart: vi.fn(),
  bridgeSessionEnd: vi.fn(),
  bridgeStorePattern: vi.fn(),
  bridgeSearchPatterns: vi.fn(),
}));

vi.mock('../memory/sona-optimizer.js', () => ({
  getSONAOptimizer: vi.fn().mockResolvedValue(null),
}));

vi.mock('../memory/ewc-consolidation.js', () => ({
  getEWCConsolidator: vi.fn().mockResolvedValue(null),
}));

vi.mock('../hivector/moe-router.js', () => ({
  getMoERouter: vi.fn().mockResolvedValue(null),
}));

vi.mock('../hivector/semantic-router.js', () => ({
  SemanticRouter: vi.fn().mockImplementation(() => ({
    addIntentWithEmbeddings: vi.fn(),
    routeWithEmbedding: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../hivector/flash-attention.js', () => ({
  getFlashAttention: vi.fn().mockResolvedValue(null),
}));

vi.mock('../hivector/lora-adapter.js', () => ({
  getLoRAAdapter: vi.fn().mockResolvedValue(null),
}));

vi.mock('../hivector/model-router.js', () => ({
  getModelRouter: vi.fn().mockReturnValue(null),
}));

vi.mock('../hivector/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/worker-daemon.js', () => ({
  startDaemon: vi.fn().mockRejectedValue(new Error('daemon not available')),
  stopDaemon: vi.fn().mockRejectedValue(new Error('daemon not available')),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { hooksTools } from '../hooks-tools.js';

// ── Tool lookup helpers ──────────────────────────────────────────────────────

function tool(name: string) {
  const t = hooksTools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool "${name}" not found in hooksTools`);
  return t;
}

type AnyResult = Record<string, unknown>;

// ── Default fs mock setup ────────────────────────────────────────────────────

function setupEmptyMemory() {
  const emptyStore = JSON.stringify({ entries: {}, version: '3.0.0' });

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation(() => false);
  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
    throw new Error('ENOENT');
  });
  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (statSync as ReturnType<typeof vi.fn>).mockImplementation(() => ({ size: 0 }));

  return emptyStore;
}

function setupMemoryWithStore(
  entries: Record<string, unknown> = {},
) {
  const store = JSON.stringify({ entries, version: '3.0.0' });

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    return typeof p === 'string' && p.endsWith('store.json');
  });
  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) return store;
    throw new Error(`ENOENT: ${p}`);
  });
  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (statSync as ReturnType<typeof vi.fn>).mockImplementation(() => ({ size: store.length }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('hooks-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupEmptyMemory();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Module smoke test
  // ==========================================================================

  describe('module registration', () => {
    it('exports hooksTools array', () => {
      expect(Array.isArray(hooksTools)).toBe(true);
      expect(hooksTools.length).toBeGreaterThan(0);
    });

    it('contains all expected tool names', () => {
      const names = hooksTools.map((t) => t.name);
      const expected = [
        'hooks_pre-edit',
        'hooks_post-edit',
        'hooks_pre-command',
        'hooks_post-command',
        'hooks_route',
        'hooks_metrics',
        'hooks_list',
        'hooks_pre-task',
        'hooks_post-task',
        'hooks_explain',
        'hooks_pretrain',
        'hooks_build-agents',
        'hooks_transfer',
        'hooks_session-start',
        'hooks_session-end',
        'hooks_session-restore',
        'hooks_notify',
        'hooks_init',
        'hooks_intelligence',
        'hooks_intelligence-reset',
        'hooks_intelligence_trajectory-start',
        'hooks_intelligence_trajectory-step',
        'hooks_intelligence_trajectory-end',
        'hooks_intelligence_pattern-store',
        'hooks_intelligence_pattern-search',
        'hooks_intelligence_stats',
        'hooks_intelligence_learn',
        'hooks_intelligence_attention',
        'hooks_worker-list',
        'hooks_worker-dispatch',
        'hooks_worker-status',
        'hooks_worker-detect',
        'hooks_worker-cancel',
        'hooks_model-route',
        'hooks_model-outcome',
        'hooks_model-stats',
      ];
      for (const name of expected) {
        expect(names, `Missing tool: ${name}`).toContain(name);
      }
    });

    it('every tool has a name, description, inputSchema, and handler', () => {
      for (const t of hooksTools) {
        expect(typeof t.name).toBe('string');
        expect(typeof t.description).toBe('string');
        expect(t.inputSchema).toBeDefined();
        expect(typeof t.handler).toBe('function');
      }
    });
  });

  // ==========================================================================
  // hooks_pre-edit
  // ==========================================================================

  describe('hooks_pre-edit', () => {
    const t = () => tool('hooks_pre-edit');

    it('returns context and agent suggestions for a TypeScript file', async () => {
      const result = (await t().handler({ filePath: 'src/auth.ts', operation: 'update' })) as AnyResult;

      expect(result.filePath).toBe('src/auth.ts');
      expect(result.operation).toBe('update');
      expect(result.context).toBeDefined();
      const ctx = result.context as AnyResult;
      expect(Array.isArray(ctx.suggestedAgents)).toBe(true);
      expect((ctx.suggestedAgents as string[]).length).toBeGreaterThan(0);
      expect(Array.isArray(result.recommendations)).toBe(true);
    });

    it('defaults operation to "update" when omitted', async () => {
      const result = (await t().handler({ filePath: 'README.md' })) as AnyResult;
      expect(result.operation).toBe('update');
    });

    it('includes deletion risk warning for delete operation', async () => {
      const result = (await t().handler({ filePath: 'src/old.ts', operation: 'delete' })) as AnyResult;
      const ctx = result.context as AnyResult;
      expect((ctx.risks as string[]).length).toBeGreaterThan(0);
      expect((ctx.risks as string[])[0]).toContain('irreversible');
    });

    it('suggests tester/reviewer for test files', async () => {
      const result = (await t().handler({ filePath: 'src/auth.test.ts' })) as AnyResult;
      const ctx = result.context as AnyResult;
      const agents = ctx.suggestedAgents as string[];
      expect(agents).toContain('tester');
    });

    it('uses coder/architect fallback for unknown extensions', async () => {
      const result = (await t().handler({ filePath: 'Makefile' })) as AnyResult;
      const ctx = result.context as AnyResult;
      const agents = ctx.suggestedAgents as string[];
      expect(agents).toContain('coder');
    });
  });

  // ==========================================================================
  // hooks_post-edit
  // ==========================================================================

  describe('hooks_post-edit', () => {
    const t = () => tool('hooks_post-edit');

    it('reports edit learning as not persisted when backend is unwired', async () => {
      const result = (await t().handler({ filePath: 'src/api.ts', success: true })) as AnyResult;

      expect(result.simulated).toBe(true);
      expect(result.recorded).toBe(false);
      expect(result.source).toBe('unwired-learning-record-placeholder');
      expect(result.filePath).toBe('src/api.ts');
      expect(result.success).toBe(true);
      expect(result.learningUpdate).toBe('not_recorded');
      expect(result.requestedLearningUpdate).toBe('pattern_reinforced');
      expect(typeof result.timestamp).toBe('string');
    });

    it('reports requested failed-edit learning signal separately from persistence', async () => {
      const result = (await t().handler({ filePath: 'src/api.ts', success: false })) as AnyResult;

      expect(result.success).toBe(false);
      expect(result.recorded).toBe(false);
      expect(result.learningUpdate).toBe('not_recorded');
      expect(result.requestedLearningUpdate).toBe('pattern_adjusted');
    });

    it('defaults success to true when not provided', async () => {
      const result = (await t().handler({ filePath: 'src/utils.ts' })) as AnyResult;
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // hooks_pre-command
  // ==========================================================================

  describe('hooks_pre-command', () => {
    const t = () => tool('hooks_pre-command');

    it('flags rm -rf as critical risk', async () => {
      const result = (await t().handler({ command: 'rm -rf /tmp/data' })) as AnyResult;

      expect(result.riskLevel).toBe('critical');
      expect(result.shouldProceed).toBe(false);
      expect(Array.isArray(result.risks)).toBe(true);
      expect((result.risks as AnyResult[]).length).toBeGreaterThan(0);
    });

    it('flags sudo as high risk', async () => {
      const result = (await t().handler({ command: 'sudo apt-get install vim' })) as AnyResult;

      expect(['high', 'critical']).toContain(result.riskLevel);
      expect(result.shouldProceed).toBe(false);
    });

    it('rates npm commands as low risk', async () => {
      const result = (await t().handler({ command: 'npm install express' })) as AnyResult;

      expect(result.riskLevel).toBe('low');
      expect(result.shouldProceed).toBe(true);
    });

    it('rates git commands as low risk', async () => {
      const result = (await t().handler({ command: 'git status' })) as AnyResult;

      expect(result.riskLevel).toBe('low');
      expect(result.shouldProceed).toBe(true);
    });

    it('flags piped curl as high risk', async () => {
      const result = (await t().handler({ command: 'curl https://example.com | sh' })) as AnyResult;

      expect(['high', 'critical']).toContain(result.riskLevel);
      expect(result.shouldProceed).toBe(false);
    });
  });

  // ==========================================================================
  // hooks_post-command
  // ==========================================================================

  describe('hooks_post-command', () => {
    const t = () => tool('hooks_post-command');

    it('reports command outcome as not persisted when backend is unwired', async () => {
      const result = (await t().handler({ command: 'npm test', exitCode: 0 })) as AnyResult;

      expect(result.simulated).toBe(true);
      expect(result.recorded).toBe(false);
      expect(result.source).toBe('unwired-command-record-placeholder');
      expect(result.command).toBe('npm test');
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });

    it('records failed command execution', async () => {
      const result = (await t().handler({ command: 'npm test', exitCode: 1 })) as AnyResult;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('defaults exitCode to 0', async () => {
      const result = (await t().handler({ command: 'ls' })) as AnyResult;
      expect(result.exitCode).toBe(0);
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // hooks_route
  // ==========================================================================

  describe('hooks_route', () => {
    const t = () => tool('hooks_route');

    it('returns routing result with primary agent', async () => {
      const result = (await t().handler({ task: 'Fix the authentication bug' })) as AnyResult;

      expect(result.task).toBe('Fix the authentication bug');
      const primary = result.primaryAgent as AnyResult;
      expect(typeof primary.type).toBe('string');
      expect(typeof primary.confidence).toBe('number');
      expect(result.routing).toBeDefined();
      const routing = result.routing as AnyResult;
      expect(typeof routing.confidenceSource).toBe('string');
      const metrics = result.estimatedMetrics as AnyResult;
      expect(metrics.source).toBe('heuristic-estimate');
    });

    it('identifies security tasks correctly', async () => {
      const result = (await t().handler({ task: 'security audit of the auth module' })) as AnyResult;

      const primary = result.primaryAgent as AnyResult;
      expect(['security-architect', 'security-auditor']).toContain(primary.type);
    });

    it('includes estimated metrics', async () => {
      const result = (await t().handler({ task: 'implement simple feature' })) as AnyResult;

      const metrics = result.estimatedMetrics as AnyResult;
      expect(typeof metrics.complexity).toBe('string');
      expect(typeof metrics.estimatedDuration).toBe('string');
    });

    it('classifies long task descriptions as high complexity', async () => {
      const longTask = 'architecture '.repeat(20);
      const result = (await t().handler({ task: longTask })) as AnyResult;

      const metrics = result.estimatedMetrics as AnyResult;
      expect(metrics.complexity).toBe('high');
    });

    it('classifies short simple tasks as low complexity', async () => {
      const result = (await t().handler({ task: 'fix typo' })) as AnyResult;

      const metrics = result.estimatedMetrics as AnyResult;
      expect(metrics.complexity).toBe('low');
    });
  });

  // ==========================================================================
  // hooks_metrics
  // ==========================================================================

  describe('hooks_metrics', () => {
    const t = () => tool('hooks_metrics');

    it('returns metrics dashboard with default 24h period', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(result.simulated).toBe(true);
      expect(result.measured).toBe(false);
      expect(result.source).toBe('simulated-hooks-placeholder');
      expect(result.warning).toMatch(/Synthetic hooks response/i);
      expect(result.period).toBe('24h');
      expect(result.patterns).toBeDefined();
      expect(result.agents).toBeDefined();
      expect(result.commands).toBeDefined();
    });

    it('uses specified period', async () => {
      const result = (await t().handler({ period: '7d' })) as AnyResult;
      expect(result.period).toBe('7d');
    });
  });

  // ==========================================================================
  // hooks_list
  // ==========================================================================

  describe('hooks_list', () => {
    const t = () => tool('hooks_list');

    it('returns all registered hooks', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(Array.isArray(result.hooks)).toBe(true);
      expect((result.hooks as unknown[]).length).toBeGreaterThan(0);
      expect(typeof result.total).toBe('number');
    });

    it('each hook has name, type, and status', async () => {
      const result = (await t().handler({})) as AnyResult;
      const hooks = result.hooks as AnyResult[];

      for (const h of hooks) {
        expect(typeof h.name).toBe('string');
        expect(typeof h.type).toBe('string');
        expect(typeof h.status).toBe('string');
      }
    });
  });

  // ==========================================================================
  // hooks_pre-task
  // ==========================================================================

  describe('hooks_pre-task', () => {
    const t = () => tool('hooks_pre-task');

    it('returns task start info with suggested agents', async () => {
      const result = (await t().handler({ taskId: 'task-001', description: 'Write unit tests for auth module' })) as AnyResult;

      expect(result.taskId).toBe('task-001');
      expect(result.description).toBe('Write unit tests for auth module');
      expect(Array.isArray(result.suggestedAgents)).toBe(true);
      expect((result.suggestedAgents as unknown[]).length).toBeGreaterThan(0);
      expect(typeof result.complexity).toBe('string');
      expect(typeof result.timestamp).toBe('string');
    });

    it('suggests security agents for security-only tasks', async () => {
      // Use a description that matches the 'security' keyword before any other keyword
      const result = (await t().handler({ taskId: 'task-002', description: 'security vulnerability scan' })) as AnyResult;

      const agents = (result.suggestedAgents as AnyResult[]).map((a) => a.type);
      expect(agents[0]).toMatch(/security/);
    });

    it('classifies complex descriptions as high complexity', async () => {
      const result = (await t().handler({
        taskId: 'task-003',
        description: 'Perform a complex architecture redesign of the entire system',
      })) as AnyResult;

      expect(result.complexity).toBe('high');
    });

    it('returns providerAlternatives array', async () => {
      const result = (await t().handler({ taskId: 'task-004', description: 'simple fix' })) as AnyResult;

      expect(Array.isArray(result.providerAlternatives)).toBe(true);
      const alts = result.providerAlternatives as AnyResult[];
      expect(alts.length).toBeGreaterThan(0);
      const providers = alts.map((a) => a.provider as string);
      expect(providers).toContain('gemini-cli');
      expect(providers).toContain('codex-cli');
    });
  });

  // ==========================================================================
  // hooks_post-task
  // ==========================================================================

  describe('hooks_post-task', () => {
    const t = () => tool('hooks_post-task');

    it('records successful task completion', async () => {
      const result = (await t().handler({ taskId: 'task-001', success: true, agent: 'coder' })) as AnyResult;

      expect(result.taskId).toBe('task-001');
      expect(result.success).toBe(true);
      expect(typeof result.duration).toBe('number');
      expect(result.learningUpdates).toBeDefined();
      expect(typeof result.timestamp).toBe('string');
    });

    it('records failed task with adjusted quality', async () => {
      const result = (await t().handler({ taskId: 'task-002', success: false })) as AnyResult;

      expect(result.success).toBe(false);
      expect(result.quality).toBe(0.3);
    });

    it('uses default quality of 0.85 on success', async () => {
      const result = (await t().handler({ taskId: 'task-003', success: true })) as AnyResult;

      expect(result.quality).toBe(0.85);
    });

    it('returns feedback object with recorded and controller fields', async () => {
      // Bridge may or may not be available in the test environment; just verify structure
      const result = (await t().handler({ taskId: 'task-004' })) as AnyResult;

      const feedback = result.feedback as AnyResult;
      expect(typeof feedback.recorded).toBe('boolean');
      expect(typeof feedback.controller).toBe('string');
    });
  });

  // ==========================================================================
  // hooks_explain
  // ==========================================================================

  describe('hooks_explain', () => {
    const t = () => tool('hooks_explain');

    it('returns routing explanation for a task', async () => {
      const result = (await t().handler({ task: 'implement authentication middleware' })) as AnyResult;

      expect(result.task).toBe('implement authentication middleware');
      expect(result.simulated).toBe(true);
      expect(result.measured).toBe(false);
      expect(result.source).toBe('simulated-hooks-placeholder');
      expect(result.warning).toMatch(/no live telemetry/i);
      expect(typeof result.explanation).toBe('string');
      expect(Array.isArray(result.factors)).toBe(true);
      expect(result.decision).toBeDefined();
    });

    it('decision object includes agent and confidence', async () => {
      const result = (await t().handler({ task: 'fix the broken unit tests' })) as AnyResult;

      const decision = result.decision as AnyResult;
      expect(typeof decision.agent).toBe('string');
      expect(typeof decision.confidence).toBe('number');
      expect(Array.isArray(decision.reasoning)).toBe(true);
    });
  });

  // ==========================================================================
  // hooks_pretrain
  // ==========================================================================

  describe('hooks_pretrain', () => {
    const t = () => tool('hooks_pretrain');

    it('returns analysis results with default medium depth', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(result.simulated).toBe(true);
      expect(result.measured).toBe(false);
      expect(result.source).toBe('simulated-hooks-placeholder');
      expect(result.warning).toMatch(/repository-wide analysis/i);
      expect(result.depth).toBe('medium');
      expect(result.stats).toBeDefined();
      const stats = result.stats as AnyResult;
      expect(typeof stats.filesAnalyzed).toBe('number');
      expect(stats.filesAnalyzed).toBeGreaterThan(0);
    });

    it('scales results by depth - deep produces more results than shallow', async () => {
      const deep = (await t().handler({ depth: 'deep' })) as AnyResult;
      const shallow = (await t().handler({ depth: 'shallow' })) as AnyResult;

      const deepStats = deep.stats as AnyResult;
      const shallowStats = shallow.stats as AnyResult;
      expect(deepStats.filesAnalyzed as number).toBeGreaterThan(shallowStats.filesAnalyzed as number);
    });

    it('includes 4-step pipeline result', async () => {
      const result = (await t().handler({ depth: 'medium' })) as AnyResult;

      const pipeline = result.pipeline as AnyResult;
      expect(pipeline.retrieve).toBeDefined();
      expect(pipeline.judge).toBeDefined();
      expect(pipeline.distill).toBeDefined();
      expect(pipeline.consolidate).toBeDefined();
    });
  });

  // ==========================================================================
  // hooks_build-agents
  // ==========================================================================

  describe('hooks_build-agents', () => {
    const t = () => tool('hooks_build-agents');

    it('generates agent configs with default focus', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(Array.isArray(result.agents)).toBe(true);
      expect((result.agents as unknown[]).length).toBeGreaterThan(0);
      expect(result.focus).toBe('all');
      const stats = result.stats as AnyResult;
      expect(stats.configsGenerated).toBeGreaterThan(0);
    });

    it('filters agents by security focus', async () => {
      const result = (await t().handler({ focus: 'security', persist: false })) as AnyResult;

      const agents = result.agents as AnyResult[];
      const types = agents.map((a) => a.type as string);
      expect(types.some((t) => t.includes('security') || t === 'reviewer')).toBe(true);
    });

    it('calls writeFileSync when persist=true', async () => {
      await t().handler({ persist: true, outputDir: '/tmp/agents-test' });

      expect(writeFileSync).toHaveBeenCalled();
    });

    it('skips writeFileSync when persist=false', async () => {
      await t().handler({ persist: false });

      expect(writeFileSync).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // hooks_transfer
  // ==========================================================================

  describe('hooks_transfer', () => {
    const t = () => tool('hooks_transfer');

    it('does not fabricate transfer data when source is empty', async () => {
      setupEmptyMemory();

      const result = (await t().handler({ sourcePath: '/tmp/empty-project' })) as AnyResult;

      const transferred = result.transferred as AnyResult;
      expect(typeof transferred.total).toBe('number');
      expect(transferred.total).toBe(0);
      expect(result.dataSource).toBe('empty-source');
      expect(result.warning).toMatch(/no demo transfer data/i);
    });

    it('applies minConfidence to stats when source patterns exist', async () => {
      setupMemoryWithStore({
        'pattern-file': {
          key: 'pattern-file',
          value: 'file pattern',
          metadata: { type: 'file-pattern' },
          storedAt: '2026-01-01T00:00:00.000Z',
          accessCount: 0,
          lastAccessed: '2026-01-01T00:00:00.000Z',
        },
      });

      const result = (await t().handler({ sourcePath: '/tmp/proj', minConfidence: 0.9 })) as AnyResult;

      const stats = result.stats as AnyResult;
      expect(stats.avgConfidence as number).toBeGreaterThan(0.85);
      expect(stats.sourcePatterns).toBe(1);
      expect(result.dataSource).toBe('source-project');
    });

    it('filters transferred types when filter provided', async () => {
      const result = (await t().handler({
        sourcePath: '/tmp/proj',
        filter: 'security',
      })) as AnyResult;

      const transferred = result.transferred as AnyResult;
      const byType = transferred.byType as Record<string, number>;
      // Non-security keys should be absent
      const keys = Object.keys(byType);
      for (const k of keys) {
        expect(k).toContain('security');
      }
    });
  });

  // ==========================================================================
  // hooks_session-start
  // ==========================================================================

  describe('hooks_session-start', () => {
    const t = () => tool('hooks_session-start');

    it('creates session with generated ID', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(typeof result.sessionId).toBe('string');
      expect((result.sessionId as string).startsWith('session-')).toBe(true);
      expect(typeof result.started).toBe('string');
    });

    it('uses provided sessionId', async () => {
      const result = (await t().handler({ sessionId: 'my-session-123' })) as AnyResult;

      expect(result.sessionId).toBe('my-session-123');
    });

    it('sets restored=true when restoreLatest is true', async () => {
      const result = (await t().handler({ restoreLatest: true })) as AnyResult;

      expect(result.restored).toBe(true);
    });

    it('includes config with intelligenceEnabled', async () => {
      const result = (await t().handler({})) as AnyResult;

      const config = result.config as AnyResult;
      expect(config.intelligenceEnabled).toBe(true);
      expect(config.hooksEnabled).toBe(true);
    });

    it('always returns a daemon status object', async () => {
      // Daemon may start or fail; handler must return daemon field either way
      const result = (await t().handler({ startDaemon: true })) as AnyResult;

      expect(result.sessionId).toBeDefined();
      const daemon = result.daemon as AnyResult;
      expect(typeof daemon.started).toBe('boolean');
    });
  });

  // ==========================================================================
  // hooks_session-end
  // ==========================================================================

  describe('hooks_session-end', () => {
    const t = () => tool('hooks_session-end');

    it('returns session summary', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(result.summary).toBeDefined();
      expect(result.measured).toBe(false);
      expect(result.warning).toMatch(/summary reports zero/i);
      const summary = result.summary as AnyResult;
      expect(summary.tasksExecuted).toBe(0);
      expect(summary.commandsExecuted).toBe(0);
    });

    it('includes learningUpdates', async () => {
      const result = (await t().handler({})) as AnyResult;

      const updates = result.learningUpdates as AnyResult;
      expect(updates.patternsLearned).toBe(0);
    });

    it('does not throw when daemon unavailable', async () => {
      const result = (await t().handler({ stopDaemon: true })) as AnyResult;

      expect(result.summary).toBeDefined();
    });

    it('includes statePath when saveState=true', async () => {
      const result = (await t().handler({ saveState: true })) as AnyResult;
      expect(typeof result.statePath).toBe('string');
    });

    it('omits statePath when saveState=false', async () => {
      const result = (await t().handler({ saveState: false })) as AnyResult;
      expect(result.statePath).toBeUndefined();
    });
  });

  // ==========================================================================
  // hooks_session-restore
  // ==========================================================================

  describe('hooks_session-restore', () => {
    const t = () => tool('hooks_session-restore');

    it('restores to a new session id', async () => {
      setupEmptyMemory();

      const result = (await t().handler({})) as AnyResult;

      expect(typeof result.sessionId).toBe('string');
      expect(typeof result.originalSessionId).toBe('string');
      expect(result.restoredState).toBeDefined();
    });

    it('uses "latest" when no sessionId given', async () => {
      const result = (await t().handler({})) as AnyResult;
      expect(result.dataSource).toBe('memory-store');
    });

    it('sets tasksRestored=0 when restoreTasks=false', async () => {
      setupEmptyMemory();

      const result = (await t().handler({ restoreTasks: false })) as AnyResult;

      const state = result.restoredState as AnyResult;
      expect(state.tasksRestored).toBe(0);
    });
  });

  // ==========================================================================
  // hooks_notify
  // ==========================================================================

  describe('hooks_notify', () => {
    const t = () => tool('hooks_notify');

    it('reports notification as not delivered when backend is unwired', async () => {
      const result = (await t().handler({ message: 'Build failed' })) as AnyResult;

      expect(result.delivered).toBe(false);
      expect(result.deliveryAttempted).toBe(false);
      expect(result.source).toBe('unwired-notification-placeholder');
      expect(result.target).toBe('all');
      expect(Array.isArray(result.recipients)).toBe(true);
      expect((result.recipients as string[])).toEqual([]);
      expect((result.intendedRecipients as string[]).length).toBeGreaterThan(1);
    });

    it('delivers to specific target agent', async () => {
      const result = (await t().handler({ message: 'Code ready for review', target: 'reviewer' })) as AnyResult;

      expect(result.target).toBe('reviewer');
      expect(result.recipients).toEqual([]);
      expect(result.intendedRecipients).toEqual(['reviewer']);
    });

    it('uses normal priority by default', async () => {
      const result = (await t().handler({ message: 'FYI' })) as AnyResult;
      expect(result.priority).toBe('normal');
    });

    it('accepts urgent priority', async () => {
      const result = (await t().handler({ message: 'CRITICAL', priority: 'urgent' })) as AnyResult;
      expect(result.priority).toBe('urgent');
    });
  });

  // ==========================================================================
  // hooks_init
  // ==========================================================================

  describe('hooks_init', () => {
    const t = () => tool('hooks_init');

    it('initialises with standard template by default', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(result.template).toBe('standard');
      const hooks = result.hooks as AnyResult;
      expect(hooks.configured).toBe(9);
    });

    it('configures fewer hooks for minimal template', async () => {
      const result = (await t().handler({ template: 'minimal' })) as AnyResult;

      const hooks = result.hooks as AnyResult;
      expect(hooks.configured).toBe(4);
    });

    it('configures more hooks for full template', async () => {
      const result = (await t().handler({ template: 'full' })) as AnyResult;

      const hooks = result.hooks as AnyResult;
      expect(hooks.configured).toBe(16);
    });

    it('intelligence.sona is only enabled for full template', async () => {
      const full = (await t().handler({ template: 'full' })) as AnyResult;
      const std = (await t().handler({ template: 'standard' })) as AnyResult;

      expect((full.intelligence as AnyResult).sona).toBe(true);
      expect((std.intelligence as AnyResult).sona).toBe(false);
    });
  });

  // ==========================================================================
  // hooks_intelligence
  // ==========================================================================

  describe('hooks_intelligence', () => {
    const t = () => tool('hooks_intelligence');

    it('returns status with all components listed', async () => {
      setupEmptyMemory();

      const result = (await t().handler({})) as AnyResult;

      expect(['active', 'memory-fallback']).toContain(result.status);
      expect(typeof result.source).toBe('string');
      const components = result.components as AnyResult;
      expect(components.sona).toBeDefined();
      expect(components.moe).toBeDefined();
      expect(components.hnsw).toBeDefined();
      expect(components.flashAttention).toBeDefined();
      expect(components.ewc).toBeDefined();
      expect(components.lora).toBeDefined();
    });

    it('all components have a status field', async () => {
      setupEmptyMemory();

      const result = (await t().handler({})) as AnyResult;

      const components = result.components as AnyResult;
      // Status is active only when a lazy backend is available; unavailable/disabled
      // states are explicit instead of pretending background systems are running.
      expect(['active', 'unavailable', 'disabled']).toContain((components.sona as AnyResult).status);
      expect(['active', 'unavailable', 'disabled']).toContain((components.moe as AnyResult).status);
      expect(['unverified', 'disabled']).toContain((components.hnsw as AnyResult).status);
      expect(['configured']).toContain((components.embeddings as AnyResult).status);
    });

    it('returns version string', async () => {
      setupEmptyMemory();
      const result = (await t().handler({})) as AnyResult;
      expect(typeof result.version).toBe('string');
    });
  });

  // ==========================================================================
  // hooks_intelligence-reset
  // ==========================================================================

  describe('hooks_intelligence-reset', () => {
    const t = () => tool('hooks_intelligence-reset');

    it('reports reset as not executed when backend is unwired', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(result.simulated).toBe(true);
      expect(result.reset).toBe(false);
      expect(result.executed).toBe(false);
      expect(result.warning).toMatch(/nothing was cleared/i);
      const cleared = result.cleared as AnyResult;
      expect(cleared.trajectories).toBe(0);
      expect(cleared.patterns).toBe(0);
      expect(cleared.hnswIndex).toBe(0);
    });
  });

  // ==========================================================================
  // Trajectory lifecycle
  // ==========================================================================

  describe('trajectory lifecycle', () => {
    const startTool = () => tool('hooks_intelligence_trajectory-start');
    const stepTool = () => tool('hooks_intelligence_trajectory-step');
    const endTool = () => tool('hooks_intelligence_trajectory-end');

    it('start creates trajectory with recording status', async () => {
      const result = (await startTool().handler({ task: 'implement feature X', agent: 'coder' })) as AnyResult;

      expect(typeof result.trajectoryId).toBe('string');
      expect(result.status).toBe('recording');
      expect(result.task).toBe('implement feature X');
      expect(result.agent).toBe('coder');
    });

    it('step records into existing trajectory', async () => {
      const start = (await startTool().handler({ task: 'write tests', agent: 'tester' })) as AnyResult;
      const trajectoryId = start.trajectoryId as string;

      const step = (await stepTool().handler({
        trajectoryId,
        action: 'create test file',
        result: 'success',
        quality: 0.9,
      })) as AnyResult;

      expect(step.trajectoryId).toBe(trajectoryId);
      expect(step.recorded).toBe(true);
      expect(step.totalSteps).toBe(1);
    });

    it('step returns recorded=false for unknown trajectoryId', async () => {
      const result = (await stepTool().handler({
        trajectoryId: 'nonexistent-id',
        action: 'some action',
      })) as AnyResult;

      expect(result.recorded).toBe(false);
    });

    it('end finalises and removes from active trajectories', async () => {
      const start = (await startTool().handler({ task: 'full flow', agent: 'coder' })) as AnyResult;
      const trajectoryId = start.trajectoryId as string;

      await stepTool().handler({ trajectoryId, action: 'step 1' });

      const end = (await endTool().handler({ trajectoryId, success: true })) as AnyResult;

      expect(end.trajectoryId).toBe(trajectoryId);
      expect(end.success).toBe(true);
      expect(end.learning).toBeDefined();

      // After end, another step should not find the trajectory
      const lateStep = (await stepTool().handler({ trajectoryId, action: 'late step' })) as AnyResult;
      expect(lateStep.recorded).toBe(false);
    });

    it('end returns null trajectory when id not found', async () => {
      const result = (await endTool().handler({ trajectoryId: 'ghost-id', success: false })) as AnyResult;

      expect(result.trajectory).toBeNull();
    });
  });

  // ==========================================================================
  // hooks_intelligence_pattern-store
  // ==========================================================================

  describe('hooks_intelligence_pattern-store', () => {
    const t = () => tool('hooks_intelligence_pattern-store');

    it('returns patternId and pattern details', async () => {
      const result = (await t().handler({ pattern: 'Use JWT for stateless auth', type: 'security' })) as AnyResult;

      expect(typeof result.patternId).toBe('string');
      expect(result.pattern).toBe('Use JWT for stateless auth');
      expect(result.type).toBe('security');
      expect(typeof result.confidence).toBe('number');
      expect(typeof result.timestamp).toBe('string');
    });

    it('defaults type to "general"', async () => {
      const result = (await t().handler({ pattern: 'some pattern' })) as AnyResult;
      expect(result.type).toBe('general');
    });

    it('defaults confidence to 0.8', async () => {
      const result = (await t().handler({ pattern: 'some pattern' })) as AnyResult;
      expect(result.confidence).toBe(0.8);
    });
  });

  // ==========================================================================
  // hooks_intelligence_pattern-search
  // ==========================================================================

  describe('hooks_intelligence_pattern-search', () => {
    const t = () => tool('hooks_intelligence_pattern-search');

    it('returns results array (empty when no search function available)', async () => {
      const result = (await t().handler({ query: 'authentication patterns' })) as AnyResult;

      expect(result.query).toBe('authentication patterns');
      expect(Array.isArray(result.results)).toBe(true);
      expect(typeof result.backend).toBe('string');
    });

    it('defaults topK to 5', async () => {
      const result = (await t().handler({ query: 'test' })) as AnyResult;
      // No crash — results may be empty but field exists
      expect(result.results).toBeDefined();
    });
  });

  // ==========================================================================
  // hooks_intelligence_stats
  // ==========================================================================

  describe('hooks_intelligence_stats', () => {
    const t = () => tool('hooks_intelligence_stats');

    it('returns stats for all components', async () => {
      setupEmptyMemory();

      const result = (await t().handler({})) as AnyResult;

      expect(result.sona).toBeDefined();
      expect(result.moe).toBeDefined();
      expect(result.ewc).toBeDefined();
      expect(result.flash).toBeDefined();
      expect(result.lora).toBeDefined();
      expect(result.hnsw).toBeDefined();
      expect((result.hnsw as AnyResult).avgSearchTimeMeasured).toBe(false);
      expect((result.hnsw as AnyResult).cacheHitRateMeasured).toBe(false);
      expect(result.warning).toMatch(/Timing and cache-hit fields are unavailable/i);
    });

    it('includes implementationStatus when detailed=true', async () => {
      setupEmptyMemory();

      const result = (await t().handler({ detailed: true })) as AnyResult;

      expect(result.implementationStatus).toBeDefined();
      expect(result.performance).toBeDefined();
    });

    it('omits implementationStatus when detailed=false', async () => {
      setupEmptyMemory();

      const result = (await t().handler({ detailed: false })) as AnyResult;

      expect(result.implementationStatus).toBeUndefined();
    });
  });

  // ==========================================================================
  // hooks_intelligence_learn
  // ==========================================================================

  describe('hooks_intelligence_learn', () => {
    const t = () => tool('hooks_intelligence_learn');

    it('returns learn result with duration', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(typeof result.duration).toBe('number');
      expect(result.updates).toBeDefined();
      expect(result.confidence).toBeDefined();
    });

    it('includes ewc stats when consolidate=true', async () => {
      const result = (await t().handler({ consolidate: true })) as AnyResult;
      expect(result.ewc).toBeDefined();
    });

    it('sets ewc=null when consolidate=false', async () => {
      const result = (await t().handler({ consolidate: false })) as AnyResult;
      expect(result.ewc).toBeNull();
    });
  });

  // ==========================================================================
  // hooks_intelligence_attention
  // ==========================================================================

  describe('hooks_intelligence_attention', () => {
    const t = () => tool('hooks_intelligence_attention');

    it('returns attention results for flash mode', async () => {
      const result = (await t().handler({ query: 'authentication patterns', mode: 'flash', topK: 3 })) as AnyResult;

      expect(result.query).toBe('authentication patterns');
      expect(result.mode).toBe('flash');
      expect(Array.isArray(result.results)).toBe(true);
      expect((result.results as unknown[]).length).toBe(3);
    });

    it('returns attention results for moe mode', async () => {
      const result = (await t().handler({ query: 'routing', mode: 'moe' })) as AnyResult;

      expect(result.mode).toBe('moe');
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('defaults to flash mode', async () => {
      const result = (await t().handler({ query: 'test' })) as AnyResult;
      expect(result.mode).toBe('flash');
    });

    it('returns stats with computeTimeMs', async () => {
      const result = (await t().handler({ query: 'test' })) as AnyResult;
      const stats = result.stats as AnyResult;
      expect(typeof stats.computeTimeMs).toBe('number');
    });
  });

  // ==========================================================================
  // Worker tools
  // ==========================================================================

  describe('hooks_worker-list', () => {
    const t = () => tool('hooks_worker-list');

    it('lists all 12 workers', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(result.total).toBe(12);
      expect(Array.isArray(result.workers)).toBe(true);
      expect((result.workers as unknown[]).length).toBe(12);
    });

    it('each worker entry has trigger, description, priority, and capabilities', async () => {
      const result = (await t().handler({})) as AnyResult;
      const workers = result.workers as AnyResult[];

      for (const w of workers) {
        expect(typeof w.trigger).toBe('string');
        expect(typeof w.description).toBe('string');
        expect(typeof w.priority).toBe('string');
        expect(Array.isArray(w.capabilities)).toBe(true);
      }
    });
  });

  describe('hooks_worker-dispatch', () => {
    const t = () => tool('hooks_worker-dispatch');

    it('dispatches a valid worker trigger', async () => {
      const result = (await t().handler({ trigger: 'audit', context: 'src/auth.ts' })) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.trigger).toBe('audit');
      expect(typeof result.workerId).toBe('string');
      expect(result.status).toBe('dispatched');
      expect(result.workPerformed).toBe(false);
      expect(result.source).toBe('local-worker-scheduler-placeholder');
    });

    it('completes synchronously when background=false', async () => {
      const result = (await t().handler({ trigger: 'consolidate', background: false })) as AnyResult;

      expect(result.success).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.workPerformed).toBe(false);
    });

    it('returns error for unknown trigger', async () => {
      const result = (await t().handler({ trigger: 'nonexistent-worker' })) as AnyResult;

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(Array.isArray(result.availableTriggers)).toBe(true);
    });
  });

  describe('hooks_worker-status', () => {
    const t = () => tool('hooks_worker-status');
    const dispatch = () => tool('hooks_worker-dispatch');

    it('returns success=false for unknown workerId', async () => {
      const result = (await t().handler({ workerId: 'worker_fake_99' })) as AnyResult;

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
    });

    it('returns worker details for known workerId', async () => {
      const dispatched = (await dispatch().handler({ trigger: 'testgaps', background: false })) as AnyResult;
      const workerId = dispatched.workerId as string;

      const status = (await t().handler({ workerId })) as AnyResult;

      expect(status.success).toBe(true);
      const worker = status.worker as AnyResult;
      expect(worker.id).toBe(workerId);
    });

    it('returns summary when no workerId specified', async () => {
      const result = (await t().handler({})) as AnyResult;

      expect(result.success).toBe(true);
      expect(Array.isArray(result.workers)).toBe(true);
      expect(result.summary).toBeDefined();
    });
  });

  describe('hooks_worker-detect', () => {
    const t = () => tool('hooks_worker-detect');

    it('detects security audit trigger', async () => {
      const result = (await t().handler({ prompt: 'I need a security audit of our authentication code' })) as AnyResult;

      const detection = result.detection as AnyResult;
      expect(detection.detected).toBe(true);
      expect((detection.triggers as string[])).toContain('audit');
    });

    it('detects optimize trigger', async () => {
      const result = (await t().handler({ prompt: 'optimize the performance of this module' })) as AnyResult;

      const detection = result.detection as AnyResult;
      expect(detection.detected).toBe(true);
      expect((detection.triggers as string[])).toContain('optimize');
    });

    it('returns no triggers for neutral prompt', async () => {
      const result = (await t().handler({ prompt: 'hello world' })) as AnyResult;

      expect(result.triggersFound).toBe(0);
    });

    it('auto-dispatches workers when autoDispatch=true and confidence high enough', async () => {
      const result = (await t().handler({
        prompt: 'security audit all vulnerabilities CVE owasp',
        autoDispatch: true,
        minConfidence: 0.0,
      })) as AnyResult;

      expect(result.autoDispatched).toBe(true);
      expect(Array.isArray(result.workerIds)).toBe(true);
      expect(result.workPerformed).toBe(false);
      expect(result.source).toBe('local-worker-scheduler-placeholder');
    });
  });

  describe('hooks_worker-cancel', () => {
    const t = () => tool('hooks_worker-cancel');
    const dispatch = () => tool('hooks_worker-dispatch');

    it('returns error for unknown workerId', async () => {
      const result = (await t().handler({ workerId: 'worker_ghost_00' })) as AnyResult;

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
    });

    it('cancels a running worker', async () => {
      // Dispatch in background so it stays in "running" state
      const dispatched = (await dispatch().handler({ trigger: 'benchmark', background: true })) as AnyResult;
      const workerId = dispatched.workerId as string;

      const cancel = (await t().handler({ workerId })) as AnyResult;

      expect(cancel.success).toBe(true);
      expect(cancel.cancelled).toBe(true);
    });

    it('returns error when worker already completed', async () => {
      const dispatched = (await dispatch().handler({ trigger: 'map', background: false })) as AnyResult;
      const workerId = dispatched.workerId as string;

      const cancel = (await t().handler({ workerId })) as AnyResult;

      expect(cancel.success).toBe(false);
      expect((cancel.error as string)).toContain('completed');
    });
  });

  // ==========================================================================
  // Model routing tools
  // ==========================================================================

  describe('hooks_model-route', () => {
    const t = () => tool('hooks_model-route');

    it('returns a valid model recommendation', async () => {
      const result = (await t().handler({ task: 'refactor the security module' })) as AnyResult;

      expect(['sonnet', 'opus']).toContain(result.model);
      expect(typeof result.confidence).toBe('number');
      // implementation is 'fallback' when model router unavailable, 'tiny-dancer-neural' when available
      expect(typeof result.implementation).toBe('string');
    });

    it('suggests opus for complex/security tasks', async () => {
      const result = (await t().handler({ task: 'complex architecture security audit of the entire system' })) as AnyResult;

      expect(result.model).toBe('opus');
    });

    it('suggests sonnet for simple tasks', async () => {
      const result = (await t().handler({ task: 'rename a variable' })) as AnyResult;

      expect(result.model).toBe('sonnet');
    });

    it('includes suggestedProviders array', async () => {
      const result = (await t().handler({ task: 'implement feature' })) as AnyResult;

      expect(Array.isArray(result.suggestedProviders)).toBe(true);
      const providers = result.suggestedProviders as AnyResult[];
      expect(providers.length).toBeGreaterThan(0);
      expect(typeof providers[0].provider).toBe('string');
    });
  });

  describe('hooks_model-outcome', () => {
    const t = () => tool('hooks_model-outcome');

    it('reports model outcome recording status without claiming an unavailable backend recorded it', async () => {
      const result = (await t().handler({
        task: 'implement OAuth login',
        model: 'sonnet',
        outcome: 'success',
      })) as AnyResult;

      expect(typeof result.recorded).toBe('boolean');
      if (result.recorded) {
        expect(result.warning).toBeUndefined();
      } else {
        expect(result.warning).toMatch(/backend is unavailable/i);
      }
      expect(result.model).toBe('sonnet');
      expect(result.outcome).toBe('success');
      expect(typeof result.timestamp).toBe('string');
    });

    it('truncates long task descriptions to 50 chars', async () => {
      const longTask = 'a'.repeat(100);
      const result = (await t().handler({
        task: longTask,
        model: 'sonnet',
        outcome: 'failure',
      })) as AnyResult;

      expect((result.task as string).length).toBe(50);
    });
  });

  describe('hooks_model-stats', () => {
    const t = () => tool('hooks_model-stats');

    it('returns stats object with available field', async () => {
      const result = (await t().handler({})) as AnyResult;

      // available=false with message when router not loaded; available=true with stats when loaded
      expect(typeof result.available).toBe('boolean');
      if (!result.available) {
        expect(typeof result.message).toBe('string');
      } else {
        expect(typeof result.timestamp).toBe('string');
      }
    });
  });

  // ==========================================================================
  // Error cases / edge inputs
  // ==========================================================================

  describe('error and edge cases', () => {
    it('hooks_pre-edit handles empty filePath string without throwing', async () => {
      const result = (await tool('hooks_pre-edit').handler({ filePath: '' })) as AnyResult;
      expect(result.filePath).toBe('');
    });

    it('hooks_route handles empty task without throwing', async () => {
      const result = (await tool('hooks_route').handler({ task: '' })) as AnyResult;
      expect(result.task).toBe('');
      expect(result.primaryAgent).toBeDefined();
    });

    it('hooks_notify handles empty message without throwing', async () => {
      const result = (await tool('hooks_notify').handler({ message: '' })) as AnyResult;
      expect(result.delivered).toBe(false);
    });

    it('hooks_intelligence_trajectory-step defaults quality to 0.85', async () => {
      const start = (await tool('hooks_intelligence_trajectory-start').handler({ task: 'edge test' })) as AnyResult;
      const result = (await tool('hooks_intelligence_trajectory-step').handler({
        trajectoryId: start.trajectoryId,
        action: 'check',
        // quality intentionally omitted
      })) as AnyResult;
      expect(result.quality).toBe(0.85);
    });

    it('hooks_worker-dispatch rejects empty trigger string', async () => {
      const result = (await tool('hooks_worker-dispatch').handler({ trigger: '' })) as AnyResult;
      expect(result.success).toBe(false);
    });

    it('hooks_pre-command handles command with no risks without throwing', async () => {
      const result = (await tool('hooks_pre-command').handler({ command: 'echo hello' })) as AnyResult;
      expect(result.riskLevel).toBe('low');
    });

    it('hooks_session-restore with explicit sessionId uses it as originalSessionId', async () => {
      const result = (await tool('hooks_session-restore').handler({ sessionId: 'session-abc' })) as AnyResult;
      expect(result.originalSessionId).toBe('session-abc');
    });
  });
});
