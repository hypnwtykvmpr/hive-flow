/**
 * Agent Task Dead Letter Queue (DLQ)
 * Ported from Neo.mjs resilience features
 */

import { DLQEntry } from './types.js';
import { ILogger } from '../mcp/types.js';
import { maskSensitiveData } from '../security/masking.js';

/**
 * Interface for the memory backend used by DLQ
 */
export interface IDLQBackend {
  store(entry: any): Promise<void>;
  get(id: string): Promise<any | null>;
  query(query: any): Promise<any[]>;
  delete(id: string): Promise<boolean>;
}

/**
 * Agent Task Dead Letter Queue (DLQ).
 * Persists failed agent tasks so they can be inspected, retried, or discarded.
 * Bounded to MAX_ENTRIES entries; oldest records are evicted when the limit is exceeded.
 */
export class AgentTaskDLQ {
  private readonly NAMESPACE = 'dlq';
  private readonly MAX_ENTRIES = 1000;

  constructor(
    private readonly logger: ILogger,
    private readonly backend: IDLQBackend
  ) {}

  /**
   * Add a failed task to the DLQ
   */
  async add(entry: Omit<DLQEntry, 'failedAt' | 'retryCount'>): Promise<void> {
    const fullEntry: DLQEntry = {
      ...entry,
      failedAt: new Date(),
      retryCount: 0,
    };

    this.logger.warn('Adding failed task to DLQ', { taskId: entry.taskId });

    const sanitizedEntry = {
      ...fullEntry,
      input: maskSensitiveData(fullEntry.input),
      contextSnapshot: maskSensitiveData((fullEntry as any).contextSnapshot),
      errors: (fullEntry as any).errors?.map((e: any) => ({
        ...e,
        stack: process.env.NODE_ENV === 'production' ? undefined : e.stack,
      })),
    };

    // Use task ID as the key for easier lookup
    const memoryEntry = {
      id: `dlq-${entry.taskId}`,
      namespace: this.NAMESPACE,
      key: entry.taskId,
      type: 'episodic',
      content: JSON.stringify(sanitizedEntry),
      tags: ['dlq', entry.agentType, 'failure'],
      metadata: {
        taskId: entry.taskId,
        agentType: entry.agentType,
        failedAt: fullEntry.failedAt.toISOString(),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      accessCount: 0,
    };

    await this.backend.store(memoryEntry);

    // Enforce bounded size: evict oldest entries when over MAX_ENTRIES
    const allEntries = await this.backend.query({
      namespace: this.NAMESPACE,
      limit: this.MAX_ENTRIES + 1,
      includeExpired: true,
    });
    if (allEntries.length > this.MAX_ENTRIES) {
      const sorted = allEntries.sort((a: any, b: any) => a.createdAt - b.createdAt);
      const toEvict = sorted.slice(0, allEntries.length - this.MAX_ENTRIES);
      for (const old of toEvict) {
        await this.backend.delete(old.id);
      }
    }
  }

  /**
   * List entries in the DLQ
   */
  async list(limit = 10, offset = 0): Promise<DLQEntry[]> {
    const results = await this.backend.query({
      namespace: this.NAMESPACE,
      limit,
      offset,
      includeExpired: true,
    });

    return results.flatMap(r => {
      try {
        return [JSON.parse(r.content) as DLQEntry];
      } catch {
        this.logger.warn('DLQ entry has unparseable content, skipping', { id: r.id });
        return [];
      }
    });
  }

  /**
   * Inspect a specific failure
   */
  async inspect(taskId: string): Promise<DLQEntry | null> {
    const id = `dlq-${taskId}`;
    const result = await this.backend.get(id);
    if (!result) return null;

    try {
      return JSON.parse(result.content) as DLQEntry;
    } catch {
      this.logger.warn('DLQ entry has unparseable content', { id: taskId });
      return null;
    }
  }

  /**
   * Remove an entry from the DLQ (e.g., after successful retry)
   */
  async remove(taskId: string): Promise<boolean> {
    const id = `dlq-${taskId}`;
    return this.backend.delete(id);
  }

  /**
   * Retry a task from the DLQ
   * Note: The actual retry logic (re-submitting to orchestrator) 
   * should be handled by the caller. This method marks the attempt.
   */
  async markRetry(taskId: string): Promise<DLQEntry | null> {
    const entry = await this.inspect(taskId);
    if (!entry) return null;

    entry.retryCount++;
    
    const id = `dlq-${taskId}`;
    const memoryEntry = await this.backend.get(id);
    if (memoryEntry) {
      memoryEntry.content = JSON.stringify(entry);
      memoryEntry.updatedAt = Date.now();
      await this.backend.store(memoryEntry);
    }

    return entry;
  }

  /**
   * Get total count of failed tasks in DLQ
   */
  async getCount(): Promise<number> {
    const results = await this.backend.query({
      namespace: this.NAMESPACE,
      limit: this.MAX_ENTRIES + 1,
      includeExpired: true,
    });
    return results.length;
  }
}
