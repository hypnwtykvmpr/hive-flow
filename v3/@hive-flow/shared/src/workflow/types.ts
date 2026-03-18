/**
 * Workflow Module System - Unified Type Definitions
 *
 * Self-contained workflow module types for the Hive Flow V3 module system.
 * These types define chainable workflow modules with typed inputs/outputs,
 * parallel track support, hive spawning configuration, and verification gates.
 *
 * NOTE: WorkflowExecutionStatus is a NEW type for the module system.
 * It does NOT modify the existing WorkflowRecord.status in workflow-tools.ts.
 */

// ---------------------------------------------------------------------------
// Module Contract — typed inputs/outputs for chainability
// ---------------------------------------------------------------------------

/**
 * Defines the typed contract for a workflow module's inputs and outputs.
 * Used to validate that module chains are compatible.
 */
export interface ModuleContract<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Schema descriptor for expected inputs */
  inputs: ModuleIODescriptor<TInput>;
  /** Schema descriptor for produced outputs */
  outputs: ModuleIODescriptor<TOutput>;
}

/**
 * Descriptor for a module's input or output fields.
 */
export interface ModuleIODescriptor<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Field definitions keyed by name */
  fields: {
    [K in keyof T]: ModuleFieldDescriptor;
  };
  /** Whether additional untyped fields are allowed */
  additionalFields?: boolean;
}

export interface ModuleFieldDescriptor {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: unknown;
}

// ---------------------------------------------------------------------------
// Module Hooks
// ---------------------------------------------------------------------------

export interface ModuleHooks {
  /** Hook fired before module execution begins */
  pre?: string;
  /** Hook fired after module execution completes */
  post?: string;
  /** Hook fired on module failure */
  onError?: string;
}

// ---------------------------------------------------------------------------
// Module Gate — verification gate configuration within a module
// ---------------------------------------------------------------------------

export interface ModuleGate {
  /** Whether the gate is enabled */
  enabled: boolean;
  /** Check categories to run */
  checks: string[];
  /** Minimum agents required for gate verification */
  minAgents: number;
  /** Whether gate failure blocks the workflow */
  blocking: boolean;
  /** Maximum retry attempts before escalation */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Module Hive Config — config for hive spawning within a module
// ---------------------------------------------------------------------------

/**
 * Configuration for spawning a hive (team of workers) within a module.
 *
 * IMPORTANT: `workerDependencies` keys are role names (e.g. "researcher",
 * "synthesizer"), NOT worker IDs. Worker IDs are generated at runtime when
 * the hive is spawned. The dependency graph is resolved by role name and
 * mapped to actual worker IDs during execution.
 */
export interface ModuleHiveConfig {
  /** Maximum number of workers to spawn */
  maxWorkers: number;
  /** Worker role definitions */
  roles: ModuleWorkerRole[];
  /**
   * Dependency graph between worker roles.
   * Keys are role names (NOT worker IDs — IDs are generated at runtime).
   * Values are arrays of role names that must complete before this role starts.
   */
  workerDependencies: Record<string, string[]>;
  /** Consensus strategy for worker outputs */
  consensusStrategy?: 'majority' | 'unanimous' | 'weighted';
}

export interface ModuleWorkerRole {
  /** Role name (used as key in workerDependencies) */
  name: string;
  /** Agent type to spawn for this role */
  agentType: string;
  /** Model preference for this worker */
  modelPreference?: 'opus' | 'sonnet' | 'haiku';
  /** Provider preference */
  providerPreference?: string;
  /** Task description template */
  taskTemplate: string;
}

// ---------------------------------------------------------------------------
// Module Execution Context
// ---------------------------------------------------------------------------

export interface ModuleExecutionContext {
  /** Current workflow ID */
  workflowId: string;
  /** Module instance ID (unique per execution) */
  moduleInstanceId: string;
  /** Input data for this module */
  inputs: Record<string, unknown>;
  /** Shared workflow variables */
  variables: Record<string, unknown>;
  /** Output from the previous module (if any) */
  previousOutput?: Record<string, unknown>;
  /** Workflow-level metadata */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module Execution Result
// ---------------------------------------------------------------------------

export interface ModuleExecutionResult {
  /** Whether the module completed successfully */
  success: boolean;
  /** Output data produced by the module */
  outputs: Record<string, unknown>;
  /** Error message if failed */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Gate result if a gate was run */
  gateResult?: {
    passed: boolean;
    failedChecks?: string[];
    iterations: number;
  };
  /** Hive execution details */
  hiveResult?: {
    workersSpawned: number;
    workersCompleted: number;
    workersFailed: number;
    consensusReached: boolean;
  };
}

// ---------------------------------------------------------------------------
// Workflow Module — self-contained stage definition
// ---------------------------------------------------------------------------

/**
 * A WorkflowModule is a self-contained stage in a workflow pipeline.
 * It defines its inputs, outputs, internal flow, hooks, gates, and
 * an execute function that processes the module's work.
 */
export interface WorkflowModule {
  /** Unique module name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Version of this module definition */
  version: string;

