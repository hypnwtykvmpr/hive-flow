/**
 * @hive-flow/integration - V3 Integration Module
 *
 * Main entry point for Hive Flow integration utilities.
 *
 * Key Features:
 * - SONA Learning: Real-time adaptation with low-latency response
 * - Flash Attention: optimization enabled with memory reduction
 * - HiveMemory: fast HNSW-indexed search via HNSW indexing
 * - Intelligence Bridge: 19 hook tools + 9 learning tools
 * - Trajectory Tracking: Experience replay for continuous learning
 *
 * Usage:
 * ```typescript
 * import { createHiveAgent } from '@hive-flow/integration';
 *
 * const agent = await createHiveAgent({
 *   id: 'agent-1',
 *   name: 'Coder',
 *   type: 'coder',
 *   capabilities: ['code-generation'],
 *   maxConcurrentTasks: 1,
 *   priority: 5,
 * });
 * ```
 *
 * @module @hive-flow/integration
 * @version 3.0.0-alpha.1
 */

// ===== Core Bridge =====
export {
  IntegrationBridge,
  createIntegrationBridge,
  getDefaultBridge,
  resetDefaultBridge,
} from './integration-bridge.js';

// ===== SONA Adapter =====
export {
  SONAAdapter,
  createSONAAdapter,
} from './sona-adapter.js';

// ===== Attention Coordinator =====
export {
  AttentionCoordinator,
  createAttentionCoordinator,
} from './attention-coordinator.js';

// ===== SDK Bridge =====
export {
  SDKBridge,
  createSDKBridge,
} from './sdk-bridge.js';

// ===== Feature Flags =====
export {
  FeatureFlagManager,
  createFeatureFlagManager,
  getDefaultFeatureFlagManager,
} from './feature-flags.js';

// ===== Local Agent Integration =====
export {
  HiveAgent,
  createHiveAgent,
} from './hive-agent.js';

// ===== Types =====
export type {
  // SONA Types
  SONAConfiguration,
  SONALearningMode,
  SONATrajectory,
  SONATrajectoryStep,
  SONAPattern,
  SONALearningStats,

  // Attention Types
  AttentionConfiguration,
  AttentionMechanism,
  AttentionResult,
  AttentionMetrics,

  // HiveMemory Types
  HiveMemoryConfiguration,
  HiveMemoryVector,
  HiveMemorySearchResult,
  HiveMemoryStats,

  // Integration Types
  IntegrationConfig,
  IntegrationStatus,
  RuntimeInfo,
  ComponentHealth,
  IntegrationEvent,
  IntegrationEventType,

  // Feature Flags
  FeatureFlags,

  // SDK Types
  SDKVersion,
  SDKCompatibility,
  SDKBridgeConfig,
} from './types.js';

// ===== Worker Task Contracts (neutral module) =====
export type {
  AgentStatus,
  Task,
  TaskResult,
  Message,
} from './worker-task-types.js';

// ===== Agent Integration Types =====
export type {
  // Core agent interfaces
  IAgent,
  IAgentConfig,
  IAgentSession,
  AgentType,
  // Execution
  AgentHealth,
  HiveAgentConfig,
} from './hive-agent.js';

// ===== Swarm Adapter (Hive Flow pattern alignment) =====
export {
  SwarmAdapter,
  createSwarmAdapter,
  getDefaultSwarmAdapter,
  resetDefaultSwarmAdapter,
} from './swarm-adapter.js';

export type {
  // Hive Flow pattern types
  HiveTopology,
  HiveAttentionMechanism,
  HiveAgentOutput,
  HiveSpecializedAgent,
  HiveExpertRoute,
  HiveAttentionResult,
  GraphRoPEContext,
  // V3 Swarm types
  V3TopologyType,
  V3AgentDomain,
  V3AgentState,
  V3TaskDefinition,
  // Adapter types
  SwarmAdapterConfig,
} from './swarm-adapter.js';

// ===== Worker Patterns (ADR-001 Integration) =====
export {
  WorkerBase,
  createWorker,
} from './worker-base.js';

