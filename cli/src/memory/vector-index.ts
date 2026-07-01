import type { DistanceMetric } from './types.js';

export interface VectorIndexConfig {
  dims: number;
  metric: DistanceMetric;
  M?: number;
  efConstruction?: number;
  maxElements?: number;
}

export interface VectorIndexStats {
  vectorCount: number;
  memoryUsage: number;
  avgSearchTime: number;
}

/**
 * Storage-free ANN vector-index seam. `searchKNN()` returns scores where higher
 * means closer/more-similar, never raw lower-is-better distances.
 *
 * Future native `hnsw_rs`/napi bindings should satisfy this interface directly
 * so callers can replace the default JS index without changing memory CRUD,
 * storage, or embedding layers.
 */
export interface IVectorIndex {
  init(config: VectorIndexConfig): Promise<void>;
  add(id: string, vector: Float32Array): Promise<void>;
  addBatch(items: Array<{ id: string; vector: Float32Array }>): Promise<void>;
  remove(id: string): Promise<boolean>;
  searchKNN(
    query: Float32Array,
    k: number,
    ef?: number
  ): Promise<Array<{ id: string; score: number }>>;
  size(): number;
  save(path: string): Promise<void>;
  load(path: string): Promise<void>;
  stats(): VectorIndexStats;
}

export function distanceToHigherScore(metric: DistanceMetric, distance: number): number {
  switch (metric) {
    case 'cosine':
      return 1 - distance;
    case 'dot':
    case 'euclidean':
    case 'manhattan':
      return -distance;
  }
}
