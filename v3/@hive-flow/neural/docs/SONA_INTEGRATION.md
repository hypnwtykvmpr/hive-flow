# SONA Integration Guide

Local SONA-compatible learning integration for the V3 Neural Module.

## Overview

The SONA (Self-Optimizing Neural Architecture) integration provides runtime-adaptive learning capabilities with sub-millisecond performance:

- **Learning Performance**: low-latency per trajectory (target)
- **Adaptation Performance**: <0.1ms per context
- **Memory Efficient**: LoRA-based (1-16 rank)
- **Platform Support**: Pure TypeScript local runtime

## Quick Start

```typescript
import {
  createSONALearningEngine,
  type Trajectory,
  type Context,
} from '@hive-flow/neural';
import { getModeConfig } from '@hive-flow/neural';

// Create SONA engine with balanced mode
const modeConfig = getModeConfig('balanced');
const sona = createSONALearningEngine('balanced', modeConfig);

// Learn from a trajectory
const trajectory: Trajectory = {
  trajectoryId: 'traj-001',
  context: 'Implement authentication',
  domain: 'code',
  steps: [
    {
      stepId: 'step-1',
      timestamp: Date.now(),
      action: 'analyze requirements',
      stateBefore: new Float32Array(768).fill(0.1),
      stateAfter: new Float32Array(768).fill(0.2),
      reward: 0.8,
    },
    // ... more steps
  ],
  qualityScore: 0.88,
  isComplete: true,
  startTime: Date.now(),
};

await sona.learn(trajectory);
console.log(`Learning time: ${sona.getLearningTime()}ms`);

// Adapt to new context
const context: Context = {
  domain: 'code',
  queryEmbedding: new Float32Array(768).fill(0.15),
};

const adapted = await sona.adapt(context);
console.log(`Confidence: ${adapted.confidence}`);
console.log(`Suggested route: ${adapted.suggestedRoute}`);
```

## API Reference

### `SONALearningEngine`

Main class for SONA learning operations.

#### Constructor

```typescript
new SONALearningEngine(mode: SONAMode, modeConfig: SONAModeConfig)
```

- `mode`: Learning mode ('real-time' | 'balanced' | 'research' | 'edge' | 'batch')
- `modeConfig`: Configuration for the mode (from `getModeConfig()`)

#### Methods

##### `learn(trajectory: Trajectory): Promise<void>`

Learn from a completed trajectory.

**Performance target**: low-latency

```typescript
await sona.learn(trajectory);
```

##### `adapt(context: Context): Promise<AdaptedBehavior>`

Adapt behavior based on current context.

**Performance target**: <0.1ms

```typescript
const adapted = await sona.adapt({
  domain: 'code',
  queryEmbedding: embedding,
});
```

Returns:
- `transformedQuery`: Query after micro-LoRA transformation
- `patterns`: Similar learned patterns
- `suggestedRoute`: Recommended model/route
- `confidence`: Confidence score (0-1)

##### `getAdaptationTime(): number`

Get the last adaptation time in milliseconds.

```typescript
const timeMs = sona.getAdaptationTime();
```

##### `getLearningTime(): number`

Get the last learning time in milliseconds.

```typescript
const timeMs = sona.getLearningTime();
```

##### `resetLearning(): void`

Reset all learning state and create a fresh engine.

```typescript
sona.resetLearning();
```

##### `forceLearning(): string`

Force an immediate background learning cycle.

```typescript
const status = sona.forceLearning();
console.log(status);
```

##### `tick(): string | null`

Tick background learning (call periodically).

```typescript
const status = sona.tick();
if (status) console.log(status);
```

##### `getStats(): SONAStats`

Get engine statistics.

```typescript
const stats = sona.getStats();
console.log(`Trajectories: ${stats.totalTrajectories}`);
console.log(`Patterns: ${stats.patternsLearned}`);
console.log(`Avg Quality: ${stats.avgQuality}`);
```

##### `setEnabled(enabled: boolean): void`

Enable or disable the engine.

```typescript
sona.setEnabled(false); // Disable learning
```

##### `isEnabled(): boolean`

Check if engine is enabled.

```typescript
if (sona.isEnabled()) {
  // Learning is active
}
```

##### `findPatterns(queryEmbedding: Float32Array, k: number): JsLearnedPattern[]`

Find k similar learned patterns.

```typescript
const patterns = sona.findPatterns(embedding, 5);
patterns.forEach(p => {
  console.log(`Quality: ${p.avgQuality}, Cluster: ${p.clusterSize}`);
});
```

## Learning Modes

### Real-Time Mode

Optimized for minimum latency:
- **LoRA Rank**: 1 (micro-LoRA only)
- **Max Latency**: low-latency
- **Background Interval**: 1 minute
- **Use Case**: Interactive applications, chatbots

```typescript
const sona = createSONALearningEngine('real-time', getModeConfig('real-time'));
```

### Balanced Mode (Default)

Balanced performance and quality:
- **LoRA Rank**: 4
- **Max Latency**: 1ms
- **Background Interval**: 30 minutes
- **Use Case**: General purpose, CLI tools

```typescript
const sona = createSONALearningEngine('balanced', getModeConfig('balanced'));
```

### Research Mode