  /** Typed input/output contract */
  contract: ModuleContract;

  /** Internal flow description (human-readable steps) */
  flow: string[];

  /** Hooks for module lifecycle events */
  hooks: ModuleHooks;

  /** Verification gate configuration */
  gates: ModuleGate;

  /** Hive spawning configuration (optional — not all modules need a hive) */
  hiveConfig?: ModuleHiveConfig;

  /** Execute the module with the given context */
  execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult>;
}

// ---------------------------------------------------------------------------
// Workflow Definition — chain of modules with parallelism
// ---------------------------------------------------------------------------

export interface WorkflowModuleRef {
  /** Module name to reference */
  moduleName: string;
  /** Override configuration for this instance */
  overrides?: Partial<Pick<WorkflowModule, 'hooks' | 'gates' | 'hiveConfig'>>;
  /** Modules that must complete before this one starts */
  dependsOn?: string[];
  /** Whether this module can run in parallel with siblings */
  parallel?: boolean;
}

export interface WorkflowDefinition {
  /** Unique workflow definition name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Version of this workflow definition */
  version: string;
  /** Ordered list of module references */
  modules: WorkflowModuleRef[];
  /** Shared state configuration */
  sharedState: {
    /** Memory namespace for shared state */
    namespace: string;
    /** Initial variables */
    initialVariables?: Record<string, unknown>;
    /** Whether to persist shared state across sessions */
    persistent?: boolean;
  };
  /** Maximum parallel tracks allowed */
  maxParallelTracks?: number;
}

// ---------------------------------------------------------------------------
// Workflow Execution Status — state tracking for module system
// ---------------------------------------------------------------------------

/**
 * Execution status for the module-based workflow system.
 * This is a NEW type — it does NOT modify WorkflowRecord.status in workflow-tools.ts.
 */
export type WorkflowExecutionStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

// ---------------------------------------------------------------------------
// Workflow State — state machine positions (supports parallel tracks)
// ---------------------------------------------------------------------------

export interface WorkflowModuleState {
  /** Module name */
  moduleName: string;
  /** Module instance ID */
  instanceId: string;
  /** Current status */
  status: WorkflowExecutionStatus;
  /** Started timestamp */
  startedAt?: string;
  /** Completed timestamp */
  completedAt?: string;
  /** Output data (if completed) */
  outputs?: Record<string, unknown>;
  /** Error message (if failed) */
  error?: string;
  /** Gate check result */
  gateResult?: {
    passed: boolean;
    failedChecks?: string[];
    iterations: number;
  };
}

export interface WorkflowParallelTrack {
  /** Track ID */
  trackId: string;
  /** Modules in this parallel track */
  modules: string[];
  /** Track status */
  status: WorkflowExecutionStatus;
}

export interface WorkflowState {
  /** Workflow definition name */
  workflowName: string;
  /** Workflow instance ID */
  instanceId: string;
  /** Overall workflow status */
  status: WorkflowExecutionStatus;
  /** Current state machine position (module name or 'IDLE'/'COMPLETE') */
  currentPosition: string;
  /** State of each module instance */
  moduleStates: Record<string, WorkflowModuleState>;
  /** Active parallel tracks */
  parallelTracks: WorkflowParallelTrack[];
  /** Shared variables */
  variables: Record<string, unknown>;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** HMAC signature for integrity verification */
  signature?: string;
}
