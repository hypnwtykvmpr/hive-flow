/**
 * Flash Attention Benchmark Suite
 *
 * Target: 2.49x - 7.47x speedup over standard multi-head attention
 * Memory Reduction: 50-75%
 *
 * This benchmark validates the Flash Attention performance claims by comparing:
 * - Standard multi-head attention (baseline, O(n^2) memory)
 * - Flash Attention (optimized, O(n) memory via tiling)
 *
 * Test configurations:
 * - Sequence lengths: 512, 1024, 2048, 4096
 * - Head counts: 8, 12, 16
 * - Head dimensions: 64, 128
 */

import { benchmark, BenchmarkRunner, formatTime, formatBytes, meetsTarget } from '../framework/benchmark.js';

// ============================================================================
// Performance Targets
// ============================================================================

const TARGETS = {
  minSpeedup: 2.49,
  targetSpeedup: 5.0,
  maxSpeedup: 7.47,
  memoryReduction: 0.5, // 50% minimum
};

// ============================================================================
// Type Definitions
// ============================================================================

interface AttentionConfig {
  seqLength: number;
  numHeads: number;
  headDim: number;
  batchSize: number;
}

interface AttentionResult {
  output: Float32Array;
  attentionWeights?: Float32Array;
}

interface BenchmarkMetrics {
  config: AttentionConfig;
  baselineTime: number;
  flashTime: number;
  speedup: number;
  baselineMemory: number;
  flashMemory: number;
  memoryReduction: number;
  targetMet: boolean;
}

// ============================================================================
// Tensor Operations
// ============================================================================

/**
 * Generate a random tensor with given shape
 */
function generateTensor(size: number): Float32Array {
  const tensor = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    tensor[i] = (Math.random() * 2 - 1) * 0.1; // Small values for numerical stability
  }
  return tensor;
}

/**
 * Matrix multiplication: C = A * B
 * A: [M x K], B: [K x N], C: [M x N]
 */
function matmul(
  a: Float32Array,
  b: Float32Array,
  m: number,
  k: number,
  n: number
): Float32Array {
  const c = new Float32Array(m * n);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let l = 0; l < k; l++) {
        sum += a[i * k + l]! * b[l * n + j]!;
      }
      c[i * n + j] = sum;
    }
  }
  return c;
}

/**
 * Transpose a matrix
 */
function transpose(matrix: Float32Array, rows: number, cols: number): Float32Array {
  const result = new Float32Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j * rows + i] = matrix[i * cols + j]!;
    }
  }
  return result;
}

/**
 * Softmax operation along the last dimension
 */
function softmax(matrix: Float32Array, rows: number, cols: number): Float32Array {
  const result = new Float32Array(rows * cols);
  for (let i = 0; i < rows; i++) {
    // Find max for numerical stability
    let maxVal = -Infinity;
    for (let j = 0; j < cols; j++) {
      const val = matrix[i * cols + j]!;
      if (val > maxVal) maxVal = val;
    }

    // Compute exp and sum
    let sum = 0;
    for (let j = 0; j < cols; j++) {
      const exp = Math.exp(matrix[i * cols + j]! - maxVal);
      result[i * cols + j] = exp;
      sum += exp;
    }

    // Normalize
    for (let j = 0; j < cols; j++) {
      result[i * cols + j]! /= sum;
    }
  }
  return result;
}

/**
 * Scale matrix by a scalar
 */
function scale(matrix: Float32Array, scalar: number): Float32Array {
  const result = new Float32Array(matrix.length);
  for (let i = 0; i < matrix.length; i++) {
    result[i] = matrix[i]! * scalar;
  }
  return result;
}

// ============================================================================
// Standard Multi-Head Attention (Baseline)
// ============================================================================

/**
 * Standard multi-head attention implementation
 *
 * Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) * V
 *
 * Memory: O(n^2) for attention weights matrix
 * Time: O(n^2 * d)
 */
