/**
 * V3 Benchmark Suite Entry Point
 *
 * Comprehensive benchmark suite for validating V3 performance targets:
 * - Flash Attention: 2.49x-7.47x speedup
 * - AgentDB Search: 150x-12,500x improvement
 * - Memory Reduction: 50-75%
 * - Startup Time: <500ms
 * - SONA Learning: <0.05ms adaptation
 */

// Framework exports
export * from './framework/benchmark.js';

// Startup benchmarks
export { default as runColdStartBenchmarks } from './startup/cli-cold-start.bench.js';
export { default as runWarmStartBenchmarks } from './startup/cli-warm-start.bench.js';
export { default as runMCPInitBenchmarks } from './startup/mcp-server-init.bench.js';
export { default as runAgentSpawnBenchmarks } from './startup/agent-spawn.bench.js';

// Memory benchmarks
export { default as runVectorSearchBenchmarks } from './memory/vector-search.bench.js';
export { default as runHNSWIndexingBenchmarks } from './memory/hnsw-indexing.bench.js';
export { default as runMemoryWriteBenchmarks } from './memory/memory-write.bench.js';
export { default as runCacheHitRateBenchmarks } from './memory/cache-hit-rate.bench.js';

// Swarm benchmarks
export { default as runAgentCoordinationBenchmarks } from './swarm/agent-coordination.bench.js';
export { default as runTaskDecompositionBenchmarks } from './swarm/task-decomposition.bench.js';
export { default as runConsensusLatencyBenchmarks } from './swarm/consensus-latency.bench.js';
export { default as runMessageThroughputBenchmarks } from './swarm/message-throughput.bench.js';

// Attention benchmarks
export { default as runFlashAttentionBenchmarks } from './attention/flash-attention.bench.js';
export { default as runMultiHeadAttentionBenchmarks } from './attention/multi-head-attention.bench.js';
export { default as runMemoryEfficiencyBenchmarks } from './attention/memory-efficiency.bench.js';

// Regression detection
export { default as compareWithBaseline } from './regression/compare.js';
export { default as generateReport } from './regression/report.js';

// ============================================================================
// Benchmark Runner
// ============================================================================

interface BenchmarkSuiteConfig {
  categories?: string[];
  verbose?: boolean;
  outputFormat?: 'console' | 'json' | 'markdown' | 'html';
  outputPath?: string;
  compareBaseline?: boolean;
  baselinePath?: string;
}

/**
 * Run all benchmarks
 */
