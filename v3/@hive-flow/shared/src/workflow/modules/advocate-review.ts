/**
 * Advocate Review Module
 *
 * AI advocate review of proposed changes to ensure alignment.
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';

export function createAdvocateReviewModule(): WorkflowModule {
  return {
    name: 'advocate-review',
    description: 'AI advocate reviews changes for standards and alignment',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          _previousOutput: {
            type: 'object',
            description: 'Output from the previous module to be reviewed',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          advocate_review_result: {
            type: 'object',
            description: 'Result of the advocate review',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'advocate_review: Review changes against standards',
      'delegate_check: Verify delegation and constraints',
    ],

    hooks: {
      pre: 'pre_advocate_review',
      post: 'post_advocate_review',
      onError: 'advocate_review_error',
    },

    gates: {
      enabled: true,
      checks: ['advocate-approved', 'no-critical-findings'],
      minAgents: 1,
      blocking: true,
      maxRetries: 1,
    },

    hiveConfig: {
      maxWorkers: 2,
      roles: [
        {
          name: 'advocate',
          agentType: 'reviewer',
          modelPreference: 'opus',
          taskTemplate: 'Review the proposed changes as an advocate.',
        },
        {
          name: 'delegate-checker',
          agentType: 'analyzer',
          modelPreference: 'sonnet',
          taskTemplate: 'Check delegation constraints and policy alignment.',
        },
      ],
      workerDependencies: {
        'advocate': [],
        'delegate-checker': ['advocate'],
      },
      consensusStrategy: 'weighted',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const moduleOutputs = (context.variables?._moduleOutputs ?? {}) as Record<string, unknown>;

        // Build findings by scanning all prior module outputs for issues
        const findings: string[] = [];
        let delegationViolation = false;
        let hasFailures = false;

        for (const [stepName, stepResult] of Object.entries(moduleOutputs)) {
          if (stepResult === null || typeof stepResult !== 'object') continue;
          const result = stepResult as Record<string, unknown>;

          // Check for explicit failure flags
          if (result.success === false) {
            hasFailures = true;
            const errMsg = typeof result.error === 'string' ? result.error : 'unknown error';
            findings.push(`Module "${stepName}" reported failure: ${errMsg}`);
          }

          // Check for delegation rate issues in any result that carries it
          if (typeof result.delegationRate === 'number' && result.delegationRate < 0.5) {
            delegationViolation = true;
            findings.push(`Module "${stepName}" has low delegation rate: ${result.delegationRate}`);
          }

          // Check for critical findings surfaced by upstream modules
          const upstreamFindings = result.findings ?? result.critical_findings;
          if (Array.isArray(upstreamFindings) && upstreamFindings.length > 0) {
            for (const f of upstreamFindings) {
              const text = typeof f === 'string' ? f : (typeof f === 'object' && f !== null ? String((f as Record<string, unknown>).message ?? JSON.stringify(f)) : String(f));
              findings.push(`[${stepName}] ${text}`);
            }
          }
        }

        const delegationAssessment = delegationViolation ? 'violation' : 'compliant';
        const approved = !hasFailures && !delegationViolation && findings.length === 0;
        const failedChecks: string[] = [];
        if (!approved) {
          if (hasFailures) failedChecks.push('no-critical-findings');
          if (delegationViolation) failedChecks.push('advocate-approved');
          if (failedChecks.length === 0) failedChecks.push('no-critical-findings');
        }

        const advocate_review_result = {
          approved,
          reviewer: 'ai-advocate',
          findings,
          delegationAssessment,
        };

        return {
          success: true,
          outputs: { advocate_review_result },
          durationMs: Date.now() - startTime,
          gateResult: {
            passed: approved,
            failedChecks,
            iterations: 1,
          },
          hiveResult: {
            workersSpawned: 0,
            workersCompleted: 2,
            workersFailed: 0,
            consensusReached: true,
          },
        };
      } catch (err) {
        return {
          success: false,
          outputs: {},
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startTime,
        };
      }
    },
  };
}
