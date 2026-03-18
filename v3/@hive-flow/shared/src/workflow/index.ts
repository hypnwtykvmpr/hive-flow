/**
 * Workflow Module System - Public API
 *
 * Exports all workflow types, state machine, and built-in modules.
 */

// Types
export type {
  ModuleContract,
  ModuleIODescriptor,
  ModuleFieldDescriptor,
  ModuleHooks,
  ModuleGate,
  ModuleHiveConfig,
  ModuleWorkerRole,
  ModuleExecutionContext,
  ModuleExecutionResult,
  WorkflowModule,
  WorkflowModuleRef,
  WorkflowDefinition,
  WorkflowExecutionStatus,
  WorkflowModuleState,
  WorkflowParallelTrack,
  WorkflowState,
} from './types.js';

// State Machine
export {
  WorkflowStateMachine,
  WORKFLOW_STATES,
} from './state-machine.js';
export type { WorkflowStateName } from './state-machine.js';

// Built-in Modules
export { createInvestigateModule } from './modules/investigate.js';
export type { InvestigationFinding, FindingRegistry } from './modules/investigate.js';

export { createVerifyModule } from './modules/verify.js';
export type {
  VerificationVerdict,
  VerificationItem,
  VerifiedRegistry,
  VerifyModuleConfig,
} from './modules/verify.js';
