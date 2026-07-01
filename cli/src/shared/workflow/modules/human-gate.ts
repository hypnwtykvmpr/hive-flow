/**
 * Human Gate Module
 *
 * Pauses workflow execution until human approval is received.
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';

export function createHumanGateModule(): WorkflowModule {
  return {
    name: 'human-gate',
    description: 'Pause execution for human review and approval',
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
          human_gate_result: {
            type: 'object',
            description: 'Result of the human review',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'request_approval: Wait for human input',
    ],

    hooks: {
      pre: 'pre_human_gate',
      post: 'post_human_gate',
      onError: 'human_gate_error',
    },

    gates: {
      enabled: true,
      checks: ['human-approved'],
      minAgents: 0,
      blocking: true,
      maxRetries: 0,
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        if (context.variables?.humanApproval === true) {
          return {
            success: true,
            outputs: {
              human_gate_result: {
                approved: true,
                reviewer: context.variables?.reviewer ?? 'human',
                notes: context.variables?.notes ?? 'Approved',
              }
            },
            durationMs: Date.now() - startTime,
            gateResult: {
              passed: true,
              failedChecks: [],
              iterations: 1,
            }
          };
        } else {
          return {
            success: false,
            status: 'waiting',
            outputs: {},
            error: 'Waiting for human approval',
            durationMs: Date.now() - startTime,
          } as any;
        }
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
