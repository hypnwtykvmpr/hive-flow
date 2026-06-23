/**
 * General development workflow — full design gate before implementation.
 */

import type { WorkflowDefinition, WorkflowModuleRef } from '../types.js';

export interface GeneralDevelopmentFlowOptions {
  /** Shared memory / state namespace */
  namespace?: string;
  initialVariables?: Record<string, unknown>;
  /** When true, inserts a human approval wait after verify-design (before implement). */
  humanGateAfterDesign?: boolean;
}

const HUMAN_GATE_REF: WorkflowModuleRef = { name: 'human-gate' };

export function createGeneralDevelopmentFlow(options?: GeneralDevelopmentFlowOptions): WorkflowDefinition {
  const namespace = options?.namespace ?? 'workflow/general-development';
  const modules: WorkflowModuleRef[] = [
    { name: 'investigate' },
    { name: 'verify-investigate' },
    { name: 'design' },
    { name: 'verify-design' },
    { name: 'planning' },
  ];

  if (options?.humanGateAfterDesign) {
    modules.push(HUMAN_GATE_REF);
  }

  modules.push(
    { name: 'implement' },
    { name: 'verify-implement' },
    { name: 'audit' },
    { name: 'verify-audit' },
    { name: 'commit' },
  );

  return {
    name: 'general-development',
    description:
      'Investigate → verify-investigate → design → verify-design → planning → [optional human gate] → implement → verify-implement → audit → verify-audit → commit',
    version: '1.0.0',
    modules,
    sharedState: {
      namespace,
      initialVariables: options?.initialVariables,
      persistent: true,
    },
    maxParallelTracks: 1,
  };
}
