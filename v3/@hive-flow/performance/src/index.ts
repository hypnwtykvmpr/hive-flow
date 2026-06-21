/**
 * @hive-flow/performance
 *
 * Performance module for hive-flow v3.
 * Provides benchmarking, Flash Attention validation, and optimization utilities.
 *
 * Target Performance Metrics:
 * - CLI Startup: <500ms
 * - MCP Init: <400ms
 * - Agent Spawn: <200ms
 * - Vector Search: measured against the current runtime
 * - Memory Write: <5ms
 * - Swarm Consensus: <100ms
 * - Flash Attention: optimization enabled
 * - Memory Usage: <256MB
 */

// Re-export benchmark framework
export {
  benchmark,
  BenchmarkRunner,
  compareResults,
  printComparisonReport,
  formatBytes,
  formatTime,
  meetsTarget,
  V3_PERFORMANCE_TARGETS,
  type BenchmarkResult,
  type BenchmarkOptions,
  type BenchmarkSuite,
  type EnvironmentInfo,
  type ComparisonResult,
  type MemoryUsage,
  type PerformanceTarget,
} from './framework/benchmark.js';

// Re-export Flash Attention integration
export {
  FlashAttentionOptimizer,
  createFlashAttentionOptimizer,
  quickBenchmark,
  type AttentionInput,
  type AttentionOutput,
  type BenchmarkResult as AttentionBenchmarkResult,
  type PerformanceMetrics as AttentionMetrics,
  flashAttention,
  scaledDotProductAttention,
} from './attention-integration.js';

// Re-export Flash Attention benchmarks
export {
  AttentionBenchmarkRunner,
  formatBenchmarkTable,
  formatSuiteReport,
  formatMemoryProfile,
  quickValidation,
  runAndDisplaySuite,
  runAndDisplayMemoryProfile,
  type ComparisonBenchmark,
  type SuiteResult,
  type MemoryProfile,
} from './attention-benchmarks.js';

// Default export for convenience
export { default } from './framework/benchmark.js';
