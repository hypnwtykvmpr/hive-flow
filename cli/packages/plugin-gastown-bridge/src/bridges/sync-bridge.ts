/**
 * Beads-HiveMemory Sync Bridge
 *
 * Provides bidirectional synchronization between Beads (bd)
 * and HiveMemory. Implements conflict resolution strategies
 * and maintains consistency between the two systems.
 *
 * Features:
 * - Bidirectional sync (Beads <-> HiveMemory)
 * - Conflict resolution strategies
 * - Incremental sync support
 * - Transaction-safe operations
 * - Embedding preservation
 *
 * @module cli/packages/plugin-gastown-bridge/bridges/sync-bridge
 */

import { z } from 'zod';
import { BdBridge, createBdBridge, type Bead, type BeadType, type BdBridgeConfig } from './bd-bridge.js';

import {
  LRUCache,
  BatchDeduplicator,
} from '../cache.js';

// ============================================================================
// Performance Caches
// ============================================================================

/** Cache for HiveMemory lookups during sync */
const hiveMemoryLookupCache = new LRUCache<string, HiveMemoryEntry | null>({
  maxEntries: 500,
  ttlMs: 30 * 1000, // 30 sec TTL
});

/** Cache for conflict detection results */
const conflictCache = new LRUCache<string, boolean>({
  maxEntries: 200,
  ttlMs: 10 * 1000, // 10 sec TTL
});

/** Deduplicator for concurrent sync operations */
const syncDedup = new BatchDeduplicator<SyncResult>();

/**
 * FNV-1a hash for cache keys
 */
function hashKey(parts: string[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    hash ^= 0xff;
  }
  return hash.toString(36);
}

// ============================================================================
// Zod Validation Schemas
// ============================================================================

/**
 * Sync conflict resolution strategy
 */
const ConflictStrategySchema = z.enum([
  'beads-wins',      // Beads data takes precedence
  'hivememory-wins',    // HiveMemory data takes precedence
  'newest-wins',     // Most recent timestamp wins
  'merge',           // Attempt to merge fields
  'manual',          // Flag for manual resolution
]);

/**
 * Sync direction
 */
const SyncDirectionSchema = z.enum([
  'to-hivememory',      // Beads -> HiveMemory
  'from-hivememory',    // HiveMemory -> Beads
  'bidirectional',   // Both directions
]);

/**
 * Sync status
 */
const SyncStatusSchema = z.enum([
  'pending',
  'in-progress',
  'completed',
  'failed',
  'conflict',
]);

/**
 * HiveMemory entry schema (compatible with hive-flow memory)
 */
const HiveMemoryEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  namespace: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  embedding: z.array(z.number()).optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  version: z.number().optional(),
});

// ============================================================================
// Types
// ============================================================================

/**
 * Conflict resolution strategy type
 */
export type ConflictStrategy = z.infer<typeof ConflictStrategySchema>;

/**
 * Sync direction type
 */
export type SyncDirection = z.infer<typeof SyncDirectionSchema>;

/**
 * Sync status type
 */
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/**
 * HiveMemory entry type
 */
export type HiveMemoryEntry = z.infer<typeof HiveMemoryEntrySchema>;

/**
 * Sync bridge configuration
 */
export interface SyncBridgeConfig {
  /**
   * Beads bridge configuration
   */
  beadsBridge?: BdBridgeConfig;

  /**
   * HiveMemory namespace for beads
   * Default: 'beads'
   */
  hivememoryNamespace?: string;

  /**
   * Conflict resolution strategy
   * Default: 'newest-wins'
   */
  conflictStrategy?: ConflictStrategy;

  /**
   * Batch size for sync operations
   * Default: 100
   */
  batchSize?: number;

  /**
   * Whether to preserve embeddings during sync
   * Default: true
   */
  preserveEmbeddings?: boolean;

  /**
   * Whether to sync metadata
   * Default: true
   */
  syncMetadata?: boolean;
}

/**
 * Sync operation result
 */