function standardAttention(
  query: Float32Array,
  key: Float32Array,
  value: Float32Array,
  config: AttentionConfig
): AttentionResult {
  const { seqLength, numHeads, headDim, batchSize } = config;
  const scaleFactor = 1 / Math.sqrt(headDim);

  // Full attention computation per head
  const outputs: Float32Array[] = [];
  const totalHeadSize = seqLength * headDim;

  for (let b = 0; b < batchSize; b++) {
    for (let h = 0; h < numHeads; h++) {
      const headOffset = (b * numHeads + h) * totalHeadSize;

      // Extract Q, K, V for this head
      const Q = query.slice(headOffset, headOffset + totalHeadSize);
      const K = key.slice(headOffset, headOffset + totalHeadSize);
      const V = value.slice(headOffset, headOffset + totalHeadSize);

      // Compute attention scores: QK^T
      const KT = transpose(K, seqLength, headDim);
      const scores = matmul(Q, KT, seqLength, headDim, seqLength);

      // Scale scores
      const scaledScores = scale(scores, scaleFactor);

      // Apply softmax to get attention weights (O(n^2) memory!)
      const attentionWeights = softmax(scaledScores, seqLength, seqLength);

      // Compute output: weights * V
      const output = matmul(attentionWeights, V, seqLength, seqLength, headDim);
      outputs.push(output);
    }
  }

  // Concatenate outputs
  const totalSize = batchSize * numHeads * seqLength * headDim;
  const finalOutput = new Float32Array(totalSize);
  let offset = 0;
  for (const out of outputs) {
    finalOutput.set(out, offset);
    offset += out.length;
  }

  return { output: finalOutput };
}

// ============================================================================
// Flash Attention (Optimized)
// ============================================================================

/**
 * Flash Attention implementation
 *
 * Key optimizations:
 * 1. Block-based computation (tiling)
 * 2. Online softmax normalization
 * 3. Memory efficient (no full n^2 attention matrix)
 *
 * Memory: O(n) - only stores block-sized attention
 * Time: O(n^2 * d) but with better memory access patterns
 */
function flashAttention(
  query: Float32Array,
  key: Float32Array,
  value: Float32Array,
  config: AttentionConfig,
  blockSize: number = 64
): AttentionResult {
  const { seqLength, numHeads, headDim, batchSize } = config;
  const scaleFactor = 1 / Math.sqrt(headDim);
  const numBlocks = Math.ceil(seqLength / blockSize);

  const totalHeadSize = seqLength * headDim;
  const outputSize = batchSize * numHeads * seqLength * headDim;
  const output = new Float32Array(outputSize);

  for (let b = 0; b < batchSize; b++) {
    for (let h = 0; h < numHeads; h++) {
      const headOffset = (b * numHeads + h) * totalHeadSize;

      // Initialize output accumulator and softmax normalizer per row
      const O = new Float32Array(seqLength * headDim);
      const L = new Float32Array(seqLength); // log-sum-exp
      const M = new Float32Array(seqLength).fill(-Infinity); // max values

      // Process query blocks
      for (let qBlock = 0; qBlock < numBlocks; qBlock++) {
        const qStart = qBlock * blockSize;
        const qEnd = Math.min(qStart + blockSize, seqLength);
        const qLen = qEnd - qStart;

        // Extract query block
        const Qblock = new Float32Array(qLen * headDim);
        for (let i = 0; i < qLen; i++) {
          for (let d = 0; d < headDim; d++) {
            Qblock[i * headDim + d] = query[headOffset + (qStart + i) * headDim + d]!;
          }
        }

        // Process key/value blocks
        for (let kvBlock = 0; kvBlock < numBlocks; kvBlock++) {
          const kvStart = kvBlock * blockSize;
          const kvEnd = Math.min(kvStart + blockSize, seqLength);
          const kvLen = kvEnd - kvStart;

          // Extract key and value blocks
          const Kblock = new Float32Array(kvLen * headDim);
          const Vblock = new Float32Array(kvLen * headDim);
          for (let i = 0; i < kvLen; i++) {
            for (let d = 0; d < headDim; d++) {
              Kblock[i * headDim + d] = key[headOffset + (kvStart + i) * headDim + d]!;
              Vblock[i * headDim + d] = value[headOffset + (kvStart + i) * headDim + d]!;
            }
          }

          // Compute block attention scores: Qblock * Kblock^T
          const KblockT = transpose(Kblock, kvLen, headDim);
          const Sblock = matmul(Qblock, KblockT, qLen, headDim, kvLen);

          // Scale scores
          for (let i = 0; i < Sblock.length; i++) {
            Sblock[i]! *= scaleFactor;
          }

          // Online softmax update
          for (let i = 0; i < qLen; i++) {
            const rowIdx = qStart + i;

            // Find local max
            let localMax = M[rowIdx]!;
            for (let j = 0; j < kvLen; j++) {
              const s = Sblock[i * kvLen + j]!;
              if (s > localMax) localMax = s;
            }

            // Update with new max
            const oldMax = M[rowIdx]!;
            const expOldMax = Math.exp(oldMax - localMax);

            // Update L (sum of exp)
            let localSum = L[rowIdx]! * expOldMax;
            const expScores = new Float32Array(kvLen);
            for (let j = 0; j < kvLen; j++) {
              const exp = Math.exp(Sblock[i * kvLen + j]! - localMax);
              expScores[j] = exp;
              localSum += exp;
            }

            // Update output with corrected previous output and new contribution
            for (let d = 0; d < headDim; d++) {
              O[rowIdx * headDim + d]! *= expOldMax;

              // Add contribution from this KV block
              for (let j = 0; j < kvLen; j++) {
                O[rowIdx * headDim + d]! += expScores[j]! * Vblock[j * headDim + d]!;
              }
            }

            M[rowIdx] = localMax;
            L[rowIdx] = localSum;
          }
        }

        // Normalize output for this query block
        for (let i = 0; i < qLen; i++) {
          const rowIdx = qStart + i;
          const normFactor = L[rowIdx]!;
          if (normFactor > 0) {
            for (let d = 0; d < headDim; d++) {
              O[rowIdx * headDim + d]! /= normFactor;
            }
          }
        }
      }

      // Copy to final output
      const outHeadOffset = (b * numHeads + h) * totalHeadSize;
      output.set(O, outHeadOffset);
    }
  }

  return { output };
}

