/**
 * V3 local learning helpers.
 *
 * This package currently exposes deterministic local pattern and reasoning
 * utilities. SONA/MoE/LoRA runtime training is not available in this build.
 *
 * @module @hive-flow/neural
 */

export type {
  SONAMode,
  SONAModeConfig,
  ModeOptimizations,
  Trajectory,
  TrajectoryStep,
  TrajectoryVerdict,
  DistilledMemory,
  Pattern,
  PatternMatch,
  PatternEvolution,
  RLAlgorithm,
  RLConfig,
  PPOConfig,
  DQNConfig,
  DecisionTransformerConfig,
  CuriosityConfig,
  AdapterConfig,
  AdapterWeights,
  EWCState,
  NeuralStats,
  NeuralEvent,
  NeuralEventListener,
} from './types.js';

export {
  ReasoningBank,
  createReasoningBank,
  createInitializedReasoningBank,
} from './reasoning-bank.js';

export type {
  ReasoningBankConfig,
  RetrievalResult,
  ConsolidationResult,
} from './reasoning-bank.js';

export {
  PatternLearner,
  createPatternLearner,
} from './pattern-learner.js';

export type { PatternLearnerConfig } from './pattern-learner.js';

export {
  PPOAlgorithm,
  createPPO,
  DEFAULT_PPO_CONFIG,
  DQNAlgorithm,
  createDQN,
  DEFAULT_DQN_CONFIG,
  A2CAlgorithm,
  createA2C,
  DEFAULT_A2C_CONFIG,
  DecisionTransformer,
  createDecisionTransformer,
  DEFAULT_DT_CONFIG,
  QLearning,
  createQLearning,
  DEFAULT_QLEARNING_CONFIG,
  SARSAAlgorithm,
  createSARSA,
  DEFAULT_SARSA_CONFIG,
  CuriosityModule,
  createCuriosity,
  DEFAULT_CURIOSITY_CONFIG,
  createAlgorithm,
  getDefaultConfig,
} from './algorithms/index.js';

export type {
  A2CConfig,
  QLearningConfig,
  SARSAConfig,
} from './algorithms/index.js';

import { ReasoningBank, createReasoningBank } from './reasoning-bank.js';
import { PatternLearner, createPatternLearner } from './pattern-learner.js';
import type {
  NeuralEventListener,
  PatternMatch,
  Trajectory,
  TrajectoryStep,
} from './types.js';

type TaskDomain = Trajectory['domain'];

interface ActiveTask {
  trajectory: Trajectory;
}

function zeroEmbedding(dim = 768): Float32Array {
  return new Float32Array(dim);
}

function normalizeRecordStepArgs(
  actionOrStep: string | { action?: string; reward?: number; stateEmbedding?: Float32Array },
  reward?: number,
  stateEmbedding?: Float32Array,
): { action: string; reward: number; stateEmbedding: Float32Array } {
  if (typeof actionOrStep === 'object' && actionOrStep !== null) {
    return {
      action: actionOrStep.action ?? 'local-pattern-step',
      reward: typeof actionOrStep.reward === 'number' ? actionOrStep.reward : 0,
      stateEmbedding: actionOrStep.stateEmbedding ?? zeroEmbedding(),
    };
  }

  return {
    action: actionOrStep,
    reward: typeof reward === 'number' ? reward : 0,
    stateEmbedding: stateEmbedding ?? zeroEmbedding(),
  };
}

/**
 * Integrated local learning facade.
 *
 * This class records trajectories, stores them in ReasoningBank, and extracts
 * local heuristic patterns. It does not perform neural model training.
 */
export class NeuralLearningSystem {
  private readonly reasoningBank: ReasoningBank;
  private readonly patternLearner: PatternLearner;
  private readonly activeTasks = new Map<string, ActiveTask>();
  private initialized = false;

