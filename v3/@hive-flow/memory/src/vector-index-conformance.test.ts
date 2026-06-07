import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HNSWIndex } from './hnsw-index.js';
import * as agentdbBackend from './agentdb-backend.js';
import type { IVectorIndex } from './vector-index.js';

type VectorIndexFactory = () => IVectorIndex;

const REQUIRED_METHODS = [
  'init',
  'add',
  'addBatch',
  'remove',
  'searchKNN',
  'size',
  'save',
  'load',
  'stats',
] as const;

function expectVectorIndexSurface(index: unknown): asserts index is IVectorIndex {
  for (const method of REQUIRED_METHODS) {
    expect((index as Record<string, unknown>)[method], method).toBeTypeOf('function');
  }
}

function createAgentDBVectorIndex(): IVectorIndex {
  const Adapter = (agentdbBackend as Record<string, unknown>).AgentDBVectorIndex;
  expect(Adapter, 'AgentDBVectorIndex export').toBeTypeOf('function');
  return new (Adapter as new () => IVectorIndex)();
}

function recallAtK(results: Array<{ id: string }>, expectedIds: string[]): number {
  const resultIds = new Set(results.map((result) => result.id));
  const hits = expectedIds.filter((id) => resultIds.has(id)).length;
  return hits / expectedIds.length;
}

const implementations: Array<{ name: string; create: VectorIndexFactory }> = [
  {
    name: 'js-hnsw',
    create: () => new HNSWIndex(),
  },
  {
    name: 'agentdb-hnsw',
    create: createAgentDBVectorIndex,
  },
];

describe.each(implementations)('IVectorIndex conformance: $name', ({ create }) => {
  it('supports the full ANN lifecycle with higher searchKNN scores for closer vectors', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hive-flow-vector-index-'));
    const savePath = join(tempDir, 'index.json');

    try {
      const index = create();
      expectVectorIndexSurface(index);

      await index.init({ dims: 3, metric: 'cosine', M: 4, efConstruction: 24, maxElements: 32 });
      await index.add('exact', new Float32Array([1, 0, 0]));
      await index.addBatch([
        { id: 'near', vector: new Float32Array([0.92, 0.08, 0]) },
        { id: 'far', vector: new Float32Array([0, 1, 0]) },
        { id: 'opposite', vector: new Float32Array([-1, 0, 0]) },
      ]);

      expect(index.size()).toBe(4);

      const firstSearch = await index.searchKNN(new Float32Array([1, 0, 0]), 3, 16);
      expect(firstSearch).toHaveLength(3);
      expect(firstSearch[0]?.id).toBe('exact');
      expect(firstSearch.map((result) => result.id)).toContain('near');
      expect(recallAtK(firstSearch, ['exact', 'near', 'far'])).toBeGreaterThanOrEqual(2 / 3);
      expect(firstSearch[0]!.score).toBeGreaterThan(firstSearch[1]!.score);
      expect(firstSearch[1]!.score).toBeGreaterThan(firstSearch[2]!.score);

      const broadSearch = await index.searchKNN(new Float32Array([1, 0, 0]), 4, 16);
      const scoreById = new Map(broadSearch.map((result) => [result.id, result.score]));
      expect(scoreById.get('exact')).toBeGreaterThan(scoreById.get('near')!);
      expect(scoreById.get('near')).toBeGreaterThan(scoreById.get('far')!);
      expect(scoreById.get('far')).toBeGreaterThan(scoreById.get('opposite')!);

      expect(await index.remove('far')).toBe(true);
      expect(await index.remove('missing')).toBe(false);
      expect(index.size()).toBe(3);
      expect((await index.searchKNN(new Float32Array([0, 1, 0]), 3, 16)).map((r) => r.id)).not.toContain('far');

      await index.save(savePath);

      const loaded = create();
      expectVectorIndexSurface(loaded);
      await loaded.load(savePath);
      expect(loaded.size()).toBe(3);

      const loadedSearch = await loaded.searchKNN(new Float32Array([1, 0, 0]), 3, 16);
      expect(loadedSearch[0]?.id).toBe('exact');
      expect(loadedSearch.map((result) => result.id)).toContain('near');
      expect(loadedSearch.map((result) => result.id)).not.toContain('far');

      const stats = loaded.stats();
      expect(stats.vectorCount).toBe(3);
      expect(stats.memoryUsage).toBeGreaterThan(0);
      expect(stats.avgSearchTime).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
