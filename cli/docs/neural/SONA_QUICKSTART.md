# Neural Quick Start

The `@hive-flow/cli/neural` subpath exposes deterministic local learning
helpers. It does not provide runtime SONA model training in this build.

## Basic Usage

```typescript
import { createNeuralLearningSystem } from '@hive-flow/cli/neural';

const system = createNeuralLearningSystem('general');
await system.initialize();

const trajectoryId = system.beginTask('Implement authentication', 'code');

system.recordStep(trajectoryId, {
  action: 'analyze requirements',
  reward: 0.8,
  stateEmbedding: new Float32Array(768).fill(0.1),
});

system.recordStep(trajectoryId, {
  action: 'write implementation',
  reward: 0.9,
  stateEmbedding: new Float32Array(768).fill(0.2),
});

await system.completeTask(trajectoryId, 0.9);

const patterns = await system.findPatterns(new Float32Array(768).fill(0.15), 3);
console.log(patterns);
```

## Available Operations

```typescript
const id = system.beginTask(context, domain);
system.recordStep(id, action, reward, stateEmbedding);
await system.completeTask(id, finalQuality);

const patterns = await system.findPatterns(queryEmbedding, 3);
const memories = await system.retrieveMemories(queryEmbedding, 3);
await system.triggerLearning();

const stats = system.getStats();
await system.cleanup();
```

## Capability Check

```typescript
import { getNeuralCapabilityStatus } from '@hive-flow/cli/neural';

console.log(getNeuralCapabilityStatus());
```

`neuralTrainingAvailable` is always `false` in the current build.
`localPatternLearningAvailable` is `true`.

## Algorithm Helpers

The subpath also exports local reinforcement-learning helper classes:

```typescript
import {
  createPPO,
  createDQN,
  createA2C,
  createQLearning,
  createSARSA,
  createDecisionTransformer,
  createCuriosity,
} from '@hive-flow/cli/neural';
```

These helpers are local TypeScript implementations. They are not a runtime SONA
training engine.

## Source

- Source: `cli/src/neural`
- API entrypoint: `cli/src/neural/index.ts`