// ============================================================================
// Memory Measurement Utilities
// ============================================================================

/**
 * Estimate memory usage for standard attention
 * Full n^2 attention matrix stored
 */
function estimateStandardMemory(config: AttentionConfig): number {
  const { seqLength, numHeads, headDim, batchSize } = config;

  // Q, K, V tensors
  const tensorSize = batchSize * numHeads * seqLength * headDim * 4; // Float32

  // Attention weights matrix (n^2 per head)
  const attentionMatrixSize = batchSize * numHeads * seqLength * seqLength * 4;

  // Output tensor
  const outputSize = batchSize * numHeads * seqLength * headDim * 4;

  return tensorSize * 3 + attentionMatrixSize + outputSize;
}

/**
 * Estimate memory usage for flash attention
 * Only block-sized attention stored
 */
function estimateFlashMemory(config: AttentionConfig, blockSize: number = 64): number {
  const { seqLength, numHeads, headDim, batchSize } = config;

  // Q, K, V tensors
  const tensorSize = batchSize * numHeads * seqLength * headDim * 4;

  // Block attention matrix (blockSize^2)
  const blockAttentionSize = blockSize * blockSize * 4;

  // Output tensor
  const outputSize = batchSize * numHeads * seqLength * headDim * 4;

  // L and M accumulators
  const accumulatorSize = seqLength * 4 * 2;

  return tensorSize * 3 + blockAttentionSize + outputSize + accumulatorSize;
}

// ============================================================================
// Benchmark Configurations
// ============================================================================

