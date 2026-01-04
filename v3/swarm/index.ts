/**
 * V3 Unified Swarm Coordination System
 *
 * This module consolidates 4 legacy coordination systems into a single unified system:
 * - SwarmCoordinator (27KB!) - Core swarm orchestration
 * - HiveMind - Queen-led hierarchical coordination
 * - Maestro - SPARC methodology integration
 * - AgentManager - Agent lifecycle and pooling
 *
 * Performance Targets:
 * - Agent coordination: <100ms for 15 agents
 * - Consensus: <100ms
 * - Message throughput: 1000+ msgs/sec
 *
 * Supported Topologies:
 * - mesh: Peer-to-peer communication (default)
 * - hierarchical: Queen-led with workers
 * - centralized: Single coordinator
 * - hybrid: Dynamic switching between topologies
 *
 * Consensus Algorithms:
 * - raft: Leader election and log replication
 * - byzantine: PBFT-style fault tolerance
 * - gossip: Eventually consistent for large scale
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
 *
 * // Register agents
 * const agentId = await coordinator.registerAgent({
 *   name: 'Worker-1',
 *   type: 'worker',
 *   capabilities: { ... },
 *   metrics: { ... },
 *   status: 'idle',
 *   workload: 0,
 *   health: 1.0,
 * });
 *
 * // Submit tasks
 * const taskId = await coordinator.submitTask({
 *   name: 'Analyze code',
 *   type: 'analysis',
 *   priority: 'high',
 *   input: { ... },
 * });
 *
 * // Achieve consensus
 * const result = await coordinator.proposeConsensus({ action: 'deploy' });
 * ```
 */

// Main coordinator
export {
  UnifiedSwarmCoordinator,
  createUnifiedSwarmCoordinator,
} from './unified-coordinator.js';

// Core components
export {
  TopologyManager,
  createTopologyManager,
} from './topology-manager.js';

export {
  MessageBus,
  createMessageBus,
} from './message-bus.js';

export {
  AgentPool,
  createAgentPool,
} from './agent-pool.js';

// Consensus engines
export {
  ConsensusEngine,
  createConsensusEngine,
  selectOptimalAlgorithm,
  RaftConsensus,
  ByzantineConsensus,
  GossipConsensus,
} from './consensus/index.js';

// Types
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

// Default export for convenience
import { UnifiedSwarmCoordinator, createUnifiedSwarmCoordinator } from './unified-coordinator.js';
export default UnifiedSwarmCoordinator;

// Version info
export const VERSION = '3.0.0';

// Performance targets as constants
export const PERFORMANCE_TARGETS = {
  COORDINATION_LATENCY_MS: 100, // <100ms for 15 agents
  CONSENSUS_LATENCY_MS: 100,    // <100ms consensus
  MESSAGE_THROUGHPUT: 1000,      // 1000+ msgs/sec
} as const;