export async function runAllBenchmarks(config: BenchmarkSuiteConfig = {}): Promise<void> {
  const {
    categories = ['startup', 'memory', 'swarm', 'attention'],
    verbose = true,
  } = config;

  console.log('=' .repeat(80));
  console.log('V3 Performance Benchmark Suite');
  console.log('=' .repeat(80));
  console.log('');
  console.log('Target Performance Metrics:');
  console.log('  - CLI Startup:      <500ms (5x faster)');
  console.log('  - MCP Init:         <400ms (4.5x faster)');
  console.log('  - Agent Spawn:      <200ms (4x faster)');
  console.log('  - Vector Search:    <1ms (150x-12,500x faster)');
  console.log('  - Memory Write:     <5ms (10x faster)');
  console.log('  - Consensus:        <100ms (5x faster)');
  console.log('  - Flash Attention:  2.49x-7.47x speedup');
  console.log('  - Memory Usage:     <256MB (50% reduction)');
  console.log('');

  const startTime = performance.now();

  // Startup benchmarks
  if (categories.includes('startup')) {
    console.log('\n' + '='.repeat(60));
    console.log('STARTUP BENCHMARKS');
    console.log('='.repeat(60));

    const { default: runColdStart } = await import('./startup/cli-cold-start.bench.js');
    const { default: runWarmStart } = await import('./startup/cli-warm-start.bench.js');
    const { default: runMCPInit } = await import('./startup/mcp-server-init.bench.js');
    const { default: runAgentSpawn } = await import('./startup/agent-spawn.bench.js');

    await runColdStart();
    await runWarmStart();
    await runMCPInit();
    await runAgentSpawn();
  }

  // Memory benchmarks
  if (categories.includes('memory')) {
    console.log('\n' + '='.repeat(60));
    console.log('MEMORY BENCHMARKS');
    console.log('='.repeat(60));

    const { default: runVectorSearch } = await import('./memory/vector-search.bench.js');
    const { default: runHNSWIndexing } = await import('./memory/hnsw-indexing.bench.js');
    const { default: runMemoryWrite } = await import('./memory/memory-write.bench.js');
    const { default: runCacheHitRate } = await import('./memory/cache-hit-rate.bench.js');

    await runVectorSearch();
    await runHNSWIndexing();
    await runMemoryWrite();
    await runCacheHitRate();
  }

  // Swarm benchmarks
  if (categories.includes('swarm')) {
    console.log('\n' + '='.repeat(60));
    console.log('SWARM BENCHMARKS');
    console.log('='.repeat(60));

    const { default: runAgentCoordination } = await import('./swarm/agent-coordination.bench.js');
    const { default: runTaskDecomposition } = await import('./swarm/task-decomposition.bench.js');
    const { default: runConsensusLatency } = await import('./swarm/consensus-latency.bench.js');
    const { default: runMessageThroughput } = await import('./swarm/message-throughput.bench.js');

    await runAgentCoordination();
    await runTaskDecomposition();
    await runConsensusLatency();
    await runMessageThroughput();
  }

  // Attention benchmarks
  if (categories.includes('attention')) {
    console.log('\n' + '='.repeat(60));
    console.log('ATTENTION BENCHMARKS');
    console.log('='.repeat(60));

    const { default: runFlashAttention } = await import('./attention/flash-attention.bench.js');
    const { default: runMultiHeadAttention } = await import('./attention/multi-head-attention.bench.js');
    const { default: runMemoryEfficiency } = await import('./attention/memory-efficiency.bench.js');

    await runFlashAttention();
    await runMultiHeadAttention();
    await runMemoryEfficiency();
  }

  const totalTime = performance.now() - startTime;

  console.log('\n' + '='.repeat(80));
  console.log('BENCHMARK SUITE COMPLETE');
  console.log('='.repeat(80));
  console.log(`Total time: ${(totalTime / 1000).toFixed(2)}s`);
  console.log('');
}

/**
 * Run specific benchmark category
 */
export async function runCategory(category: string): Promise<void> {
  switch (category.toLowerCase()) {
    case 'startup':
      const { default: runColdStart } = await import('./startup/cli-cold-start.bench.js');
      const { default: runWarmStart } = await import('./startup/cli-warm-start.bench.js');
      const { default: runMCPInit } = await import('./startup/mcp-server-init.bench.js');
      const { default: runAgentSpawn } = await import('./startup/agent-spawn.bench.js');
      await runColdStart();
      await runWarmStart();
      await runMCPInit();
      await runAgentSpawn();
      break;

    case 'memory':
      const { default: runVectorSearch } = await import('./memory/vector-search.bench.js');
      const { default: runHNSWIndexing } = await import('./memory/hnsw-indexing.bench.js');
      const { default: runMemoryWrite } = await import('./memory/memory-write.bench.js');
      const { default: runCacheHitRate } = await import('./memory/cache-hit-rate.bench.js');
      await runVectorSearch();
      await runHNSWIndexing();
      await runMemoryWrite();
      await runCacheHitRate();
      break;

    case 'swarm':
      const { default: runAgentCoordination } = await import('./swarm/agent-coordination.bench.js');
      const { default: runTaskDecomposition } = await import('./swarm/task-decomposition.bench.js');
      const { default: runConsensusLatency } = await import('./swarm/consensus-latency.bench.js');
      const { default: runMessageThroughput } = await import('./swarm/message-throughput.bench.js');
      await runAgentCoordination();
      await runTaskDecomposition();
      await runConsensusLatency();
      await runMessageThroughput();
      break;

    case 'attention':
      const { default: runFlashAttention } = await import('./attention/flash-attention.bench.js');
      const { default: runMultiHeadAttention } = await import('./attention/multi-head-attention.bench.js');
      const { default: runMemoryEfficiency } = await import('./attention/memory-efficiency.bench.js');
      await runFlashAttention();
      await runMultiHeadAttention();
      await runMemoryEfficiency();
      break;

    default:
      console.error(`Unknown category: ${category}`);
      console.log('Available categories: startup, memory, swarm, attention');
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const category = args[0];

  if (category) {
    runCategory(category).catch(console.error);
  } else {
    runAllBenchmarks().catch(console.error);
  }
}

export default {
  runAllBenchmarks,
  runCategory,
};