export interface SyncResult {
  success: boolean;
  direction: SyncDirection;
  synced: number;
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
  errors: Array<{ id: string; error: string }>;
  durationMs: number;
  timestamp: string;
}

/**
 * Conflict record
 */
export interface SyncConflict {
  beadId: string;
  beadData: Bead;
  hivememoryData: HiveMemoryEntry;
  conflictType: 'update' | 'delete' | 'create';
  resolution?: 'beads' | 'hivememory' | 'merged' | 'pending';
  resolvedAt?: string;
}

/**
 * Sync state for incremental sync
 */
export interface SyncState {
  lastSyncTime: string;
  lastBeadId?: string;
  lastHiveMemoryKey?: string;
  pendingConflicts: string[];
  version: number;
}

/**
 * HiveMemory interface (to be provided by hive-flow)
 */
export interface IHiveMemoryService {
  store(key: string, value: unknown, namespace?: string, metadata?: Record<string, unknown>): Promise<void>;
  retrieve(key: string, namespace?: string): Promise<HiveMemoryEntry | null>;
  search(query: string, namespace?: string, limit?: number): Promise<HiveMemoryEntry[]>;
  list(namespace?: string, limit?: number, offset?: number): Promise<HiveMemoryEntry[]>;
  delete(key: string, namespace?: string): Promise<void>;
  getNamespaceStats(namespace: string): Promise<{ count: number; lastUpdated?: string }>;
}

/**
 * Logger interface
 */
export interface SyncLogger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Sync bridge error codes
 */
export type SyncErrorCode =
  | 'NOT_INITIALIZED'
  | 'SYNC_FAILED'
  | 'CONFLICT_UNRESOLVED'
  | 'HIVEMEMORY_ERROR'
  | 'BEADS_ERROR'
  | 'VALIDATION_ERROR'
  | 'TRANSACTION_FAILED';

/**
 * Sync bridge error
 */
export class SyncBridgeError extends Error {
  constructor(
    message: string,
    public readonly code: SyncErrorCode,
    public readonly details?: Record<string, unknown>,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'SyncBridgeError';
  }
}

// ============================================================================
// Default Logger
// ============================================================================

const defaultLogger: SyncLogger = {
  debug: (msg, meta) => console.debug(`[sync-bridge] ${msg}`, meta ?? ''),
  info: (msg, meta) => console.info(`[sync-bridge] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[sync-bridge] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[sync-bridge] ${msg}`, meta ?? ''),
};

// ============================================================================
// Sync Bridge Implementation
// ============================================================================

/**
 * Beads-HiveMemory Sync Bridge
 *
 * Provides bidirectional synchronization between Beads and HiveMemory
 * with configurable conflict resolution.
 *
 * @example
 * ```typescript
 * const syncBridge = new SyncBridge(hiveMemory, {
 *   conflictStrategy: 'newest-wins',
 *   hivememoryNamespace: 'conversation-beads',
 * });
 * await syncBridge.initialize();
 *
 * // Sync beads to HiveMemory
 * const result = await syncBridge.syncToHiveMemory(beads);
 *
 * // Sync from HiveMemory back to beads
 * const beads = await syncBridge.syncFromHiveMemory();
 * ```
 */
export class SyncBridge {
  private bdBridge: BdBridge;
  private hiveMemory: IHiveMemoryService;
  private config: Required<SyncBridgeConfig>;
  private logger: SyncLogger;
  private initialized = false;
  private syncState: SyncState;
  private conflicts: Map<string, SyncConflict> = new Map();

