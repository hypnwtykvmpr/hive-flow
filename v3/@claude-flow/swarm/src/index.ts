/**
 * @claude-flow/swarm
 * V3 Unified Swarm Coordination Module
 *
 * Provides 15-agent hierarchical mesh coordination with consensus algorithms.
 *
 * Features:
 * - Unified SwarmCoordinator consolidating 4 legacy systems
 * - Multiple topology support: mesh, hierarchical, centralized, hybrid
 * - Consensus algorithms: raft, byzantine, gossip
 * - Agent pool management with workload balancing
 * - Message bus for inter-agent communication
 *
 * Performance Targets:
 * - Agent coordination: <100ms for 15 agents
 * - Consensus: <100ms
 * - Message throughput: 1000+ msgs/sec
 *
 * Usage:
 * ```typescript
 * import { createUnifiedSwarmCoordinator } from '@claude-flow/swarm';
 *
 * const coordinator = createUnifiedSwarmCoordinator({
 *   topology: { type: 'hierarchical', maxAgents: 15 },
 *   consensus: { algorithm: 'raft', threshold: 0.66 },
 * });
 *
 * await coordinator.initialize();
 * ```
 *
 * @module @claude-flow/swarm
 * @version 3.0.0-alpha.1
 */

// =============================================================================
// Types
// =============================================================================

export * from './types.js';

// Re-export commonly used types for convenience
export type {
  SwarmId,
  AgentId,
  TaskId,
  AgentState,
  AgentType,
  AgentStatus,
  AgentCapabilities,
  AgentMetrics,
  TaskDefinition,
  TaskType,
  TaskStatus,
  TaskPriority,
  TopologyType,
  TopologyConfig,
  TopologyState,
  TopologyNode,
  ConsensusAlgorithm,
  ConsensusConfig,
  ConsensusProposal,
  ConsensusVote,
  ConsensusResult,
  Message,
  MessageType,
  MessageBusConfig,
  MessageBusStats,
  CoordinatorConfig,
  CoordinatorState,
  CoordinatorMetrics,
  SwarmStatus,
  SwarmEvent,
  SwarmEventType,
  PerformanceReport,
  AgentPoolConfig,
  AgentPoolState,
} from './types.js';

// =============================================================================
// Unified Coordinator
// =============================================================================

export {
  UnifiedSwarmCoordinator,
  createUnifiedSwarmCoordinator,
} from './unified-coordinator.js';

// Domain types for 15-agent hierarchy
export type {
  AgentDomain,
  DomainConfig,
  TaskAssignment,
  ParallelExecutionResult,
  DomainStatus,
} from './unified-coordinator.js';

// =============================================================================
// Topology Manager
// =============================================================================

export {
  TopologyManager,
  createTopologyManager,
} from './topology-manager.js';

// =============================================================================
// Message Bus
// =============================================================================

export {
  MessageBus,
  createMessageBus,
} from './message-bus.js';

// =============================================================================
// Agent Pool
// =============================================================================

export {
  AgentPool,
  createAgentPool,
} from './agent-pool.js';

// =============================================================================
// Consensus Engines
// =============================================================================

export {
  ConsensusEngine,
  createConsensusEngine,
  selectOptimalAlgorithm,
  RaftConsensus,
  ByzantineConsensus,
  GossipConsensus,
  RaftConfig,
  ByzantineConfig,
  GossipConfig,
} from './consensus/index.js';

// =============================================================================
// Coordination Components
// =============================================================================

export {
  AgentRegistry,
  createAgentRegistry,
  type IAgentRegistry,
} from './coordination/agent-registry.js';

export {
  TaskOrchestrator,
  createTaskOrchestrator,
  type ITaskOrchestrator,
  type TaskSpec,
} from './coordination/task-orchestrator.js';

export {
  SwarmHub,
  createSwarmHub,
  type ISwarmHub,
} from './coordination/swarm-hub.js';

// =============================================================================
// Default Export
// =============================================================================

import { UnifiedSwarmCoordinator, createUnifiedSwarmCoordinator } from './unified-coordinator.js';
export default UnifiedSwarmCoordinator;

// =============================================================================
// Constants
// =============================================================================

/** Module version */
export const VERSION = '3.0.0-alpha.1';

/** Performance targets for swarm operations */
export const PERFORMANCE_TARGETS = {
  /** Maximum latency for coordinating 15 agents */
  COORDINATION_LATENCY_MS: 100,
  /** Maximum latency for consensus operations */
  CONSENSUS_LATENCY_MS: 100,
  /** Minimum message throughput */
  MESSAGE_THROUGHPUT: 1000,
} as const;

/** Supported topology types */
export const TOPOLOGY_TYPES = ['mesh', 'hierarchical', 'centralized', 'hybrid'] as const;

/** Supported consensus algorithms */
export const CONSENSUS_ALGORITHMS = ['raft', 'byzantine', 'gossip', 'paxos'] as const;

/** Default swarm configuration */
export const DEFAULT_CONFIG = {
  topology: {
    type: 'hierarchical' as const,
    maxAgents: 15,
  },
  consensus: {
    algorithm: 'raft' as const,
    threshold: 0.66,
    timeoutMs: 5000,
  },
  messageBus: {
    maxQueueSize: 10000,
    batchSize: 100,
  },
  agentPool: {
    minAgents: 1,
    maxAgents: 15,
    idleTimeoutMs: 300000,
  },
} as const;
