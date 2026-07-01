/**
 * Neural MCP Tools for CLI
 *
 * V2 Compatibility - Neural network and ML tools
 *
 * Honest local implementation:
 * - Uses @hive-flow/embeddings when available
 * - Falls back to deterministic hash embeddings
 * - Supports local pattern storage and cosine-similarity search
 * - Reports model training/compression/optimization as unavailable
 */

import type { MCPTool } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Try to import real embeddings from @hive-flow/embeddings
let realEmbeddings: { embed: (text: string) => Promise<number[]> } | null = null;
let embeddingServiceName: string = 'none';
try {
  // Dynamic import to avoid hard dependency
  const embeddingsModule = await import('@hive-flow/embeddings');
  if (embeddingsModule.createEmbeddingService) {
    // Try the local embedding service, fall back to mock
    try {
      const service = embeddingsModule.createEmbeddingService({ provider: 'local' });
      realEmbeddings = {
        embed: async (text: string) => {
          const result = await service.embed(text);
          // Convert Float32Array to number[] if needed
          return Array.from(result.embedding);
        },
      };
      embeddingServiceName = 'local';
    } catch {
      // Fall back to mock service
      const service = embeddingsModule.createEmbeddingService({ provider: 'mock' });
      realEmbeddings = {
        embed: async (text: string) => {
          const result = await service.embed(text);
          return Array.from(result.embedding);
        },
      };
      embeddingServiceName = 'mock';
    }
  }
} catch {
  // @hive-flow/embeddings not available, will use fallback
}

// Storage paths
const STORAGE_DIR = '.hive-flow';
const NEURAL_DIR = 'neural';
const MODELS_FILE = 'models.json';
const PATTERNS_FILE = 'patterns.json';

interface NeuralModel {
  id: string;
  name: string;
  type: 'moe' | 'transformer' | 'classifier' | 'embedding';
  status: 'untrained' | 'ready' | 'error';
  accuracy: number;
  trainedAt?: string;
  epochs: number;
  config: Record<string, unknown>;
}

interface Pattern {
  id: string;
  name: string;
  type: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: string;
  usageCount: number;
}

interface NeuralStore {
  models: Record<string, NeuralModel>;
  patterns: Record<string, Pattern>;
  version: string;
}

function getNeuralDir(): string {
  return join(process.cwd(), STORAGE_DIR, NEURAL_DIR);
}

function getNeuralPath(): string {
  return join(getNeuralDir(), MODELS_FILE);
}

