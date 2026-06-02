import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { updateMemoryStats } from '../memory.js';
import { refreshStatuslineSnapshot } from '../../refresher.js';
import { parseMemorySummary } from '../../refresher.js';
import { probeMemory } from '../../inline-collectors.js';
import { statuslinePaths } from '../../paths.js';
import type { MemorySummary } from '../../types.js';

describe('statusline recorders/memory', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-memory-recorder-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('materializes agentdb memory stats in the MemorySummary schema consumed by parser and probe', async () => {
    const dbPath = join(projectRoot, '.swarm', 'memory.db');
    await createMemoryDb(dbPath);

    const summary = await updateMemoryStats({
      projectRoot,
      now: () => '2026-06-02T12:00:00.000Z',
    });

    expect(summary).toMatchObject<MemorySummary>({
      sourceDescription: 'agentdb',
      dbSizeBytes: statSync(dbPath).size,
      memories: {
        count: 2,
        source: 'agentdb',
        observedAt: '2026-06-02T12:00:00.000Z',
      },
      embeddings: {
        count: 1,
        source: 'agentdb',
        observedAt: '2026-06-02T12:00:00.000Z',
      },
    });

    const written = JSON.parse(readFileSync(statuslinePaths(projectRoot).memoryStats, 'utf8')) as unknown;
    const parsed = parseMemorySummary(written);
    const probed = await probeMemory(statuslinePaths(projectRoot).memoryStats);
    expect(parsed).toEqual(summary);
    expect(probed).toEqual(summary);

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot,
      force: true,
      now: Date.parse('2026-06-02T12:00:00.000Z'),
    });
    expect(snapshot.memory).toEqual(summary);
    expect(snapshot.sources.memory?.reason).toBe('agentdb');
  });

  it('omits stats when no real agentdb memory database exists', async () => {
    const summary = await updateMemoryStats(projectRoot);

    expect(summary).toBeUndefined();
    expect(existsSync(statuslinePaths(projectRoot).memoryStats)).toBe(false);
  });

  it('records stat-only metadata for a corrupt DB without fabricating counters', async () => {
    const dbPath = join(projectRoot, '.swarm', 'memory.db');
    await mkdir(join(dbPath, '..'), { recursive: true });
    writeFileSync(dbPath, 'not a sqlite database');

    const summary = await updateMemoryStats({
      projectRoot,
      now: () => '2026-06-02T12:00:00.000Z',
    });

    expect(summary).toEqual<MemorySummary>({
      sourceDescription: 'agentdb',
      dbSizeBytes: statSync(dbPath).size,
    });
    const parsed = parseMemorySummary(
      JSON.parse(readFileSync(statuslinePaths(projectRoot).memoryStats, 'utf8')) as unknown,
    );
    expect(parsed).toEqual(summary);
    expect(parsed?.memories).toBeUndefined();
    expect(parsed?.embeddings).toBeUndefined();
  });

  it('does not re-open an unchanged large DB when mtime and size match prior stats', async () => {
    const dbPath = join(projectRoot, '.swarm', 'memory.db');
    await mkdir(join(dbPath, '..'), { recursive: true });
    writeFileSync(dbPath, Buffer.alloc(1024 * 1024 + 1, 1));

    const first = await updateMemoryStats({
      projectRoot,
      now: () => '2026-06-02T12:00:00.000Z',
    });
    const openDb = vi.fn<() => Promise<{ memories: number; embeddings: number }>>();
    const second = await updateMemoryStats({
      projectRoot,
      now: () => '2026-06-02T12:00:01.000Z',
      openDb,
    });

    expect(openDb).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it('does not re-open when the DB mtime is unchanged even if the stats file mtime is older', async () => {
    const dbPath = join(projectRoot, '.swarm', 'memory.db');
    await createMemoryDb(dbPath);

    const first = await updateMemoryStats({
      projectRoot,
      now: () => '2026-06-02T12:00:00.000Z',
    });
    const dbStat = statSync(dbPath);
    const older = new Date(dbStat.mtimeMs - 1_000);
    utimesSync(statuslinePaths(projectRoot).memoryStats, older, older);

    const openDb = vi.fn<() => Promise<{ memories: number; embeddings: number }>>();
    const second = await updateMemoryStats({
      projectRoot,
      now: () => '2026-06-02T12:00:01.000Z',
      openDb,
    });

    expect(openDb).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });
});

async function createMemoryDb(dbPath: string): Promise<void> {
  await mkdir(join(dbPath, '..'), { recursive: true });
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        embedding BLOB
      );
    `);
    db.run(
      'INSERT INTO memory_entries (id, status, embedding) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?);',
      [
        'active-embedded',
        'active',
        new Uint8Array([1, 2, 3]),
        'active-unembedded',
        'active',
        null,
        'deleted-embedded',
        'deleted',
        new Uint8Array([4, 5, 6]),
      ],
    );
    writeFileSync(dbPath, Buffer.from(db.export()));
  } finally {
    db.close();
  }
}
