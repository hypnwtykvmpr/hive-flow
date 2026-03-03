/**
 * ContextReranker Tests
 *
 * Tests cover:
 * 1. computeCompositeScore() - verifies score is in [0, 1] range
 * 2. Phase transitions - 65%, 75%, 90% context percentage → correct phase
 * 3. generateCullPlan() - bottom 20% in entriesToCull, next 20% in entriesToSummarize
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Module mocks ----
vi.mock('../../src/services/context-shadow.js', () => {
  // Use a real function (not arrow) so it can be called as a constructor
  function ContextShadow() {
    return {
      getState: vi.fn(),
      getAll: vi.fn(),
      updateRankings: vi.fn(),
      updateSummaries: vi.fn(),
      getByRank: vi.fn(),
      getLowestRanked: vi.fn(),
      initialize: vi.fn(),
    };
  }
  return { ContextShadow };
});

import { ContextReranker } from '../../src/services/context-reranker.js';
import { ContextShadow } from '../../src/services/context-shadow.js';
import type { ShadowEntry, ShadowState } from '../../src/services/context-shadow.js';

// ---- Helpers ----

type MockShadow = {
  getState: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  updateRankings: ReturnType<typeof vi.fn>;
  updateSummaries: ReturnType<typeof vi.fn>;
  getByRank: ReturnType<typeof vi.fn>;
  getLowestRanked: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
};

function makeEntry(overrides: Partial<ShadowEntry> = {}): ShadowEntry {
  return {
    id: 'e1',
    messageIndex: 0,
    role: 'user',
    content: 'some content for testing',
    contentHash: 'hash1',
    sessionId: 'sess',
    tokenEstimate: 50,
    importanceScore: 0.5,
    importanceRank: 0,
    lastRankedAt: 0,
    summaryShort: '',
    summaryLong: '',
    toolNames: [],
    filePaths: [],
    embedding: null,
    confidence: 1.0,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeState(contextPercentage: number): ShadowState {
  const tokens = Math.floor(contextPercentage * 200_000);
  let phase: ShadowState['rankingPhase'] = 'tracking';
  if (contextPercentage >= 0.85) phase = 'critical';
  else if (contextPercentage >= 0.70) phase = 'warning';
  return {
    totalEntries: 10,
    totalTokens: tokens,
    contextPercentage,
    rankingPhase: phase,
    lastUpdated: Date.now(),
  };
}

// ---- Tests ----

describe('ContextReranker', () => {
  let mockShadow: MockShadow;
  let reranker: ContextReranker;

  beforeEach(() => {
    vi.clearAllMocks();
    // Instantiate the mocked class — the factory returns a plain object acting as the shadow
    mockShadow = new (ContextShadow as unknown as new () => MockShadow)();
    reranker = new ContextReranker(mockShadow as never);
  });

  describe('computeCompositeScore()', () => {
    it('returns a score in the [0, 1] range for a basic entry', async () => {
      const entry = makeEntry();
      mockShadow.getState.mockResolvedValue(makeState(0.5));
      mockShadow.getAll.mockResolvedValue([entry]);
      mockShadow.updateRankings.mockResolvedValue(undefined);

      await reranker.trackPhase('sess');

      const rankings: Array<{ id: string; score: number; rank: number }> =
        mockShadow.updateRankings.mock.calls[0][0];
      expect(rankings[0].score).toBeGreaterThanOrEqual(0);
      expect(rankings[0].score).toBeLessThanOrEqual(1);
    });

    it('gives higher score to entry with tool calls and file paths', async () => {
      const rich = makeEntry({ id: 'rich', toolNames: ['Read'], filePaths: ['src/a.ts'] });
      const plain = makeEntry({ id: 'plain' });

      mockShadow.getState.mockResolvedValue(makeState(0.5));
      mockShadow.getAll.mockResolvedValue([rich, plain]);
      mockShadow.updateRankings.mockResolvedValue(undefined);

      await reranker.trackPhase('sess');

      const rankings: Array<{ id: string; score: number; rank: number }> =
        mockShadow.updateRankings.mock.calls[0][0];
      const richScore = rankings.find(r => r.id === 'rich')!.score;
      const plainScore = rankings.find(r => r.id === 'plain')!.score;
      expect(richScore).toBeGreaterThan(plainScore);
    });

    it('score is lower for older entries due to recency decay', async () => {
      const fresh = makeEntry({ id: 'fresh', createdAt: Date.now() - 1_000 });
      const old = makeEntry({ id: 'old', createdAt: Date.now() - 30 * 86_400_000 });

      mockShadow.getState.mockResolvedValue(makeState(0.5));
      mockShadow.getAll.mockResolvedValue([fresh, old]);
      mockShadow.updateRankings.mockResolvedValue(undefined);

      await reranker.trackPhase('sess');

      const rankings: Array<{ id: string; score: number; rank: number }> =
        mockShadow.updateRankings.mock.calls[0][0];
      const freshScore = rankings.find(r => r.id === 'fresh')!.score;
      const oldScore = rankings.find(r => r.id === 'old')!.score;
      expect(freshScore).toBeGreaterThan(oldScore);
    });
  });

  describe('Phase transitions', () => {
    it('rerank() returns "tracking" phase at 65% context', async () => {
      mockShadow.getState.mockResolvedValue(makeState(0.65));
      mockShadow.getAll.mockResolvedValue([makeEntry()]);
      mockShadow.updateRankings.mockResolvedValue(undefined);

      const result = await reranker.rerank('sess');

      expect(result.phase).toBe('tracking');
      expect(result.cullPlan).toBeNull();
    });

    it('rerank() returns "warning" phase at 75% context', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({ id: `e${i}`, contentHash: `h${i}`, importanceScore: i * 0.1 }),
      );

      mockShadow.getState.mockResolvedValue(makeState(0.75));
      mockShadow.getAll.mockResolvedValue(entries);
      mockShadow.updateRankings.mockResolvedValue(undefined);
      mockShadow.updateSummaries.mockResolvedValue(undefined);

      const result = await reranker.rerank('sess');

      expect(result.phase).toBe('warning');
      expect(result.cullPlan).not.toBeNull();
      expect(result.cullPlan!.phase).toBe('warning');
    });

    it('rerank() returns "critical" phase at 90% context', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({ id: `e${i}`, contentHash: `h${i}`, importanceScore: i * 0.1 }),
      );

      mockShadow.getState.mockResolvedValue(makeState(0.90));
      mockShadow.getAll.mockResolvedValue(entries);
      mockShadow.updateRankings.mockResolvedValue(undefined);
      mockShadow.updateSummaries.mockResolvedValue(undefined);

      const result = await reranker.rerank('sess');

      expect(result.phase).toBe('critical');
      expect(result.cullPlan).not.toBeNull();
      expect(result.cullPlan!.phase).toBe('critical');
    });
  });

  describe('generateCullPlan()', () => {
    it('places bottom 20% of entries in entriesToCull', async () => {
      // 10 entries → ceil(10 * 0.20) = 2 culled
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({ id: `e${i}`, contentHash: `h${i}`, importanceScore: (10 - i) * 0.1 }),
      );

      mockShadow.getState.mockResolvedValue(makeState(0.75));
      mockShadow.getAll.mockResolvedValue(entries);
      mockShadow.updateRankings.mockResolvedValue(undefined);
      mockShadow.updateSummaries.mockResolvedValue(undefined);

      const result = await reranker.rerank('sess');

      expect(result.cullPlan!.entriesToCull).toHaveLength(2);
    });

    it('places next 20% of entries in entriesToSummarize', async () => {
      // 10 entries → ceil(10 * 0.20) = 2 to summarize
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({ id: `e${i}`, contentHash: `h${i}`, importanceScore: (10 - i) * 0.1 }),
      );

      mockShadow.getState.mockResolvedValue(makeState(0.75));
      mockShadow.getAll.mockResolvedValue(entries);
      mockShadow.updateRankings.mockResolvedValue(undefined);
      mockShadow.updateSummaries.mockResolvedValue(undefined);

      const result = await reranker.rerank('sess');

      expect(result.cullPlan!.entriesToSummarize).toHaveLength(2);
    });

    it('cull plan includes tokensFreed and tokensRetained summing to total', async () => {
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeEntry({ id: `e${i}`, contentHash: `h${i}`, tokenEstimate: 100, importanceScore: i * 0.2 }),
      );

      mockShadow.getState.mockResolvedValue(makeState(0.90));
      mockShadow.getAll.mockResolvedValue(entries);
      mockShadow.updateRankings.mockResolvedValue(undefined);
      mockShadow.updateSummaries.mockResolvedValue(undefined);

      const result = await reranker.rerank('sess');
      const plan = result.cullPlan!;

      expect(plan.tokensFreed).toBeGreaterThan(0);
      expect(plan.tokensRetained).toBeGreaterThanOrEqual(0);
      expect(plan.tokensFreed + plan.tokensRetained).toBe(500);
    });

    it('cull plan entries include required fields', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({
          id: `e${i}`,
          contentHash: `h${i}`,
          importanceScore: i * 0.1,
          summaryShort: i > 7 ? `short${i}` : '',
        }),
      );

      mockShadow.getState.mockResolvedValue(makeState(0.75));
      mockShadow.getAll.mockResolvedValue(entries);
      mockShadow.updateRankings.mockResolvedValue(undefined);
      mockShadow.updateSummaries.mockResolvedValue(undefined);

      const result = await reranker.rerank('sess');
      const first = result.cullPlan!.entriesToCull[0];

      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('score');
      expect(first).toHaveProperty('tokenEstimate');
      expect(first).toHaveProperty('summaryShort');
    });
  });
});
