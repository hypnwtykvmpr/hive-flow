/**
 * Re-export shared types from @claude-flow/shared
 * This enables local relative imports from '../shared/types'
 */
export type {
  AgentId,
  AgentRole,
  AgentDomain,
  AgentStatus,
  AgentDefinition,
  AgentState,
  AgentCapability,
  AgentMetrics,
  TaskType,
  TaskId,
  TaskStatus,
  TaskPriority,
  TaskDefinition,
  SwarmEvent,
  EventType,
  EventHandler,
  SwarmConfig,
  TopologyType,
  IAgent,
  ITask,
  // Additional types needed by swarm module
  TaskResult,
  TaskMetadata,
  TaskResultMetrics,
  PhaseId,
  PhaseDefinition,
  MilestoneDefinition,
  SwarmState,
  SwarmMetrics,
  SwarmMessage,
  MessageType,
  MessageHandler,
} from '@claude-flow/shared';

// Value exports (constants)
export { V3_PERFORMANCE_TARGETS } from '@claude-flow/shared';
