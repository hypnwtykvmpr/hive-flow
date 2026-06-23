/**
 * Bugfix workflow — fast path without design stage.
 */

import type { WorkflowDefinition, WorkflowModuleRef } from '../types.js';

export interface BugfixFlowOptions {
  namespace?: string;
  initialVariables?: Record<string, unknown>;
}

export function createBugfixFlow(options?: BugfixFlowOptions): WorkflowDefinition {
  const namespace = options?.namespace ?? 'workflow/bugfix';
  const modules: WorkflowModuleRef[] = [
    { name: 'investigate' },
    { name: 'verify-investigate' },
    { name: 'implement' },
    { name: 'verify-implement' },
    { name: 'commit' },
  ];

  return {
    name: 'bugfix',
    description: 'Investigate → verify → implement → verify → commit',
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
