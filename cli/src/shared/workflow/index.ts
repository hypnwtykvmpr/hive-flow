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
  WorkflowFlowDefinition,
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
export {
  createInvestigateModule,
  normalizeRawInvestigationFinding,
  dedupeInvestigationFindings,
} from './modules/investigate.js';
export type {
  InvestigationFinding,
  FindingRegistry,
  RawInvestigationFinding,
} from './modules/investigate.js';

export { createVerifyModule } from './modules/verify.js';
export type {
  VerificationVerdict,
  VerificationItem,
  VerifiedRegistry,
  VerifyModuleConfig,
  VerificationResultInput,
} from './modules/verify.js';
export { extractRegistryItems, mergeVerificationResults } from './modules/verify.js';

export {
  createResearchModule,
  normalizeRawResearchNote,
  dedupeResearchNotes,
} from './modules/research.js';
export type { ResearchNote, ResearchBrief, RawResearchNote } from './modules/research.js';

export {
  createDesignModule,
  normalizeRawDesignChange,
  dedupeDesignChanges,
} from './modules/design.js';
export type {
  DesignChange,
  DesignTestStrategy,
  DesignRiskAssessment,
  ImplementationPlan,
  RawDesignChange,
} from './modules/design.js';

export {
  createPlanningModule,
  normalizeRawWorkPackage,
  normalizeRawWontFixItem,
  normalizeWontFixList,
  categorizeChangesForPlanning,
} from './modules/planning.js';
export type {
  WorkPackage,
  ExecutionBand,
  ExecutionPlan,
  WontFixItem,
  RawWorkPackage,
  RawWontFixItem,
  ChangeSlice,
} from './modules/planning.js';

export {
  createImplementModule,
  normalizeRawChangedFile,
  normalizeRawBugReport,
} from './modules/implement.js';
export type {
  ChangedFile,
  BugReport,
  ImplementationResult,
  RawChangedFile,
  RawBugReport,
} from './modules/implement.js';

export { createAuditModule } from './modules/audit.js';
export type {
  AuditResult,
  AuditVerdict,
  BuildResult,
  TestResult,
  GrepCheck,
  DiffReview,
} from './modules/audit.js';

export { createCommitModule, SECRET_PATTERNS } from './modules/commit.js';
export type { CommitResult } from './modules/commit.js';

export { createTestModule } from './modules/test.js';
export { createDebugModule } from './modules/debug.js';
export { createHumanGateModule } from './modules/human-gate.js';
export { createAdvocateReviewModule } from './modules/advocate-review.js';

export { validateWorkflowDefinition } from './validation.js';

// Flow templates
export {
  FLOW_REGISTRY,
  listFlowNames,
  createGeneralDevelopmentFlow,
  createRemediationFlow,
  createBugfixFlow,
} from './flows/index.js';
export type { FlowFactory, FlowOptions } from './flows/index.js';
