/**
 * Local learning compatibility tests.
 *
 * The former SONA runtime is not shipped in this package. These tests keep the
 * package-level compatibility surface honest: local pattern learning works, and
 * neural model training is reported as unavailable.
 */

import { describe, it, expect } from 'vitest';
import {
  createNeuralLearningSystem,
  getNeuralCapabilityStatus,
} from '../src/index.js';

describe('local learning compatibility facade', () => {
  it('reports neural training as unavailable while keeping local patterns available', () => {
    const status = getNeuralCapabilityStatus();

    expect(status.neuralTrainingAvailable).toBe(false);
    expect(status.localPatternLearningAvailable).toBe(true);
    expect(status.reason).toContain('unavailable');
  });

  it('records a trajectory into local reasoning and pattern stores', async () => {
    const system = createNeuralLearningSystem('code');
    await system.initialize();

    const trajectoryId = system.beginTask('Implement a focused test', 'code');
    system.recordStep(trajectoryId, 'inspect-source', 0.7, new Float32Array(768).fill(0.1));
    system.recordStep(trajectoryId, { action: 'write-test', reward: 0.9, stateEmbedding: new Float32Array(768).fill(0.2) });

    await system.completeTask(trajectoryId, 0.85);

    const stats = system.getStats();
    expect(stats.neuralTrainingAvailable).toBe(false);
    expect(stats.reasoningBank.trajectoryCount).toBe(1);
    expect(stats.reasoningBank.memoryCount).toBe(1);
    expect(stats.patternLearner.totalPatterns).toBeGreaterThanOrEqual(1);

    const memories = await system.retrieveMemories(new Float32Array(768).fill(0.1), 1);
    expect(memories).toHaveLength(1);
    expect(memories[0].memory.strategy).toContain('write-test');
  });

  it('is mode-compatible but mode-independent', async () => {
    const system = createNeuralLearningSystem('balanced');
    await system.initialize();
    await expect(system.setMode('research')).resolves.toBeUndefined();

    expect(system.isInitialized()).toBe(true);
    await system.cleanup();
    expect(system.isInitialized()).toBe(false);
  });
});