  constructor(
    hiveMemory: IHiveMemoryService,
    config?: SyncBridgeConfig,
    logger?: SyncLogger
  ) {
    this.hiveMemory = hiveMemory;
    this.config = {
      beadsBridge: config?.beadsBridge ?? {},
      hivememoryNamespace: config?.hivememoryNamespace ?? 'beads',
      conflictStrategy: config?.conflictStrategy ?? 'newest-wins',
      batchSize: config?.batchSize ?? 100,
      preserveEmbeddings: config?.preserveEmbeddings ?? true,
      syncMetadata: config?.syncMetadata ?? true,
    };
    this.logger = logger ?? defaultLogger;
    this.bdBridge = createBdBridge(this.config.beadsBridge, {
      debug: (msg, meta) => this.logger.debug(`[bd] ${msg}`, meta),
      info: (msg, meta) => this.logger.info(`[bd] ${msg}`, meta),
      warn: (msg, meta) => this.logger.warn(`[bd] ${msg}`, meta),
      error: (msg, meta) => this.logger.error(`[bd] ${msg}`, meta),
    });
    this.syncState = {
      lastSyncTime: new Date(0).toISOString(),
      pendingConflicts: [],
      version: 1,
    };
  }

  /**
   * Initialize the sync bridge
   */
  async initialize(): Promise<void> {
    try {
      await this.bdBridge.initialize();

      // Load sync state from HiveMemory if exists
      const savedState = await this.hiveMemory.retrieve(
        '_sync_state',
        this.config.hivememoryNamespace
      );

      if (savedState?.value) {
        const parsed = savedState.value as SyncState;
        this.syncState = {
          lastSyncTime: parsed.lastSyncTime ?? new Date(0).toISOString(),
          lastBeadId: parsed.lastBeadId,
          lastHiveMemoryKey: parsed.lastHiveMemoryKey,
          pendingConflicts: parsed.pendingConflicts ?? [],
          version: (parsed.version ?? 0) + 1,
        };
      }

      this.initialized = true;
      this.logger.info('Sync bridge initialized', {
        namespace: this.config.hivememoryNamespace,
        conflictStrategy: this.config.conflictStrategy,
        syncState: this.syncState,
      });
    } catch (error) {
      throw new SyncBridgeError(
        'Failed to initialize sync bridge',
        'NOT_INITIALIZED',
        undefined,
        error as Error
      );
    }
  }

