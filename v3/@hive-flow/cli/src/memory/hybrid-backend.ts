/**
 * HybridBackend - Combines SQLite (structured queries) + local HNSW vector search
 *
 * - SQLite for: Structured queries, ACID transactions, exact matches
 * - LocalVectorBackend for: Semantic search, vector similarity, RAG bootstrap
 *
 * @module v3/memory/hybrid-backend
 */

import { EventEmitter } from 'node:events';
import {
  IMemoryBackend,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryUpdate,
  MemoryQuery,
  SearchOptions,
  SearchResult,
  BackendStats,
  HealthCheckResult,
  ComponentHealth,
  EmbeddingGenerator,
  createDefaultEntry,
  QueryType,
  MemoryType,
} from './types.js';
import { SQLiteBackend, SQLiteBackendConfig } from './sqlite-backend.js';
import { SqlJsBackend, SqlJsBackendConfig } from './sqljs-backend.js';
import { LocalVectorBackend, LocalVectorBackendConfig } from './local-vector-backend.js';

type StructuredBackend = SQLiteBackend | SqlJsBackend;

/**
 * Configuration for HybridBackend
 */
export interface HybridBackendConfig {
  /** SQLite configuration */
  sqlite?: Partial<SQLiteBackendConfig>;

  /** Local vector backend configuration */
  localVector?: Partial<LocalVectorBackendConfig>;

  /** Default namespace */
  defaultNamespace?: string;

  /** Embedding generator function */
  embeddingGenerator?: EmbeddingGenerator;

  /** Query routing strategy */
  routingStrategy?: 'auto' | 'sqlite-first' | 'localVector-first';

  /** Enable dual-write (write to both backends) */
  dualWrite?: boolean;

  /** Semantic search threshold for hybrid queries */
  semanticThreshold?: number;

  /** Maximum results to fetch from each backend in hybrid queries */
  hybridMaxResults?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<HybridBackendConfig> = {
  sqlite: {},
  localVector: {},
  defaultNamespace: 'default',
  embeddingGenerator: undefined as unknown as EmbeddingGenerator, // SAFETY: Required<> makes field mandatory but default is undefined
  routingStrategy: 'auto',
  dualWrite: true,
  semanticThreshold: 0.7,
  hybridMaxResults: 100,
};

/**
 * Structured Query Interface
 * Optimized for SQLite's strengths
 */
export interface StructuredQuery {
  /** Exact key match */
  key?: string;

  /** Key prefix match */
  keyPrefix?: string;

  /** Namespace filter */
  namespace?: string;

  /** Owner filter */
  ownerId?: string;

  /** Type filter */
  type?: string;

  /** Time range filters */
  createdAfter?: number;
  createdBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;

  /** Pagination */
  limit?: number;
  offset?: number;
}

/**
 * Semantic Query Interface
 * Optimized for local HNSW vector search
 */
export interface SemanticQuery {
  /** Content to search for (will be embedded) */
  content?: string;

  /** Pre-computed embedding */
  embedding?: Float32Array;

  /** Number of results */
  k?: number;

  /** Similarity threshold (0-1) */
  threshold?: number;

  /** Additional filters */
  filters?: Partial<MemoryQuery>;
}

/**
 * Hybrid Query Interface
 * Combines structured + semantic search
 */
export interface HybridQuery {
  /** Semantic component */
  semantic: SemanticQuery;

  /** Structured component */
  structured?: StructuredQuery;

  /** How to combine results */
  combineStrategy?: 'union' | 'intersection' | 'semantic-first' | 'structured-first';

  /** Weights for score combination */
  weights?: {
    semantic: number;
    structured: number;
  };
}

/**
 * HybridBackend Implementation
 *
 * Intelligently routes queries between SQLite and local vector search:
 * - Exact matches, prefix queries → SQLite
 * - Semantic search, similarity → LocalVectorBackend
 * - Complex hybrid queries → Both backends with intelligent merging
 */
export class HybridBackend extends EventEmitter implements IMemoryBackend {
  private sqlite: StructuredBackend;
  private localVector: LocalVectorBackend;
  private config: Required<HybridBackendConfig>;
  private initialized: boolean = false;

  // Performance tracking
  private stats = {
    sqliteQueries: 0,
    localVectorQueries: 0,
    hybridQueries: 0,
    totalQueryTime: 0,
  };

