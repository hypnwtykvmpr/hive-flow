---
name: performance-analysis
description: >
  Performance profiling, benchmarking, and optimization analysis. Identifies bottlenecks, measures latency, and provides optimization recommendations.
  Use when: performance issues, slow responses, memory usage concerns, optimization needed, benchmarking required.
  Skip when: feature development, bug fixes unrelated to performance, documentation tasks.
---

# Performance Analysis Skill

## Purpose
Performance profiling, benchmarking, and optimization analysis for claude-flow applications.

## When to Trigger
- Performance issues reported
- Slow API responses (>100ms for MCP)
- High memory usage
- Before/after optimization comparison
- Benchmarking new features

## Commands

### Run Benchmark Suite
```bash
npx claude-flow performance benchmark --suite all
```

### Profile Memory Usage
```bash
npx claude-flow memory usage --detail by-agent
```

### Detect Bottlenecks
```bash
npx claude-flow performance profile --depth full
```

### Generate Report
```bash
npx claude-flow performance report --format markdown
```

### Optimize Configuration
```bash
npx claude-flow performance optimize --target memory
```

## Performance Targets

| Metric | Target | How to Measure |
|--------|--------|----------------|
| HNSW Search | 150x-12,500x faster | `memory search --benchmark` |
| MCP Response | <100ms | `mcp test --latency` |
| CLI Startup | <500ms | `time npx claude-flow --version` |
| Memory Reduction | 50-75% | `memory usage --quantization int8` |

## Best Practices
1. Always establish baseline before optimization
2. Profile in production-like environment
3. Focus on critical path bottlenecks
4. Measure impact of each change independently
