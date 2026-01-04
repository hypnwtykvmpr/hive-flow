/**
 * Flash Attention Benchmark
 *
 * Target: 2.49x-7.47x speedup over standard attention
 *
 * Measures Flash Attention performance improvements including
 * memory efficiency and computational speedup.
 */

import { benchmark, BenchmarkRunner, formatTime, formatBytes } from '../framework/benchmark.js';

// ============================================================================
// Attention Types
// ============================================================================

interface AttentionConfig {
  seqLength: number;
  headDim: number;
  numHeads: number;
  batchSize: number;
}

interface AttentionResult {
  output: Float32Array;
  attentionWeights?: Float32Array;
  memoryUsed: number;
  computeTime: number;
}

// ============================================================================
// Standard Attention Implementation
// ============================================================================

/**
 * Standard scaled dot-product attention
 * O(n^2) memory complexity for attention matrix
 */
class StandardAttention {
  private config: AttentionConfig;

  constructor(config: AttentionConfig) {
    this.config = config;
  }

  forward(
    query: Float32Array,
    key: Float32Array,
    value: Float32Array
  ): AttentionResult {
    const memBefore = process.memoryUsage().heapUsed;
    const startTime = performance.now();

    const { seqLength, headDim } = this.config;

    // Compute attention scores: Q @ K^T / sqrt(d_k)
    const scores = new Float32Array(seqLength * seqLength);
    const scale = 1 / Math.sqrt(headDim);

    for (let i = 0; i < seqLength; i++) {
      for (let j = 0; j < seqLength; j++) {
        let dot = 0;
        for (let k = 0; k < headDim; k++) {
          dot += query[i * headDim + k]! * key[j * headDim + k]!;
        }
        scores[i * seqLength + j] = dot * scale;
      }
    }

    // Softmax
    for (let i = 0; i < seqLength; i++) {
      let max = -Infinity;
      for (let j = 0; j < seqLength; j++) {
        max = Math.max(max, scores[i * seqLength + j]!);
      }

      let sum = 0;
      for (let j = 0; j < seqLength; j++) {
        const exp = Math.exp(scores[i * seqLength + j]! - max);
        scores[i * seqLength + j] = exp;
        sum += exp;
      }

      for (let j = 0; j < seqLength; j++) {
        scores[i * seqLength + j]! /= sum;
      }
    }

    // Attention output: scores @ V
    const output = new Float32Array(seqLength * headDim);

    for (let i = 0; i < seqLength; i++) {
      for (let j = 0; j < headDim; j++) {
        let sum = 0;
        for (let k = 0; k < seqLength; k++) {
          sum += scores[i * seqLength + k]! * value[k * headDim + j]!;
        }
        output[i * headDim + j] = sum;
      }
    }

    return {
      output,
      attentionWeights: scores,
      memoryUsed: process.memoryUsage().heapUsed - memBefore,
      computeTime: performance.now() - startTime,
    };
  }
}

/**
 * Flash Attention - memory efficient attention
 * Uses tiling to reduce memory from O(n^2) to O(n)
 */
class FlashAttention {
  private config: AttentionConfig;
  private blockSize: number;

  constructor(config: AttentionConfig, blockSize: number = 64) {
    this.config = config;
    this.blockSize = blockSize;
  }

