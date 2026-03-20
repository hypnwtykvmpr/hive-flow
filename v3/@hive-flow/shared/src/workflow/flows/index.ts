/**
 * Named workflow flow factories and registry.
 */

import type { WorkflowDefinition } from '../types.js';

export type { WorkflowFlowDefinition, WorkflowModuleRef } from '../types.js';

import { createGeneralDevelopmentFlow } from './general-development.js';
import { createRemediationFlow } from './remediation.js';
import { createBugfixFlow } from './bugfix.js';

/** Options accepted by any registered flow factory (unknown keys are ignored per-flow). */
export interface FlowOptions {
  namespace?: string;
  initialVariables?: Record<string, unknown>;
  bandCount?: number;
  humanGateAfterDesign?: boolean;
}

export type FlowFactory = (options?: FlowOptions) => WorkflowDefinition;

export const FLOW_REGISTRY = new Map<string, FlowFactory>([
  ['general-development', (opts) => createGeneralDevelopmentFlow(opts)],
  ['remediation', (opts) => createRemediationFlow(opts)],
  ['bugfix', (opts) => createBugfixFlow(opts)],
]);

export function listFlowNames(): string[] {
  return [...FLOW_REGISTRY.keys()];
}

export { createGeneralDevelopmentFlow, type GeneralDevelopmentFlowOptions } from './general-development.js';
export { createRemediationFlow, type RemediationFlowOptions } from './remediation.js';
export { createBugfixFlow, type BugfixFlowOptions } from './bugfix.js';
