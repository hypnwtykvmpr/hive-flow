/**
 * Remediation workflow — audit-driven bands of implement / verify / commit.
 */

import type { WorkflowDefinition, WorkflowModuleRef } from '../types.js';

export interface RemediationFlowOptions {
  namespace?: string;
  initialVariables?: Record<string, unknown>;
  /** Number of implement → verify-implement → commit triplets (default: 1). */
  bandCount?: number;
}

export function createRemediationFlow(options?: RemediationFlowOptions): WorkflowDefinition {
  const namespace = options?.namespace ?? 'workflow/remediation';
  const bandCount = Math.max(1, options?.bandCount ?? 1);

  const modules: WorkflowModuleRef[] = [
    { name: 'audit' },
    { name: 'verify-audit' },
    { name: 'planning' },
  ];

  for (let b = 1; b <= bandCount; b++) {
    modules.push(
      {
        name: `implement-band-${b}`,
        registryModule: 'implement',
      },
      {
        name: `verify-implement-band-${b}`,
        registryModule: 'verify-implement',
      },
      {
        name: `commit-band-${b}`,
        registryModule: 'commit',
      },
    );
  }

  return {
    name: 'remediation',
    description:
      'Audit → verify-audit → planning → N×(implement-band-N → verify-implement-band-N → commit-band-N)',
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
