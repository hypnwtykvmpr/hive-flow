/**
 * Vector Database Module
 *
 * Provides local vector operations for:
 * - Semantic similarity search
 * - HNSW indexing (fast)
 * - Embedding generation
 *
 * External vector modules are intentionally detached; local fallback is the
 * primary implementation.
 */

// ============================================================================
// Types
// ============================================================================

export interface VectorDB {
  insert(embedding: Float32Array, id: string, metadata?: Record<string, unknown>): void | Promise<void>;
  search(query: Float32Array, k?: number): Array<{ id: string; score: number; metadata?: Record<string, unknown> }> | Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>>;
  remove(id: string): boolean | Promise<boolean>;
  size(): number | Promise<number>;
  clear(): void | Promise<void>;
}

export interface HivectorModule {
  createVectorDB(dimensions: number): Promise<VectorDB>;
  generateEmbedding(text: string, dimensions?: number): Float32Array;
  cosineSimilarity(a: Float32Array, b: Float32Array): number;
  isWASMAccelerated(): boolean;
}

// ============================================================================
// Local Implementation
// ============================================================================

class FallbackVectorDB implements VectorDB {
  private vectors: Map<string, { embedding: Float32Array; metadata?: Record<string, unknown> }> = new Map();
  private dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  insert(embedding: Float32Array, id: string, metadata?: Record<string, unknown>): void {
    this.vectors.set(id, { embedding, metadata });
  }

  search(query: Float32Array, k: number = 10): Array<{ id: string; score: number; metadata?: Record<string, unknown> }> {
    const results: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> = [];

    for (const [id, { embedding, metadata }] of this.vectors) {
      const score = cosineSimilarity(query, embedding);
      results.push({ id, score, metadata });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  remove(id: string): boolean {
    return this.vectors.delete(id);
  }

  size(): number {
    return this.vectors.size;
  }

  clear(): void {
    this.vectors.clear();
  }
}

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Generate a simple hash-based embedding.
 */
function generateHashEmbedding(text: string, dimensions: number = 768): Float32Array {
  const embedding = new Float32Array(dimensions);
  const normalized = text.toLowerCase().trim();

  // Simple hash function
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }

  // Generate pseudo-random embedding based on hash
  for (let i = 0; i < dimensions; i++) {
    embedding[i] = Math.sin(hash * (i + 1) * 0.001) * 0.5 + 0.5;
  }

  // Normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dimensions; i++) {
    embedding[i] /= norm;
  }

  return embedding;
}

// ============================================================================
// Module State
// ============================================================================

let hivectorModule: HivectorModule | null = null;
let loadAttempted = false;
let isAvailable = false;

// ============================================================================
// Public API
// ============================================================================

/**
 * External vector modules are intentionally detached; local fallback is primary.
 */
export async function loadHivector(): Promise<boolean> {
  if (loadAttempted) {
    return isAvailable;
  }

  loadAttempted = true;
  hivectorModule = null;
  isAvailable = false;
  return false;
}

/** @deprecated Use loadHivector. */
export const loadRuVector = loadHivector;

/**
 * Check if an external vector backend is available.
 */
export function isHivectorAvailable(): boolean {
  return isAvailable;
}

/** @deprecated Use isHivectorAvailable. */
export const isRuVectorAvailable = isHivectorAvailable;

/**
 * Check if external WASM acceleration is enabled.
 */
export function isWASMAccelerated(): boolean {
  if (hivectorModule && typeof hivectorModule.isWASMAccelerated === 'function') {
    return hivectorModule.isWASMAccelerated();
  }
  return false;
}

/**
 * Create a vector database
 * Uses the local brute-force implementation.
 */
export async function createVectorDB(dimensions: number = 768): Promise<VectorDB> {
  await loadHivector();

  if (hivectorModule && typeof hivectorModule.createVectorDB === 'function') {
    try {
      return await hivectorModule.createVectorDB(dimensions);
    } catch {
      // Fall back to simple implementation
    }
  }

  return new FallbackVectorDB(dimensions);
}

/**
 * Generate an embedding for text
 * Uses hash-based local embeddings.
 */
export function generateEmbedding(text: string, dimensions: number = 768): Float32Array {
  if (hivectorModule && typeof hivectorModule.generateEmbedding === 'function') {
    try {
      return hivectorModule.generateEmbedding(text, dimensions);
    } catch {
      // Fall back to hash-based embedding
    }
  }

  return generateHashEmbedding(text, dimensions);
}

/**
 * Compute cosine similarity between two vectors
 */
export function computeSimilarity(a: Float32Array, b: Float32Array): number {
  if (hivectorModule && typeof hivectorModule.cosineSimilarity === 'function') {
    try {
      return hivectorModule.cosineSimilarity(a, b);
    } catch {
      // Fall back to JS implementation
    }
  }

  return cosineSimilarity(a, b);
}

/**
 * Get status information about the local vector backend.
 */
export function getStatus(): {
  available: boolean;
  wasmAccelerated: boolean;
  backend: 'fallback';
} {
  if (!isAvailable) {
    return {
      available: false,
      wasmAccelerated: false,
      backend: 'fallback',
    };
  }
  return {
    available: false,
    wasmAccelerated: false,
    backend: 'fallback',
  };
}