  constructor(_mode: TaskDomain | string = 'general') {
    this.reasoningBank = createReasoningBank();
    this.patternLearner = createPatternLearner();
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  getReasoningBank(): ReasoningBank {
    return this.reasoningBank;
  }

  getPatternLearner(): PatternLearner {
    return this.patternLearner;
  }

  async setMode(_mode: string): Promise<void> {
    // SONA modes are unavailable; local heuristic behavior is mode-independent.
  }

  beginTask(context: string, domain: TaskDomain = 'general'): string {
    const trajectoryId = `traj_${Date.now()}_${this.activeTasks.size}`;
    this.activeTasks.set(trajectoryId, {
      trajectory: {
        trajectoryId,
        context,
        domain,
        steps: [],
        qualityScore: 0,
        isComplete: false,
        startTime: Date.now(),
      },
    });
    return trajectoryId;
  }

  recordStep(
    trajectoryId: string,
    actionOrStep: string | { action?: string; reward?: number; stateEmbedding?: Float32Array },
    reward?: number,
    stateEmbedding?: Float32Array,
  ): void {
    const task = this.activeTasks.get(trajectoryId);
    if (!task || task.trajectory.isComplete) return;

    const normalized = normalizeRecordStepArgs(actionOrStep, reward, stateEmbedding);
    const previousState = task.trajectory.steps.at(-1)?.stateAfter ?? normalized.stateEmbedding;
    const step: TrajectoryStep = {
      stepId: `step_${task.trajectory.steps.length}`,
      timestamp: Date.now(),
      action: normalized.action,
      stateBefore: previousState,
      stateAfter: normalized.stateEmbedding,
      reward: normalized.reward,
    };
    task.trajectory.steps.push(step);
    task.trajectory.qualityScore =
      task.trajectory.steps.reduce((sum, item) => sum + item.reward, 0) / task.trajectory.steps.length;
  }

  async completeTask(trajectoryId: string, quality?: number): Promise<void> {
    const task = this.activeTasks.get(trajectoryId);
    if (!task) return;

    const trajectory = task.trajectory;
    trajectory.isComplete = true;
    trajectory.endTime = Date.now();
    if (typeof quality === 'number') {
      trajectory.qualityScore = quality;
    }

    this.reasoningBank.storeTrajectory(trajectory);
    const memory = await this.reasoningBank.distill(trajectory);
    if (memory) {
      this.patternLearner.extractPattern(trajectory, memory);
    }
    this.activeTasks.delete(trajectoryId);
  }

  async findPatterns(queryEmbedding: Float32Array, k: number = 3): Promise<PatternMatch[]> {
    return this.patternLearner.findMatches(queryEmbedding, k);
  }

  async retrieveMemories(
    queryEmbedding: Float32Array,
    k: number = 3,
  ): Promise<import('./reasoning-bank.js').RetrievalResult[]> {
    return this.reasoningBank.retrieve(queryEmbedding, k);
  }

  async triggerLearning(): Promise<void> {
    await this.reasoningBank.consolidate();
  }

  getStats(): {
    reasoningBank: Record<string, number>;
    patternLearner: Record<string, number>;
    neuralTrainingAvailable: false;
  } {
    return {
      reasoningBank: this.reasoningBank.getStats(),
      patternLearner: this.patternLearner.getStats(),
      neuralTrainingAvailable: false,
    };
  }

  addEventListener(listener: NeuralEventListener): void {
    this.reasoningBank.addEventListener(listener);
    this.patternLearner.addEventListener(listener);
  }

  async cleanup(): Promise<void> {
    this.activeTasks.clear();
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export function createNeuralLearningSystem(mode: TaskDomain | string = 'general'): NeuralLearningSystem {
  return new NeuralLearningSystem(mode);
}

export function getNeuralCapabilityStatus(): {
  neuralTrainingAvailable: false;
  localPatternLearningAvailable: true;
  reason: string;
} {
  return {
    neuralTrainingAvailable: false,
    localPatternLearningAvailable: true,
    reason: 'This build provides local heuristic pattern learning only; neural model training is unavailable.',
  };
}

export default {
  createReasoningBank,
  createPatternLearner,
  createNeuralLearningSystem,
  getNeuralCapabilityStatus,
  ReasoningBank,
  PatternLearner,
  NeuralLearningSystem,
};