  constructor(config: HybridBackendConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize SQLite backend
    this.sqlite = new SQLiteBackend({
      ...this.config.sqlite,
      defaultNamespace: this.config.defaultNamespace,
      embeddingGenerator: this.config.embeddingGenerator,
    });

    // Initialize local HNSW-backed vector backend
    this.localVector = new LocalVectorBackend({
      ...this.config.localVector,
      defaultNamespace: this.config.defaultNamespace,
      embeddingGenerator: this.config.embeddingGenerator,
    });

    this.forwardStructuredEvents();
    this.forwardLocalVectorEvents();
  }

  private forwardStructuredEvents(): void {
    this.sqlite.on('entry:stored', (data) => this.emit('sqlite:stored', data));
    this.sqlite.on('entry:updated', (data) => this.emit('sqlite:updated', data));
    this.sqlite.on('entry:deleted', (data) => this.emit('sqlite:deleted', data));
  }

  private forwardLocalVectorEvents(): void {
    this.localVector.on('entry:stored', (data) => this.emit('localVector:stored', data));
    this.localVector.on('entry:updated', (data) => this.emit('localVector:updated', data));
    this.localVector.on('entry:deleted', (data) => this.emit('localVector:deleted', data));
    this.localVector.on('cache:hit', (data) => this.emit('cache:hit', data));
    this.localVector.on('cache:miss', (data) => this.emit('cache:miss', data));
  }

  /**
   * Initialize both backends
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await this.sqlite.initialize();
    } catch (error) {
      this.sqlite.removeAllListeners();
      const sqliteConfig = this.config.sqlite;
      this.sqlite = new SqlJsBackend({
        databasePath: sqliteConfig.databasePath ?? ':memory:',
        optimize: sqliteConfig.optimize ?? true,
        defaultNamespace: this.config.defaultNamespace,
        embeddingGenerator: this.config.embeddingGenerator,
        maxEntries: sqliteConfig.maxEntries ?? 1000000,
        verbose: sqliteConfig.verbose ?? false,
        autoPersistInterval: 0,
      } satisfies Partial<SqlJsBackendConfig>);
      this.forwardStructuredEvents();
      await this.sqlite.initialize();
      this.emit('sqlite:fallback', { reason: error instanceof Error ? error.message : String(error) });
    }

    await this.localVector.initialize();

    this.initialized = true;
    this.emit('initialized');
  }

  /**
   * Shutdown both backends
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    await Promise.all([this.sqlite.shutdown(), this.localVector.shutdown()]);

    this.initialized = false;
    this.emit('shutdown');
  }

  /**
   * Store in both backends (dual-write for consistency)
   */
  async store(entry: MemoryEntry): Promise<void> {
    if (this.config.dualWrite) {
      // Write to both backends in parallel
      await Promise.all([this.sqlite.store(entry), this.localVector.store(entry)]);
    } else {
      // Write to primary backend only (local vector backend has vector search)
      await this.localVector.store(entry);
    }

    this.emit('entry:stored', { id: entry.id });
  }

  /**
   * Get from local vector backend (has caching enabled)
   */
  async get(id: string): Promise<MemoryEntry | null> {
    return this.localVector.get(id);
  }

  /**
   * Get by key (SQLite optimized for exact matches)
   */
  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
    return this.sqlite.getByKey(namespace, key);
  }

  /**
   * Update in both backends
   */
  async update(id: string, update: MemoryEntryUpdate): Promise<MemoryEntry | null> {
    if (this.config.dualWrite) {
      // Update both backends
      const [sqliteResult, localVectorResult] = await Promise.all([
        this.sqlite.update(id, update),
        this.localVector.update(id, update),
      ]);
      return localVectorResult || sqliteResult;
    } else {
      return this.localVector.update(id, update);
    }
  }

  /**
   * Delete from both backends
   */
  async delete(id: string): Promise<boolean> {
    if (this.config.dualWrite) {
      const [sqliteResult, localVectorResult] = await Promise.all([
        this.sqlite.delete(id),
        this.localVector.delete(id),
      ]);
      return sqliteResult || localVectorResult;
    } else {
      return this.localVector.delete(id);
    }
  }

  /**
   * Query routing - semantic goes to local vector backend, structured to SQLite
   */
  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const startTime = performance.now();

    let results: MemoryEntry[];

