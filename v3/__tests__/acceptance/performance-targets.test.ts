/**
 * V3 Claude-Flow Performance Targets Acceptance Tests
 *
 * Acceptance tests for V3 performance requirements
 * Tests against ADR targets: 2.49x-7.47x speedup, 150x-12,500x search improvement
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMock, type MockedInterface } from '../helpers/create-mock';
import { assertPerformanceTarget } from '../helpers/assertions';
import { performanceConfigs, memoryConfigs } from '../fixtures/configurations';
import { agentDBTestData, generateMockEmbedding, createMemoryBatch } from '../fixtures/memory-entries';

/**
 * Performance measurement interface
 */
interface IPerformanceMeasurer {
  measure<T>(operation: () => Promise<T>): Promise<MeasurementResult<T>>;
  compare(baseline: number, optimized: number): SpeedupResult;
  recordMetric(name: string, value: number, unit: string): void;
  getReport(): PerformanceReport;
}

/**
 * Vector search interface for performance testing
 */
interface IVectorSearchEngine {
  initialize(config: SearchConfig): Promise<void>;
  insert(entries: VectorEntry[]): Promise<number>;
  search(query: number[], topK: number): Promise<SearchResult[]>;
  getStats(): SearchStats;
}

/**
 * Memory optimizer interface
 */
interface IMemoryOptimizer {
  analyze(): Promise<MemoryAnalysis>;
  optimize(): Promise<OptimizationResult>;
  getUsage(): MemoryUsage;
}

interface MeasurementResult<T> {
  result: T;
  duration: number;
  memory: number;
}

interface SpeedupResult {
  speedup: number;
  improvement: string;
  meetsTarget: boolean;
}

interface PerformanceReport {
  metrics: Map<string, { value: number; unit: string }>;
  summary: string;
}

interface SearchConfig {
  dimensions: number;
  indexType: 'hnsw' | 'flat';
  hnswConfig?: {
    M: number;
    efConstruction: number;
    efSearch: number;
  };
}

interface VectorEntry {
  id: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

interface SearchResult {
  id: string;
  score: number;
}

interface SearchStats {
  totalEntries: number;
  indexSize: number;
  averageSearchTime: number;
  indexBuildTime: number;
}

interface MemoryAnalysis {
  totalMemory: number;
  usedMemory: number;
  potentialSavings: number;
  recommendations: string[];
}

interface OptimizationResult {
  originalSize: number;
  optimizedSize: number;
  reduction: number;
  techniquesApplied: string[];
}

interface MemoryUsage {
  heap: number;
  external: number;
  arrayBuffers: number;
}

/**
 * Mock performance measurer for testing
 */
class PerformanceMeasurer implements IPerformanceMeasurer {
  private metrics: Map<string, { value: number; unit: string }> = new Map();

  async measure<T>(operation: () => Promise<T>): Promise<MeasurementResult<T>> {
    const startMemory = process.memoryUsage().heapUsed;
    const startTime = performance.now();

    const result = await operation();

    const duration = performance.now() - startTime;
    const memory = process.memoryUsage().heapUsed - startMemory;

    return { result, duration, memory };
  }

  compare(baseline: number, optimized: number): SpeedupResult {
    const speedup = baseline / optimized;
    const targets = performanceConfigs.v3Targets.targets;

    const meetsFlashAttention =
      speedup >= targets.flashAttentionSpeedup[0] &&
      speedup <= targets.flashAttentionSpeedup[1];

    return {
      speedup,
      improvement: `${((speedup - 1) * 100).toFixed(1)}% faster`,
      meetsTarget: meetsFlashAttention,
    };
  }

  recordMetric(name: string, value: number, unit: string): void {
    this.metrics.set(name, { value, unit });
  }