function ensureNeuralDir(): void {
  const dir = getNeuralDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadNeuralStore(): NeuralStore {
  try {
    const path = getNeuralPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return empty store
  }
  return { models: {}, patterns: {}, version: '3.0.0' };
}

function saveNeuralStore(store: NeuralStore): void {
  ensureNeuralDir();
  writeFileSync(getNeuralPath(), JSON.stringify(store, null, 2), 'utf-8');
}

function stableId(prefix: string, parts: unknown[]): string {
  const raw = JSON.stringify(parts);
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

// Generate embedding - uses real embeddings if available, falls back to hash-based
async function generateEmbedding(text?: string, dims: number = 384): Promise<number[]> {
  // If real embeddings available and text provided, use them
  if (realEmbeddings && text) {
    try {
      return await realEmbeddings.embed(text);
    } catch {
      // Fall back to hash-based
    }
  }

  // Hash-based deterministic embedding (better than pure random for consistency)
  if (text) {
    const hash = text.split('').reduce((acc, char, i) => {
      return acc + char.charCodeAt(0) * (i + 1);
    }, 0);

    // Use hash to seed a deterministic embedding
    const embedding: number[] = [];
    let seed = hash;
    for (let i = 0; i < dims; i++) {
      // Simple LCG random with seed
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      embedding.push((seed / 0x7fffffff) * 2 - 1);
    }
    return embedding;
  }

  // Deterministic empty-input fallback.
  return Array.from({ length: dims }, (_, i) => ((i % 17) - 8) / 8);
}

// Cosine similarity for pattern search
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

const UNAVAILABLE_NEURAL_MESSAGE =
  'Neural model training is unavailable in this build; use neural_patterns for local deterministic pattern storage and search.';

export const neuralTools: MCPTool[] = [
  {
    name: 'neural_train',
    description: 'Train a neural model',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to train' },
        modelType: { type: 'string', enum: ['moe', 'transformer', 'classifier', 'embedding'], description: 'Model type' },
        epochs: { type: 'number', description: 'Number of training epochs' },
        learningRate: { type: 'number', description: 'Learning rate' },
        data: { type: 'object', description: 'Training data' },
      },
      required: ['modelType'],
    },
    handler: async (input) => {
      const modelId = (input.modelId as string) || stableId('model', [input.modelType, input.data ?? null]);
      const modelType = input.modelType as NeuralModel['type'];
      const epochs = (input.epochs as number) || 10;

      return {
        success: false,
        status: 'unavailable',
        error: UNAVAILABLE_NEURAL_MESSAGE,
        modelId,
        type: modelType,
        epochs,
      };
    },
  },
  {
    name: 'neural_predict',
    description: 'Make predictions using a neural model',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to use' },
        input: { type: 'string', description: 'Input text or data' },
        topK: { type: 'number', description: 'Number of top predictions' },
      },
      required: ['input'],
    },
    handler: async (input) => {
      const store = loadNeuralStore();
      const modelId = input.modelId as string;
      const inputText = input.input as string;
      const topK = (input.topK as number) || 3;

      // Find model or use default
      const model = modelId ? store.models[modelId] : Object.values(store.models).find(m => m.status === 'ready');

      if (model && model.status !== 'ready') {
        return { success: false, error: 'Model not ready' };
      }

      // Generate real embedding for the input
      const startTime = performance.now();
      const embedding = await generateEmbedding(inputText, 384);
      const latency = Math.round(performance.now() - startTime);

      const predictions = Object.values(store.patterns)
        .map((pattern) => ({
          label: pattern.type || pattern.name || 'unknown',
          confidence: cosineSimilarity(embedding, pattern.embedding),
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, topK);

      return {
        success: true,
        _realEmbedding: !!realEmbeddings,
        _localHeuristic: true,
        modelId: model?.id || 'default',
        input: inputText,
        predictions,
        embedding: embedding.slice(0, 8), // Preview of embedding
        embeddingDims: embedding.length,
        latency,
      };
    },
  },
  {
    name: 'neural_patterns',
    description: 'Get or manage neural patterns',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'store', 'search', 'delete'], description: 'Action to perform' },
        patternId: { type: 'string', description: 'Pattern ID' },
        name: { type: 'string', description: 'Pattern name' },
        type: { type: 'string', description: 'Pattern type' },
        query: { type: 'string', description: 'Search query' },
        data: { type: 'object', description: 'Pattern data' },
      },
    },
    handler: async (input) => {
      const store = loadNeuralStore();
      const action = (input.action as string) || 'list';

      if (action === 'list') {
        const patterns = Object.values(store.patterns);
        const typeFilter = input.type as string;
        const filtered = typeFilter ? patterns.filter(p => p.type === typeFilter) : patterns;

        return {
          patterns: filtered.map(p => ({
            id: p.id,
            name: p.name,
            type: p.type,
            usageCount: p.usageCount,
            createdAt: p.createdAt,
          })),
          total: filtered.length,
        };
      }

      if (action === 'get') {
        const pattern = store.patterns[input.patternId as string];
        if (!pattern) {
          return { success: false, error: 'Pattern not found' };
        }
        return { success: true, pattern };
      }

      if (action === 'store') {
        const patternName = (input.name as string) || 'Unnamed pattern';
        const patternType = (input.type as string) || 'general';

        // Generate embedding from pattern name/content
        const embedding = await generateEmbedding(patternName, 384);

        const patternId = (input.patternId as string) || stableId('pattern', [patternName, patternType, input.data ?? null]);

        const pattern: Pattern = {
          id: patternId,
          name: patternName,
          type: patternType,
          embedding,
          metadata: (input.data as Record<string, unknown>) || {},
          createdAt: new Date().toISOString(),
          usageCount: 0,
        };

        store.patterns[patternId] = pattern;
        saveNeuralStore(store);

        return {
          success: true,
          _realEmbedding: !!realEmbeddings,
          _localHeuristic: true,
          patternId,
          name: pattern.name,
          type: pattern.type,
          embeddingDims: embedding.length,
          createdAt: pattern.createdAt,
        };
      }

      if (action === 'search') {
        const query = input.query as string;
        const queryEmbedding = await generateEmbedding(query, 384);

        const results = Object.values(store.patterns)
          .map(p => ({
            ...p,
            similarity: cosineSimilarity(queryEmbedding, p.embedding),
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 10);

        return {
          _realSimilarity: true,
          _realEmbedding: !!realEmbeddings,
          _localHeuristic: true,
          query,
          results: results.map(r => ({
            id: r.id,
            name: r.name,
            type: r.type,
            similarity: r.similarity,
          })),
          total: results.length,
        };
      }

      if (action === 'delete') {
        const patternId = input.patternId as string;
        if (!store.patterns[patternId]) {
          return { success: false, error: 'Pattern not found' };
        }
        delete store.patterns[patternId];
        saveNeuralStore(store);
        return { success: true, deleted: patternId };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
  {
    name: 'neural_compress',
    description: 'Compress neural model or embeddings',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to compress' },
        method: { type: 'string', enum: ['quantize', 'prune', 'distill'], description: 'Compression method' },
        targetSize: { type: 'number', description: 'Target size reduction (0-1)' },
      },
    },
    handler: async (input) => {
      const method = (input.method as string) || 'quantize';

      return {
        success: false,
        status: 'unavailable',
        error: 'Neural model compression is unavailable because no local neural model runtime is present.',
        method,
      };
    },
  },
  {
    name: 'neural_status',
    description: 'Get neural system status',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Specific model ID' },
        detailed: { type: 'boolean', description: 'Include detailed info' },
      },
    },
    handler: async (input) => {
      const store = loadNeuralStore();

      if (input.modelId) {
        const model = store.models[input.modelId as string];
        if (!model) {
          return { success: false, error: 'Model not found' };
        }
        return { success: true, model };
      }

      const models = Object.values(store.models);
      const patterns = Object.values(store.patterns);

      return {
        _realEmbeddings: !!realEmbeddings,
        embeddingProvider: realEmbeddings ? `@hive-flow/embeddings (${embeddingServiceName})` : 'hash-based (deterministic)',
        models: {
          total: models.length,
          ready: models.filter(m => m.status === 'ready').length,
          training: 0,
          avgAccuracy: models.length > 0
            ? models.reduce((sum, m) => sum + m.accuracy, 0) / models.length
            : 0,
        },
        patterns: {
          total: patterns.length,
          byType: patterns.reduce((acc, p) => {
            acc[p.type] = (acc[p.type] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          totalEmbeddingDims: patterns.length > 0 ? patterns[0].embedding.length : 384,
        },
        features: {
          localPatternSearch: true,
          modelTraining: false,
          compression: false,
          optimization: false,
          flashAttention: false,
        },
      };
    },
  },
  {
    name: 'neural_optimize',
    description: 'Optimize neural model performance',
    category: 'neural',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: { type: 'string', description: 'Model ID to optimize' },
        target: { type: 'string', enum: ['speed', 'memory', 'accuracy', 'balanced'], description: 'Optimization target' },
      },
    },
    handler: async (input) => {
      const target = (input.target as string) || 'balanced';

      return {
        success: false,
        status: 'unavailable',
        error: 'Neural model optimization is unavailable because no local neural model runtime is present.',
        target,
      };
    },
  },
];