Maximum quality, slower:
- **LoRA Rank**: 16
- **Max Latency**: 10ms
- **Background Interval**: 1 hour
- **Use Case**: Research, analysis, high-quality generation

```typescript
const sona = createSONALearningEngine('research', getModeConfig('research'));
```

### Edge Mode

Optimized for resource-constrained devices:
- **LoRA Rank**: 1
- **Hidden Dim**: 384 (vs 768)
- **Memory Budget**: 50MB
- **Use Case**: Mobile, embedded systems

```typescript
const sona = createSONALearningEngine('edge', getModeConfig('edge'));
```

### Batch Mode

Optimized for batch processing:
- **LoRA Rank**: 8
- **Background Interval**: 2 hours
- **Batch Size**: 128
- **Use Case**: Offline training, batch jobs

```typescript
const sona = createSONALearningEngine('batch', getModeConfig('batch'));
```

## Types

### `Context`

```typescript
interface Context {
  domain: 'code' | 'creative' | 'reasoning' | 'chat' | 'math' | 'general';
  queryEmbedding: Float32Array;
  metadata?: Record<string, unknown>;
}
```

### `AdaptedBehavior`

```typescript
interface AdaptedBehavior {
  transformedQuery: Float32Array;
  patterns: JsLearnedPattern[];
  suggestedRoute?: string;
  confidence: number;
}
```

### `SONAStats`

```typescript
interface SONAStats {
  totalTrajectories: number;
  patternsLearned: number;
  avgQuality: number;
  lastLearningMs: number;
  enabled: boolean;
}
```

### `JsLearnedPattern`

```typescript
interface JsLearnedPattern {
  id: string;
  centroid: number[];
  clusterSize: number;
  totalWeight: number;
  avgQuality: number;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  patternType: string;
}
```

## Performance Characteristics

### Learning Performance

| Mode       | Avg Time    | Target      | Memory  |
|------------|-------------|-------------|---------|
| Real-time  | low-latency | low-latency | 100MB   |
| Balanced   | low-latency | low-latency | 200MB   |
| Research   | low-latency | <0.10ms     | 500MB   |
| Edge       | low-latency | low-latency | 50MB    |
| Batch      | low-latency | <0.10ms     | 1GB     |

### Adaptation Performance

| Operation           | Time        |
|---------------------|-------------|
| Micro-LoRA Apply    | low-latency |
| Pattern Search (k=5)| low-latency |
| Total Adaptation    | low-latency |

## Examples

See `/examples/sona-usage.ts` for comprehensive examples:

1. **Basic Learning**: Learn from trajectories
2. **Context Adaptation**: Adapt behavior to new contexts
3. **Pattern Discovery**: Discover and cluster patterns
4. **Performance Monitoring**: Benchmark learning performance

Run examples:

```bash
cd v3/@hive-flow/neural
tsx examples/sona-usage.ts
```

## Integration with V3 Neural Module

The SONA integration works seamlessly with other V3 neural components:

```typescript
import { createNeuralLearningSystem } from '@hive-flow/neural';

const system = createNeuralLearningSystem('balanced');
await system.initialize();

// SONA is used internally by the neural system
const taskId = system.beginTask('Implement feature X', 'code');

// Record steps...
system.recordStep(
  taskId,
  'analyze requirements',
  0.8,
  queryEmbedding
);

// Complete and trigger SONA learning
await system.completeTask(taskId, 0.9);
```

## Platform Support

SONA uses native bindings for optimal performance:

- **Linux**: x64, ARM64 (GNU, MUSL)
- **macOS**: x64, ARM64 (Universal binary)
- **Windows**: x64, ARM64 (MSVC)

Runtime selection is automatic based on platform.

## Advanced Usage

### Custom Configuration

```typescript
import { createSONALearningEngine, type SONAModeConfig } from '@hive-flow/neural';

const customConfig: SONAModeConfig = {
  mode: 'balanced',
  loraRank: 8,
  learningRate: 0.002,
  batchSize: 32,
  trajectoryCapacity: 20000,
  patternClusters: 100,
  qualityThreshold: 0.6,
  maxLatencyMs: 18,
  memoryBudgetMb: 50,
  ewcLambda: 1000.0,
};

const engine = createSONALearningEngine('balanced', customConfig);
```

### Background Learning

SONA automatically runs background learning cycles:

```typescript
// Tick periodically (e.g., every second)
setInterval(() => {
  const status = sona.tick();
  if (status) {
    console.log('Background learning:', status);
  }
}, 1000);
```

Or force immediate learning:

```typescript
const status = sona.forceLearning();
console.log(status);
```

## Troubleshooting

### Learning is too slow

- Use `'real-time'` or `'edge'` mode
- Reduce `baseLoraRank` in config
- Enable SIMD optimizations (`enableSimd: true`)

### Memory usage too high

- Use `'edge'` mode
- Reduce `trajectoryCapacity`
- Reduce `patternClusters`
- Lower `hiddenDim` and `embeddingDim`

### Patterns not forming

- Increase `trajectoryCapacity`
- Lower `qualityThreshold`
- Increase `backgroundIntervalMs`
- Call `forceLearning()` manually

## License

SONA integration follows the same license as the V3 neural module.
