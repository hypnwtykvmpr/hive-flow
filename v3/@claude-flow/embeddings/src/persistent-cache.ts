/**
 * SQLite-backed Persistent Cache for Embeddings
 *
 * Features:
 * - Disk persistence across sessions
 * - LRU eviction with configurable max size
 * - Automatic schema creation
 * - TTL support for cache entries
 * - Lazy initialization (no startup cost if not used)
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// SQLite types (dynamically imported)
type Database = {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
};

type Statement = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

/**
 * Configuration for persistent cache
 */
export interface PersistentCacheConfig {
  /** Path to SQLite database file */
  dbPath: string;
  /** Maximum number of entries (default: 10000) */
  maxSize?: number;
  /** TTL in milliseconds (default: 7 days) */
  ttlMs?: number;
  /** Enable compression for large embeddings */
  compress?: boolean;
}

/**
 * Cache statistics
 */
export interface PersistentCacheStats {
  size: number;
  maxSize: number;
  hitRate: number;
  hits: number;
  misses: number;
  dbSizeBytes?: number;
}

/**
 * SQLite-backed persistent embedding cache
 */
export class PersistentEmbeddingCache {
  private db: Database | null = null;
  private initialized = false;
  private hits = 0;
  private misses = 0;

  private readonly dbPath: string;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(config: PersistentCacheConfig) {
    this.dbPath = config.dbPath;
    this.maxSize = config.maxSize ?? 10000;
    this.ttlMs = config.ttlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  /**
   * Lazily initialize database connection
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      // Dynamically import better-sqlite3
      const BetterSqlite3 = (await import('better-sqlite3')).default;

      // Ensure directory exists
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.db = new BetterSqlite3(this.dbPath) as unknown as Database;

      // Create schema
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          key TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          dimensions INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          access_count INTEGER DEFAULT 1
        );

        CREATE INDEX IF NOT EXISTS idx_accessed_at ON embeddings(accessed_at);
        CREATE INDEX IF NOT EXISTS idx_created_at ON embeddings(created_at);
      `);

      // Clean expired entries on startup
      this.cleanExpired();

      this.initialized = true;
    } catch (error) {
      // If better-sqlite3 not available, fall back gracefully
      console.warn('[persistent-cache] SQLite not available, cache disabled:',
        error instanceof Error ? error.message : error);
      this.initialized = true; // Mark as initialized to prevent retry
    }
  }

  /**
   * Generate cache key from text
   */
  private hashKey(text: string): string {
    // FNV-1a hash for fast, deterministic key generation
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return `emb_${hash.toString(16)}_${text.length}`;
  }

  /**
   * Serialize Float32Array to Buffer
   */
  private serializeEmbedding(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  /**
   * Deserialize Buffer to Float32Array
   */
  private deserializeEmbedding(buffer: Buffer, dimensions: number): Float32Array {
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    return new Float32Array(arrayBuffer);
  }

  /**
   * Get embedding from cache
   */
  async get(text: string): Promise<Float32Array | null> {
    await this.ensureInitialized();
    if (!this.db) {
      this.misses++;
      return null;
    }

    const key = this.hashKey(text);
    const now = Date.now();

    try {
      const row = this.db.prepare(`
        SELECT embedding, dimensions, created_at
        FROM embeddings
        WHERE key = ?
      `).get(key) as { embedding: Buffer; dimensions: number; created_at: number } | undefined;

      if (!row) {
        this.misses++;
        return null;
      }

      // Check TTL
      if (now - row.created_at > this.ttlMs) {
        this.db.prepare('DELETE FROM embeddings WHERE key = ?').run(key);
        this.misses++;
        return null;
      }

      // Update access time and count
      this.db.prepare(`
        UPDATE embeddings
        SET accessed_at = ?, access_count = access_count + 1
        WHERE key = ?
      `).run(now, key);

      this.hits++;
      return this.deserializeEmbedding(row.embedding, row.dimensions);
    } catch (error) {
      console.error('[persistent-cache] Get error:', error);
      this.misses++;
      return null;
    }
  }

  /**
   * Store embedding in cache
   */
  async set(text: string, embedding: Float32Array): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) return;

    const key = this.hashKey(text);
    const now = Date.now();
    const buffer = this.serializeEmbedding(embedding);

    try {
      // Upsert entry
      this.db.prepare(`
        INSERT INTO embeddings (key, embedding, dimensions, created_at, accessed_at, access_count)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(key) DO UPDATE SET
          embedding = excluded.embedding,
          accessed_at = excluded.accessed_at,
          access_count = access_count + 1
      `).run(key, buffer, embedding.length, now, now);

      // Check size and evict if needed
      await this.evictIfNeeded();
    } catch (error) {
      console.error('[persistent-cache] Set error:', error);
    }
  }

  /**
   * Evict oldest entries if cache exceeds max size
   */
  private async evictIfNeeded(): Promise<void> {
    if (!this.db) return;

    const count = (this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number }).count;

    if (count > this.maxSize) {
      const toDelete = count - this.maxSize + Math.floor(this.maxSize * 0.1); // Delete 10% extra
      this.db.prepare(`
        DELETE FROM embeddings
        WHERE key IN (
          SELECT key FROM embeddings
          ORDER BY accessed_at ASC
          LIMIT ?
        )
      `).run(toDelete);
    }
  }

  /**
   * Clean expired entries
   */
  private cleanExpired(): void {
    if (!this.db) return;

    const cutoff = Date.now() - this.ttlMs;
    this.db.prepare('DELETE FROM embeddings WHERE created_at < ?').run(cutoff);
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<PersistentCacheStats> {
    await this.ensureInitialized();

    const total = this.hits + this.misses;
    const stats: PersistentCacheStats = {
      size: 0,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.hits / total : 0,
      hits: this.hits,
      misses: this.misses,
    };

    if (this.db) {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number };
      stats.size = row.count;
    }

    return stats;
  }

  /**
   * Clear all cached entries
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();
    if (!this.db) return;

    this.db.exec('DELETE FROM embeddings');
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }
}

/**
 * Check if persistent cache is available (better-sqlite3 installed)
 */
export async function isPersistentCacheAvailable(): Promise<boolean> {
  try {
    await import('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}