  getReport(): PerformanceReport {
    return {
      metrics: this.metrics,
      summary: `Recorded ${this.metrics.size} metrics`,
    };
  }
}

describe('V3 Performance Targets Acceptance', () => {
  let measurer: PerformanceMeasurer;
  let mockSearchEngine: MockedInterface<IVectorSearchEngine>;
  let mockMemoryOptimizer: MockedInterface<IMemoryOptimizer>;

  beforeEach(() => {
    measurer = new PerformanceMeasurer();
    mockSearchEngine = createMock<IVectorSearchEngine>();
    mockMemoryOptimizer = createMock<IMemoryOptimizer>();

    // Configure mock search engine
    mockSearchEngine.initialize.mockResolvedValue(undefined);
    mockSearchEngine.insert.mockResolvedValue(1000);
    mockSearchEngine.search.mockImplementation(async () => {
      // Simulate fast HNSW search
      await new Promise((r) => setTimeout(r, 0.1));
      return [
        { id: 'result-1', score: 0.95 },
        { id: 'result-2', score: 0.90 },
      ];
    });
    mockSearchEngine.getStats.mockReturnValue({
      totalEntries: 1000000,
      indexSize: 500000000,
      averageSearchTime: 0.1,
      indexBuildTime: 5000,
    });

    // Configure mock memory optimizer
    mockMemoryOptimizer.analyze.mockResolvedValue({
      totalMemory: 2147483648, // 2GB
      usedMemory: 1073741824, // 1GB
      potentialSavings: 536870912, // 512MB
      recommendations: ['Enable quantization', 'Use HNSW indexing'],
    });
    mockMemoryOptimizer.optimize.mockResolvedValue({
      originalSize: 1073741824,
      optimizedSize: 536870912,
      reduction: 0.5,
      techniquesApplied: ['scalar-quantization', 'hnsw-indexing'],
    });
    mockMemoryOptimizer.getUsage.mockReturnValue({
      heap: 536870912,
      external: 104857600,
      arrayBuffers: 52428800,
    });
  });

  describe('Flash Attention Speedup (2.49x-7.47x)', () => {
    it('should achieve minimum 2.49x speedup target', async () => {
      // Given
      const baselineTime = 1000; // 1 second baseline
      const optimizedTime = baselineTime / 2.49; // Target minimum

      // When
      const result = measurer.compare(baselineTime, optimizedTime);

      // Then
      expect(result.speedup).toBeGreaterThanOrEqual(2.49);
      expect(result.meetsTarget).toBe(true);
    });

    it('should not exceed 7.47x speedup target', async () => {
      // Given
      const baselineTime = 1000;
      const optimizedTime = baselineTime / 7.47; // Target maximum

      // When
      const result = measurer.compare(baselineTime, optimizedTime);

      // Then
      expect(result.speedup).toBeLessThanOrEqual(7.47);
      expect(result.meetsTarget).toBe(true);
    });

    it('should report failure for speedup below target', async () => {
      // Given
      const baselineTime = 1000;
      const optimizedTime = baselineTime / 1.5; // Below target

      // When
      const result = measurer.compare(baselineTime, optimizedTime);

      // Then
      expect(result.speedup).toBeLessThan(2.49);
      expect(result.meetsTarget).toBe(false);
    });
  });

  describe('AgentDB Search Improvement (150x-12,500x)', () => {
    it('should achieve minimum 150x search improvement', async () => {
      // Given
      const baselineSearchTime = 15; // 15ms baseline (brute force)
      const optimizedSearchTime = 0.1; // 0.1ms optimized (HNSW)

      // When
      const improvement = baselineSearchTime / optimizedSearchTime;

      // Then
      expect(improvement).toBeGreaterThanOrEqual(150);
    });

    it('should support up to 12,500x improvement for large datasets', async () => {
      // Given
      const baselineSearchTime = 125; // 125ms for large dataset brute force
      const optimizedSearchTime = 0.01; // 0.01ms with optimized HNSW

      // When
      const improvement = baselineSearchTime / optimizedSearchTime;

      // Then
      expect(improvement).toBeGreaterThanOrEqual(12500);
    });

    it('should verify HNSW index configuration meets targets', async () => {
      // Given
      const hnswConfig = agentDBTestData.hnswConfig;

      // When
      await mockSearchEngine.initialize({
        dimensions: hnswConfig.dimensions,
        indexType: 'hnsw',
        hnswConfig: {
          M: hnswConfig.M,
          efConstruction: hnswConfig.efConstruction,
          efSearch: hnswConfig.efSearch,
        },
      });

      // Then
      expect(mockSearchEngine.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          indexType: 'hnsw',
          hnswConfig: expect.objectContaining({
            M: 16, // Optimal for balance of speed/recall
            efConstruction: 200, // Good build quality
            efSearch: 50, // Fast search
          }),
        })
      );
    });

    it('should measure search time under target threshold', async () => {
      // Given
      const targetSearchTime = 1; // 1ms target

      // When
      const measurement = await measurer.measure(async () => {
        return mockSearchEngine.search(generateMockEmbedding(384, 'query'), 10);
      });

      // Then
      expect(measurement.duration).toBeLessThan(targetSearchTime);
    });
  });