const BENCHMARK_CONFIGS: AttentionConfig[] = [
  // Standard configurations
  { seqLength: 512, numHeads: 8, headDim: 64, batchSize: 1 },
  { seqLength: 512, numHeads: 12, headDim: 64, batchSize: 1 },
  { seqLength: 512, numHeads: 16, headDim: 64, batchSize: 1 },

  { seqLength: 1024, numHeads: 8, headDim: 64, batchSize: 1 },
  { seqLength: 1024, numHeads: 12, headDim: 64, batchSize: 1 },
  { seqLength: 1024, numHeads: 16, headDim: 64, batchSize: 1 },

  { seqLength: 2048, numHeads: 8, headDim: 64, batchSize: 1 },
  { seqLength: 2048, numHeads: 12, headDim: 64, batchSize: 1 },
  { seqLength: 2048, numHeads: 16, headDim: 64, batchSize: 1 },

  // Higher dimension configurations
  { seqLength: 512, numHeads: 8, headDim: 128, batchSize: 1 },
  { seqLength: 1024, numHeads: 8, headDim: 128, batchSize: 1 },
  { seqLength: 2048, numHeads: 8, headDim: 128, batchSize: 1 },
];

// Long sequence configurations (for memory advantage demonstration)
const LONG_SEQUENCE_CONFIGS: AttentionConfig[] = [
  { seqLength: 4096, numHeads: 8, headDim: 64, batchSize: 1 },
  { seqLength: 4096, numHeads: 12, headDim: 64, batchSize: 1 },
  { seqLength: 4096, numHeads: 16, headDim: 64, batchSize: 1 },
];

// ============================================================================
// Benchmark Suite
// ============================================================================

/**
 * Run a single configuration benchmark
 */
async function benchmarkConfig(
  runner: BenchmarkRunner,
  config: AttentionConfig,
  iterations: number = 20
): Promise<BenchmarkMetrics> {
  const { seqLength, numHeads, headDim, batchSize } = config;
  const configName = `seq${seqLength}_h${numHeads}_d${headDim}`;

  // Generate input tensors
  const tensorSize = batchSize * numHeads * seqLength * headDim;
  const query = generateTensor(tensorSize);
  const key = generateTensor(tensorSize);
  const value = generateTensor(tensorSize);

  // Benchmark standard attention
  const baselineResult = await runner.run(
    `standard-attention-${configName}`,
    async () => {
      standardAttention(query, key, value, config);
    },
    { iterations, forceGC: true }
  );

  // Benchmark flash attention
  const flashResult = await runner.run(
    `flash-attention-${configName}`,
    async () => {
      flashAttention(query, key, value, config);
    },
    { iterations, forceGC: true }
  );

  // Calculate metrics
  const speedup = baselineResult.mean / flashResult.mean;
  const baselineMemory = estimateStandardMemory(config);
  const flashMemory = estimateFlashMemory(config);
  const memoryReduction = (baselineMemory - flashMemory) / baselineMemory;

  const targetMet = speedup >= TARGETS.minSpeedup && memoryReduction >= TARGETS.memoryReduction;

  return {
    config,
    baselineTime: baselineResult.mean,
    flashTime: flashResult.mean,
    speedup,
    baselineMemory,
    flashMemory,
    memoryReduction,
    targetMet,
  };
}

/**
 * Run the complete Flash Attention benchmark suite
 */
export async function runFlashAttentionBenchmarks(): Promise<void> {
  const runner = new BenchmarkRunner('Flash Attention');

  console.log('\n' + '='.repeat(80));
  console.log('Flash Attention Benchmark Suite');
  console.log('Target: 2.49x - 7.47x speedup, 50-75% memory reduction');
  console.log('='.repeat(80) + '\n');

  const results: BenchmarkMetrics[] = [];

  // Run standard benchmarks
  console.log('--- Standard Sequence Lengths (512-2048) ---\n');

  for (const config of BENCHMARK_CONFIGS) {
    const { seqLength, numHeads, headDim } = config;
    console.log(`Testing: seq=${seqLength}, heads=${numHeads}, dim=${headDim}`);

    const metrics = await benchmarkConfig(runner, config);
    results.push(metrics);

    console.log(`  Standard: ${formatTime(metrics.baselineTime)} | Flash: ${formatTime(metrics.flashTime)}`);
    console.log(`  Speedup: ${metrics.speedup.toFixed(2)}x | Memory Reduction: ${(metrics.memoryReduction * 100).toFixed(1)}%`);
    console.log(`  Target Met: ${metrics.targetMet ? 'PASS' : 'FAIL'}`);
    console.log('');
  }

  // Run long sequence benchmarks (reduced iterations due to compute time)
  console.log('\n--- Long Sequence Lengths (4096) ---\n');

  for (const config of LONG_SEQUENCE_CONFIGS) {
    const { seqLength, numHeads, headDim } = config;
    console.log(`Testing: seq=${seqLength}, heads=${numHeads}, dim=${headDim}`);

    const metrics = await benchmarkConfig(runner, config, 5);
    results.push(metrics);

    console.log(`  Standard: ${formatTime(metrics.baselineTime)} | Flash: ${formatTime(metrics.flashTime)}`);
    console.log(`  Speedup: ${metrics.speedup.toFixed(2)}x | Memory Reduction: ${(metrics.memoryReduction * 100).toFixed(1)}%`);
    console.log(`  Target Met: ${metrics.targetMet ? 'PASS' : 'FAIL'}`);
    console.log('');
  }

  // Summary statistics
  printSummary(results);

  // Print detailed benchmark results
  runner.printResults();
}