  /**
   * Sync beads to HiveMemory
   */
  async syncToHiveMemory(beads: Bead[]): Promise<SyncResult> {
    this.ensureInitialized();

    const startTime = Date.now();
    const result: SyncResult = {
      success: true,
      direction: 'to-hivememory',
      synced: 0,
      created: 0,
      updated: 0,
      deleted: 0,
      conflicts: 0,
      errors: [],
      durationMs: 0,
      timestamp: new Date().toISOString(),
    };

    this.logger.info(`Starting sync to HiveMemory: ${beads.length} beads`);

    // Process in batches with parallel lookups
    for (let i = 0; i < beads.length; i += this.config.batchSize) {
      const batch = beads.slice(i, i + this.config.batchSize);

      // Parallel lookup for all beads in batch
      const lookupPromises = batch.map(async (bead) => {
        const key = this.beadToKey(bead);
        const cacheKey = hashKey([key, this.config.hivememoryNamespace]);

        // Check cache first
        if (hiveMemoryLookupCache.has(cacheKey)) {
          return { bead, key, existing: hiveMemoryLookupCache.get(cacheKey) };
        }

        const existing = await this.hiveMemory.retrieve(key, this.config.hivememoryNamespace);
        hiveMemoryLookupCache.set(cacheKey, existing);
        return { bead, key, existing };
      });

      const lookupResults = await Promise.all(lookupPromises);

      // Process results
      for (const { bead, key, existing } of lookupResults) {
        try {
          if (existing) {
            // Check for conflicts (use cache)
            const conflictCacheKey = hashKey([bead.id, bead.content, existing.key]);
            let hasConflict = conflictCache.get(conflictCacheKey);

            if (hasConflict === undefined) {
              hasConflict = await this.detectConflict(bead, existing);
              conflictCache.set(conflictCacheKey, hasConflict);
            }

            if (hasConflict) {
              const resolved = await this.resolveConflict(bead, existing);
              if (!resolved) {
                result.conflicts++;
                continue;
              }
            }
            result.updated++;
          } else {
            result.created++;
          }

          // Store bead in HiveMemory
          await this.hiveMemory.store(
            key,
            this.beadToHiveMemoryValue(bead),
            this.config.hivememoryNamespace,
            this.buildMetadata(bead)
          );

          // Invalidate lookup cache for this key
          const cacheKey = hashKey([key, this.config.hivememoryNamespace]);
          hiveMemoryLookupCache.delete(cacheKey);

          result.synced++;
        } catch (error) {
          result.errors.push({
            id: bead.id,
            error: error instanceof Error ? error.message : String(error),
          });
          this.logger.error(`Failed to sync bead ${bead.id}`, { error });
        }
      }
    }

    // Update sync state
    this.syncState.lastSyncTime = result.timestamp;
    if (beads.length > 0) {
      this.syncState.lastBeadId = beads[beads.length - 1]?.id;
    }
    await this.saveSyncState();

    result.durationMs = Date.now() - startTime;
    result.success = result.errors.length === 0 && result.conflicts === 0;

    this.logger.info('Sync to HiveMemory complete', {
      synced: result.synced,
      created: result.created,
      updated: result.updated,
      conflicts: result.conflicts,
      errors: result.errors.length,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Sync from HiveMemory to Beads
   */
  async syncFromHiveMemory(): Promise<Bead[]> {
    this.ensureInitialized();

    const startTime = Date.now();
    const beads: Bead[] = [];

    this.logger.info('Starting sync from HiveMemory');

    try {
      // Get all entries from HiveMemory namespace
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const entries = await this.hiveMemory.list(
          this.config.hivememoryNamespace,
          this.config.batchSize,
          offset
        );

        if (entries.length === 0) {
          hasMore = false;
          continue;
        }

        for (const entry of entries) {
          // Skip sync state entry
          if (entry.key === '_sync_state') continue;

          try {
            const bead = this.hiveMemoryToBead(entry);
            if (bead) {
              beads.push(bead);
            }
          } catch (error) {
            this.logger.warn(`Failed to convert HiveMemory entry to bead: ${entry.key}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        offset += entries.length;
        hasMore = entries.length === this.config.batchSize;
      }

      // Update sync state
      this.syncState.lastSyncTime = new Date().toISOString();
      await this.saveSyncState();

      const durationMs = Date.now() - startTime;
      this.logger.info('Sync from HiveMemory complete', {
        beads: beads.length,
        durationMs,
      });

      return beads;
    } catch (error) {
      throw new SyncBridgeError(
        'Failed to sync from HiveMemory',
        'SYNC_FAILED',
        undefined,
        error as Error
      );
    }
  }

  /**
   * Perform full bidirectional sync
   */
  async syncBidirectional(): Promise<{
    toHiveMemory: SyncResult;
    fromHiveMemory: Bead[];
  }> {
    this.ensureInitialized();

    this.logger.info('Starting bidirectional sync');

    // First sync from beads to HiveMemory
    const allBeads = await this.bdBridge.listBeads({
      after: this.syncState.lastSyncTime,
    });

    const toHiveMemoryResult = await this.syncToHiveMemory(allBeads);

    // Then sync from HiveMemory to beads
    const fromHiveMemoryBeads = await this.syncFromHiveMemory();

    return {
      toHiveMemory: toHiveMemoryResult,
      fromHiveMemory: fromHiveMemoryBeads,
    };
  }

  /**
   * Get pending conflicts
   */
  getPendingConflicts(): SyncConflict[] {
    return Array.from(this.conflicts.values()).filter(
      c => c.resolution === 'pending' || !c.resolution
    );
  }

  /**
   * Resolve a specific conflict manually
   */
  async resolveConflictManually(
    beadId: string,
    resolution: 'beads' | 'hivememory' | 'merged',
    mergedData?: Partial<Bead>
  ): Promise<void> {
    const conflict = this.conflicts.get(beadId);
    if (!conflict) {
      throw new SyncBridgeError(
        `No conflict found for bead: ${beadId}`,
        'VALIDATION_ERROR'
      );
    }

    const key = this.beadToKey(conflict.beadData);

    switch (resolution) {
      case 'beads':
        await this.hiveMemory.store(
          key,
          this.beadToHiveMemoryValue(conflict.beadData),
          this.config.hivememoryNamespace,
          this.buildMetadata(conflict.beadData)
        );
        break;

      case 'hivememory':
        // HiveMemory data is already stored, nothing to do
        break;

      case 'merged':
        if (!mergedData) {
          throw new SyncBridgeError(
            'Merged data required for merge resolution',
            'VALIDATION_ERROR'
          );
        }
        const merged = { ...conflict.beadData, ...mergedData };
        await this.hiveMemory.store(
          key,
          this.beadToHiveMemoryValue(merged as Bead),
          this.config.hivememoryNamespace,
          this.buildMetadata(merged as Bead)
        );
        break;
    }

    conflict.resolution = resolution;
    conflict.resolvedAt = new Date().toISOString();

    // Remove from pending
    const pendingIndex = this.syncState.pendingConflicts.indexOf(beadId);
    if (pendingIndex !== -1) {
      this.syncState.pendingConflicts.splice(pendingIndex, 1);
      await this.saveSyncState();
    }

    this.logger.info(`Conflict resolved for bead ${beadId}`, { resolution });
  }

  /**
   * Get sync state
   */
  getSyncState(): Readonly<SyncState> {
    return { ...this.syncState };
  }

  /**
   * Get sync statistics
   */
  async getSyncStats(): Promise<{
    hivememoryCount: number;
    lastSyncTime: string;
    pendingConflicts: number;
    syncVersion: number;
  }> {
    this.ensureInitialized();

    const stats = await this.hiveMemory.getNamespaceStats(this.config.hivememoryNamespace);

    return {
      hivememoryCount: stats.count,
      lastSyncTime: this.syncState.lastSyncTime,
      pendingConflicts: this.syncState.pendingConflicts.length,
      syncVersion: this.syncState.version,
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Convert bead to HiveMemory key
   */
  private beadToKey(bead: Bead): string {
    return `bead:${bead.id}`;
  }

  /**
   * Convert bead to HiveMemory value
   */
  private beadToHiveMemoryValue(bead: Bead): Record<string, unknown> {
    const value: Record<string, unknown> = {
      id: bead.id,
      type: bead.type,
      content: bead.content,
      timestamp: bead.timestamp,
      parentId: bead.parentId,
      threadId: bead.threadId,
      agentId: bead.agentId,
      tags: bead.tags,
      hash: bead.hash,
    };

    if (this.config.preserveEmbeddings && bead.embedding) {
      value.embedding = bead.embedding;
    }

    if (this.config.syncMetadata && bead.metadata) {
      value.metadata = bead.metadata;
    }

    return value;
  }

  /**
   * Build metadata for HiveMemory entry
   */
  private buildMetadata(bead: Bead): Record<string, unknown> {
    return {
      beadType: bead.type,
      threadId: bead.threadId,
      agentId: bead.agentId,
      syncedAt: new Date().toISOString(),
      syncVersion: this.syncState.version,
    };
  }

  /**
   * Convert HiveMemory entry to Bead
   */
  private hiveMemoryToBead(entry: HiveMemoryEntry): Bead | null {
    if (!entry.value || typeof entry.value !== 'object') {
      return null;
    }

    const data = entry.value as Record<string, unknown>;

    // Validate required fields
    if (!data.id || !data.type || !data.content) {
      return null;
    }

    return {
      id: String(data.id),
      type: data.type as BeadType,
      content: String(data.content),
      timestamp: data.timestamp as string | undefined,
      parentId: data.parentId as string | undefined,
      threadId: data.threadId as string | undefined,
      agentId: data.agentId as string | undefined,
      tags: data.tags as string[] | undefined,
      metadata: data.metadata as Record<string, unknown> | undefined,
      embedding: data.embedding as number[] | undefined,
      hash: data.hash as string | undefined,
    };
  }

  /**
   * Detect if there's a conflict between bead and HiveMemory entry
   */
  private async detectConflict(bead: Bead, entry: HiveMemoryEntry): Promise<boolean> {
    if (!entry.value || typeof entry.value !== 'object') {
      return false;
    }

    const data = entry.value as Record<string, unknown>;

    // No conflict if content is the same
    if (data.content === bead.content) {
      return false;
    }

    // Check timestamps
    const beadTime = bead.timestamp ? new Date(bead.timestamp).getTime() : 0;
    const entryTime = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;

    // If bead is newer, no conflict - it should update
    if (beadTime > entryTime) {
      return false;
    }

    // If HiveMemory is newer and content differs, conflict
    if (entryTime > beadTime && data.content !== bead.content) {
      return true;
    }

    return false;
  }

  /**
   * Resolve conflict based on strategy
   */
  private async resolveConflict(bead: Bead, entry: HiveMemoryEntry): Promise<boolean> {
    const conflict: SyncConflict = {
      beadId: bead.id,
      beadData: bead,
      hivememoryData: entry,
      conflictType: 'update',
    };

    switch (this.config.conflictStrategy) {
      case 'beads-wins':
        conflict.resolution = 'beads';
        this.conflicts.set(bead.id, conflict);
        return true;

      case 'hivememory-wins':
        conflict.resolution = 'hivememory';
        this.conflicts.set(bead.id, conflict);
        return false; // Don't update HiveMemory

      case 'newest-wins': {
        const beadTime = bead.timestamp ? new Date(bead.timestamp).getTime() : 0;
        const entryTime = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;

        if (beadTime >= entryTime) {
          conflict.resolution = 'beads';
          this.conflicts.set(bead.id, conflict);
          return true;
        } else {
          conflict.resolution = 'hivememory';
          this.conflicts.set(bead.id, conflict);
          return false;
        }
      }

      case 'merge': {
        // Simple merge: keep both contents with separator
        const entryData = entry.value as Record<string, unknown>;
        const mergedBead: Bead = {
          ...bead,
          content: `${bead.content}\n---\n${entryData.content}`,
          metadata: {
            ...bead.metadata,
            merged: true,
            mergedAt: new Date().toISOString(),
          },
        };
        conflict.beadData = mergedBead;
        conflict.resolution = 'merged';
        this.conflicts.set(bead.id, conflict);
        return true;
      }

      case 'manual':
        conflict.resolution = 'pending';
        this.conflicts.set(bead.id, conflict);
        this.syncState.pendingConflicts.push(bead.id);
        return false;

      default:
        return false;
    }
  }

  /**
   * Save sync state to HiveMemory
   */
  private async saveSyncState(): Promise<void> {
    try {
      await this.hiveMemory.store(
        '_sync_state',
        this.syncState,
        this.config.hivememoryNamespace,
        { type: 'sync-state' }
      );
    } catch (error) {
      this.logger.error('Failed to save sync state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Ensure bridge is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new SyncBridgeError(
        'Sync bridge not initialized. Call initialize() first.',
        'NOT_INITIALIZED'
      );
    }
  }

  /**
   * Check if bridge is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get beads bridge instance
   */
  getBeadsBridge(): BdBridge {
    return this.bdBridge;
  }

  /**
   * Get cache statistics for performance monitoring
   */
  getCacheStats(): {
    hiveMemoryLookupCache: { entries: number; sizeBytes: number };
    conflictCache: { entries: number; sizeBytes: number };
  } {
    return {
      hiveMemoryLookupCache: hiveMemoryLookupCache.stats(),
      conflictCache: conflictCache.stats(),
    };
  }

  /**
   * Clear all sync caches
   */
  clearCaches(): void {
    hiveMemoryLookupCache.clear();
    conflictCache.clear();
  }
}

/**
 * Create a new sync bridge instance
 */
export function createSyncBridge(
  hiveMemory: IHiveMemoryService,
  config?: SyncBridgeConfig,
  logger?: SyncLogger
): SyncBridge {
  return new SyncBridge(hiveMemory, config, logger);
}

// Export schemas for external use
export {
  ConflictStrategySchema,
  SyncDirectionSchema,
  SyncStatusSchema,
  HiveMemoryEntrySchema,
};

export default SyncBridge;
