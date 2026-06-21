/**
 * V3 HNSW Vector Index
 *
 * High-performance Hierarchical Navigable Small World (HNSW) index for
 * fast HNSW-indexed vector similarity search compared to brute force.
 *
 * OPTIMIZATIONS:
 * - BinaryMinHeap/BinaryMaxHeap for O(log n) operations (vs O(n log n) Array.sort)
 * - Pre-normalized vectors for O(1) cosine similarity (no sqrt needed)
 * - Bounded max-heap for efficient top-k tracking
 *
 * @module v3/memory/hnsw-index
 */

import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import {
  DistanceMetric,
  HNSWConfig,
  HNSWStats,
  SearchResult,
  MemoryEntry,
  MemoryEvent,
  MemoryEventHandler,
  QuantizationConfig,
  QuantizedVector,
} from './types.js';
import {
  IVectorIndex,
  VectorIndexConfig,
  VectorIndexStats,
  distanceToHigherScore,
} from './vector-index.js';

/**
 * Binary Min Heap for O(log n) priority queue operations
 * Used for candidate selection in HNSW search
 */
class BinaryMinHeap<T> {
  private heap: Array<{ item: T; priority: number }> = [];

  get size(): number {
    return this.heap.length;
  }

  insert(item: T, priority: number): void {
    this.heap.push({ item, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  extractMin(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const min = this.heap[0].item;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return min;
  }

  peek(): T | undefined {
    return this.heap[0]?.item;
  }

  peekPriority(): number | undefined {
    return this.heap[0]?.priority;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  toArray(): T[] {
    return this.heap
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => entry.item);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent].priority <= this.heap[index].priority) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && this.heap[left].priority < this.heap[smallest].priority) {
        smallest = left;
      }
      if (right < length && this.heap[right].priority < this.heap[smallest].priority) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.heap[smallest], this.heap[index]] = [this.heap[index], this.heap[smallest]];
      index = smallest;
    }
  }
}

/**
 * Binary Max Heap for bounded top-k tracking
 * Keeps track of k smallest elements by evicting largest when full
 */
class BinaryMaxHeap<T> {
  private heap: Array<{ item: T; priority: number }> = [];
  private maxSize: number;

  constructor(maxSize: number = Infinity) {
    this.maxSize = maxSize;
  }

  get size(): number {
    return this.heap.length;
  }

  insert(item: T, priority: number): boolean {
    // If at capacity and new item is worse than worst, reject
    if (this.heap.length >= this.maxSize && priority >= this.heap[0]?.priority) {
      return false;
    }

    if (this.heap.length >= this.maxSize) {
      // Replace max element
      this.heap[0] = { item, priority };
      this.bubbleDown(0);
    } else {
      this.heap.push({ item, priority });
      this.bubbleUp(this.heap.length - 1);
    }
    return true;
  }

  peekMax(): T | undefined {
    return this.heap[0]?.item;
  }

  peekMaxPriority(): number {
    return this.heap[0]?.priority ?? Infinity;
  }

  extractMax(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const max = this.heap[0].item;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return max;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  toSortedArray(): Array<{ item: T; priority: number }> {
    return this.heap.slice().sort((a, b) => a.priority - b.priority);
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent].priority >= this.heap[index].priority) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      let largest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      if (left < length && this.heap[left].priority > this.heap[largest].priority) {
        largest = left;
      }
      if (right < length && this.heap[right].priority > this.heap[largest].priority) {
        largest = right;
      }
      if (largest === index) break;
      [this.heap[largest], this.heap[index]] = [this.heap[index], this.heap[largest]];
      index = largest;
    }
  }
}

/**
 * Internal node structure for HNSW graph
 */
interface HNSWNode {
  /** Node ID (memory entry ID) */
  id: string;

  /** Vector embedding (original) */
  vector: Float32Array;

  /** Pre-normalized vector for O(1) cosine similarity */
  normalizedVector: Float32Array | null;

  /** Connections at each layer */
  connections: Map<number, Set<string>>;

  /** Node level (top layer this node appears in) */
  level: number;

  /** Quantized vector data (null when quantization is disabled) */
  quantizedData: QuantizedVector | null;
}