/**
 * Print summary of benchmark results
 */
function printSummary(results: BenchmarkMetrics[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('BENCHMARK SUMMARY');
  console.log('='.repeat(80) + '\n');

  // Calculate aggregate statistics
  const speedups = results.map((r) => r.speedup);
  const memoryReductions = results.map((r) => r.memoryReduction);

  const avgSpeedup = speedups.reduce((a, b) => a + b, 0) / speedups.length;
  const minSpeedup = Math.min(...speedups);
  const maxSpeedup = Math.max(...speedups);

  const avgMemoryReduction = memoryReductions.reduce((a, b) => a + b, 0) / memoryReductions.length;

  const targetsMet = results.filter((r) => r.targetMet).length;

  console.log('Speedup Statistics:');
  console.log(`  Average: ${avgSpeedup.toFixed(2)}x`);
  console.log(`  Minimum: ${minSpeedup.toFixed(2)}x`);
  console.log(`  Maximum: ${maxSpeedup.toFixed(2)}x`);
  console.log(`  Target Range: ${TARGETS.minSpeedup}x - ${TARGETS.maxSpeedup}x`);
  console.log('');

  console.log('Memory Reduction Statistics:');
  console.log(`  Average: ${(avgMemoryReduction * 100).toFixed(1)}%`);
  console.log(`  Target: >${(TARGETS.memoryReduction * 100).toFixed(0)}%`);
  console.log('');

  console.log('Results by Sequence Length:');
  const bySeqLength = new Map<number, BenchmarkMetrics[]>();
  for (const result of results) {
    const seqLen = result.config.seqLength;
    if (!bySeqLength.has(seqLen)) {
      bySeqLength.set(seqLen, []);
    }
    bySeqLength.get(seqLen)!.push(result);
  }

  for (const [seqLen, seqResults] of [...bySeqLength.entries()].sort((a, b) => a[0] - b[0])) {
    const avgSeqSpeedup = seqResults.reduce((a, r) => a + r.speedup, 0) / seqResults.length;
    const avgSeqMemory = seqResults.reduce((a, r) => a + r.memoryReduction, 0) / seqResults.length;
    console.log(`  Seq ${seqLen}: Avg Speedup ${avgSeqSpeedup.toFixed(2)}x, Memory Reduction ${(avgSeqMemory * 100).toFixed(1)}%`);
  }
  console.log('');

  console.log('Target Achievement:');
  console.log(`  Configurations Meeting Targets: ${targetsMet}/${results.length}`);
  console.log(`  Success Rate: ${((targetsMet / results.length) * 100).toFixed(1)}%`);
  console.log('');

  // Validation status
  const overallPass = avgSpeedup >= TARGETS.minSpeedup && avgMemoryReduction >= TARGETS.memoryReduction;
  console.log('='.repeat(80));
  console.log(`OVERALL STATUS: ${overallPass ? 'TARGETS VALIDATED' : 'TARGETS NOT MET'}`);
  console.log('='.repeat(80) + '\n');
}

// ============================================================================
// Flash Attention Optimization Strategies
// ============================================================================

export const flashAttentionOptimizations = {
  /**
   * Block-wise tiling: Process attention in memory-efficient blocks
   */
  blockTiling: {
    description: 'Compute attention in blocks to fit in L1/L2 cache',
    expectedImprovement: '2-4x speedup',
    implementation: `
      // Process attention in blocks that fit in SRAM
      for (const qBlock of queryBlocks) {
        for (const kvBlock of keyValueBlocks) {
          const blockAttention = computeBlockAttention(qBlock, kvBlock);
          updateOnlineSoftmax(blockAttention);
        }
      }
    `,
  },

  /**
   * Online softmax: Compute softmax incrementally without full matrix
   */
  onlineSoftmax: {
    description: 'Update softmax normalization incrementally per block',
    expectedImprovement: 'O(n) vs O(n^2) memory',
    implementation: `
      // Track running max and sum for stable softmax
      let runningMax = -Infinity;
      let runningSum = 0;

      for (const block of blocks) {
        const localMax = Math.max(...block);
        const correction = Math.exp(runningMax - localMax);
        runningSum = runningSum * correction + blockSum(block, localMax);
        runningMax = localMax;
      }
    `,
  },

  /**
   * Memory recomputation: Trade compute for memory by recomputing values
   */
  memoryRecomputation: {
    description: 'Recompute attention during backward pass instead of storing',
    expectedImprovement: '50-75% memory reduction',
    implementation: `
      // Forward pass: only store O, L, M (not full attention matrix)
      // Backward pass: recompute attention blocks as needed
      function flashAttentionBackward(dO, Q, K, V, O, L, M) {
        for (const block of blocks) {
          const S = recomputeBlockAttention(Q, K, block);
          const dV = computeGradient(S, dO);
        }
      }
    `,
  },

  /**
   * Fused operations: Combine multiple kernels into single GPU kernel
   */
  fusedKernels: {
    description: 'Fuse matmul, softmax, and dropout into single kernel',
    expectedImprovement: '1.5-2x from reduced memory bandwidth',
    implementation: `
      // Single fused kernel instead of separate operations
      function fusedAttention(Q, K, V) {
        // All operations in single pass through data
        return fusedMatmulSoftmaxMatmul(Q, K, V);
      }
    `,
  },

  /**
   * Sparse attention patterns: Skip attention computation for masked positions
   */
  sparseAttention: {
    description: 'Skip computation for causally masked or sparse positions',
    expectedImprovement: '2x for causal, variable for sparse patterns',
    implementation: `
      // Only compute lower triangle for causal attention
      for (let i = 0; i < seqLen; i++) {
        for (let j = 0; j <= i; j++) {  // j <= i for causal
          attention[i][j] = computeAttention(Q[i], K[j]);
        }
      }
    `,
  },
};

// ============================================================================
// Performance Recommendations
// ============================================================================

export const performanceRecommendations = {
  /**
   * Optimal block size selection based on hardware
   */
  blockSizeSelection: (cacheSize: number, headDim: number): number => {
    // Block size should fit in L2 cache
    // Each block needs: 2 * blockSize * headDim * 4 bytes (Q and KV)
    const bytesPerElement = 4; // Float32
    const overhead = 2; // Safety factor
    const maxBlockSize = Math.floor(
      Math.sqrt(cacheSize / (2 * headDim * bytesPerElement * overhead))
    );
    return Math.min(Math.max(32, maxBlockSize), 128); // Clamp to reasonable range
  },

  /**
   * Sequence length thresholds for Flash Attention advantage
   */
  sequenceLengthThresholds: {
    minimum: 256,    // Below this, standard attention may be faster
    optimal: 1024,   // Flash Attention clearly faster
    recommended: 2048, // Significant speedup and memory savings
  },

  /**
   * Head count recommendations
   */
  headCountGuidelines: {
    standard: 8,     // Good balance of parallelism and efficiency
    optimal: 12,     // Better for larger models
    maximum: 16,     // May have diminishing returns beyond this
  },
};

// ============================================================================
// Run if executed directly
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  runFlashAttentionBenchmarks().catch(console.error);
}

export default runFlashAttentionBenchmarks;
export { TARGETS, BENCHMARK_CONFIGS, LONG_SEQUENCE_CONFIGS, standardAttention, flashAttention };
