import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HNSWIndex } from './hnsw-index.js';

function createDeterministicRandom(seed = 0x12345678): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state + 1) / 0x100000001;
  };
}

function sampleLevels(index: HNSWIndex, sampleCount: number, seed?: number): number[] {
  const random = createDeterministicRandom(seed);
  const spy = vi.spyOn(Math, 'random').mockImplementation(random);

  try {
    const getRandomLevel = (index as unknown as { getRandomLevel: () => number }).getRandomLevel;
    return Array.from({ length: sampleCount }, () => getRandomLevel.call(index));
  } finally {
    spy.mockRestore();
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe('HNSWIndex', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getRandomLevel', () => {
    it('samples standard HNSW geometric levels from the configured M and caps levels', () => {
      const sampleCount = 100_000;
      const m16Levels = sampleLevels(new HNSWIndex({ dimensions: 2, M: 16 }), sampleCount, 42);
      const m4Levels = sampleLevels(new HNSWIndex({ dimensions: 2, M: 4 }), sampleCount, 42);

      expect(Math.max(...m16Levels)).toBeLessThanOrEqual(16);
      expect(Math.max(...m4Levels)).toBeLessThanOrEqual(16);

      expect(mean(m16Levels)).toBeGreaterThan(0.045);
      expect(mean(m16Levels)).toBeLessThan(0.09);

      expect(mean(m4Levels)).toBeGreaterThan(0.28);
      expect(mean(m4Levels)).toBeLessThan(0.38);
      expect(mean(m4Levels)).toBeGreaterThan(mean(m16Levels) * 3);

      const getRandomLevel = (
        new HNSWIndex({ dimensions: 2, M: 16 }) as unknown as { getRandomLevel: () => number }
      ).getRandomLevel;
      vi.spyOn(Math, 'random').mockReturnValue(Number.MIN_VALUE);
      expect(getRandomLevel.call(new HNSWIndex({ dimensions: 2, M: 16 }))).toBe(16);
    });
  });

  describe('persistence', () => {
    it('saves and loads searchable index content through the IVectorIndex API', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'hive-flow-hnsw-'));
      const savePath = join(tempDir, 'index.json');
      const config = { dimensions: 2, M: 16, metric: 'cosine' as const };

      try {
        const index = new HNSWIndex(config);
        await index.addPoint('persisted-across-processes', new Float32Array([1, 0]));

        expect(index.size()).toBe(1);
        await expect(index.search(new Float32Array([1, 0]), 1)).resolves.toEqual([
          { id: 'persisted-across-processes', distance: 0 },
        ]);

        await index.save(savePath);

        const freshIndex = new HNSWIndex(config);
        expect(freshIndex.size()).toBe(0);

        await freshIndex.load(savePath);
        expect(freshIndex.size()).toBe(1);
        await expect(freshIndex.search(new Float32Array([1, 0]), 1)).resolves.toEqual([
          { id: 'persisted-across-processes', distance: 0 },
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
