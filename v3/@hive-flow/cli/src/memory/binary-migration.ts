/**
 * Binary Migration Utility — bidirectional migration between Hive Flow binary
 * binary files and legacy formats (JSON files, sql.js / better-sqlite3 databases).
 * @module @hive-flow/cli/memory/binary-migration
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BinaryBackend } from './binary-backend.js';
import type { MemoryEntry, MemoryType, AccessLevel } from './types.js';
import { generateMemoryId } from './types.js';

/** Options for controlling the migration process. */
export interface BinaryMigrationOptions {
  verbose?: boolean;
  /** Entries per batch (default 500). */
  batchSize?: number;
  /** Embedding dimensions for target binary file (default 1536). */
  dimensions?: number;
  onProgress?: (progress: { current: number; total: number; phase: string }) => void;
}

/** Result returned after a migration completes. */
export interface BinaryMigrationResult {
  success: boolean;
  entriesMigrated: number;
  sourceFormat: string;
  targetFormat: string;
  durationMs: number;
  errors: string[];
}

// -- Internal helpers -------------------------------------------------------

function fillDefaults(raw: Record<string, unknown>): MemoryEntry {
  const now = Date.now();
  return {
    id: (raw.id as string) ?? generateMemoryId(),
    key: (raw.key as string) ?? '',
    content: (raw.content as string) ?? '',
    type: (raw.type as MemoryType) ?? 'semantic',
    namespace: (raw.namespace as string) ?? 'default',
    tags: (raw.tags as string[]) ?? [],
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    ownerId: raw.ownerId as string | undefined,
    accessLevel: (raw.accessLevel as AccessLevel) ?? 'private',
    createdAt: (raw.createdAt as number) ?? now,
    updatedAt: (raw.updatedAt as number) ?? now,
    expiresAt: raw.expiresAt as number | undefined,
    version: (raw.version as number) ?? 1,
    references: (raw.references as string[]) ?? [],
    accessCount: (raw.accessCount as number) ?? 0,
    lastAccessedAt: (raw.lastAccessedAt as number) ?? now,
    embedding: deserializeEmbedding(raw.embedding),
  };
}

function deserializeEmbedding(value: unknown): Float32Array | undefined {
  if (!value) return undefined;
  if (value instanceof Float32Array) return value;
  if (value instanceof Buffer || value instanceof Uint8Array) {
    if (value.byteLength === 0) return undefined;
    const out = new Float32Array(value.byteLength / 4);
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  if (Array.isArray(value)) return new Float32Array(value as number[]);
  return undefined;
}

function serializeForJson(entry: MemoryEntry): Record<string, unknown> {
  return { ...entry, embedding: entry.embedding ? Array.from(entry.embedding) : undefined };
}

function validateMigrationPath(p: string): void {
  if (!p || typeof p !== 'string') throw new Error('Path must be a non-empty string');
  if (p.includes('\0')) throw new Error('Path contains null bytes');
}

async function ensureDir(filePath: string): Promise<void> {
  validateMigrationPath(filePath);
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function atomicWrite(targetPath: string, data: string | Buffer): Promise<void> {
  validateMigrationPath(targetPath);
  const abs = resolve(targetPath);
  const tmp = abs + '.tmp.' + Date.now();
  await ensureDir(abs);
  await writeFile(tmp, data, typeof data === 'string' ? 'utf-8' : undefined);
  await rename(tmp, abs);
}

function mkResult(
  success: boolean, entriesMigrated: number, sourceFormat: string,
  targetFormat: string, startMs: number, errors: string[],
): BinaryMigrationResult {
  return { success, entriesMigrated, sourceFormat, targetFormat, durationMs: Date.now() - startMs, errors };
}

function normalizeSqliteRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const col of ['tags', 'metadata', 'references'] as const) {
    if (typeof out[col] === 'string') {
      try { out[col] = JSON.parse(out[col] as string); } catch { out[col] = col === 'metadata' ? {} : []; }
    }
  }
  return out;
}

// -- SQLite reader (better-sqlite3 first, then sql.js) ----------------------

interface SqliteRow { [key: string]: unknown }

async function readSqliteRows(dbPath: string): Promise<SqliteRow[]> {
  // Attempt better-sqlite3
  try {
    const mod = await import('better-sqlite3' as string);
    const Database = mod.default ?? mod;
    const db = new Database(dbPath, { readonly: true });
    try { return db.prepare('SELECT * FROM memory_entries').all() as SqliteRow[]; }
    finally { db.close(); }
  } catch { /* unavailable */ }
  // Attempt sql.js
  try {
    const mod = await import('sql.js' as string);
    const SQL = await (mod.default ?? mod)();
    const db = new SQL.Database(await readFile(dbPath));
    try {
      const stmt = db.prepare('SELECT * FROM memory_entries');
      const rows: SqliteRow[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as SqliteRow);
      stmt.free();
      return rows;
    } finally { db.close(); }
  } catch { /* unavailable */ }
  throw new Error('Cannot read SQLite: install better-sqlite3 or sql.js');
}

// -- Batch migration helper -------------------------------------------------

