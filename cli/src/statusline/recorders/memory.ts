import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import initSqlJs from 'sql.js';

import { statuslinePaths } from '../paths.js';
import { atomicWriteJson, readJsonFile, safeUnlinkInHiveFlow } from '../storage.js';
import type { MemorySummary } from '../types.js';

export interface UpdateMemoryStatsOptions {
  readonly projectRoot: string;
  readonly observedAt?: string;
  readonly now?: () => string;
  readonly openDb?: (dbPath: string) => Promise<HiveMemoryCounts | undefined>;
}

interface SqlJsDatabase {
  exec(sql: string): Array<{ values: unknown[][] }>;
  close(): void;
}

const MAX_MEMORY_STATS_BYTES = 256 * 1024;
const MAX_MEMORY_META_BYTES = 32 * 1024;
const MEMORY_STATS_META_VERSION = 1;

interface MemoryStatsMeta {
  readonly version: 1;
  readonly dbMtimeMs: number;
  readonly dbSizeBytes: number;
}

export async function updateMemoryStats(
  projectRootOrOptions: string | UpdateMemoryStatsOptions,
): Promise<MemorySummary | undefined> {
  const options =
    typeof projectRootOrOptions === 'string'
      ? { projectRoot: projectRootOrOptions }
      : projectRootOrOptions;
  const projectRoot = resolve(options.projectRoot);
  const paths = statuslinePaths(projectRoot);
  const dbPath = join(projectRoot, '.swarm', 'memory.db');
  const dbStat = await stat(dbPath).catch(() => undefined);
  if (dbStat === undefined || !dbStat.isFile()) {
    await safeUnlinkInHiveFlow(paths.memoryStats);
    await safeUnlinkInHiveFlow(memoryStatsMetaPath(paths.memoryStats));
    return undefined;
  }

  const existing = await readJsonFile<MemorySummary>(paths.memoryStats, MAX_MEMORY_STATS_BYTES);
  const existingMeta = await readJsonFile<MemoryStatsMeta>(
    memoryStatsMetaPath(paths.memoryStats),
    MAX_MEMORY_META_BYTES,
  );
  if (
    existing !== undefined &&
    isMemoryStatsMeta(existingMeta) &&
    existingMeta.dbMtimeMs === dbStat.mtimeMs &&
    existingMeta.dbSizeBytes === dbStat.size &&
    existing.dbSizeBytes === dbStat.size
  ) {
    return existing;
  }

  const openDb = options.openDb ?? readHiveMemoryCounts;
  const counts = await Promise.resolve(openDb(dbPath)).catch(() => undefined);
  const observedAt = options.observedAt ?? options.now?.() ?? new Date().toISOString();
  const summary: MemorySummary = {
    sourceDescription: 'hivememory',
    dbSizeBytes: dbStat.size,
    ...(counts !== undefined
      ? {
          memories: {
            count: counts.memories,
            source: 'hivememory',
            observedAt,
          },
          embeddings: {
            count: counts.embeddings,
            source: 'hivememory',
            observedAt,
          },
        }
      : {}),
  };

  await atomicWriteJson(paths.memoryStats, summary);
  await atomicWriteJson(memoryStatsMetaPath(paths.memoryStats), {
    version: MEMORY_STATS_META_VERSION,
    dbMtimeMs: dbStat.mtimeMs,
    dbSizeBytes: dbStat.size,
  } satisfies MemoryStatsMeta);
  return summary;
}

interface HiveMemoryCounts {
  readonly memories: number;
  readonly embeddings: number;
}

async function readHiveMemoryCounts(dbPath: string): Promise<HiveMemoryCounts | undefined> {
  const bytes = await readFile(dbPath).catch(() => undefined);
  if (bytes === undefined) return undefined;
  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes) as SqlJsDatabase;
  try {
    const memories = readCount(
      db,
      "SELECT COUNT(*) FROM memory_entries WHERE status='active'",
    );
    const embeddings = readCount(
      db,
      "SELECT COUNT(*) FROM memory_entries WHERE status='active' AND embedding IS NOT NULL",
    );
    if (memories === undefined || embeddings === undefined) return undefined;
    return { memories, embeddings };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function memoryStatsMetaPath(memoryStatsPath: string): string {
  return join(dirname(memoryStatsPath), 'stats.meta.json');
}

function isMemoryStatsMeta(value: unknown): value is MemoryStatsMeta {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === MEMORY_STATS_META_VERSION &&
    typeof (value as { dbMtimeMs?: unknown }).dbMtimeMs === 'number' &&
    Number.isFinite((value as { dbMtimeMs: number }).dbMtimeMs) &&
    typeof (value as { dbSizeBytes?: unknown }).dbSizeBytes === 'number' &&
    Number.isFinite((value as { dbSizeBytes: number }).dbSizeBytes)
  );
}

function readCount(db: SqlJsDatabase, sql: string): number | undefined {
  const rows = db.exec(sql);
  const value = rows[0]?.values[0]?.[0];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