/**
 * HNSW Index implementation for ultra-fast vector similarity search
 *
 * Performance characteristics:
 * - Search: O(log n) approximate nearest neighbor
 * - Insert: O(log n) amortized
 * - Memory: O(n * M * L) where M is max connections, L is layers
 */
type SerializedHNSWIndex = {
  version: 1;
  config: {
    dimensions: number;
    M: number;
    efConstruction: number;
    maxElements: number;
    metric: DistanceMetric;
  };
  vectors: Array<{ id: string; vector: number[] }>;
};

export class HNSWIndex extends EventEmitter implements IVectorIndex {
  private config: HNSWConfig;
  private nodes: Map<string, HNSWNode> = new Map();
  private entryPoint: string | null = null;
  private maxLevel: number = 0;

  // Product quantization state
  private pqCodebook: Float32Array[][] | null = null;
  private pqNumSubvectors: number = 0;
  private pqSubvectorDim: number = 0;
  private pqNumCentroids: number = 256;
  private pqTrained: boolean = false;

  // Per-search context (safe: JS is single-threaded)
  private searchContext: {
    binaryQuery?: Uint8Array;
    pqDistanceTables?: Float32Array[];
  } | null = null;

  // Performance tracking
  private performanceStats: {
    searchCount: number;
    totalSearchTime: number;
    insertCount: number;
    totalInsertTime: number;
    buildStartTime: number;
  } = {
    searchCount: 0,
    totalSearchTime: 0,
    insertCount: 0,
    totalInsertTime: 0,
    buildStartTime: 0,
  };

  constructor(config: Partial<HNSWConfig> = {}) {
    super();
    this.config = this.configure(config);
  }

  /**
   * Initialize the storage-free IVectorIndex surface.
   */
  async init(config: VectorIndexConfig): Promise<void> {
    this.config = this.configure({
      dimensions: config.dims,
      M: config.M,
      efConstruction: config.efConstruction,
      maxElements: config.maxElements,
      metric: config.metric,
    });
    this.clear();
  }

  async add(id: string, vector: Float32Array): Promise<void> {
    await this.addPoint(id, vector);
  }

  async addBatch(items: Array<{ id: string; vector: Float32Array }>): Promise<void> {
    for (const item of items) {
      await this.addPoint(item.id, item.vector);
    }
  }

  async remove(id: string): Promise<boolean> {
    return this.removePoint(id);
  }

  async searchKNN(
    query: Float32Array,
    k: number,
    ef?: number
  ): Promise<Array<{ id: string; score: number }>> {
    const results = await this.search(query, k, ef);
    return results
      .map((result) => ({
        id: result.id,
        score: distanceToHigherScore(this.config.metric, result.distance),
      }))
      .sort((a, b) => b.score - a.score);
  }

  size(): number {
    return this.nodes.size;
  }

  async save(path: string): Promise<void> {
    const serialized: SerializedHNSWIndex = {
      version: 1,
      config: {
        dimensions: this.config.dimensions,
        M: this.config.M,
        efConstruction: this.config.efConstruction,
        maxElements: this.config.maxElements,
        metric: this.config.metric,
      },
      vectors: Array.from(this.nodes.values()).map((node) => ({
        id: node.id,
        vector: Array.from(node.vector),
      })),
    };
    await writeFile(path, JSON.stringify(serialized, null, 2), 'utf8');
  }

  async load(path: string): Promise<void> {
    const serialized = JSON.parse(await readFile(path, 'utf8')) as SerializedHNSWIndex;
    if (serialized.version !== 1) {
      throw new Error(`Unsupported HNSW index format version: ${serialized.version}`);
    }
    this.config = this.configure(serialized.config);
    await this.rebuild(
      serialized.vectors.map((item) => ({
        id: item.id,
        vector: new Float32Array(item.vector),
      }))
    );
  }

  stats(): VectorIndexStats {
    const current = this.getStats();
    return {
      vectorCount: current.vectorCount,
      memoryUsage: current.memoryUsage,
      avgSearchTime: current.avgSearchTime,
    };
  }

