import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ───────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock @hive-flow/embeddings — not installed in test environment
vi.mock('@hive-flow/embeddings', () => {
  throw new Error('Module not found');
});

// Mock @hive-flow/neural — not installed in test environment
vi.mock('@hive-flow/neural', () => {
  throw new Error('Module not found');
});

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { neuralTools } from '../mcp-tools/neural-tools.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface NeuralStore {
  models: Record<string, unknown>;
  patterns: Record<string, unknown>;
  version: string;
}

const trainTool = neuralTools.find((t) => t.name === 'neural_train')!;
const predictTool = neuralTools.find((t) => t.name === 'neural_predict')!;
const patternsTool = neuralTools.find((t) => t.name === 'neural_patterns')!;
const compressTool = neuralTools.find((t) => t.name === 'neural_compress')!;
const statusTool = neuralTools.find((t) => t.name === 'neural_status')!;
const optimizeTool = neuralTools.find((t) => t.name === 'neural_optimize')!;

function setupMocks(
  initialStore: NeuralStore = { models: {}, patterns: {}, version: '3.0.0' },
) {
  let currentStore = JSON.parse(JSON.stringify(initialStore));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('models.json')) return true;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('models.json')) {
      return JSON.stringify(currentStore);
    }
    throw new Error(`ENOENT: no such file '${p}'`);
  });

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      try {
        currentStore = JSON.parse(data);
      } catch {
        // non-JSON write
      }
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedStore: () => currentStore as NeuralStore,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('neural-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================================
  // Tool registration
  // ========================================================================

  describe('tool registration', () => {
    it('exports all expected tools', () => {
      const names = neuralTools.map((t) => t.name);
      expect(names).toContain('neural_train');
      expect(names).toContain('neural_predict');
      expect(names).toContain('neural_patterns');
      expect(names).toContain('neural_compress');
      expect(names).toContain('neural_status');
      expect(names).toContain('neural_optimize');
    });

    it('all tools have category "neural"', () => {
      for (const tool of neuralTools) {
        expect(tool.category).toBe('neural');
      }
    });
  });

  // ========================================================================
  // neural_train
  // ========================================================================

  describe('neural_train', () => {
    it('reports model training as unavailable', async () => {
      const { getPersistedStore } = setupMocks();

      const result = (await trainTool.handler({
        modelType: 'moe',
        epochs: 5,
      })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.type).toBe('moe');
      expect(result.epochs).toBe(5);
      expect(result.status).toBe('unavailable');
      expect(String(result.error)).toContain('unavailable');
      expect(result.modelId).toBeDefined();

      // Unavailable training must not persist a fake model.
      const store = getPersistedStore();
      expect(Object.keys(store.models).length).toBe(0);
    });

    it('uses provided modelId', async () => {
      setupMocks();

      const result = (await trainTool.handler({
        modelType: 'transformer',
        modelId: 'my-model',
      })) as Record<string, unknown>;

      expect(result.modelId).toBe('my-model');
    });

    it('defaults epochs to 10', async () => {
      setupMocks();

      const result = (await trainTool.handler({
        modelType: 'classifier',
      })) as Record<string, unknown>;

      expect(result.epochs).toBe(10);
    });

    it('does not mark unavailable training as simulated success', async () => {
      setupMocks();

      const result = (await trainTool.handler({
        modelType: 'embedding',
      })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.simulated).toBeUndefined();
    });
  });

  // ========================================================================
  // neural_predict
  // ========================================================================

  describe('neural_predict', () => {
    it('returns predictions for input text', async () => {
      setupMocks();

      const result = (await predictTool.handler({
        input: 'authentication pattern',
        topK: 2,
      })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.input).toBe('authentication pattern');
      expect(Array.isArray(result.predictions)).toBe(true);
      expect((result.predictions as unknown[]).length).toBeLessThanOrEqual(2);
      expect(result.embeddingDims).toBe(384);
      expect(Array.isArray(result.embedding)).toBe(true);
      expect((result.embedding as unknown[]).length).toBe(8); // preview slice
    });

    it('returns error when model is not ready', async () => {
      setupMocks({
        models: {
          'm1': {
            id: 'm1',
            name: 'test',
            type: 'moe',
            status: 'training',
            accuracy: 0,
            epochs: 10,
            config: {},
          },
        },
        patterns: {},
        version: '3.0.0',
      });

      const result = (await predictTool.handler({
        modelId: 'm1',
        input: 'test',
      })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Model not ready');
    });

    it('uses default model when modelId is not provided', async () => {
      setupMocks({
        models: {
          'ready-model': {
            id: 'ready-model',
            name: 'test',
            type: 'moe',
            status: 'ready',
            accuracy: 0.9,
            epochs: 10,
            config: {},
          },
        },
        patterns: {},
        version: '3.0.0',
      });

      const result = (await predictTool.handler({
        input: 'test query',
      })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.modelId).toBe('ready-model');
    });

    it('defaults topK to 3', async () => {
      setupMocks();

      const result = (await predictTool.handler({
        input: 'test',
      })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect((result.predictions as unknown[]).length).toBeLessThanOrEqual(3);
    });
  });

  // ========================================================================
  // neural_patterns
  // ========================================================================

  describe('neural_patterns', () => {
    it('lists patterns from store', async () => {
      setupMocks({
        models: {},
        patterns: {
          'p1': {
            id: 'p1',
            name: 'Auth pattern',
            type: 'security',
            embedding: [0.1, 0.2],
            metadata: {},
            createdAt: '2025-01-01',
            usageCount: 5,
          },
        },
        version: '3.0.0',
      });

      const result = (await patternsTool.handler({ action: 'list' })) as Record<string, unknown>;

      expect(result.total).toBe(1);
      expect(Array.isArray(result.patterns)).toBe(true);
    });

    it('filters patterns by type', async () => {
      setupMocks({
        models: {},
        patterns: {
          'p1': { id: 'p1', name: 'A', type: 'security', embedding: [], metadata: {}, createdAt: '', usageCount: 0 },
          'p2': { id: 'p2', name: 'B', type: 'code', embedding: [], metadata: {}, createdAt: '', usageCount: 0 },
        },
        version: '3.0.0',
      });

      const result = (await patternsTool.handler({ action: 'list', type: 'security' })) as Record<string, unknown>;

      expect(result.total).toBe(1);
    });

    it('gets a specific pattern by id', async () => {
      setupMocks({
        models: {},
        patterns: {
          'p1': { id: 'p1', name: 'My pattern', type: 'general', embedding: [], metadata: {}, createdAt: '', usageCount: 0 },
        },
        version: '3.0.0',
      });

      const result = (await patternsTool.handler({ action: 'get', patternId: 'p1' })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.pattern).toBeDefined();
    });

    it('returns error when pattern not found', async () => {
      setupMocks();

      const result = (await patternsTool.handler({ action: 'get', patternId: 'nonexistent' })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Pattern not found');
    });

    it('stores a new pattern', async () => {
      const { getPersistedStore } = setupMocks();

      const result = (await patternsTool.handler({
        action: 'store',
        name: 'New pattern',
        type: 'code',
      })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.name).toBe('New pattern');
      expect(result.type).toBe('code');
      expect(result.embeddingDims).toBe(384);
      expect(result.patternId).toBeDefined();

      const store = getPersistedStore();
      expect(Object.keys(store.patterns).length).toBe(1);
    });

    it('searches patterns by query', async () => {
      setupMocks({
        models: {},
        patterns: {
          'p1': {
            id: 'p1',
            name: 'authentication',
            type: 'security',
            embedding: Array.from({ length: 384 }, () => 0.5),
            metadata: {},
            createdAt: '',
            usageCount: 0,
          },
        },
        version: '3.0.0',
      });

      const result = (await patternsTool.handler({
        action: 'search',
        query: 'auth',
      })) as Record<string, unknown>;

      expect(result._realSimilarity).toBe(true);
      expect(result.query).toBe('auth');
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('deletes a pattern', async () => {
      const { getPersistedStore } = setupMocks({
        models: {},
        patterns: {
          'p1': { id: 'p1', name: 'A', type: 'general', embedding: [], metadata: {}, createdAt: '', usageCount: 0 },
        },
        version: '3.0.0',
      });

      const result = (await patternsTool.handler({ action: 'delete', patternId: 'p1' })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.deleted).toBe('p1');

      const store = getPersistedStore();
      expect(store.patterns['p1']).toBeUndefined();
    });

    it('returns error when deleting nonexistent pattern', async () => {
      setupMocks();

      const result = (await patternsTool.handler({ action: 'delete', patternId: 'nope' })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Pattern not found');
    });

    it('returns error for unknown action', async () => {
      setupMocks();

      const result = (await patternsTool.handler({ action: 'invalid' })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown action');
    });
  });

  // ========================================================================
  // neural_compress
  // ========================================================================

  describe('neural_compress', () => {
    it('reports compression as unavailable for quantize', async () => {
      const result = (await compressTool.handler({
        method: 'quantize',
        targetSize: 0.25,
      })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.method).toBe('quantize');
      expect(result.status).toBe('unavailable');
      expect(String(result.error)).toContain('unavailable');
    });

    it('reports compression as unavailable for prune', async () => {
      const result = (await compressTool.handler({
        method: 'prune',
      })) as Record<string, unknown>;

      expect(result.method).toBe('prune');
      expect(result.success).toBe(false);
      expect(result.status).toBe('unavailable');
    });

    it('reports compression as unavailable for distill', async () => {
      const result = (await compressTool.handler({
        method: 'distill',
      })) as Record<string, unknown>;

      expect(result.method).toBe('distill');
      expect(result.success).toBe(false);
      expect(result.status).toBe('unavailable');
    });

    it('defaults to quantize method', async () => {
      const result = (await compressTool.handler({})) as Record<string, unknown>;

      expect(result.method).toBe('quantize');
    });
  });

  // ========================================================================
  // neural_status
  // ========================================================================

  describe('neural_status', () => {
    it('returns system status overview', async () => {
      setupMocks({
        models: {
          'm1': { id: 'm1', status: 'ready', accuracy: 0.9 },
          'm2': { id: 'm2', status: 'error', accuracy: 0 },
        },
        patterns: {
          'p1': { id: 'p1', type: 'code', embedding: [0.1] },
        },
        version: '3.0.0',
      });

      const result = (await statusTool.handler({})) as Record<string, unknown>;

      const models = result.models as Record<string, unknown>;
      expect(models.total).toBe(2);
      expect(models.ready).toBe(1);
      expect(models.training).toBe(0);

      const patterns = result.patterns as Record<string, unknown>;
      expect(patterns.total).toBe(1);

      expect(result.features).toBeDefined();
    });

    it('returns specific model status', async () => {
      setupMocks({
        models: {
          'my-model': { id: 'my-model', name: 'test', type: 'moe', status: 'ready', accuracy: 0.85 },
        },
        patterns: {},
        version: '3.0.0',
      });

      const result = (await statusTool.handler({ modelId: 'my-model' })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.model).toBeDefined();
    });

    it('returns error for unknown model', async () => {
      setupMocks();

      const result = (await statusTool.handler({ modelId: 'unknown' })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Model not found');
    });
  });

  // ========================================================================
  // neural_optimize
  // ========================================================================

  describe('neural_optimize', () => {
    it('reports optimization as unavailable for speed', async () => {
      const result = (await optimizeTool.handler({ target: 'speed' })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.target).toBe('speed');
      expect(result.status).toBe('unavailable');
      expect(String(result.error)).toContain('unavailable');
    });

    it('reports optimization as unavailable for memory', async () => {
      const result = (await optimizeTool.handler({ target: 'memory' })) as Record<string, unknown>;

      expect(result.target).toBe('memory');
      expect(result.success).toBe(false);
      expect(result.status).toBe('unavailable');
    });

    it('returns optimization results for accuracy', async () => {
      const result = (await optimizeTool.handler({ target: 'accuracy' })) as Record<string, unknown>;

      expect(result.target).toBe('accuracy');
    });

    it('defaults to balanced', async () => {
      const result = (await optimizeTool.handler({})) as Record<string, unknown>;

      expect(result.target).toBe('balanced');
    });
  });
});
