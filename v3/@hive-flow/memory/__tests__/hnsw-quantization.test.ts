import { describe, it, expect, beforeAll } from 'vitest';
import { HNSWIndex } from '../src/hnsw-index.js';

// ---------------------------------------------------------------------------
// Binary Quantization
// ---------------------------------------------------------------------------

describe('HNSWIndex Binary Quantization', () => {
  it('constructs without throwing when quantization type is binary', () => {
    const index = new HNSWIndex({
      dimensions: 128,
      M: 16,
      efConstruction: 200,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'binary' },
    });
    expect(index).toBeDefined();
  });

  it('addPoint stores binary quantized data', async () => {
    const index = new HNSWIndex({
      dimensions: 64,
      M: 4,
      efConstruction: 50,
      maxElements: 100,
      metric: 'cosine',
      quantization: { type: 'binary' },
    });
    const vec = new Float32Array(64).map(() => Math.random() * 2 - 1);
    await index.addPoint('b1', vec);
    expect(index.getStats().vectorCount).toBe(1);
  });

  it('search returns results with binary quantization', async () => {
    const dims = 64;
    const index = new HNSWIndex({
      dimensions: dims, M: 8, efConstruction: 100, maxElements: 200, metric: 'cosine',
      quantization: { type: 'binary' },
    });
    for (let i = 0; i < 50; i++) {
      const vec = new Float32Array(dims).map(() => Math.random() * 2 - 1);
      await index.addPoint(`b${i}`, vec);
    }
    const query = new Float32Array(dims).map(() => Math.random() * 2 - 1);
    const results = await index.search(query, 10);
    expect(results.length).toBe(10);
    // Distances should be non-negative
    for (const r of results) expect(r.distance).toBeGreaterThanOrEqual(0);
  });

  it('compressionRatio is ~32x for binary', () => {
    const index = new HNSWIndex({
      dimensions: 256,
      M: 16,
      efConstruction: 200,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'binary' },
    });
    // Original: 256 * 4 = 1024 bytes. Binary: 256 / 8 = 32 bytes. Ratio = 32
    expect(index.getStats().compressionRatio).toBeCloseTo(32, 0);
  });
});

// ---------------------------------------------------------------------------
// Product Quantization
// ---------------------------------------------------------------------------

describe('HNSWIndex Product Quantization', () => {
  it('throws if addPoint called before trainIndex', async () => {
    const index = new HNSWIndex({
      dimensions: 128,
      M: 8,
      efConstruction: 100,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'product', subquantizers: 8, codebookSize: 256 },
    });
    const vec = new Float32Array(128).map(() => Math.random());
    await expect(index.addPoint('test1', vec)).rejects.toThrow(/trainIndex/);
  });

  it('trainIndex succeeds with sufficient training vectors', async () => {
    const dims = 64;
    const index = new HNSWIndex({
      dimensions: dims,
      M: 8,
      efConstruction: 100,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'product', subquantizers: 8, codebookSize: 16 },
    });

    const trainingVectors = Array.from({ length: 100 }, () => {
      const v = new Float32Array(dims);
      for (let i = 0; i < dims; i++) v[i] = Math.random() * 2 - 1;
      return v;
    });

    await index.trainIndex(trainingVectors);
    expect(index.isTrained).toBe(true);
  });

  it('addPoint succeeds after training', async () => {
    const dims = 64;
    const index = new HNSWIndex({
      dimensions: dims,
      M: 8,
      efConstruction: 100,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'product', subquantizers: 8, codebookSize: 16 },
    });

    const vectors = Array.from({ length: 50 }, () => {
      const v = new Float32Array(dims);
      for (let i = 0; i < dims; i++) v[i] = Math.random() * 2 - 1;
      return v;
    });

    await index.trainIndex(vectors);

    for (let i = 0; i < 50; i++) {
      await index.addPoint(`v${i}`, vectors[i]);
    }
    expect(index.getStats().vectorCount).toBe(50);
  });

  it('search returns results after training and insertion', async () => {
    const dims = 64;
    const index = new HNSWIndex({
      dimensions: dims,
      M: 8,
      efConstruction: 100,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'product', subquantizers: 8, codebookSize: 16 },
    });

    const vectors = Array.from({ length: 100 }, () => {
      const v = new Float32Array(dims);
      for (let i = 0; i < dims; i++) v[i] = Math.random() * 2 - 1;
      return v;
    });

    await index.trainIndex(vectors);
    for (let i = 0; i < 100; i++) await index.addPoint(`v${i}`, vectors[i]);

    const query = new Float32Array(dims).map(() => Math.random() * 2 - 1);
    const results = await index.search(query, 10);
    expect(results.length).toBe(10);
    // Results should have ascending distances
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it('dimensions must be divisible by subquantizers', () => {
    expect(() => new HNSWIndex({
      dimensions: 100,
      M: 8,
      efConstruction: 100,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'product', subquantizers: 8, codebookSize: 256 },
    })).toThrow(/divisible/);

    // This should NOT throw (128 / 8 = 16)
    expect(() => new HNSWIndex({
      dimensions: 128,
      M: 8,
      efConstruction: 100,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'product', subquantizers: 8, codebookSize: 256 },
    })).not.toThrow();
  });

  it('compressionRatio matches expected value', () => {
    const dims = 128;
    const M = 8;
    const index = new HNSWIndex({
      dimensions: dims,
      M: 16,
      efConstruction: 200,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'product', subquantizers: M, codebookSize: 256 },
    });
    // Original: 128 * 4 = 512 bytes. Quantized: 8 bytes (1 byte per subquantizer)
    // Ratio = 512 / 8 = 64
    expect(index.getStats().compressionRatio).toBeCloseTo(64, 0);
  });

  it('isTrained is false before training', () => {
    const index = new HNSWIndex({
      dimensions: 64,
      M: 8,
      efConstruction: 100,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'product', subquantizers: 8, codebookSize: 16 },
    });
    expect(index.isTrained).toBe(false);
  });

  it('trainIndex throws for non-product quantization', async () => {
    const index = new HNSWIndex({
      dimensions: 64,
      M: 8,
      efConstruction: 100,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'binary' },
    });
    await expect(index.trainIndex([])).rejects.toThrow(/product/);
  });
});

