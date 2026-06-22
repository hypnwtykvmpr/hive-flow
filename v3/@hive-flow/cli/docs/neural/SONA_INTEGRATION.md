# Neural Integration Guide

`@hive-flow/cli/neural` is the local learning subpath now shipped with the CLI.
It exposes trajectory tracking, ReasoningBank storage, pattern extraction, and
local algorithm helpers. Runtime SONA model training, LoRA fine-tuning, MoE
routing, and EWC training are not available in this build.

## Integration Model

```typescript
import {
  createNeuralLearningSystem,
  getNeuralCapabilityStatus,
} from '@hive-flow/cli/neural';

const status = getNeuralCapabilityStatus();
if (!status.localPatternLearningAvailable) {
  throw new Error(status.reason);
}

const learning = createNeuralLearningSystem('code');
await learning.initialize();
```

## Recording A Trajectory

```typescript
const trajectoryId = learning.beginTask('Review auth middleware', 'code');

learning.recordStep(trajectoryId, {
  action: 'inspect routes',
  reward: 0.7,
  stateEmbedding: new Float32Array(768).fill(0.1),
});

learning.recordStep(trajectoryId, {
  action: 'identify missing authorization check',
  reward: 0.9,
  stateEmbedding: new Float32Array(768).fill(0.2),
});

await learning.completeTask(trajectoryId, 0.85);
```

Completing a task stores the trajectory in `ReasoningBank` and gives
`PatternLearner` a chance to extract a reusable local pattern.

## Querying Learned Patterns

```typescript
const queryEmbedding = new Float32Array(768).fill(0.15);
const matches = await learning.findPatterns(queryEmbedding, 5);
const memories = await learning.retrieveMemories(queryEmbedding, 5);
```

## Event Hooks

```typescript
learning.addEventListener((event) => {
  if (event.type === 'trajectory_completed') {
    console.log(`Completed ${event.trajectoryId}`);
  }
});
```

## Algorithm Helpers

The module exports local reinforcement-learning helper classes and factories:

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

These helpers are local algorithm implementations. They do not imply an active
neural training service.

## Memory Bridge

`@hive-flow/memory` loads this subpath lazily through
`@hive-flow/cli/neural` when no custom neural loader is provided. If the CLI
subpath is unavailable, memory learning degrades to a no-op.

## Source

- Source: `v3/@hive-flow/cli/src/neural`
- API entrypoint: `v3/@hive-flow/cli/src/neural/index.ts`
- Tests: `v3/@hive-flow/cli/src/neural/__tests__`