  /**
   * Add a vector to the index
   */
  async addPoint(id: string, vector: Float32Array): Promise<void> {
    const startTime = performance.now();

    if (vector.length !== this.config.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.dimensions}, got ${vector.length}`
      );
    }

    if (this.nodes.size >= this.config.maxElements) {
      throw new Error('Index is full, cannot add more elements');
    }

    // Pre-normalize vector for O(1) cosine similarity
    const normalizedVector = this.config.metric === 'cosine'
      ? this.normalizeVector(vector)
      : null;

    // Quantize vector if configured
    let quantizedData: QuantizedVector | null = null;
    if (this.config.quantization) {
      switch (this.config.quantization.type) {
        case 'binary':
          quantizedData = { type: 'binary', packed: this.binaryQuantize(vector) };
          break;
        case 'scalar': {
          const sq = this.scalarQuantize(vector);
          quantizedData = { type: 'scalar', quantized: sq.quantized, min: sq.min, range: sq.range };
          break;
        }
        case 'product':
          if (!this.pqTrained) {
            throw new Error('Product quantization requires training before inserting vectors. Call trainIndex() first.');
          }
          quantizedData = { type: 'product', codes: this.productEncode(vector) };
          break;
      }
    }

    // Generate random level for new node
    const level = this.getRandomLevel();

    const node: HNSWNode = {
      id,
      vector,
      normalizedVector,
      connections: new Map(),
      level,
      quantizedData,
    };

    // Initialize connection sets for each layer
    for (let l = 0; l <= level; l++) {
      node.connections.set(l, new Set());
    }

    if (this.entryPoint === null) {
      // First node
      this.entryPoint = id;
      this.maxLevel = level;
      this.nodes.set(id, node);
    } else {
      // Insert new node into the graph
      await this.insertNode(node);
    }

    const duration = performance.now() - startTime;
    this.performanceStats.insertCount++;
    this.performanceStats.totalInsertTime += duration;

    this.emit('point:added', { id, level, duration });
  }

  /**
   * Search for k nearest neighbors
   */
  async search(
    query: Float32Array,
    k: number,
    ef?: number
  ): Promise<Array<{ id: string; distance: number }>> {
    const startTime = performance.now();

    if (query.length !== this.config.dimensions) {
      throw new Error(
        `Query dimension mismatch: expected ${this.config.dimensions}, got ${query.length}`
      );
    }

    if (this.entryPoint === null) {
      return [];
    }

    const searchEf = ef || Math.max(k, this.config.efConstruction);

    // Pre-normalize query for O(1) cosine similarity
    const normalizedQuery = this.config.metric === 'cosine'
      ? this.normalizeVector(query)
      : null;

    // Set up quantized search context
    if (this.config.quantization) {
      switch (this.config.quantization.type) {
        case 'binary':
          this.searchContext = { binaryQuery: this.binaryQuantize(query) };
          break;
        case 'product':
          if (this.pqTrained && this.pqCodebook) {
            this.searchContext = { pqDistanceTables: this.buildPQDistanceTables(query) };
          }
          break;
        default:
          this.searchContext = null;
      }
    } else {
      this.searchContext = null;
    }

    try {
      // Start from entry point and search down the layers
      let currentNode = this.entryPoint;
      let currentDist = this.distanceOptimized(
        query,
        normalizedQuery,
        this.nodes.get(currentNode)!
      );

      // Search through layers from top to 1
      for (let level = this.maxLevel; level > 0; level--) {
        const layerResult = this.searchLayerOptimized(
          query,
          normalizedQuery,
          currentNode,
          1,
          level
        );
        currentNode = layerResult[0]?.id || currentNode;
        currentDist = this.distanceOptimized(
          query,
          normalizedQuery,
          this.nodes.get(currentNode)!
        );
      }

      // Search layer 0 with ef candidates using heap-based search
      const candidates = this.searchLayerOptimized(
        query,
        normalizedQuery,
        currentNode,
        searchEf,
        0
      );

      // Return top k results (already sorted by heap)
      const results = candidates.slice(0, k);

      const duration = performance.now() - startTime;
      this.performanceStats.searchCount++;
      this.performanceStats.totalSearchTime += duration;

      return results;
    } finally {
      this.searchContext = null;
    }
  }

  /**
   * Search with filters applied post-retrieval
   */
  async searchWithFilters(
    query: Float32Array,
    k: number,
    filter: (id: string) => boolean,
    ef?: number
  ): Promise<Array<{ id: string; distance: number }>> {
    // Over-fetch to account for filtered results
    const overFetchFactor = 3;
    const candidates = await this.search(query, k * overFetchFactor, ef);

    return candidates
      .filter((c) => filter(c.id))
      .slice(0, k);
  }

  /**
   * Remove a point from the index
   */
  async removePoint(id: string): Promise<boolean> {
    const node = this.nodes.get(id);
    if (!node) {
      return false;
    }

    // Remove all connections to this node
    for (let level = 0; level <= node.level; level++) {
      const connections = node.connections.get(level);
      if (connections) {
        for (const connectedId of connections) {
          const connectedNode = this.nodes.get(connectedId);
          if (connectedNode) {
            connectedNode.connections.get(level)?.delete(id);
          }
        }
      }
    }

    this.nodes.delete(id);

    // Update entry point if needed
    if (this.entryPoint === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null;
        this.maxLevel = 0;
      } else {
        // Find new entry point with highest level
        let newEntry: string | null = null;
        let newMaxLevel = 0;
        for (const [nodeId, n] of this.nodes) {
          if (newEntry === null || n.level > newMaxLevel) {
            newMaxLevel = n.level;
            newEntry = nodeId;
          }
        }
        this.entryPoint = newEntry;
        this.maxLevel = newMaxLevel;
      }
    }

    this.emit('point:removed', { id });
    return true;
  }

  /**
   * Rebuild the index from scratch
   */
  async rebuild(
    entries: Array<{ id: string; vector: Float32Array }>
  ): Promise<void> {
    this.performanceStats.buildStartTime = performance.now();

    this.nodes.clear();
    this.entryPoint = null;
    this.maxLevel = 0;

    for (const entry of entries) {
      await this.addPoint(entry.id, entry.vector);
    }

    const buildTime = performance.now() - this.performanceStats.buildStartTime;

    this.emit('index:rebuilt', {
      vectorCount: this.nodes.size,
      buildTime,
    });
  }

  /**
   * Get index statistics
   */
  getStats(): HNSWStats {
    const vectorCount = this.nodes.size;
    const avgSearchTime =
      this.performanceStats.searchCount > 0
        ? this.performanceStats.totalSearchTime / this.performanceStats.searchCount
        : 0;

    // Estimate memory usage
    const bytesPerVector = this.config.dimensions * 4; // Float32 = 4 bytes
    const connectionOverhead = this.config.M * 8 * (this.maxLevel + 1); // Approximate
    const memoryUsage = vectorCount * (bytesPerVector + connectionOverhead);

    let compressionRatio = 1.0;
    if (this.config.quantization) {
      const bytesOriginal = this.config.dimensions * 4;
      switch (this.config.quantization.type) {
        case 'binary':
          compressionRatio = bytesOriginal / Math.ceil(this.config.dimensions / 8);
          break;
        case 'scalar':
          compressionRatio = 4.0; // Float32 -> Uint8
          break;
        case 'product':
          compressionRatio = bytesOriginal / (this.pqNumSubvectors || 1);
          break;
      }
    }

    return {
      vectorCount,
      memoryUsage,
      avgSearchTime,
      buildTime: performance.now() - this.performanceStats.buildStartTime,
      compressionRatio,
    };
  }

  /**
   * Clear the index
   */
  clear(): void {
    this.nodes.clear();
    this.entryPoint = null;
    this.maxLevel = 0;
    this.performanceStats = {
      searchCount: 0,
      totalSearchTime: 0,
      insertCount: 0,
      totalInsertTime: 0,
      buildStartTime: 0,
    };
  }

  /**
   * Check if an ID exists in the index
   */
  has(id: string): boolean {
    return this.nodes.has(id);
  }

  // ===== Private Methods =====

  private configure(config: Partial<HNSWConfig>): HNSWConfig {
    const merged = this.mergeConfig(config);
    if (merged.M && merged.M < 2) merged.M = 2;

    this.pqCodebook = null;
    this.pqNumSubvectors = 0;
    this.pqSubvectorDim = 0;
    this.pqNumCentroids = 256;
    this.pqTrained = false;

    if (merged.quantization) {
      const q = merged.quantization;
      if (q.type === 'product') {
        this.pqNumSubvectors = q.subquantizers ?? 8;
        this.pqNumCentroids = q.codebookSize ?? 256;
        if (merged.dimensions % this.pqNumSubvectors !== 0) {
          throw new Error(
            `Dimensions (${merged.dimensions}) must be divisible by subquantizers (${this.pqNumSubvectors})`
          );
        }
        this.pqSubvectorDim = merged.dimensions / this.pqNumSubvectors;
      }
    }

    return merged;
  }

  private mergeConfig(config: Partial<HNSWConfig>): HNSWConfig {
    return {
      dimensions: config.dimensions || 1536, // OpenAI embedding size
      M: config.M || 16,
      efConstruction: config.efConstruction || 200,
      maxElements: config.maxElements || 1000000,
      metric: config.metric || 'cosine',
      quantization: config.quantization,
    };
  }

  private getRandomLevel(): number {
    const random = Math.max(Math.random(), Number.MIN_VALUE);
    const level = Math.floor(-Math.log(random) * (1 / Math.log(this.config.M)));
    return Math.max(0, Math.min(level, 16));
  }

  private async insertNode(node: HNSWNode): Promise<void> {
    const query = node.vector;
    const normalizedQuery = node.normalizedVector;
    let currentNode = this.entryPoint!;
    let currentDist = this.distanceOptimized(
      query,
      normalizedQuery,
      this.nodes.get(currentNode)!
    );

    // Find entry point for the node's level
    for (let level = this.maxLevel; level > node.level; level--) {
      const result = this.searchLayerOptimized(query, normalizedQuery, currentNode, 1, level);
      if (result.length > 0 && result[0].distance < currentDist) {
        currentNode = result[0].id;
        currentDist = result[0].distance;
      }
    }

    // Insert at each level from node.level down to 0
    for (let level = Math.min(node.level, this.maxLevel); level >= 0; level--) {
      const neighbors = this.searchLayerOptimized(
        query,
        normalizedQuery,
        currentNode,
        this.config.efConstruction,
        level
      );

      // Select M best neighbors
      const selectedNeighbors = this.selectNeighbors(
        node.id,
        query,
        neighbors,
        this.config.M
      );

      // Add connections
      for (const neighbor of selectedNeighbors) {
        node.connections.get(level)!.add(neighbor.id);
        this.nodes.get(neighbor.id)?.connections.get(level)?.add(node.id);

        // Prune connections if over limit
        const neighborNode = this.nodes.get(neighbor.id);
        if (neighborNode) {
          const neighborConns = neighborNode.connections.get(level)!;
          if (neighborConns.size > this.config.M * 2) {
            this.pruneConnections(neighborNode, level, this.config.M);
          }
        }
      }

      if (neighbors.length > 0) {
        currentNode = neighbors[0].id;
      }
    }

    this.nodes.set(node.id, node);

    // Update max level if needed
    if (node.level > this.maxLevel) {
      this.maxLevel = node.level;
      this.entryPoint = node.id;
    }
  }

  private async searchLayer(
    query: Float32Array,
    entryPoint: string,
    ef: number,
    level: number
  ): Promise<Array<{ id: string; distance: number }>> {
    const visited = new Set<string>([entryPoint]);
    const candidates: Array<{ id: string; distance: number }> = [];
    const results: Array<{ id: string; distance: number }> = [];

    const entryDist = this.distance(query, this.nodes.get(entryPoint)!.vector);
    candidates.push({ id: entryPoint, distance: entryDist });
    results.push({ id: entryPoint, distance: entryDist });

    while (candidates.length > 0) {
      // Get closest candidate
      candidates.sort((a, b) => a.distance - b.distance);
      const current = candidates.shift()!;

      // Check termination condition
      const worstResult = results.length > 0
        ? Math.max(...results.map((r) => r.distance))
        : Infinity;
      if (current.distance > worstResult && results.length >= ef) {
        break;
      }

      // Explore neighbors
      const node = this.nodes.get(current.id);
      if (!node) continue;

      const connections = node.connections.get(level);
      if (!connections) continue;

      for (const neighborId of connections) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const distance = this.distance(query, neighborNode.vector);

        if (results.length < ef || distance < worstResult) {
          candidates.push({ id: neighborId, distance });
          results.push({ id: neighborId, distance });

          // Keep results bounded
          if (results.length > ef) {
            results.sort((a, b) => a.distance - b.distance);
            results.pop();
          }
        }
      }
    }

    return results.sort((a, b) => a.distance - b.distance);
  }

  /**
   * OPTIMIZED searchLayer using heap-based priority queues
   * Performance: O(log n) per operation vs O(n log n) for Array.sort()
   * Expected improvement for large result sets
   */
  private searchLayerOptimized(
    query: Float32Array,
    normalizedQuery: Float32Array | null,
    entryPoint: string,
    ef: number,
    level: number
  ): Array<{ id: string; distance: number }> {
    const visited = new Set<string>([entryPoint]);

    // Min-heap for candidates (closest first for expansion)
    const candidates = new BinaryMinHeap<string>();

    // Max-heap for results (bounded size, tracks worst distance efficiently)
    const results = new BinaryMaxHeap<string>(ef);

    const entryNode = this.nodes.get(entryPoint)!;
    const entryDist = this.distanceOptimized(query, normalizedQuery, entryNode);

    candidates.insert(entryPoint, entryDist);
    results.insert(entryPoint, entryDist);

    while (!candidates.isEmpty()) {
      // Get closest candidate - O(log n)
      const currentDist = candidates.peekPriority()!;
      const currentId = candidates.extractMin()!;

      // Check termination: if closest candidate is worse than worst result, stop
      const worstResultDist = results.peekMaxPriority();
      if (currentDist > worstResultDist && results.size >= ef) {
        break;
      }

      // Explore neighbors
      const node = this.nodes.get(currentId);
      if (!node) continue;

      const connections = node.connections.get(level);
      if (!connections) continue;

      for (const neighborId of connections) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const distance = this.distanceOptimized(query, normalizedQuery, neighborNode);

        // Only add if within threshold or results not full
        if (results.size < ef || distance < worstResultDist) {
          candidates.insert(neighborId, distance);
          // Max-heap handles size bounding automatically - O(log n)
          results.insert(neighborId, distance);
        }
      }
    }

    // Return sorted results
    return results.toSortedArray().map(({ item, priority }) => ({
      id: item,
      distance: priority,
    }));
  }

  private selectNeighbors(
    nodeId: string,
    query: Float32Array,
    candidates: Array<{ id: string; distance: number }>,
    M: number
  ): Array<{ id: string; distance: number }> {
    // Simple selection: take M closest
    return candidates
      .filter((c) => c.id !== nodeId)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, M);
  }

  private pruneConnections(node: HNSWNode, level: number, maxConnections: number): void {
    const connections = node.connections.get(level);
    if (!connections || connections.size <= maxConnections) return;

    // Calculate distances to all connections
    const distances: Array<{ id: string; distance: number }> = [];
    for (const connId of connections) {
      const connNode = this.nodes.get(connId);
      if (connNode) {
        distances.push({
          id: connId,
          distance: this.distance(node.vector, connNode.vector),
        });
      }
    }

    // Keep only the closest ones
    distances.sort((a, b) => a.distance - b.distance);
    const toKeep = new Set(distances.slice(0, maxConnections).map((d) => d.id));

    // Remove excess connections
    for (const connId of connections) {
      if (!toKeep.has(connId)) {
        connections.delete(connId);
        this.nodes.get(connId)?.connections.get(level)?.delete(node.id);
      }
    }
  }

  private distance(a: Float32Array, b: Float32Array): number {
    switch (this.config.metric) {
      case 'cosine':
        return this.cosineDistance(a, b);
      case 'euclidean':
        return this.euclideanDistance(a, b);
      case 'dot':
        return this.dotProductDistance(a, b);
      case 'manhattan':
        return this.manhattanDistance(a, b);
      default:
        return this.cosineDistance(a, b);
    }
  }

  private cosineDistance(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return 1 - similarity; // Convert to distance
  }

  /**
   * OPTIMIZED: Cosine distance using pre-normalized vectors
   * Only requires dot product (no sqrt operations)
   * Performance: O(n), faster than standard cosine
   */
  private cosineDistanceNormalized(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
    }
    // For normalized vectors: cosine_similarity = dot_product
    // Return distance (1 - similarity)
    return 1 - dotProduct;
  }

  /**
   * Normalize a vector to unit length for O(1) cosine similarity
   */
  private normalizeVector(vector: Float32Array): Float32Array {
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);

    if (norm === 0) {
      return vector; // Return as-is if zero vector
    }

    const normalized = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      normalized[i] = vector[i] / norm;
    }
    return normalized;
  }

  /**
   * OPTIMIZED distance calculation that uses quantized or pre-normalized vectors when available
   */
  private distanceOptimized(
    query: Float32Array,
    normalizedQuery: Float32Array | null,
    node: HNSWNode
  ): number {
    // Quantized distance paths
    if (this.config.quantization && node.quantizedData) {
      switch (node.quantizedData.type) {
        case 'binary':
          if (this.searchContext?.binaryQuery) {
            return this.hammingDistance(this.searchContext.binaryQuery, node.quantizedData.packed);
          }
          break;
        case 'scalar': {
          const dequantized = this.scalarDequantize(
            node.quantizedData.quantized,
            node.quantizedData.min,
            node.quantizedData.range
          );
          return this.distance(query, dequantized);
        }
        case 'product':
          if (this.searchContext?.pqDistanceTables) {
            return this.adcDistance(this.searchContext.pqDistanceTables, node.quantizedData.codes);
          }
          break;
      }
    }

    // Unquantized: optimized cosine with pre-normalized vectors
    if (
      this.config.metric === 'cosine' &&
      normalizedQuery !== null &&
      node.normalizedVector !== null
    ) {
      return this.cosineDistanceNormalized(normalizedQuery, node.normalizedVector);
    }

    return this.distance(query, node.vector);
  }

  private euclideanDistance(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  private dotProductDistance(a: Float32Array, b: Float32Array): number {
    let dotProduct = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
    }
    // Negative because higher dot product = more similar
    return -dotProduct;
  }

  private manhattanDistance(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += Math.abs(a[i] - b[i]);
    }
    return sum;
  }

  // ===== Quantization Methods =====

  private binaryQuantize(vector: Float32Array): Uint8Array {
    const numBytes = Math.ceil(vector.length / 8);
    const packed = new Uint8Array(numBytes);
    for (let i = 0; i < vector.length; i++) {
      if (vector[i] > 0) {
        packed[i >> 3] |= (1 << (i & 7));
      }
    }
    return packed;
  }

  private hammingDistance(a: Uint8Array, b: Uint8Array): number {
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
      let xor = a[i] ^ b[i];
      while (xor) {
        distance++;
        xor &= xor - 1;
      }
    }
    return distance;
  }

  private scalarQuantize(vector: Float32Array): { quantized: Uint8Array; min: number; range: number } {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < vector.length; i++) {
      if (vector[i] < min) min = vector[i];
      if (vector[i] > max) max = vector[i];
    }
    const range = max - min || 1e-10;
    const quantized = new Uint8Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
      quantized[i] = Math.round(((vector[i] - min) / range) * 255);
    }
    return { quantized, min, range };
  }

  private scalarDequantize(quantized: Uint8Array, min: number, range: number): Float32Array {
    const result = new Float32Array(quantized.length);
    for (let i = 0; i < quantized.length; i++) {
      result[i] = (quantized[i] / 255) * range + min;
    }
    return result;
  }

  async trainIndex(trainingVectors: Float32Array[]): Promise<void> {
    if (!this.config.quantization || this.config.quantization.type !== 'product') {
      throw new Error('trainIndex() only applies to product quantization');
    }
    if (trainingVectors.length < this.pqNumCentroids) {
      throw new Error(
        `Need at least ${this.pqNumCentroids} training vectors, got ${trainingVectors.length}`
      );
    }

    this.pqCodebook = [];
    for (let m = 0; m < this.pqNumSubvectors; m++) {
      const subvectors = this.extractSubvectors(trainingVectors, m);
      const centroids = this.kMeansPlusPlus(subvectors, this.pqNumCentroids);
      this.pqCodebook.push(centroids);
    }
    this.pqTrained = true;
  }

  get isTrained(): boolean {
    if (!this.config.quantization || this.config.quantization.type !== 'product') return true;
    return this.pqTrained;
  }

  private extractSubvectors(vectors: Float32Array[], m: number): Float32Array[] {
    const start = m * this.pqSubvectorDim;
    return vectors.map(v => v.slice(start, start + this.pqSubvectorDim));
  }

  private kMeansPlusPlus(data: Float32Array[], k: number): Float32Array[] {
    const dim = data[0].length;
    const centroids: Float32Array[] = [];

    // k-means++ initialization
    centroids.push(new Float32Array(data[Math.floor(Math.random() * data.length)]));

    for (let c = 1; c < k; c++) {
      const distances = data.map(v => {
        let minDist = Infinity;
        for (const centroid of centroids) {
          let d = 0;
          for (let i = 0; i < dim; i++) {
            const diff = v[i] - centroid[i];
            d += diff * diff;
          }
          if (d < minDist) minDist = d;
        }
        return minDist;
      });
      const total = distances.reduce((a, b) => a + b, 0);
      let threshold = Math.random() * total;
      let chosen = 0;
      for (let i = 0; i < data.length; i++) {
        threshold -= distances[i];
        if (threshold <= 0) { chosen = i; break; }
      }
      centroids.push(new Float32Array(data[chosen]));
    }

    // k-means iterations
    for (let iter = 0; iter < 100; iter++) {
      const assignments: number[][] = Array.from({ length: k }, () => []);
      for (let i = 0; i < data.length; i++) {
        let minDist = Infinity, minIdx = 0;
        for (let c = 0; c < k; c++) {
          let d = 0;
          for (let j = 0; j < dim; j++) {
            const diff = data[i][j] - centroids[c][j];
            d += diff * diff;
          }
          if (d < minDist) { minDist = d; minIdx = c; }
        }
        assignments[minIdx].push(i);
      }

      let maxShift = 0;
      for (let c = 0; c < k; c++) {
        if (assignments[c].length === 0) {
          centroids[c] = new Float32Array(data[Math.floor(Math.random() * data.length)]);
          continue;
        }
        const newCentroid = new Float32Array(dim);
        for (const idx of assignments[c]) {
          for (let d = 0; d < dim; d++) newCentroid[d] += data[idx][d];
        }
        for (let d = 0; d < dim; d++) newCentroid[d] /= assignments[c].length;
        let shift = 0;
        for (let d = 0; d < dim; d++) {
          const diff = centroids[c][d] - newCentroid[d];
          shift += diff * diff;
        }
        maxShift = Math.max(maxShift, shift);
        centroids[c] = newCentroid;
      }

      if (maxShift < 1e-6) break;
    }

    return centroids;
  }

  private productEncode(vector: Float32Array): Uint8Array {
    const codes = new Uint8Array(this.pqNumSubvectors);
    for (let m = 0; m < this.pqNumSubvectors; m++) {
      const start = m * this.pqSubvectorDim;
      let minDist = Infinity, minIdx = 0;
      for (let c = 0; c < this.pqNumCentroids; c++) {
        let d = 0;
        for (let j = 0; j < this.pqSubvectorDim; j++) {
          const diff = vector[start + j] - this.pqCodebook![m][c][j];
          d += diff * diff;
        }
        if (d < minDist) { minDist = d; minIdx = c; }
      }
      codes[m] = minIdx;
    }
    return codes;
  }

  private buildPQDistanceTables(query: Float32Array): Float32Array[] {
    const tables: Float32Array[] = [];
    for (let m = 0; m < this.pqNumSubvectors; m++) {
      const start = m * this.pqSubvectorDim;
      const table = new Float32Array(this.pqNumCentroids);
      for (let c = 0; c < this.pqNumCentroids; c++) {
        let d = 0;
        for (let j = 0; j < this.pqSubvectorDim; j++) {
          const diff = query[start + j] - this.pqCodebook![m][c][j];
          d += diff * diff;
        }
        table[c] = d;
      }
      tables.push(table);
    }
    return tables;
  }

  private adcDistance(tables: Float32Array[], codes: Uint8Array): number {
    let sum = 0;
    for (let m = 0; m < codes.length; m++) {
      sum += tables[m][codes[m]];
    }
    return Math.sqrt(sum);
  }
}

export default HNSWIndex;