async function migrateBatches(
  items: Record<string, unknown>[],
  binaryPath: string,
  options: BinaryMigrationOptions,
  normalize?: (r: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ migrated: number; errors: string[] }> {
  const batchSize = options.batchSize ?? 500;
  const dimensions = options.dimensions ?? 1536;
  const backend = new BinaryBackend({ databasePath: binaryPath, dimensions, verbose: options.verbose });
  await backend.initialize();
  let migrated = 0;
  const errors: string[] = [];
  try {
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const entries: MemoryEntry[] = [];
      for (const item of batch) {
        try {
          entries.push(fillDefaults(normalize ? normalize(item) : item));
        } catch (e) { errors.push(`Entry ${item.id ?? i}: ${(e as Error).message}`); }
      }
      if (entries.length > 0) { await backend.bulkInsert(entries); migrated += entries.length; }
      options.onProgress?.({ current: Math.min(i + batchSize, items.length), total: items.length, phase: 'migrating' });
    }
  } finally { await backend.shutdown(); }
  return { migrated, errors };
}

/**
 * Bidirectional migration utility between Hive Flow binary and legacy memory formats.
 *
 * All methods are static — no instantiation required.
 */
export class BinaryMigrator {
  /** Migrate a JSON memory file to Hive Flow binary format. */
  static async fromJsonFile(
    jsonPath: string, binaryPath: string, options: BinaryMigrationOptions = {},
  ): Promise<BinaryMigrationResult> {
    const start = Date.now();
    const raw = await readFile(jsonPath, 'utf-8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (e) { return mkResult(false, 0, 'json', 'binary', start, [`Invalid JSON: ${(e as Error).message}`]); }
    const items = Array.isArray(parsed) ? parsed : [parsed as Record<string, unknown>];
    const { migrated, errors } = await migrateBatches(items, binaryPath, options);
    if (options.verbose) console.log(`[BinaryMigrator] Migrated ${migrated} entries from JSON to binary`);
    return mkResult(errors.length === 0, migrated, 'json', 'binary', start, errors);
  }

  /** Migrate a SQLite (better-sqlite3 / sql.js) database to Hive Flow binary. */
  static async fromSqlite(
    dbPath: string, binaryPath: string, options: BinaryMigrationOptions = {},
  ): Promise<BinaryMigrationResult> {
    const start = Date.now();
    let rows: SqliteRow[];
    try { rows = await readSqliteRows(dbPath); }
    catch (e) { return mkResult(false, 0, 'sqlite', 'binary', start, [(e as Error).message]); }
    options.onProgress?.({ current: 0, total: rows.length, phase: 'reading' });
    const { migrated, errors } = await migrateBatches(rows, binaryPath, options, normalizeSqliteRow);
    if (options.verbose) console.log(`[BinaryMigrator] Migrated ${migrated} entries from SQLite to binary`);
    return mkResult(errors.length === 0, migrated, 'sqlite', 'binary', start, errors);
  }

  /** Export a binary memory file back to a JSON array. */
  static async toJsonFile(binaryPath: string, jsonPath: string): Promise<BinaryMigrationResult> {
    const start = Date.now();
    const backend = new BinaryBackend({ databasePath: binaryPath });
    await backend.initialize();
    let entries: MemoryEntry[];
    try { entries = await backend.query({ type: 'hybrid', limit: Number.MAX_SAFE_INTEGER }); }
    finally { await backend.shutdown(); }
    const warnings: string[] = [];
    if (entries.length === 0) warnings.push('Source binary file contained no entries');
    await atomicWrite(jsonPath, JSON.stringify(entries.map(serializeForJson), null, 2));
    return mkResult(true, entries.length, 'binary', 'json', start, warnings);
  }

  /**
   * Detect file format by magic bytes.
   * - Legacy 0x52 0x56 0x46 0x00 -> 'binary'
   * - HFDB  (0x48 0x46 0x44 0x42) -> 'binary'
   * - SQLi  (0x53 0x51 0x4C 0x69) -> 'sqlite'
   * - Leading [ or {              -> 'json'
   */
  static async detectFormat(filePath: string): Promise<'binary' | 'json' | 'sqlite' | 'unknown'> {
    if (!existsSync(filePath)) return 'unknown';
    const fd = await import('node:fs').then(m => m.promises.open(filePath, 'r'));
    try {
      const buf = Buffer.alloc(16);
      await fd.read(buf, 0, 16, 0);
      if (buf[0] === 0x52 && buf[1] === 0x56 && buf[2] === 0x46 && buf[3] === 0x00) return 'binary';
      if (buf[0] === 0x48 && buf[1] === 0x46 && buf[2] === 0x44 && buf[3] === 0x42) return 'binary';
      if (buf[0] === 0x53 && buf[1] === 0x51 && buf[2] === 0x4C && buf[3] === 0x69) return 'sqlite';
      const head = buf.toString('utf-8').trimStart();
      if (head.startsWith('[') || head.startsWith('{')) return 'json';
      return 'unknown';
    } finally { await fd.close(); }
  }

  /** Auto-detect source format and migrate to Hive Flow binary. */
  static async autoMigrate(
    sourcePath: string, targetBinaryPath: string, options: BinaryMigrationOptions = {},
  ): Promise<BinaryMigrationResult> {
    const format = await BinaryMigrator.detectFormat(sourcePath);
    if (options.verbose) console.log(`[BinaryMigrator] Detected source format: ${format}`);
    switch (format) {
      case 'json':   return BinaryMigrator.fromJsonFile(sourcePath, targetBinaryPath, options);
      case 'sqlite': return BinaryMigrator.fromSqlite(sourcePath, targetBinaryPath, options);
      case 'binary': return { success: true, entriesMigrated: 0, sourceFormat: 'binary', targetFormat: 'binary', durationMs: 0, errors: [] };
      default:       return { success: false, entriesMigrated: 0, sourceFormat: 'unknown', targetFormat: 'binary', durationMs: 0, errors: [`Unrecognized format: ${sourcePath}`] };
    }
  }
}
