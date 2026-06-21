# @hive-flow/neural

> Local pattern learning and trajectory tracking module for Hive Flow V3.

> **Note:** SONA/MoE/LoRA runtime training is not available in this build. This package provides deterministic local heuristic pattern learning via `ReasoningBank` and `PatternLearner`. Neural model training (LoRA fine-tuning, EWC++, runtime SONA adaptation) is unavailable at this time.

## Features

- **Local Pattern Learning** - Heuristic pattern extraction and reuse via `PatternLearner`
- **Trajectory Tracking** - Record and store agent execution paths in `ReasoningBank`
- **9 RL Algorithm Classes** - `PPOAlgorithm`, `A2CAlgorithm`, `DQNAlgorithm`, `QLearning`, `SARSAAlgorithm`, `DecisionTransformer`, and more (algorithmic implementations; runtime neural training not available)
- **Pattern Recognition** - Automatic pattern extraction from completed trajectories
- **Event System** - Subscribe to learning and trajectory events

## Quick Start

```typescript
import { NeuralLearningSystem, createNeuralLearningSystem } from '@hive-flow/neural';

// Create learning system
const system = createNeuralLearningSystem('general');
await system.initialize();

// Begin task tracking
const trajectoryId = system.beginTask('code-review-task', 'development');

// Record steps
system.recordStep(trajectoryId, 'analyze-code', 0.8, stateEmbedding);

system.recordStep(trajectoryId, 'generate-feedback', 0.9, newStateEmbedding);

// Complete task (stores trajectory and extracts patterns)
await system.completeTask(trajectoryId);

// Find similar patterns for guidance
const patterns = await system.findPatterns(contextEmbedding, 3);
```

## API Reference

### NeuralLearningSystem

```typescript
import { NeuralLearningSystem } from '@hive-flow/neural';

const system = new NeuralLearningSystem('general');
await system.initialize();

// Task / Trajectory Management
const trajectoryId = system.beginTask(context, domain);
system.recordStep(trajectoryId, action, reward, stateEmbedding);
await system.completeTask(trajectoryId, finalQuality);

// Pattern Matching
const patterns = await system.findPatterns(embedding, k);

// Memory Retrieval
const memories = await system.retrieveMemories(embedding, k);

// Learning
await system.triggerLearning();

// Statistics
const stats = system.getStats();
// stats.neuralTrainingAvailable is always false in this build

// Events
system.addEventListener(listener);

// Lifecycle
await system.cleanup();
system.isInitialized();
```

> **Unavailable methods:** `storePattern()`, `updatePatternUsage()`, `applyAdaptations()`, `getConfig()`, `setMode()` (no-op stub only — SONA modes are not active), `getLoRAConfig()`, `initializeLoRAWeights()`, `getEWCConfig()`, `consolidateEWC()` — none of these exist on `NeuralLearningSystem` in the current build.

### Factory Function

```typescript
import { createNeuralLearningSystem } from '@hive-flow/neural';

const system = createNeuralLearningSystem('general');
```

### RL Algorithms

```typescript
import { PPOAlgorithm, A2CAlgorithm, DQNAlgorithm, QLearning, SARSAAlgorithm, DecisionTransformer } from '@hive-flow/neural';

// Proximal Policy Optimization
const ppo = new PPOAlgorithm({
  learningRate: 0.0003,
  epsilon: 0.2,
  valueCoef: 0.5
});

// Advantage Actor-Critic
const a2c = new A2CAlgorithm({
  learningRate: 0.001,
  gamma: 0.99,
  entropyCoef: 0.01
});

// Deep Q-Network
const dqn = new DQNAlgorithm({
  learningRate: 0.001,
  gamma: 0.99,
  epsilon: 0.1,
  targetUpdateFreq: 100
});

// Decision Transformer
const dt = new DecisionTransformer({
  contextLength: 20,
  embeddingDim: 256,
  numHeads: 4
});
```

### Event System

```typescript
// Subscribe to neural events
system.addEventListener((event) => {
  switch (event.type) {
    case 'trajectory_started':
      console.log(`Started: ${event.trajectoryId}`);
      break;
    case 'trajectory_completed':
      console.log(`Completed with quality: ${event.qualityScore}`);
      break;
    case 'pattern_matched':
      console.log(`Pattern ${event.patternId} matched`);
      break;
    case 'learning_triggered':
      console.log(`Learning: ${event.reason}`);
      break;
  }
});
```

## TypeScript Types

```typescript
import type {
  SONAMode,
  SONAModeConfig,
  Trajectory,
  TrajectoryStep,
  Pattern,
  PatternMatch,
  NeuralStats,
  NeuralEvent,
  RLAlgorithm
} from '@hive-flow/neural';
```

> **Note:** `LoRAConfig`, `LoRAWeights`, and `EWCConfig` types are not exported from this package. `SONAMode` and `SONAModeConfig` types are exported but SONA mode switching has no effect at runtime.

## Capability Status

```typescript
import { getNeuralCapabilityStatus } from '@hive-flow/neural';

const status = getNeuralCapabilityStatus();
// {
//   neuralTrainingAvailable: false,
//   localPatternLearningAvailable: true,
//   reason: 'This build provides local heuristic pattern learning only; neural model training is unavailable.'
// }
```

## Dependencies

- [@hive-flow/memory](../memory) - Memory integration

## Related Packages

- [@hive-flow/memory](../memory) - Vector memory for patterns
- [@hive-flow/integration](../integration) - local compatibility integration
- [@hive-flow/performance](../performance) - Benchmarking

## License

MIT