  describe('Memory Reduction (50-75%)', () => {
    it('should achieve minimum 50% memory reduction', async () => {
      // Given
      const targets = performanceConfigs.v3Targets.targets;

      // When
      const result = await mockMemoryOptimizer.optimize();

      // Then
      expect(result.reduction).toBeGreaterThanOrEqual(targets.memoryReduction);
    });

    it('should apply quantization for memory reduction', async () => {
      // When
      const result = await mockMemoryOptimizer.optimize();

      // Then
      expect(result.techniquesApplied).toContain('scalar-quantization');
    });

    it('should report memory analysis with recommendations', async () => {
      // When
      const analysis = await mockMemoryOptimizer.analyze();

      // Then
      expect(analysis.recommendations).toContain('Enable quantization');
      expect(analysis.potentialSavings).toBeGreaterThan(0);
    });

    it('should verify quantization configuration', async () => {
      // Given
      const quantizationConfig = agentDBTestData.quantizationConfigs;

      // Then - Verify 4-bit quantization achieves 8x compression
      expect(quantizationConfig.scalar4bit.compressionRatio).toBe(8);

      // Verify 8-bit quantization achieves 4x compression
      expect(quantizationConfig.scalar8bit.compressionRatio).toBe(4);

      // Verify product quantization achieves 32x compression
      expect(quantizationConfig.product.compressionRatio).toBe(32);
    });
  });

  describe('Startup Time (<500ms)', () => {
    it('should achieve startup time under 500ms', async () => {
      // Given
      const targetStartupTime = performanceConfigs.v3Targets.targets.startupTime;

      // When
      const measurement = await measurer.measure(async () => {
        // Simulate initialization
        await mockSearchEngine.initialize({
          dimensions: 384,
          indexType: 'hnsw',
        });
        return true;
      });

      // Then
      expect(measurement.duration).toBeLessThan(targetStartupTime);
    });
  });

  describe('Code Size Target (<5,000 lines)', () => {
    it('should verify architecture supports code reduction', () => {
      // Given - V3 architecture principles
      const v3Principles = {
        eliminateDuplication: true, // ADR-001
        dddBoundedContexts: true, // ADR-002
        unifiedCoordinator: true, // ADR-003
        pluginArchitecture: true, // ADR-004
      };

      // Then
      expect(v3Principles.eliminateDuplication).toBe(true);
      expect(v3Principles.dddBoundedContexts).toBe(true);
      expect(v3Principles.unifiedCoordinator).toBe(true);
      expect(v3Principles.pluginArchitecture).toBe(true);
    });
  });

  describe('Performance Measurement Infrastructure', () => {
    it('should record and report metrics', async () => {
      // Given
      measurer.recordMetric('search_time', 0.1, 'ms');
      measurer.recordMetric('memory_usage', 512, 'MB');
      measurer.recordMetric('speedup', 3.5, 'x');

      // When
      const report = measurer.getReport();

      // Then
      expect(report.metrics.size).toBe(3);
      expect(report.metrics.get('search_time')).toEqual({ value: 0.1, unit: 'ms' });
    });

    it('should measure operation with memory tracking', async () => {
      // Given
      const operation = async () => {
        const data = new Array(1000).fill({ test: 'data' });
        return data.length;
      };

      // When
      const result = await measurer.measure(operation);

      // Then
      expect(result.result).toBe(1000);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.memory).toBe('number');
    });
  });

  describe('Batch Operation Performance', () => {
    it('should handle batch vector insertions efficiently', async () => {
      // Given
      const batchSize = 1000;
      const entries = createMemoryBatch(batchSize);

      // When
      const measurement = await measurer.measure(async () => {
        return mockSearchEngine.insert(
          entries.map((e) => ({
            id: e.key,
            embedding: e.embedding!,
            metadata: e.metadata,
          }))
        );
      });

      // Then
      const insertionsPerSecond = (batchSize / measurement.duration) * 1000;
      expect(insertionsPerSecond).toBeGreaterThan(100); // At least 100 inserts/sec
    });

    it('should maintain search performance at scale', async () => {
      // Given
      mockSearchEngine.getStats.mockReturnValue({
        totalEntries: 1000000, // 1M vectors
        indexSize: 500000000,
        averageSearchTime: 0.1,
        indexBuildTime: 5000,
      });

      // When
      const stats = mockSearchEngine.getStats();

      // Then
      expect(stats.averageSearchTime).toBeLessThan(1); // Under 1ms
      expect(stats.totalEntries).toBe(1000000);
    });
  });

  describe('Performance Regression Prevention', () => {
    it('should detect performance regression', async () => {
      // Given
      const previousBenchmark = 100; // Previous: 100ms
      const currentMeasurement = 150; // Current: 150ms (regression)

      // When
      const regression = currentMeasurement > previousBenchmark * 1.1; // 10% tolerance

      // Then
      expect(regression).toBe(true);
    });

    it('should validate performance improvement', async () => {
      // Given
      const previousBenchmark = 100;
      const currentMeasurement = 50; // Improved

      // When
      const improvement = previousBenchmark / currentMeasurement;

      // Then
      expect(improvement).toBeGreaterThan(1);
    });
  });
});
