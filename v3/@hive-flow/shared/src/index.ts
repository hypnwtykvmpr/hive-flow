/**
 * @hive-flow/shared - Shared Module
 * Common types, events, utilities, and core interfaces for V3 Hive-Flow
 *
 * Based on ADR-002 (DDD) and ADR-006 (Unified Memory Service)
 */

// =============================================================================
// Types - Primary type definitions (from ./types.js and ./types/index.js)
// ./types.js exports are listed explicitly to avoid ambiguity with ./types/index.js
// Conflicting names (AgentStatus, SwarmMessage, SwarmMetrics, TaskMetadata,
// TaskPriority, TaskStatus) are only exported from ./types/index.js.
// =============================================================================
export type {
  AgentId,
  AgentRole,
  AgentDomain,
  AgentCapability,
  AgentDefinition,
  AgentState,
  AgentMetrics,
  TaskId,
  TaskType,
  TaskDefinition,
  TaskResult,
  TaskResultMetrics,
  PhaseId,
  PhaseDefinition,
  MilestoneDefinition,
  MilestoneStatus,
  MilestoneCriteria,
  TopologyType,
  SwarmConfig,
  LoadBalancingStrategy,
  SwarmState,
  EventType,
  SwarmEvent,
  EventHandler,
  MessageType,
  MessageHandler,
  PerformanceTargets,
  DeepPartial,
  AsyncCallback,
} from './types.js';
export { V3_PERFORMANCE_TARGETS } from './types.js';
export * from './types/index.js';

// =============================================================================
// Events - Event bus and basic event interfaces (from ./events.js)
// =============================================================================
export { EventBus } from './events.js';
export type { IEventBus, EventFilter } from './events.js';

// =============================================================================
// Event Sourcing - ADR-007 Domain events and event store
// (from ./events/index.js - no duplicates with ./events.js)
// =============================================================================
export type {
  DomainEvent,
  AllDomainEvents,
  AgentSpawnedEvent,
  AgentStartedEvent,
  AgentStoppedEvent,
  AgentFailedEvent,
  AgentStatusChangedEvent,
  AgentTaskAssignedEvent,
  AgentTaskCompletedEvent,
  TaskCreatedEvent,
  TaskStartedEvent,
  TaskCompletedEvent,
  TaskFailedEvent,
  TaskBlockedEvent,
  TaskQueuedEvent,
  MemoryStoredEvent,
  MemoryRetrievedEvent,
  MemoryDeletedEvent,
  MemoryExpiredEvent,
  SwarmInitializedEvent,
  SwarmScaledEvent,
  SwarmTerminatedEvent,
  SwarmPhaseChangedEvent,
  SwarmMilestoneReachedEvent,
  SwarmErrorEvent,
  EventStoreConfig,
  EventSnapshot,
  EventStoreStats,
  AgentProjectionState,
  TaskProjectionState,
  MemoryProjectionState,
  AggregateRoot,
  ReconstructorOptions,
} from './events/index.js';

export {
  createAgentSpawnedEvent,
  createAgentStartedEvent,
  createAgentStoppedEvent,
  createAgentFailedEvent,
  createTaskCreatedEvent,
  createTaskStartedEvent,
  createTaskCompletedEvent,
  createTaskFailedEvent,
  createMemoryStoredEvent,
  createMemoryRetrievedEvent,
  createMemoryDeletedEvent,
  createSwarmInitializedEvent,
  createSwarmScaledEvent,
  createSwarmTerminatedEvent,
  EventStore,
  Projection,
  AgentStateProjection,
  TaskHistoryProjection,
  MemoryIndexProjection,
  StateReconstructor,
  createStateReconstructor,
  AgentAggregate,
  TaskAggregate,
} from './events/index.js';

// =============================================================================
// Plugin System - ADR-004
// =============================================================================
export * from './plugin-loader.js';
export * from './plugin-registry.js';

// =============================================================================
// Core - DDD interfaces, config, orchestrator
// Note: Only export non-overlapping items from core to avoid duplicates with types.js
// =============================================================================
export {
  // Event Bus
  createEventBus,
  // Orchestrator
  createOrchestrator,
  TaskManager,
  SessionManager,
  HealthMonitor,
  LifecycleManager,
  EventCoordinator,
  CheckpointManager,
  CrashDetector,
  // Config validation/loading
  ConfigLoader,
  loadConfig,
  ConfigValidator,
  validateAgentConfig,
  validateTaskConfig,
  validateSwarmConfig,
  validateMemoryConfig,
  validateMCPServerConfig,
  validateOrchestratorConfig,
  validateSystemConfig,
  // Defaults
  defaultAgentConfig,
  defaultTaskConfig,
  defaultSwarmConfigCore,
  defaultMemoryConfig,
  defaultMCPServerConfig,
  defaultOrchestratorConfig,
  defaultSystemConfig,
  agentTypePresets,
  mergeWithDefaults,
} from './core/index.js';

export type {
  // Config types
  LoadedConfig,
  ConfigSource,
  ValidationResult,
  ValidationError,
  // Orchestrator types
  OrchestratorFacadeConfig,
  OrchestratorComponents,
  SessionManagerConfig,
  HealthMonitorConfig,
  LifecycleManagerConfig,
  CheckpointManagerConfig,
  CrashDetectorConfig,
  Checkpoint,
  AgentCheckpointState,
  TaskCheckpointState,
  RecoverableSession,
  // Schema types (from config - note these extend the basic types from types.js)
  AgentConfig,
  TaskConfig,
  SwarmConfig as SwarmConfigSchema,
  MemoryConfig,
  MCPServerConfig,
  OrchestratorConfig,
  SystemConfig,
  AgentConfigInput,
  TaskConfigInput,
  SwarmConfigInput,
  MemoryConfigInput,
  MCPServerConfigInput,
  OrchestratorConfigInput,
  SystemConfigInput,
  // Interface types
  ITask,
  ITaskCreate,
  ITaskResult,
  IAgent,
  IAgentConfig,
  IEventBus as ICoreEventBus,
  IMemoryBackend as ICoreMemoryBackend,
  ISwarmConfig,
  ISwarmState,
  ICoordinator,
  ICoordinationManager,
  IHealthStatus,
  IComponentHealth,
  IHealthMonitor,
  IMetricsCollector,
  IOrchestratorMetrics,
  IOrchestrator,
  SwarmTopology,
  CoordinationStatus,
} from './core/index.js';

// =============================================================================
// Hooks System
// =============================================================================
export * from './hooks/index.js';

// =============================================================================
// Security Utilities
// =============================================================================
export * from './security/index.js';

// =============================================================================
// Resilience Patterns
// =============================================================================
export * from './resilience/index.js';

// =============================================================================
// Lifecycle - Graceful shutdown, process tracking, resource cleanup
// =============================================================================
export * from './lifecycle/index.js';

// =============================================================================
// Signals - User-initiated workflow control (pause, resume, skip, stop)
// =============================================================================
export * from './signals/index.js';

// =============================================================================
// Directives - Agent-issued workflow control (loop, checkpoint, trigger)
// =============================================================================
export * from './directives/index.js';

// =============================================================================
// Observability - Tracing, metrics, span buffering, diagnostics
// =============================================================================
export * from './observability/index.js';

// =============================================================================
// Services
// =============================================================================
export * from './services/index.js';
