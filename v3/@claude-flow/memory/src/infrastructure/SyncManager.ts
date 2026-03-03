import { IMemoryBackend, MemoryEntry, MemoryEntryInput, createDefaultEntry } from '../types.js';
import { DeterministicIdGenerator } from './DeterministicIdGenerator.js';

/**
 * Sync Result Summary
 */
export interface SyncResult {
  namespace: string;
  totalProcessed: number;
  added: number;
  updated: number;
  deleted: number;
  errors: string[];
}

/**
 * Sync Manager for Deterministic Delta Synchronization
 * 
 * Ported from Neo-mjs research. Uses content-hash IDs to identify
 * changes and minimize database writes.
 */
export class SyncManager {
  private backend: IMemoryBackend;

  constructor(backend: IMemoryBackend) {
    this.backend = backend;
  }

  /**
   * Performs a delta sync for a set of memory chunks within a namespace
   * 
   * @param namespace - The namespace for organization
   * @param chunks - Incoming memory chunks
   * @returns Sync statistics
   */
  public async sync(namespace: string, chunks: MemoryEntryInput[]): Promise<SyncResult> {
    const result: SyncResult = {
      namespace,
      totalProcessed: chunks.length,
      added: 0,
      updated: 0,
      deleted: 0,
      errors: []
    };

    try {
      // 1. Generate IDs and prepare entries
      const currentChunksMap = new Map<string, MemoryEntry>();
      for (const chunk of chunks) {
        const type = chunk.type || 'semantic';
        const id = DeterministicIdGenerator.generateId(
          namespace,
          type,
          chunk.key,
          chunk.content,
          chunk.metadata || {}
        );
        
        const entry: MemoryEntry = {
          ...createDefaultEntry(chunk),
          id,
          namespace,
          type
        };
        currentChunksMap.set(id, entry);
      }

      const currentIds = Array.from(currentChunksMap.keys());

      // 2. Fetch existing entries for this namespace
      // Note: We use query with namespace and limit 0 to potentially get counts or a specialized query.
      // But standard IMemoryBackend doesn't have listAllIdsInNamespace. 
      // We'll fetch entries in batches if necessary, but for now we assume we can query by namespace.
      const existingEntries = await this.backend.query({
        type: 'exact', // We'll use hybrid or semantic if exact doesn't support namespace-only
        namespace,
        limit: 10000 // Reasonable limit for knowledge base sync
      });

      const existingIds = existingEntries.map(e => e.id);
      const existingIdsSet = new Set(existingIds);

      // 3. Determine entries to add/update
      const entriesToUpsert: MemoryEntry[] = [];
      for (const [id, entry] of currentChunksMap.entries()) {
        if (!existingIdsSet.has(id)) {
          entriesToUpsert.push(entry);
          result.added++;
        } else {
          // In content-hash sync, if ID is same, content is same. 
          // However, metadata or tags might have changed if they weren't part of the hash.
          // For now, we assume if ID matches, no update is needed.
          // result.updated++ if we implement comparison.
        }
      }

      // 4. Perform bulk insert
      if (entriesToUpsert.length > 0) {
        await this.backend.bulkInsert(entriesToUpsert);
      }

      // 5. Identify and delete stale entries
      const currentIdsSet = new Set(currentIds);
      const idsToDelete: string[] = [];
      for (const existingId of existingIds) {
        if (!currentIdsSet.has(existingId)) {
          idsToDelete.push(existingId);
          result.deleted++;
        }
      }

      if (idsToDelete.length > 0) {
        await this.backend.bulkDelete(idsToDelete);
      }

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
    }

    return result;
  }
}
