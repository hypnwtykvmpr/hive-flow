/**
 * Test Module
 *
 * Runs tests and coverage analysis on implementation results.
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Shape helpers — used when raw_test_result is absent but
// implementation_result contains structured metadata.
// ---------------------------------------------------------------------------

interface RawTestResult {
  passed?: boolean;
  failed?: number;
  skipped?: number;
  coverage?: number;
  failures?: string[];
  [key: string]: unknown;
}

interface ImplementationResult {
  changed_files?: Array<{ id?: string; path?: string; changeKind?: string }>;
  totals?: {
    filesTouched?: number;
    bugsOpen?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const TEST_GATE_CHECKS: string[] = [
  'all-tests-pass',
  'no-new-failures',
  'coverage-threshold',
];

const COVERAGE_THRESHOLD = 80;

function evaluateTestGates(
  testResult: {
    passed: boolean;
    failed: number;
    coverage: number;
    failures: string[];
  },
  checks: string[],
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];

  if (checks.includes('all-tests-pass')) {
    if (!testResult.passed || testResult.failed > 0) {
      failed.push('all-tests-pass');
    }
  }
  if (checks.includes('no-new-failures')) {
    if (testResult.failures && testResult.failures.length > 0) {
      failed.push('no-new-failures');
    }
  }
  if (checks.includes('coverage-threshold')) {
    if (testResult.coverage < COVERAGE_THRESHOLD) {
      failed.push('coverage-threshold');
    }
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

export function createTestModule(): WorkflowModule {
  return {
    name: 'test',
    description: 'Execute test suites and analyze coverage',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          implementation_result: {
            type: 'object',
            description: 'Result from the implementation phase',
            required: true,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          test_result: {
            type: 'object',
            description: 'Results of the test execution',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'run_tests: Execute test suites',
      'analyze_coverage: Analyze test coverage',
    ],

    hooks: {
      pre: 'pre_test',
      post: 'post_test',
      onError: 'test_error',
    },

    gates: {
      enabled: true,
      checks: ['all-tests-pass', 'no-new-failures', 'coverage-threshold'],
      minAgents: 1,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 2,
      roles: [
        {
          name: 'test-runner',
          agentType: 'tester',
          modelPreference: 'sonnet',
          taskTemplate: 'Run test suite for the implementation and report failures.',
        },
        {
          name: 'coverage-analyzer',
          agentType: 'analyzer',
          modelPreference: 'sonnet',
          taskTemplate: 'Analyze test coverage and ensure thresholds are met.',
        },
      ],
      workerDependencies: {
        'test-runner': [],
        'coverage-analyzer': ['test-runner'],
      },
      consensusStrategy: 'weighted',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const implementationResult = context.inputs.implementation_result;

        if (!implementationResult) {
          return {
            success: false,
            outputs: {},
            error: 'Missing required input: implementation_result is required',
            durationMs: Date.now() - startTime,
          };
        }

        // If workers pre-supplied structured test data use it directly;
        // otherwise derive a fail-safe result from implementation metadata.
        const raw = context.inputs.raw_test_result as Partial<RawTestResult> | undefined;
        const ir = implementationResult as ImplementationResult;

        let passed: boolean;
        let failed: number;
        let skipped: number;
        let coverage: number;
        let failures: string[];

        if (raw !== undefined && raw !== null) {
          // Worker-supplied data — trust it as-is
          passed = raw.passed ?? false;
          failed = raw.failed ?? 0;
          skipped = raw.skipped ?? 0;
          coverage = raw.coverage ?? 0;
          failures = raw.failures ?? [];
        } else {
          // No worker test data — derive from implementation metadata.
          // Fail-safe: default to failed=0 coverage=0 so gates catch missing data.
          const filesTouched = ir.totals?.filesTouched ?? (ir.changed_files?.length ?? 0);
          failed = 0;
          skipped = 0;
          coverage = 0;
          failures = [];
          // passed only if there is at least one file touched and no known open bugs
          const bugsOpen = ir.totals?.bugsOpen ?? 0;
          passed = filesTouched > 0 && bugsOpen === 0;
        }

        const test_result = { passed, failed, skipped, coverage, failures };

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : TEST_GATE_CHECKS;
        const gateOutcome = evaluateTestGates(test_result, activeChecks);

        return {
          success: true,
          outputs: { test_result },
          durationMs: Date.now() - startTime,
          gateResult: {
            passed: gateOutcome.passed,
            failedChecks: gateOutcome.failedChecks,
            iterations: 1,
          },
          hiveResult: {
            workersSpawned: 0,
            workersCompleted: 0,
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