export type {
  WorkerConfig,
  WorkerType,
  WorkerMemoryConfig,
  WorkerCoordinationConfig,
  WorkerProviderConfig,
  AgentOutput,
  WorkerArtifact,
  WorkerMetrics,
  WorkerHealth,
} from './worker-base.js';

// ===== Specialized Worker =====
export {
  SpecializedWorker,
  createSpecializedWorker,
  createFrontendWorker,
  createBackendWorker,
  createTestingWorker,
} from './specialized-worker.js';

export type {
  SpecializedWorkerConfig,
  DomainSpecialization,
  DomainHandlers,
  TaskMatchResult,
} from './specialized-worker.js';

// ===== Long-Running Worker =====
export {
  LongRunningWorker,
  createLongRunningWorker,
  createCheckpointStorage,
} from './long-running-worker.js';

export type {
  LongRunningWorkerConfig,
  Checkpoint,
  CheckpointState,
  CheckpointStorage,
  ExecutionPhase,
  ProgressUpdate,
} from './long-running-worker.js';

// ===== Worker Pool =====
export {
  WorkerPool,
  createWorkerPool,
  createAndInitializeWorkerPool,
} from './worker-pool.js';

export type {
  WorkerPoolConfig,
  RoutingStrategy,
  LoadBalancingStrategy,
  RoutingResult,
  PoolStats,
  SpawnOptions,
} from './worker-pool.js';

// ===== Provider Adapter =====
export {
  ProviderAdapter,
  createProviderAdapter,
  createDefaultProviders,
} from './provider-adapter.js';

export type {
  Provider,
  ProviderType,
  ProviderCapability,
  ProviderStatus,
  ModelInfo,
  RateLimits,
  CostInfo,
  ProviderRequirements,
  ProviderSelectionResult,
  ExecutionOptions,
  ExecutionResult,
  ProviderMetrics,
  ProviderAdapterConfig,
} from './provider-adapter.js';

// ===== Default Configurations =====
export {
  DEFAULT_SONA_CONFIG,
  DEFAULT_ATTENTION_CONFIG,
  DEFAULT_HIVEMEMORY_CONFIG,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_INTEGRATION_CONFIG,
} from './types.js';

// ===== Error Types =====
export {
  IntegrationError,
} from './types.js';

// ===== Multi-Model Router (Cost Optimization) =====
export {
  MultiModelRouter,
  createMultiModelRouter,
} from './multi-model-router.js';

// ===== Token Optimizer (Agent Booster Integration) =====
export {
  TokenOptimizer,
  getTokenOptimizer,
} from './token-optimizer.js';

export type {
  ProviderType as RouterProviderType,
  ModelConfig,
  ProviderConfig,
  RoutingRule,
  RoutingMode,
  RouterConfig as MultiModelRouterConfig,
  RoutingRequest as RouteRequest,
  RoutingResult as RouteResult,
  CostTracker as RouterStats,
} from './multi-model-router.js';

// ===== Quick Start Utilities =====

/**
 * Quick initialization with sensible defaults
 */
export async function quickStart(options?: {
  mode?: 'minimal' | 'standard' | 'full';
  debug?: boolean;
}): Promise<{
  bridge: import('./integration-bridge.js').IntegrationBridge;
  sona: import('./sona-adapter.js').SONAAdapter | null;
  attention: import('./attention-coordinator.js').AttentionCoordinator | null;
}> {
  const { IntegrationBridge } = await import('./integration-bridge.js');
  const { FeatureFlagManager } = await import('./feature-flags.js');
  type SONAAdapterType = import('./sona-adapter.js').SONAAdapter;
  type AttentionCoordinatorType = import('./attention-coordinator.js').AttentionCoordinator;

  const mode = options?.mode || 'standard';
  const flags = FeatureFlagManager.fromProfile(mode);

  const bridge = new IntegrationBridge({
    features: flags,
    debug: options?.debug ?? false,
  });

  await bridge.initialize();

  let sona: SONAAdapterType | null = null;
  let attention: AttentionCoordinatorType | null = null;

  if (flags.enableSONA) {
    sona = await bridge.getSONAAdapter();
  }

  if (flags.enableFlashAttention) {
    attention = await bridge.getAttentionCoordinator();
  }

  return { bridge, sona, attention };
}