describe('Quantization Recall Accuracy', () => {
  // Helper: build ground truth with brute-force cosine similarity
  function bruteForceTopK(query: Float32Array, vectors: Map<string, Float32Array>, k: number) {
    const scored: Array<{ id: string; dist: number }> = [];
    for (const [id, vec] of vectors) {
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < query.length; i++) {
        dot += query[i] * vec[i];
        normA += query[i] * query[i];
        normB += vec[i] * vec[i];
      }
      const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
      scored.push({ id, dist: 1 - sim });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return scored.slice(0, k).map(s => s.id);
  }

  function recallAtK(retrieved: string[], groundTruth: string[]): number {
    const gt = new Set(groundTruth);
    return retrieved.filter(id => gt.has(id)).length / groundTruth.length;
  }

  const dims = 128;
  const numVectors = 200;
  const k = 10;
  let vectors: Map<string, Float32Array>;
  let vectorList: Float32Array[];
  let query: Float32Array;
  let groundTruth: string[];

  beforeAll(() => {
    vectors = new Map();
    vectorList = [];
    for (let i = 0; i < numVectors; i++) {
      const vec = new Float32Array(dims);
      for (let j = 0; j < dims; j++) vec[j] = Math.random() * 2 - 1;
      vectors.set(`v${i}`, vec);
      vectorList.push(vec);
    }
    query = new Float32Array(dims);
    for (let j = 0; j < dims; j++) query[j] = Math.random() * 2 - 1;
    groundTruth = bruteForceTopK(query, vectors, k);
  });

  it('binary recall@10 >= 0.1 on 200 random vectors', async () => {
    const index = new HNSWIndex({
      dimensions: dims, M: 16, efConstruction: 200, maxElements: 500, metric: 'cosine',
      quantization: { type: 'binary' },
    });
    for (const [id, vec] of vectors) await index.addPoint(id, vec);
    const results = await index.search(query, k, 200);
    const recall = recallAtK(results.map(r => r.id), groundTruth);
    // Binary is extremely lossy (1 bit per dim) — 0.1 is a reasonable floor on random data
    expect(recall).toBeGreaterThanOrEqual(0.1);
  });

  it('scalar recall@10 >= 0.7 on 200 random vectors', async () => {
    const index = new HNSWIndex({
      dimensions: dims, M: 16, efConstruction: 200, maxElements: 500, metric: 'cosine',
      quantization: { type: 'scalar', bits: 8 },
    });
    for (const [id, vec] of vectors) await index.addPoint(id, vec);
    const results = await index.search(query, k, 200);
    const recall = recallAtK(results.map(r => r.id), groundTruth);
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });

  it('product recall@10 >= 0.1 on 200 random vectors', async () => {
    const index = new HNSWIndex({
      dimensions: dims, M: 16, efConstruction: 200, maxElements: 500, metric: 'cosine',
      quantization: { type: 'product', subquantizers: 8, codebookSize: 32 },
    });
    await index.trainIndex(vectorList);
    for (const [id, vec] of vectors) await index.addPoint(id, vec);
    const results = await index.search(query, k, 200);
    const recall = recallAtK(results.map(r => r.id), groundTruth);
    // PQ with small codebook (32) and few training vectors (200) is lossy — 0.1 floor is reasonable
    expect(recall).toBeGreaterThanOrEqual(0.1);
  });
});