  forward(
    query: Float32Array,
    key: Float32Array,
    value: Float32Array
  ): AttentionResult {
    const memBefore = process.memoryUsage().heapUsed;
    const startTime = performance.now();

    const { seqLength, headDim } = this.config;
    const blockSize = this.blockSize;
    const scale = 1 / Math.sqrt(headDim);

    // Output and running statistics
    const output = new Float32Array(seqLength * headDim);
    const rowMax = new Float32Array(seqLength).fill(-Infinity);
    const rowSum = new Float32Array(seqLength).fill(0);

    // Process in blocks (tiling)
    const numBlocks = Math.ceil(seqLength / blockSize);

    // Block buffers (reused, so O(blockSize^2) instead of O(n^2))
    const blockScores = new Float32Array(blockSize * blockSize);

    for (let bi = 0; bi < numBlocks; bi++) {
      const iStart = bi * blockSize;
      const iEnd = Math.min(iStart + blockSize, seqLength);
      const iSize = iEnd - iStart;

      for (let bj = 0; bj < numBlocks; bj++) {
        const jStart = bj * blockSize;
        const jEnd = Math.min(jStart + blockSize, seqLength);
        const jSize = jEnd - jStart;

        // Compute block scores
        for (let i = 0; i < iSize; i++) {
          for (let j = 0; j < jSize; j++) {
            let dot = 0;
            for (let k = 0; k < headDim; k++) {
              dot +=
                query[(iStart + i) * headDim + k]! *
                key[(jStart + j) * headDim + k]!;
            }
            blockScores[i * blockSize + j] = dot * scale;
          }
        }

        // Online softmax update
        for (let i = 0; i < iSize; i++) {
          const globalI = iStart + i;
          let localMax = rowMax[globalI]!;
          let localSum = rowSum[globalI]!;

          // Find new max
          for (let j = 0; j < jSize; j++) {
            localMax = Math.max(localMax, blockScores[i * blockSize + j]!);
          }

          // Rescale previous sum
          const oldMax = rowMax[globalI]!;
          if (oldMax !== -Infinity) {
            localSum *= Math.exp(oldMax - localMax);
          }

          // Add new exponentials
          for (let j = 0; j < jSize; j++) {
            const exp = Math.exp(blockScores[i * blockSize + j]! - localMax);
            blockScores[i * blockSize + j] = exp;
            localSum += exp;
          }

          // Update output with rescaling
          if (oldMax !== -Infinity && oldMax !== localMax) {
            const rescale = Math.exp(oldMax - localMax);
            for (let k = 0; k < headDim; k++) {
              output[globalI * headDim + k]! *= rescale;
            }
          }

          // Add contribution from current block
          for (let k = 0; k < headDim; k++) {
            let contrib = 0;
            for (let j = 0; j < jSize; j++) {
              contrib +=
                blockScores[i * blockSize + j]! *
                value[(jStart + j) * headDim + k]!;
            }
            output[globalI * headDim + k]! += contrib;
          }

          rowMax[globalI] = localMax;
          rowSum[globalI] = localSum;
        }
      }
    }

    // Final normalization
    for (let i = 0; i < seqLength; i++) {
      for (let k = 0; k < headDim; k++) {
        output[i * headDim + k]! /= rowSum[i]!;
      }
    }

    return {
      output,
      memoryUsed: process.memoryUsage().heapUsed - memBefore,
      computeTime: performance.now() - startTime,
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function generateRandomTensor(size: number): Float32Array {
  const tensor = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    tensor[i] = Math.random() * 2 - 1;
  }
  return tensor;
}

function createQKV(
  seqLength: number,
  headDim: number
): { query: Float32Array; key: Float32Array; value: Float32Array } {
  const size = seqLength * headDim;
  return {
    query: generateRandomTensor(size),
    key: generateRandomTensor(size),
    value: generateRandomTensor(size),
  };
}

// ============================================================================
// Benchmark Suite
// ============================================================================

export async function runFlashAttentionBenchmarks(): Promise<void> {
  const runner = new BenchmarkRunner('Flash Attention');

  console.log('\n--- Flash Attention Benchmarks ---\n');

  // Test configurations
  const configs: AttentionConfig[] = [
    { seqLength: 128, headDim: 64, numHeads: 8, batchSize: 1 },
    { seqLength: 256, headDim: 64, numHeads: 8, batchSize: 1 },
    { seqLength: 512, headDim: 64, numHeads: 8, batchSize: 1 },
    { seqLength: 1024, headDim: 64, numHeads: 8, batchSize: 1 },
  ];

  for (const config of configs) {
    const { seqLength, headDim } = config;
    console.log(`\n--- Sequence Length: ${seqLength} ---`);

    const standardAttn = new StandardAttention(config);
    const flashAttn = new FlashAttention(config, 64);

    const { query, key, value } = createQKV(seqLength, headDim);

    // Benchmark Standard Attention
    let standardResult: AttentionResult | null = null;

    const standardBenchResult = await runner.run(
      `standard-attention-seq${seqLength}`,
      async () => {
        standardResult = standardAttn.forward(query, key, value);
      },
      { iterations: seqLength <= 256 ? 100 : 20 }
    );

    console.log(`Standard Attention: ${formatTime(standardBenchResult.mean)}`);
    if (standardResult) {
      console.log(`  Memory: ${formatBytes(standardResult.memoryUsed)}`);
    }

    // Benchmark Flash Attention
    let flashResult: AttentionResult | null = null;

    const flashBenchResult = await runner.run(
      `flash-attention-seq${seqLength}`,
      async () => {
        flashResult = flashAttn.forward(query, key, value);
      },
      { iterations: seqLength <= 256 ? 200 : 50 }
    );

    console.log(`Flash Attention: ${formatTime(flashBenchResult.mean)}`);
    if (flashResult) {
      console.log(`  Memory: ${formatBytes(flashResult.memoryUsed)}`);
    }

    // Calculate speedup
    const speedup = standardBenchResult.mean / flashBenchResult.mean;
    console.log(`Speedup: ${speedup.toFixed(2)}x`);

    // Memory reduction
    if (standardResult && flashResult) {
      const memoryReduction =
        ((standardResult.memoryUsed - flashResult.memoryUsed) /
          standardResult.memoryUsed) *
        100;
      console.log(`Memory Reduction: ${memoryReduction.toFixed(1)}%`);
    }

    // Check if within target range
    const targetMin = 2.49;
    const targetMax = 7.47;
    console.log(
      `Target (${targetMin}x-${targetMax}x): ${
        speedup >= targetMin ? 'PASS' : 'BELOW'
      }${speedup > targetMax ? ' (EXCEEDED!)' : ''}`
    );
  }

  // Benchmark block size variations
  console.log('\n--- Block Size Comparison (seq=512) ---');

  const testConfig: AttentionConfig = {
    seqLength: 512,
    headDim: 64,
    numHeads: 8,
    batchSize: 1,
  };
  const { query, key, value } = createQKV(testConfig.seqLength, testConfig.headDim);

  const blockSizes = [32, 64, 128, 256];

  for (const blockSize of blockSizes) {
    const flashAttn = new FlashAttention(testConfig, blockSize);

    const result = await runner.run(
      `flash-attention-block${blockSize}`,
      async () => {
        flashAttn.forward(query, key, value);
      },
      { iterations: 50 }
    );

    console.log(`Block Size ${blockSize}: ${formatTime(result.mean)}`);
  }

  // Memory scaling test
  console.log('\n--- Memory Scaling Analysis ---');

  const memoryTestConfigs = [128, 256, 512, 1024];

  for (const seqLen of memoryTestConfigs) {
    const config: AttentionConfig = {
      seqLength: seqLen,
      headDim: 64,
      numHeads: 8,
      batchSize: 1,
    };

    const standard = new StandardAttention(config);
    const flash = new FlashAttention(config);
    const qkv = createQKV(seqLen, 64);

    // Force GC
    if (typeof global.gc === 'function') global.gc();
    const memBefore = process.memoryUsage().heapUsed;

    const stdResult = standard.forward(qkv.query, qkv.key, qkv.value);
    const stdMem = process.memoryUsage().heapUsed - memBefore;

    if (typeof global.gc === 'function') global.gc();
    const memBefore2 = process.memoryUsage().heapUsed;

    const flashRes = flash.forward(qkv.query, qkv.key, qkv.value);
    const flashMem = process.memoryUsage().heapUsed - memBefore2;

    console.log(
      `Seq ${seqLen}: Standard ${formatBytes(stdMem)} vs Flash ${formatBytes(flashMem)}`
    );
  }

  // Print summary
  console.log('\n--- Summary ---');
  const results = runner.getResults();

  const seq512Standard = results.find((r) => r.name === 'standard-attention-seq512');
  const seq512Flash = results.find((r) => r.name === 'flash-attention-seq512');

  if (seq512Standard && seq512Flash) {
    const speedup = seq512Standard.mean / seq512Flash.mean;
    console.log(`Primary Benchmark (seq=512):`);
    console.log(`  Standard: ${formatTime(seq512Standard.mean)}`);
    console.log(`  Flash: ${formatTime(seq512Flash.mean)}`);
    console.log(`  Speedup: ${speedup.toFixed(2)}x`);
    console.log(`  Target (2.49x-7.47x): ${speedup >= 2.49 ? 'ACHIEVED' : 'NOT MET'}`);
  }

  // Print full results
  runner.printResults();
}

// ============================================================================
// Flash Attention Optimization Strategies
// ============================================================================

export const flashAttentionOptimizations = {
  optimalBlockSize: {
    description: 'Choose block size based on hardware cache size',
    expectedImprovement: '10-30% depending on hardware',
  },
  simdVectorization: {
    description: 'Use SIMD instructions for dot products and softmax',
    expectedImprovement: '2-4x speedup',
  },
  fusedOperations: {
    description: 'Fuse softmax and matrix multiplication',
    expectedImprovement: '20-40% memory bandwidth',
  },
  multiQueryAttention: {
    description: 'Share K and V across attention heads',
    expectedImprovement: '2-4x memory, 1.5-2x speed',
  },
  gradientCheckpointing: {
    description: 'Recompute attention instead of storing for backprop',
    expectedImprovement: 'O(1) memory for attention during training',
  },
};

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runFlashAttentionBenchmarks().catch(console.error);
}

export default runFlashAttentionBenchmarks;
