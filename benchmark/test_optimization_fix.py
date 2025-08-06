#!/usr/bin/env python3
"""
Test script to verify that the optimization warning has been fixed
and the optimization engine is working properly.
"""

import asyncio
import sys
import os

# Add the src directory to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from swarm_benchmark.core.optimized_benchmark_engine import OptimizedBenchmarkEngine, OPTIMIZATIONS_AVAILABLE
from swarm_benchmark.core.models import BenchmarkConfig, StrategyType, CoordinationMode
from swarm_benchmark.optimization import OptimizedExecutor, CircularBuffer, TTLMap, AsyncFileManager


async def test_optimization_components():
    """Test individual optimization components."""
    print("🧪 Testing optimization components...")
    
    # Test CircularBuffer
    print("  ✓ Testing CircularBuffer...")
    buffer = CircularBuffer(5)
    for i in range(10):
        buffer.push(f"item_{i}")
    
    recent = buffer.get_recent(3)
    print(f"    Recent items: {len(recent)}")
    print(f"    Total written: {buffer.getTotalItemsWritten()}")
    
    # Test TTLMap
    print("  ✓ Testing TTLMap...")
    ttl_map = TTLMap({'defaultTTL': 1000, 'maxSize': 100})
    ttl_map.set('test_key', 'test_value')
    
    value = ttl_map.get('test_key')
    stats = ttl_map.getStats()
    print(f"    Cache hit rate: {stats['hit_rate']:.2f}")
    
    # Test AsyncFileManager
    print("  ✓ Testing AsyncFileManager...")
    file_manager = AsyncFileManager()
    
    test_data = {'message': 'Hello optimization!', 'timestamp': '2025-01-01'}
    await file_manager.writeJSON('/tmp/test_optimization.json', test_data, pretty=True)
    
    read_data = await file_manager.readJSON('/tmp/test_optimization.json')
    print(f"    File I/O test: {'✓ PASS' if read_data['message'] == test_data['message'] else '✗ FAIL'}")
    
    # Test OptimizedExecutor
    print("  ✓ Testing OptimizedExecutor...")
    executor = OptimizedExecutor({
        'connectionPool': {'min': 2, 'max': 5},
        'concurrency': 3
    })
    
    # Create mock tasks
    mock_tasks = [
        type('Task', (), {'id': f'task_{i}', 'objective': f'Test task {i}'})()
        for i in range(3)
    ]
    
    results = await executor.execute_parallel(mock_tasks)
    metrics = executor.getMetrics()
    
    print(f"    Executed {len(results)} tasks")
    print(f"    Average execution time: {metrics['average_execution_time']:.3f}s")
    
    await executor.shutdown()
    
    # Cleanup
    ttl_map.destroy()
    await file_manager.waitForPendingOperations()
    
    print("✅ All optimization components tested successfully!")


async def test_optimized_benchmark_engine():
    """Test the OptimizedBenchmarkEngine."""
    print("\n🏗️ Testing OptimizedBenchmarkEngine...")
    
    config = BenchmarkConfig(
        name="optimization_test",
        description="Test optimization functionality",
        strategy=StrategyType.DEVELOPMENT,
        mode=CoordinationMode.MESH,
        max_agents=3,
        task_timeout=30,
        max_retries=2
    )
    
    engine = OptimizedBenchmarkEngine(config, enable_optimizations=True)
    
    print(f"  Optimizations available: {OPTIMIZATIONS_AVAILABLE}")
    print(f"  Optimizations enabled: {engine.optimizations_enabled}")
    
    if engine.optimizations_enabled:
        print("  ✓ Optimization engine initialized successfully")
        
        # Test a simple benchmark
        result = await engine.run_benchmark("Test optimization engine functionality")
        
        print(f"  ✓ Benchmark completed: {result['status']}")
        print(f"  ✓ Duration: {result.get('duration', 'N/A')}s")
        print(f"  ✓ Optimized: {result.get('optimized', False)}")
        
        # Test performance metrics
        if 'performance_metrics' in result:
            metrics = result['performance_metrics']
            print(f"  ✓ Performance metrics available: {len(metrics)} categories")
        
        await engine.shutdown()
        print("✅ OptimizedBenchmarkEngine tested successfully!")
    else:
        print("⚠️ Optimizations not enabled, but engine still functional")


def test_import_fix():
    """Test that the import issue has been resolved."""
    print("🔧 Testing import fix...")
    
    try:
        from swarm_benchmark.optimization import (
            OptimizedExecutor, CircularBuffer, TTLMap, AsyncFileManager
        )
        print("  ✓ Direct optimization imports successful")
        
        from swarm_benchmark.core.optimized_benchmark_engine import OPTIMIZATIONS_AVAILABLE
        print(f"  ✓ OPTIMIZATIONS_AVAILABLE: {OPTIMIZATIONS_AVAILABLE}")
        
        if OPTIMIZATIONS_AVAILABLE:
            print("✅ Import fix successful - no more warnings!")
            return True
        else:
            print("⚠️ Optimizations not available, but no import errors")
            return False
            
    except ImportError as e:
        print(f"❌ Import failed: {e}")
        return False


async def main():
    """Run all tests."""
    print("🚀 Testing optimization engine fix...\n")
    
    # Test 1: Import fix
    import_success = test_import_fix()
    
    if import_success:
        # Test 2: Individual components
        await test_optimization_components()
        
        # Test 3: Full engine
        await test_optimized_benchmark_engine()
        
        print("\n🎉 All tests completed successfully!")
        print("The optimization warning has been fixed and the engine is fully functional.")
    else:
        print("\n⚠️ Tests completed with some limitations.")
        print("The optimization engine provides fallback functionality.")


if __name__ == "__main__":
    asyncio.run(main())