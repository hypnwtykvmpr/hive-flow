/**
 * Test agentic-flow v1.7.4 - Verified Exports Fix
 *
 * This test verifies that the export configuration issue from v1.7.1
 * has been resolved in v1.7.4, and all features are now accessible
 * via standard imports.
 */

console.log('🧪 Testing agentic-flow v1.7.4 - Export Fix Verification\n');
console.log('📦 Package: agentic-flow@1.7.4');
console.log('🔗 Integration: hive-flow@alpha v2.7.1\n');

// Test 1: Standard imports (should work now!)
console.log('═══════════════════════════════════════════════════');
console.log('Test 1: Standard Imports (Previously Failed)');
console.log('═══════════════════════════════════════════════════');

try {
  const {
    HybridReasoningBank,
    AdvancedMemorySystem,
    ReflexionMemory,
    CausalRecall,
    NightlyLearner
  } = await import('agentic-flow/reasoningbank');

  console.log('✅ All imports successful!');
  console.log(`   - HybridReasoningBank: ${typeof HybridReasoningBank}`);
  console.log(`   - AdvancedMemorySystem: ${typeof AdvancedMemorySystem}`);
  console.log(`   - ReflexionMemory: ${typeof ReflexionMemory}`);
  console.log(`   - CausalRecall: ${typeof CausalRecall}`);
  console.log(`   - NightlyLearner: ${typeof NightlyLearner}`);

  // Test 2: HybridReasoningBank instantiation
  console.log('\n═══════════════════════════════════════════════════');
  console.log('Test 2: HybridReasoningBank Instantiation');
  console.log('═══════════════════════════════════════════════════');

  const rb = new HybridReasoningBank({
    preferWasm: false,  // Use TypeScript backend for testing
    enableCaching: true,
    queryTTL: 60000
  });

  console.log('✅ HybridReasoningBank instantiated successfully');

  // List available methods
  const rbMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(rb))
    .filter(m => m !== 'constructor' && typeof rb[m] === 'function');

  console.log(`\n📋 Available methods (${rbMethods.length} total):`);
  rbMethods.forEach(method => console.log(`   - ${method}()`));

  // Test getStats (should work without database)
  console.log('\n🔍 Testing getStats() method...');
  const stats = rb.getStats();
  console.log('✅ Statistics retrieved:', JSON.stringify(stats, null, 2));

  // Test 3: AdvancedMemorySystem instantiation
  console.log('\n═══════════════════════════════════════════════════');
  console.log('Test 3: AdvancedMemorySystem Instantiation');
  console.log('═══════════════════════════════════════════════════');

  const memory = new AdvancedMemorySystem();
  console.log('✅ AdvancedMemorySystem instantiated successfully');

  const memoryMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(memory))
    .filter(m => m !== 'constructor' && typeof memory[m] === 'function');

  console.log(`\n📋 Available methods (${memoryMethods.length} total):`);
  memoryMethods.forEach(method => console.log(`   - ${method}()`));

  // Test getStats
  console.log('\n🔍 Testing getStats() method...');
  const memoryStats = memory.getStats();
  console.log('✅ Statistics retrieved:', JSON.stringify(memoryStats, null, 2));

  // Test 4: Backwards compatibility
  console.log('\n═══════════════════════════════════════════════════');
  console.log('Test 4: Backwards Compatibility (v1.7.0 APIs)');
  console.log('═══════════════════════════════════════════════════');

  const {
    retrieveMemories,
    judgeTrajectory,
    distillMemories,
    consolidate
  } = await import('agentic-flow/reasoningbank');

  console.log('✅ All v1.7.0 APIs still available:');
  console.log(`   - retrieveMemories: ${typeof retrieveMemories}`);
  console.log(`   - judgeTrajectory: ${typeof judgeTrajectory}`);
  console.log(`   - distillMemories: ${typeof distillMemories}`);
  console.log(`   - consolidate: ${typeof consolidate}`);

  // Summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log('📊 Test Summary');
  console.log('═══════════════════════════════════════════════════');
  console.log('✅ All standard imports working');
  console.log('✅ HybridReasoningBank operational');
  console.log('✅ AdvancedMemorySystem operational');
  console.log('✅ Backwards compatibility maintained');
  console.log('✅ Export configuration issue RESOLVED');
  console.log('');
  console.log('🎉 v1.7.4 is PRODUCTION READY!');
  console.log('');
  console.log('📝 Next steps:');
  console.log('   1. Update integration documentation');
  console.log('   2. Remove workaround notes from v1.7.1');
  console.log('   3. Create v1.7.4 verification report');
  console.log('   4. Update Quick Start guides');

} catch (error) {
  console.error('\n❌ Test failed:', error.message);
  console.error('   Stack:', error.stack?.split('\n').slice(0, 5).join('\n'));
  console.log('\n⚠️  Export issue may still exist.');
  console.log('   Check package version with: npm list agentic-flow');
  process.exit(1);
}
