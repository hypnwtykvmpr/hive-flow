/**
 * V3 Embedding Service Module
 *
 * Production embedding service aligned with agentic-flow@alpha:
 * - OpenAI provider (text-embedding-3-small/large)
 * - Transformers.js provider (local ONNX models)
 * - Agentic-flow provider (optimized ONNX with SIMD)
 * - Mock provider (development/testing)
 *
 * @module @claude-flow/embeddings
 */

export * from './types.js';
export * from './embedding-service.js';

// Re-export commonly used items at top level
export {
  createEmbeddingService,
  getEmbedding,
  cosineSimilarity,
  euclideanDistance,
  dotProduct,
  computeSimilarity,
  OpenAIEmbeddingService,
  TransformersEmbeddingService,
  MockEmbeddingService,
  AgenticFlowEmbeddingService,
} from './embedding-service.js';

export type {
  EmbeddingProvider,
  EmbeddingConfig,
  OpenAIEmbeddingConfig,
  TransformersEmbeddingConfig,
  MockEmbeddingConfig,
  AgenticFlowEmbeddingConfig,
  EmbeddingResult,
  BatchEmbeddingResult,
  IEmbeddingService,
  SimilarityMetric,
  SimilarityResult,
} from './types.js';
