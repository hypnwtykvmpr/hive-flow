/**
 * ContextManagerWorker Tests
 *
 * Tests cover:
 * 1. Returns early with success when no transcript is found
 * 2. Calls reranker and saves cull plan JSON when transcript exists
 * 3. All file I/O and class dependencies are mocked
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Module mocks ----
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/'),
}));

// Shared spy refs so tests can override return values per-test
const mockRerank = vi.fn().mockResolvedValue({
  phase: 'tracking',
  entriesRanked: 5,
  cullPlan: null,
  durationMs: 10,
});
const mockShadowInitialize = vi.fn().mockResolvedValue(undefined);
const mockShadowUpdateFromTranscript = vi.fn().mockResolvedValue({
  totalEntries: 5,
  totalTokens: 1000,
  contextPercentage: 0.5,
  rankingPhase: 'tracking',
  lastUpdated: Date.now(),
});
const mockShadowGetAll = vi.fn().mockResolvedValue([]);

vi.mock('../../src/services/context-shadow.js', () => {
  function ContextShadow() {
    return {
      initialize: mockShadowInitialize,
      updateFromTranscript: mockShadowUpdateFromTranscript,
      getAll: mockShadowGetAll,
    };
  }
  return { ContextShadow };
});

vi.mock('../../src/services/context-reranker.js', () => {
  function ContextReranker() {
    return { rerank: mockRerank };
  }
  return { ContextReranker };
});

vi.mock('../../src/services/context-offloader.js', () => {
  function ContextOffloader() {
    return {
      isEnabled: vi.fn().mockReturnValue(false),
      checkProviders: vi.fn().mockReturnValue({ gemini: false, codex: false, cursor: false, recommended: null }),
      buildRequest: vi.fn().mockReturnValue({}),
      buildOffloadPrompt: vi.fn().mockReturnValue('prompt'),
    };
  }
  return { ContextOffloader };
});

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { runContextManagerWorker } from '../../src/services/context-manager-worker.js';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;

// ---- Tests ----

describe('runContextManagerWorker()', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset shared spy return values to defaults
    mockRerank.mockResolvedValue({
      phase: 'tracking',
      entriesRanked: 5,
      cullPlan: null,
      durationMs: 10,
    });
    mockShadowInitialize.mockResolvedValue(undefined);
    mockShadowUpdateFromTranscript.mockResolvedValue({
      totalEntries: 5,
      totalTokens: 1000,
      contextPercentage: 0.5,
      rankingPhase: 'tracking',
      lastUpdated: Date.now(),
    });
    mockShadowGetAll.mockResolvedValue([]);

    // Default: no directories or files exist
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    mockStatSync.mockReturnValue({ mtimeMs: 0 });
    mockReadFileSync.mockReturnValue('');
  });

  describe('early return when no transcript found', () => {
    it('returns success: true with tracking phase and zero entries when no transcript exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await runContextManagerWorker('/project');

      expect(result.success).toBe(true);
      expect(result.phase).toBe('tracking');
      expect(result.entriesTracked).toBe(0);
      expect(result.cullPlanGenerated).toBe(false);
    });

    it('does not call reranker.rerank() when no transcript is found', async () => {
      mockExistsSync.mockReturnValue(false);

      await runContextManagerWorker('/project');

      expect(mockRerank).not.toHaveBeenCalled();
    });
  });

  describe('normal execution with transcript', () => {
    function setupTranscriptExists() {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['session.jsonl']);
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() });
      mockReadFileSync.mockReturnValue(JSON.stringify({ sessionId: 'sess-abc' }));
    }

    it('returns success: true with tracking phase when reranker returns tracking', async () => {
      setupTranscriptExists();

      const result = await runContextManagerWorker('/project');

      expect(result.success).toBe(true);
      expect(result.phase).toBe('tracking');
    });

    it('calls shadow.initialize()', async () => {
      setupTranscriptExists();

      await runContextManagerWorker('/project');

      expect(mockShadowInitialize).toHaveBeenCalled();
    });

    it('calls reranker.rerank() when transcript is found', async () => {
      setupTranscriptExists();

      await runContextManagerWorker('/project');

      expect(mockRerank).toHaveBeenCalled();
    });

    it('does not write cull-plan.json when cullPlan is null', async () => {
      setupTranscriptExists();

      await runContextManagerWorker('/project');

      const cullPlanWritten = mockWriteFileSync.mock.calls.some(
        ([p]: [string]) => String(p).includes('cull-plan.json'),
      );
      expect(cullPlanWritten).toBe(false);
    });

    it('writes cull-plan.json when reranker returns a cull plan', async () => {
      setupTranscriptExists();

      const mockCullPlan = {
        sessionId: 'sess-abc',
        createdAt: Date.now(),
        phase: 'warning',
        entriesToCull: [],
        entriesToSummarize: [],
        tokensFreed: 100,
        tokensRetained: 900,
        totalEntries: 10,
      };

      mockRerank.mockResolvedValue({
        phase: 'warning',
        entriesRanked: 10,
        cullPlan: mockCullPlan,
        durationMs: 20,
      });

      await runContextManagerWorker('/project');

      const cullPlanCalls = mockWriteFileSync.mock.calls.filter(
        ([p]: [string]) => String(p).includes('cull-plan.json'),
      );
      expect(cullPlanCalls.length).toBe(1);
      const writtenContent = JSON.parse(cullPlanCalls[0][1]);
      expect(writtenContent.phase).toBe('warning');
    });

    it('sets cullPlanGenerated: true in result when cull plan exists', async () => {
      setupTranscriptExists();

      mockRerank.mockResolvedValue({
        phase: 'critical',
        entriesRanked: 10,
        cullPlan: {
          sessionId: 'sess-abc',
          createdAt: Date.now(),
          phase: 'critical',
          entriesToCull: [],
          entriesToSummarize: [],
          tokensFreed: 200,
          tokensRetained: 800,
          totalEntries: 10,
        },
        durationMs: 15,
      });

      const result = await runContextManagerWorker('/project');

      expect(result.cullPlanGenerated).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns success: false with error message when shadow.initialize() throws', async () => {
      mockShadowInitialize.mockRejectedValue(new Error('disk full'));

      const result = await runContextManagerWorker('/project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('disk full');
    });

    it('includes durationMs as a non-negative number in the result', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await runContextManagerWorker('/project');

      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('offload behaviour', () => {
    function setupTranscriptExists() {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(['session.jsonl']);
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() });
      mockReadFileSync.mockReturnValue(JSON.stringify({ sessionId: 'sess-abc' }));
    }

    it('does not attempt offload when phase is tracking', async () => {
      setupTranscriptExists();

      const result = await runContextManagerWorker('/project');

      expect(result.offloadAttempted).toBe(false);
    });

    it('does not attempt offload when offloader is disabled', async () => {
      setupTranscriptExists();

      mockRerank.mockResolvedValue({
        phase: 'warning',
        entriesRanked: 5,
        cullPlan: null,
        durationMs: 10,
      });

      const result = await runContextManagerWorker('/project');

      // offloader.isEnabled() returns false by default in mock
      expect(result.offloadAttempted).toBe(false);
    });
  });
});
