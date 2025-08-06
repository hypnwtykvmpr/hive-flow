"""
Advanced Metrics Collection Module

This module provides comprehensive performance metrics collection and optimization
for Claude Flow swarm benchmarking systems.

Features:
- Token usage optimization tracking
- Memory persistence profiling
- Neural processing benchmarks
- Real-time metric aggregation
- Performance analysis and optimization suggestions
"""

from .token_optimizer import TokenOptimizationTracker
from .memory_profiler import MemoryPersistenceProfiler
from .neural_benchmarks import NeuralProcessingBenchmark
from .metric_aggregator import MetricAggregator
from .performance_analyzer import PerformanceAnalyzer

__all__ = [
    'TokenOptimizationTracker',
    'MemoryPersistenceProfiler', 
    'NeuralProcessingBenchmark',
    'MetricAggregator',
    'PerformanceAnalyzer'
]

__version__ = '1.0.0'