/**
 * Performance benchmark utility
 */
export async function benchmark(): Promise<{
  sona: { latencyMs: number; patternsPerSecond: number } | null;
  attention: { latencyMs: number; tokensPerSecond: number } | null;
  overall: { grade: 'A' | 'B' | 'C' | 'D' | 'F' };
}> {
  const { bridge, sona, attention } = await quickStart({ mode: 'full' });

  const results: {
    sona: { latencyMs: number; patternsPerSecond: number } | null;
    attention: { latencyMs: number; tokensPerSecond: number } | null;
    overall: { grade: 'A' | 'B' | 'C' | 'D' | 'F' };
  } = {
    sona: null,
    attention: null,
    overall: { grade: 'C' },
  };

  // Benchmark SONA
  if (sona) {
    const start = performance.now();
    const iterations = 100;

    for (let i = 0; i < iterations; i++) {
      await sona.storePattern({
        pattern: `test-pattern-${i}`,
        solution: `test-solution-${i}`,
        category: 'benchmark',
        confidence: 0.9,
      });
    }

    const duration = performance.now() - start;
    results.sona = {
      latencyMs: duration / iterations,
      patternsPerSecond: (iterations / duration) * 1000,
    };
  }

  // Benchmark Attention
  if (attention) {
    const query = new Array(64).fill(0).map(() => Math.random());
    const key = new Array(64).fill(0).map(() => Math.random());
    const value = new Array(64).fill(0).map(() => Math.random());

    const start = performance.now();
    const iterations = 100;

    for (let i = 0; i < iterations; i++) {
      await attention.compute({ query, key, value });
    }

    const duration = performance.now() - start;
    results.attention = {
      latencyMs: duration / iterations,
      tokensPerSecond: (iterations / duration) * 1000,
    };
  }

  // Calculate overall grade
  let score = 0;
  if (results.sona && results.sona.latencyMs < 1) score += 50;
  else if (results.sona && results.sona.latencyMs < 5) score += 30;
  else if (results.sona) score += 10;

  if (results.attention && results.attention.latencyMs < 1) score += 50;
  else if (results.attention && results.attention.latencyMs < 5) score += 30;
  else if (results.attention) score += 10;

  if (score >= 90) results.overall.grade = 'A';
  else if (score >= 70) results.overall.grade = 'B';
  else if (score >= 50) results.overall.grade = 'C';
  else if (score >= 30) results.overall.grade = 'D';
  else results.overall.grade = 'F';

  await bridge.shutdown();

  return results;
}

/**
 * Module version
 */
export const VERSION = '3.0.0-alpha.1';

/**
 * Module metadata
 */
export const METADATA = {
  name: '@hive-flow/integration',
  version: VERSION,
  description: 'Deep Hive Flow@alpha integration for hive-flow v3',
  implements: ['ADR-001'],
  features: [
    'SONA Learning (5 modes)',
    'Flash Attention (8 mechanisms)',
    'HiveMemory (HNSW indexing)',
    'Intelligence Bridge (19 tools)',
    'Trajectory Tracking',
    'Feature Flags',
    'SDK Compatibility Layer',
    'Worker Patterns (Hive Flow aligned)',
    'Specialized Workers (16 domains)',
    'Long-Running Workers (checkpoint support)',
    'Worker Pool (intelligent routing)',
    'Provider Adapter (multi-model support)',
    'Multi-Model Router (cost optimization)',
  ],
  performance: {
    flashAttentionSpeedup: 'Flash Attention optimization',
    hiveMemorySearchSpeedup: 'HNSW-indexed',
    sonaAdaptationLatency: 'low-latency',
    memoryReduction: 'memory reduction',
  },
  workerPatterns: {
    baseWorker: 'WorkerBase with embeddings and load management',
    specializedWorker: '16 domain specializations with intelligent routing',
    longRunningWorker: 'Checkpoint-based execution with auto-resume',
    workerPool: 'Dynamic scaling with hybrid routing strategy',
    providerAdapter: 'Multi-provider support with failover and cost tracking',
  },
};
