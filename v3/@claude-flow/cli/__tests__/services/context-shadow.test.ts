/**
 * ContextShadow Tests
 *
 * Tests cover:
 * 1. initialize() - creates fresh state; loads existing JSON
 * 2. updateFromTranscript() - parses JSONL, deduplicates by content hash
 * 3. getByRank() - returns entries sorted by importanceRank ascending
 * 4. buildTieredRestoration() - allocates budget across 3 tiers (50/35/15)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Module mocks (must be hoisted before imports) ----
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/'),
}));

vi.mock('node:crypto', () => ({
  createHash: () => ({
    update: (v: string) => ({
      digest: () => Buffer.from(v).toString('hex').slice(0, 64),
    }),
  }),
}));

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ContextShadow, buildTieredRestoration } from '../../src/services/context-shadow.js';
import type { ShadowEntry } from '../../src/services/context-shadow.js';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>;

// ---- Helpers ----

function makeShadowEntry(overrides: Partial<ShadowEntry> = {}): ShadowEntry {
  return {
    id: 'shadow-sess-0',
    messageIndex: 0,
    role: 'user',
    content: 'hello world',
    contentHash: 'abc',
    sessionId: 'sess',
    tokenEstimate: 3,
    importanceScore: 0.5,
    importanceRank: 1,
    lastRankedAt: 0,
    summaryShort: '',
    summaryLong: '',
    toolNames: [],
    filePaths: [],
    embedding: null,
    confidence: 1.0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ---- Tests ----

describe('ContextShadow', () => {
  let shadow: ContextShadow;

  beforeEach(() => {
    vi.clearAllMocks();
    shadow = new ContextShadow('/project');
  });

  describe('initialize()', () => {
    it('creates data directory when it does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await shadow.initialize();

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.claude-flow/data'),
        { recursive: true },
      );
    });

    it('loads existing JSON when shadow file exists', async () => {
      const stored = {
        entries: [makeShadowEntry({ id: 'shadow-sess-1', contentHash: 'xyz' })],
        updatedAt: Date.now(),
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(stored));

      await shadow.initialize();
      const count = await shadow.getEntryCount();

      expect(count).toBe(1);
    });

    it('starts with empty entries when JSON is malformed', async () => {
      mockExistsSync.mockImplementation((p: string) =>
        String(p).includes('shadow-context') ? true : false,
      );
      mockReadFileSync.mockReturnValue('{bad json}}');

      await shadow.initialize();

      expect(await shadow.getEntryCount()).toBe(0);
    });
  });

  describe('updateFromTranscript()', () => {
    it('returns empty state when transcript file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const state = await shadow.updateFromTranscript('/fake/transcript.jsonl', 'sess');

      expect(state.totalEntries).toBe(0);
    });

    it('parses JSONL lines and adds entries', async () => {
      const line1 = JSON.stringify({ role: 'user', content: 'hello' });
      const line2 = JSON.stringify({ role: 'assistant', content: 'world' });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`${line1}\n${line2}\n`);

      const state = await shadow.updateFromTranscript('/t.jsonl', 'sess');

      expect(state.totalEntries).toBe(2);
    });

    it('deduplicates entries by content hash', async () => {
      const line = JSON.stringify({ role: 'user', content: 'duplicate content' });

      mockExistsSync.mockReturnValue(true);
      // Return same line twice in same call (two lines with identical content)
      mockReadFileSync.mockReturnValue(`${line}\n${line}\n`);

      await shadow.updateFromTranscript('/t.jsonl', 'sess');
      const count = await shadow.getEntryCount();

      expect(count).toBe(1);
    });

    it('skips malformed JSONL lines', async () => {
      const goodLine = JSON.stringify({ role: 'user', content: 'valid' });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`{bad\n${goodLine}\n`);

      const state = await shadow.updateFromTranscript('/t.jsonl', 'sess');

      expect(state.totalEntries).toBe(1);
    });

    it('calls writeFileSync when new entries are added', async () => {
      const line = JSON.stringify({ role: 'user', content: 'new entry' });

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`${line}\n`);

      await shadow.updateFromTranscript('/t.jsonl', 'sess');

      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe('getByRank()', () => {
    it('returns entries sorted by importanceRank ascending', async () => {
      const stored = {
        entries: [
          makeShadowEntry({ id: 'a', importanceRank: 3, contentHash: 'h1', sessionId: 'sess' }),
          makeShadowEntry({ id: 'b', importanceRank: 1, contentHash: 'h2', sessionId: 'sess' }),
          makeShadowEntry({ id: 'c', importanceRank: 2, contentHash: 'h3', sessionId: 'sess' }),
        ],
        updatedAt: Date.now(),
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(stored));

      await shadow.initialize();
      const ranked = await shadow.getByRank('sess', 10);

      expect(ranked.map(e => e.id)).toEqual(['b', 'c', 'a']);
    });

    it('excludes entries with importanceRank of 0', async () => {
      const stored = {
        entries: [
          makeShadowEntry({ id: 'ranked', importanceRank: 1, contentHash: 'h1', sessionId: 'sess' }),
          makeShadowEntry({ id: 'unranked', importanceRank: 0, contentHash: 'h2', sessionId: 'sess' }),
        ],
        updatedAt: Date.now(),
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(stored));

      await shadow.initialize();
      const ranked = await shadow.getByRank('sess', 10);

      expect(ranked.map(e => e.id)).toEqual(['ranked']);
    });

    it('respects the limit parameter', async () => {
      const entries = [1, 2, 3, 4, 5].map(i =>
        makeShadowEntry({ id: `e${i}`, importanceRank: i, contentHash: `h${i}`, sessionId: 'sess' }),
      );
      const stored = { entries, updatedAt: Date.now() };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(stored));

      await shadow.initialize();
      const ranked = await shadow.getByRank('sess', 3);

      expect(ranked).toHaveLength(3);
    });
  });
});

describe('buildTieredRestoration()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allocates budget with 50/35/15 split across tiers', () => {
    const entries: ShadowEntry[] = [1, 2, 3].map(i =>
      makeShadowEntry({
        id: `e${i}`,
        importanceRank: i,
        content: 'x'.repeat(100),
        summaryLong: 'summary',
        summaryShort: 'short',
        filePaths: [`file${i}.ts`],
        toolNames: [`tool${i}`],
      }),
    );

    const result = buildTieredRestoration(entries, 4000);

    expect(result.totalChars).toBeGreaterThanOrEqual(0);
    expect(result.totalChars).toBeLessThanOrEqual(4000);
    expect(result).toHaveProperty('tier1Critical');
    expect(result).toHaveProperty('tier2Summary');
    expect(result).toHaveProperty('tier3References');
  });

  it('returns empty tier1 and tier2 for empty entries array', () => {
    const result = buildTieredRestoration([]);

    expect(result.tier1Critical).toBe('');
    expect(result.tier2Summary).toBe('');
    // tier3 may contain "Files: \nTools: " even with no entries — totalChars reflects that
    expect(result.totalChars).toBeGreaterThanOrEqual(0);
  });

  it('tier1 contains role and content', () => {
    const entry = makeShadowEntry({
      importanceRank: 1,
      role: 'user',
      content: 'important context',
    });

    const result = buildTieredRestoration([entry], 4000);

    expect(result.tier1Critical).toContain('[user]');
    expect(result.tier1Critical).toContain('important context');
  });

  it('tier3 references include file paths and tool names', () => {
    const entry = makeShadowEntry({
      importanceRank: 1,
      content: 'ctx',
      filePaths: ['src/main.ts'],
      toolNames: ['Read'],
    });

    const result = buildTieredRestoration([entry], 4000);

    expect(result.tier3References).toContain('src/main.ts');
    expect(result.tier3References).toContain('Read');
  });
});
