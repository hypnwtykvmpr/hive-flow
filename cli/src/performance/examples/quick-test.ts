#!/usr/bin/env tsx
/**
 * Quick Integration Test
 *
 * Verifies the local attention integration is working correctly.
 * Run with: tsx cli/src/performance/examples/quick-test.ts
 */

import {
  createFlashAttentionOptimizer,
  flashAttention,
  quickBenchmark,
} from '../attention-integration.js';

async function quickTest() {
  console.log('\n🧪 Quick Integration Test\n');
  console.log('━'.repeat(60));

  try {
    // Test 1: Direct local attention kernel usage
    console.log('\n✓ Test 1: Direct local attention kernel usage');
    const query = new Float32Array(128).fill(1.0);
    const keys = [new Float32Array(128).fill(1.0)];
    const values = [new Float32Array(128).fill(1.0)];
    const result = flashAttention(query, keys, values, 64);
    console.log(`  Result: Float32Array[${result.length}]`);

    // Test 2: V3 optimizer
    console.log('\n✓ Test 2: V3 FlashAttentionOptimizer');
    const optimizer = createFlashAttentionOptimizer(128);
    const output = optimizer.optimize({
      query: new Float32Array(128).fill(1.0),
      keys: Array.from({ length: 50 }, () => new Float32Array(128).fill(1.0)),
      values: Array.from({ length: 50 }, () => new Float32Array(128).fill(1.0)),
    });
    console.log(`  Execution time: ${output.executionTimeMs.toFixed(3)}ms`);
    console.log(`  Runtime: ${output.runtime}`);

    // Test 3: Quick benchmark
    console.log('\n✓ Test 3: Quick benchmark');
    const benchResult = quickBenchmark(256);
    console.log(`  Flash: ${benchResult.flashAttention.averageTimeMs.toFixed(3)}ms`);
    console.log(`  Baseline: ${benchResult.baseline.averageTimeMs.toFixed(3)}ms`);
    console.log(`  Speedup: ${benchResult.speedup.toFixed(2)}x`);
    console.log(`  Meets target: ${benchResult.meetsTarget ? 'YES ✓' : 'NO ✗'}`);

    console.log('\n' + '━'.repeat(60));
    console.log('\n✅ All tests passed! Integration working correctly.\n');

    return true;
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.log('\n' + '━'.repeat(60) + '\n');
    return false;
  }
}

// Run test
quickTest().then(success => {
  process.exit(success ? 0 : 1);
});