    // Route based on query type
    switch (query.type) {
      case 'exact':
        // SQLite optimized for exact matches
        this.stats.sqliteQueries++;
        results = await this.sqlite.query(query);
        break;

      case 'prefix':
        // SQLite optimized for prefix queries
        this.stats.sqliteQueries++;
        results = await this.sqlite.query(query);
        break;

      case 'tag':
        // Both can handle tags, use SQLite for structured filtering
        this.stats.sqliteQueries++;
        results = await this.sqlite.query(query);
        break;

      case 'semantic':
        // Local vector backend optimized for semantic search
        this.stats.localVectorQueries++;
        results = await this.localVector.query(query);
        break;

      case 'hybrid':
        // Use hybrid query combining both backends
        this.stats.hybridQueries++;
        results = await this.queryHybridInternal(query);
        break;

      default:
        // Auto-routing based on query properties
        results = await this.autoRoute(query);
    }

    const duration = performance.now() - startTime;
    this.stats.totalQueryTime += duration;

    this.emit('query:completed', { type: query.type, duration, count: results.length });
    return results;
  }

  /**
   * Structured queries (SQL)
   * Routes to SQLite for optimal performance
   */
  async queryStructured(query: StructuredQuery): Promise<MemoryEntry[]> {
    this.stats.sqliteQueries++;

    const memoryQuery: MemoryQuery = {
      type: query.key ? 'exact' : query.keyPrefix ? 'prefix' : 'hybrid',
      key: query.key,
      keyPrefix: query.keyPrefix,
      namespace: query.namespace,
      ownerId: query.ownerId,
      memoryType: query.type as MemoryType | undefined, // SAFETY: StructuredQuery.type is string matching MemoryType union
      createdAfter: query.createdAfter,
      createdBefore: query.createdBefore,
      updatedAfter: query.updatedAfter,
      updatedBefore: query.updatedBefore,
      limit: query.limit || 100,
      offset: query.offset || 0,
    };

    return this.sqlite.query(memoryQuery);
  }

  /**
   * Semantic queries (vector)
   * Routes to local HNSW-based vector search
   */
  async querySemantic(query: SemanticQuery): Promise<MemoryEntry[]> {
    this.stats.localVectorQueries++;

    let embedding = query.embedding;

    // Generate embedding if content provided
    if (!embedding && query.content && this.config.embeddingGenerator) {
      embedding = await this.config.embeddingGenerator(query.content);
    }

    if (!embedding) {
      throw new Error('SemanticQuery requires either content or embedding');
    }

    const searchResults = await this.localVector.search(embedding, {
      k: (query.k || 10) * 2, // Over-fetch to account for post-filtering
      threshold: query.threshold || this.config.semanticThreshold,
      filters: query.filters as MemoryQuery | undefined,
    });

    let entries = searchResults.map((r) => r.entry);

    // Apply tag/namespace/type filters defensively after semantic search
    if (query.filters) {
      const f = query.filters as Record<string, unknown>;
      if (f.tags && Array.isArray(f.tags)) {
        const requiredTags = f.tags as string[];
        entries = entries.filter((e) =>
          requiredTags.every((t) => e.tags.includes(t))
        );
      }
      if (f.namespace && typeof f.namespace === 'string') {
        entries = entries.filter((e) => e.namespace === f.namespace);
      }
      if (f.type && typeof f.type === 'string' && f.type !== 'semantic') {
        entries = entries.filter((e) => e.type === f.type);
      }
    }

    return entries.slice(0, query.k || 10);
  }

  /**
   * Hybrid queries (combine both)
   * Intelligently merges results from both backends
   */
  async queryHybrid(query: HybridQuery): Promise<MemoryEntry[]> {
    this.stats.hybridQueries++;

    const strategy = query.combineStrategy || 'semantic-first';
    const weights = query.weights || { semantic: 0.7, structured: 0.3 };

    // Execute both queries in parallel
    const [semanticResults, structuredResults] = await Promise.all([
      this.querySemantic(query.semantic),
      query.structured ? this.queryStructured(query.structured) : Promise.resolve([]),
    ]);

    // Combine results based on strategy
    switch (strategy) {
      case 'union':
        return this.combineUnion(semanticResults, structuredResults);

      case 'intersection':
        return this.combineIntersection(semanticResults, structuredResults);

      case 'semantic-first':
        return this.combineSemanticFirst(semanticResults, structuredResults);

      case 'structured-first':
        return this.combineStructuredFirst(semanticResults, structuredResults);

      default:
        return this.combineUnion(semanticResults, structuredResults);
    }
  }

  /**
   * Semantic vector search (routes to local vector backend)
   */
  async search(embedding: Float32Array, options: SearchOptions): Promise<SearchResult[]> {
    this.stats.localVectorQueries++;
    return this.localVector.search(embedding, options);
  }

  /**
   * Bulk insert to both backends
   */
  async bulkInsert(entries: MemoryEntry[]): Promise<void> {
    if (this.config.dualWrite) {
      await Promise.all([this.sqlite.bulkInsert(entries), this.localVector.bulkInsert(entries)]);
    } else {
      await this.localVector.bulkInsert(entries);
    }
  }

  /**
   * Bulk delete from both backends
   */
  async bulkDelete(ids: string[]): Promise<number> {
    if (this.config.dualWrite) {
      const [sqliteCount, localVectorCount] = await Promise.all([
        this.sqlite.bulkDelete(ids),
        this.localVector.bulkDelete(ids),
      ]);
      return Math.max(sqliteCount, localVectorCount);
    } else {
      return this.localVector.bulkDelete(ids);
    }
  }

  /**
   * Count entries (use SQLite for efficiency)
   */
  async count(namespace?: string): Promise<number> {
    return this.sqlite.count(namespace);
  }

  /**
   * List namespaces (use SQLite)
   */
  async listNamespaces(): Promise<string[]> {
    return this.sqlite.listNamespaces();
  }

  /**
   * Clear namespace in both backends
   */
  async clearNamespace(namespace: string): Promise<number> {
    if (this.config.dualWrite) {
      const [sqliteCount, localVectorCount] = await Promise.all([
        this.sqlite.clearNamespace(namespace),
        this.localVector.clearNamespace(namespace),
      ]);
      return Math.max(sqliteCount, localVectorCount);
    } else {
      return this.localVector.clearNamespace(namespace);
    }
  }

  /**
   * Get combined statistics from both backends
   */
  async getStats(): Promise<BackendStats> {
    const [sqliteStats, localVectorStats] = await Promise.all([
      this.sqlite.getStats(),
      this.localVector.getStats(),
    ]);

    return {
      totalEntries: Math.max(sqliteStats.totalEntries, localVectorStats.totalEntries),
      entriesByNamespace: localVectorStats.entriesByNamespace,
      entriesByType: localVectorStats.entriesByType,
      memoryUsage: sqliteStats.memoryUsage + localVectorStats.memoryUsage,
      hnswStats: localVectorStats.hnswStats ?? {
        vectorCount: localVectorStats.totalEntries,
        memoryUsage: 0,
        avgSearchTime: localVectorStats.avgSearchTime,
        buildTime: 0,
        compressionRatio: 1.0,
      },
      cacheStats: localVectorStats.cacheStats ?? {
        hitRate: 0,
        size: 0,
        hits: 0,
        misses: 0,
        evictions: 0,
        memoryUsage: 0,
      },
      avgQueryTime:
        this.stats.hybridQueries + this.stats.sqliteQueries + this.stats.localVectorQueries > 0
          ? this.stats.totalQueryTime /
            (this.stats.hybridQueries + this.stats.sqliteQueries + this.stats.localVectorQueries)
          : 0,
      avgSearchTime: localVectorStats.avgSearchTime,
    };
  }

  /**
   * Health check for both backends
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const [sqliteHealth, localVectorHealth] = await Promise.all([
      this.sqlite.healthCheck(),
      this.localVector.healthCheck(),
    ]);

    const allIssues = [...sqliteHealth.issues, ...localVectorHealth.issues];
    const allRecommendations = [
      ...sqliteHealth.recommendations,
      ...localVectorHealth.recommendations,
    ];

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (
      sqliteHealth.status === 'unhealthy' ||
      localVectorHealth.status === 'unhealthy'
    ) {
      status = 'unhealthy';
    } else if (
      sqliteHealth.status === 'degraded' ||
      localVectorHealth.status === 'degraded'
    ) {
      status = 'degraded';
    }

    return {
      status,
      components: {
        storage: sqliteHealth.components.storage,
        index: localVectorHealth.components.index,
        cache: localVectorHealth.components.cache,
      },
      timestamp: Date.now(),
      issues: allIssues,
      recommendations: allRecommendations,
    };
  }

  // ===== Private Methods =====

  /**
   * Auto-route queries based on properties
   */
  private async autoRoute(query: MemoryQuery): Promise<MemoryEntry[]> {
    // If has embedding or content, use semantic search.
    const hasEmbeddingGenerator = typeof this.config.embeddingGenerator === 'function';
    if (query.embedding || (query.content && hasEmbeddingGenerator)) {
      this.stats.localVectorQueries++;
      return this.localVector.query(query);
    }

    // If has exact key or prefix, use structured search (SQLite)
    if (query.key || query.keyPrefix) {
      this.stats.sqliteQueries++;
      return this.sqlite.query(query);
    }

    // For other filters, use routing strategy
    switch (this.config.routingStrategy) {
      case 'sqlite-first':
        this.stats.sqliteQueries++;
        return this.sqlite.query(query);

      case 'localVector-first':
        this.stats.localVectorQueries++;
        return this.localVector.query(query);

      case 'auto':
      default:
        // Default to local vector backend (has caching)
        this.stats.localVectorQueries++;
        return this.localVector.query(query);
    }
  }

  /**
   * Internal hybrid query implementation
   */
  private async queryHybridInternal(query: MemoryQuery): Promise<MemoryEntry[]> {
    // If semantic component exists, use hybrid
    if (query.embedding || query.content) {
      const semanticQuery: SemanticQuery = {
        content: query.content,
        embedding: query.embedding,
        k: query.limit || 10,
        threshold: query.threshold,
        filters: query,
      };

      const structuredQuery: StructuredQuery = {
        namespace: query.namespace,
        key: query.key,
        keyPrefix: query.keyPrefix,
        ownerId: query.ownerId,
        type: query.memoryType,
        createdAfter: query.createdAfter,
        createdBefore: query.createdBefore,
        updatedAfter: query.updatedAfter,
        updatedBefore: query.updatedBefore,
        limit: query.limit,
        offset: query.offset,
      };

      return this.queryHybrid({
        semantic: semanticQuery,
        structured: structuredQuery,
        combineStrategy: 'semantic-first',
      });
    }

    // Otherwise, route to structured
    return this.autoRoute(query);
  }

  /**
   * Combine results using union (all unique results)
   */
  private combineUnion(
    semanticResults: MemoryEntry[],
    structuredResults: MemoryEntry[]
  ): MemoryEntry[] {
    const seen = new Set<string>();
    const combined: MemoryEntry[] = [];

    for (const entry of [...semanticResults, ...structuredResults]) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        combined.push(entry);
      }
    }

    return combined;
  }

  /**
   * Combine results using intersection (only common results)
   */
  private combineIntersection(
    semanticResults: MemoryEntry[],
    structuredResults: MemoryEntry[]
  ): MemoryEntry[] {
    const semanticIds = new Set(semanticResults.map((e) => e.id));
    return structuredResults.filter((e) => semanticIds.has(e.id));
  }

  /**
   * Semantic-first: Prefer semantic results, add structured if not present
   */
  private combineSemanticFirst(
    semanticResults: MemoryEntry[],
    structuredResults: MemoryEntry[]
  ): MemoryEntry[] {
    const semanticIds = new Set(semanticResults.map((e) => e.id));
    const additional = structuredResults.filter((e) => !semanticIds.has(e.id));
    return [...semanticResults, ...additional];
  }

  /**
   * Structured-first: Prefer structured results, add semantic if not present
   */
  private combineStructuredFirst(
    semanticResults: MemoryEntry[],
    structuredResults: MemoryEntry[]
  ): MemoryEntry[] {
    const structuredIds = new Set(structuredResults.map((e) => e.id));
    const additional = semanticResults.filter((e) => !structuredIds.has(e.id));
    return [...structuredResults, ...additional];
  }

  // ===== Controller-only capabilities not provided by the JS bootstrap =====

  /**
   * Record feedback for a memory entry.
   * The JS bootstrap does not provide learning-feedback controllers.
   */
  async recordFeedback(
    _entryId: string,
    _feedback: { score: number; label?: string; context?: Record<string, unknown> },
  ): Promise<boolean> {
    return false;
  }

  /**
   * Verify a witness chain for a memory entry.
   * Witness chains are unavailable until the future Rust memory layer provides them.
   */
  async verifyWitnessChain(_entryId: string): Promise<{
    valid: boolean;
    chainLength: number;
    errors: string[];
  }> {
    return {
      valid: false,
      chainLength: 0,
      errors: ['Witness chains are unavailable in the JS HNSW bootstrap'],
    };
  }

  /**
   * Get the witness chain for a memory entry.
   * Witness chains are unavailable until the future Rust memory layer provides them.
   */
  async getWitnessChain(_entryId: string): Promise<Array<{
    hash: string;
    timestamp: number;
    operation: string;
  }>> {
    return [];
  }

  // ===== Backend Access =====

  /**
   * Get underlying backends for advanced operations
   */
  getSQLiteBackend(): StructuredBackend {
    return this.sqlite;
  }

  getLocalVectorBackend(): LocalVectorBackend {
    return this.localVector;
  }
}

export default HybridBackend;
