# Optimization Swarm Strategy

## Purpose
Performance optimization through specialized analysis.

## Activation

### Using MCP Tools
```javascript
// Initialize optimization swarm
mcp__hive-flow__swarm_init({
  "topology": "mesh",
  "maxAgents": 6,
  "strategy": "adaptive"
})

// Orchestrate optimization task
mcp__hive-flow__task_orchestrate({
  "task": "optimize performance",
  "strategy": "parallel",
  "priority": "high"
})
```

### Using CLI (Fallback)
`hive-flow swarm "optimize performance" --strategy optimization`

## Agent Roles

### Agent Spawning with MCP
```javascript
// Spawn optimization agents
mcp__hive-flow__agent_spawn({
  "type": "optimizer",
  "name": "Performance Profiler",
  "capabilities": ["profiling", "bottleneck-detection"]
})

mcp__hive-flow__agent_spawn({
  "type": "analyst",
  "name": "Memory Analyzer",
  "capabilities": ["memory-analysis", "leak-detection"]
})

mcp__hive-flow__agent_spawn({
  "type": "optimizer",
  "name": "Code Optimizer",
  "capabilities": ["code-optimization", "refactoring"]
})

mcp__hive-flow__agent_spawn({
  "type": "tester",
  "name": "Benchmark Runner",
  "capabilities": ["benchmarking", "performance-testing"]
})
```

## Optimization Areas

### Performance Analysis
```javascript
// Analyze bottlenecks
mcp__hive-flow__bottleneck_analyze({
  "component": "all",
  "metrics": ["cpu", "memory", "io", "network"]
})

// Run benchmarks
mcp__hive-flow__benchmark_run({
  "suite": "performance"
})

// WASM optimization
mcp__hive-flow__wasm_optimize({
  "operation": "simd-acceleration"
})
```

### Optimization Operations
```javascript
// Optimize topology
mcp__hive-flow__topology_optimize({
  "swarmId": "optimization-swarm"
})

// DAA optimization
mcp__hive-flow__daa_optimization({
  "target": "performance",
  "metrics": ["speed", "memory", "efficiency"]
})

// Load balancing
mcp__hive-flow__load_balance({
  "swarmId": "optimization-swarm",
  "tasks": optimizationTasks
})
```

### Monitoring and Reporting
```javascript
// Performance report
mcp__hive-flow__performance_report({
  "format": "detailed",
  "timeframe": "7d"
})

// Trend analysis
mcp__hive-flow__trend_analysis({
  "metric": "performance",
  "period": "30d"
})

// Cost analysis
mcp__hive-flow__cost_analysis({
  "timeframe": "30d"
})
```