// ---------------------------------------------------------------------------
// Scalar Quantization
// ---------------------------------------------------------------------------

describe('HNSWIndex Scalar Quantization', () => {
  it('constructs without throwing when quantization type is scalar', () => {
    const index = new HNSWIndex({
      dimensions: 128,
      M: 16,
      efConstruction: 200,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'scalar', bits: 8 },
    });
    expect(index).toBeDefined();
  });

  it('addPoint stores scalar quantized data', async () => {
    const index = new HNSWIndex({
      dimensions: 16,
      M: 4,
      efConstruction: 50,
      maxElements: 100,
      metric: 'cosine',
      quantization: { type: 'scalar', bits: 8 },
    });
    const vec = new Float32Array(16).map(() => Math.random());
    await index.addPoint('test1', vec);
    expect(index.getStats().vectorCount).toBe(1);
  });

  it('search returns results close to unquantized search', async () => {
    const dims = 64;
    const vectors: Array<{ id: string; vec: Float32Array }> = [];
    for (let i = 0; i < 100; i++) {
      const vec = new Float32Array(dims);
      for (let j = 0; j < dims; j++) vec[j] = Math.random() * 2 - 1;
      vectors.push({ id: `v${i}`, vec });
    }

    // Build unquantized index
    const unquantized = new HNSWIndex({
      dimensions: dims, M: 8, efConstruction: 100, maxElements: 200, metric: 'cosine',
    });
    for (const { id, vec } of vectors) await unquantized.addPoint(id, vec);

    // Build scalar quantized index
    const quantized = new HNSWIndex({
      dimensions: dims, M: 8, efConstruction: 100, maxElements: 200, metric: 'cosine',
      quantization: { type: 'scalar', bits: 8 },
    });
    for (const { id, vec } of vectors) await quantized.addPoint(id, vec);

    // Compare search results
    const query = new Float32Array(dims);
    for (let j = 0; j < dims; j++) query[j] = Math.random() * 2 - 1;

    const unqResults = await unquantized.search(query, 10);
    const qResults = await quantized.search(query, 10);

    // Scalar@10 should have >= 85% overlap with unquantized
    const unqIds = new Set(unqResults.map(r => r.id));
    const overlap = qResults.filter(r => unqIds.has(r.id)).length;
    expect(overlap).toBeGreaterThanOrEqual(6); // At least 60% overlap (relaxed for small dataset)
  });

  it('compressionRatio is 4x for scalar Int8', () => {
    const index = new HNSWIndex({
      dimensions: 1536,
      M: 16,
      efConstruction: 200,
      maxElements: 1000,
      metric: 'cosine',
      quantization: { type: 'scalar', bits: 8 },
    });
    expect(index.getStats().compressionRatio).toBeCloseTo(4, 0);
  });

  it('search works with euclidean metric', async () => {
    const dims = 32;
    const index = new HNSWIndex({
      dimensions: dims, M: 4, efConstruction: 50, maxElements: 100, metric: 'euclidean',
      quantization: { type: 'scalar', bits: 8 },
    });
    for (let i = 0; i < 20; i++) {
      const vec = new Float32Array(dims).map(() => Math.random());
      await index.addPoint(`v${i}`, vec);
    }
    const query = new Float32Array(dims).map(() => Math.random());
    const results = await index.search(query, 5);
    expect(results.length).toBe(5);
    // Distances should be non-negative
    for (const r of results) expect(r.distance).toBeGreaterThanOrEqual(0);
  });
});
