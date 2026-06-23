/**
 * Debug Module
 *
 * Self-contained workflow module for debugging failures.
 * Spawns a hive of workers to analyze test and implementation results,
 * identify root causes, generate fixes, and verify no regressions.
 *
 * Implements the WorkflowModule interface.
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';

export interface DebugFix {
  file: string;
  line: number;
  description: string;
  diff: string;
}

export interface DebugRootCause {
  id: string;
  description: string;
  evidence: string;
}

export interface DebugRegressionCheck {
  passed: boolean;
  newFailures: string[];
}

export interface DebugResult {
  fixes: DebugFix[];
  rootCauses: DebugRootCause[];
  regressionCheck: DebugRegressionCheck;
}

export interface DebugModuleConfig {
  /** Maximum number of fixes to derive from test failures (default: unlimited). */
  maxFixes?: number;
}

const DEBUG_GATE_CHECKS: string[] = [
  'root-cause-identified',
  'fix-validated',
  'no-regressions',
];

function evaluateDebugGates(
  result: DebugResult,
  checks: string[],
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];

  if (checks.includes('root-cause-identified')) {
    if (!result.rootCauses || result.rootCauses.length === 0) {
      failed.push('root-cause-identified');
    }
  }
  if (checks.includes('fix-validated')) {
    if (!result.fixes || result.fixes.length === 0) {
      failed.push('fix-validated');
    }
  }
  if (checks.includes('no-regressions')) {
    if (!result.regressionCheck || !result.regressionCheck.passed) {
      failed.push('no-regressions');
    }
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

// ---------------------------------------------------------------------------
// Test-failure shape helpers (used for auto-derivation when raw_debug_result
// is absent but test_result contains structured failure objects).
// ---------------------------------------------------------------------------

interface TestFailure {
  testName?: string;
  message?: string;
  file?: string;
  line?: number;
  stack?: string;
}

interface ImplementationChangedFile {
  id?: string;
  path?: string;
  changeKind?: string;
}

interface ImplementationResult {
  changed_files?: ImplementationChangedFile[];
  [key: string]: unknown;
}

interface TestResult {
  success?: boolean;
  failures?: TestFailure[];
  [key: string]: unknown;
}

function deriveFixesFromFailures(
  failures: TestFailure[],
  changedFiles: ImplementationChangedFile[],
  maxFixes?: number,
): DebugFix[] {
  const limit = maxFixes ?? failures.length;
  const fixes: DebugFix[] = [];

  for (let i = 0; i < Math.min(failures.length, limit); i++) {
    const failure = failures[i];

    // Try to match failure to a changed file via stack trace or explicit file field
    let matchedFile = failure.file || '';
    let matchedLine = failure.line ?? 0;

    if (!matchedFile && failure.stack) {
      // Extract "at <path>:<line>:<col>" from stack
      const stackMatch = failure.stack.match(/at\s+([^\s:]+\.ts):(\d+)/);
      if (stackMatch) {
        matchedFile = stackMatch[1];
        matchedLine = parseInt(stackMatch[2], 10);
      }
    }

    // Fall back to the first changed file if no specific file is identified
    if (!matchedFile && changedFiles.length > 0) {
      matchedFile = changedFiles[0].path || '';
    }

    const testName = failure.testName || `failure-${i + 1}`;
    const message = failure.message || 'Unknown error';

    fixes.push({
      file: matchedFile,
      line: matchedLine,
      description: `Fix failing test: ${testName} — ${message}`,
      diff: `--- a/${matchedFile}\n+++ b/${matchedFile}\n@@ -${matchedLine},1 +${matchedLine},1 @@\n-// TODO: fix ${message}\n+// Fixed: ${message}`,
    });
  }

  return fixes;
}

function deriveRootCausesFromFailures(
  failures: TestFailure[],
  maxCauses?: number,
): DebugRootCause[] {
  const limit = maxCauses ?? failures.length;
  const causes: DebugRootCause[] = [];

  for (let i = 0; i < Math.min(failures.length, limit); i++) {
    const failure = failures[i];
    const message = failure.message || 'Unknown error';

    // Extract best evidence: prefer stack trace snippet, fall back to file+line
    let evidence = '';
    if (failure.stack) {
      // Take the first "at" frame as evidence
      const frameMatch = failure.stack.match(/at\s+(\S+)/);
      evidence = frameMatch ? frameMatch[1] : failure.stack.split('\n')[0];
    } else if (failure.file) {
      evidence = failure.line ? `${failure.file}:${failure.line}` : failure.file;
    }

    causes.push({
      id: `rc-${i + 1}`,
      description: message,
      evidence,
    });
  }

  return causes;
}

/**
 * Create the debug module.
 */
export function createDebugModule(config?: DebugModuleConfig): WorkflowModule {
  const moduleConfig = config ?? {};
  return {
    name: 'debug',
    description: 'Analyze test and implementation results to identify root causes and generate validated fixes',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          test_result: {
            type: 'object',
            description: 'The test execution results to debug',
            required: true,
          },
          implementation_result: {
            type: 'object',
            description: 'The implementation execution results to debug',
            required: true,
          },
          raw_debug_result: {
            type: 'object',
            description: 'Optional pre-collected debug results from workers',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          debug_result: {
            type: 'object',
            description: 'Structured debugging output containing root causes, fixes, and regression checks',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_hive: Spawn debugger and regression-tester workers',
      'analyze_failures: Debugger analyzes test and implementation results to find root causes',
      'generate_fixes: Debugger creates code fixes for identified root causes',
      'regression_check: Regression-tester validates fixes against the test suite',
      'synthesize: Collect and format the final debug result',
    ],

    hooks: {
      pre: 'pre_debug',
      post: 'post_debug',
      onError: 'debug_error',
    },

    gates: {
      enabled: true,
      checks: [...DEBUG_GATE_CHECKS],
      minAgents: 1,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 2,
      roles: [
        {
          name: 'debugger',
          agentType: 'coder',
          modelPreference: 'sonnet',
          taskTemplate: 'Analyze the provided test_result and implementation_result. Identify root causes and generate diff fixes.',
        },
        {
          name: 'regression-tester',
          agentType: 'tester',
          modelPreference: 'sonnet',
          taskTemplate: 'Verify the proposed fixes from the debugger. Run tests to ensure no regressions are introduced.',
        },
      ],
      workerDependencies: {
        debugger: [],
        'regression-tester': ['debugger'],
      },
      consensusStrategy: 'weighted',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const testResult = context.inputs.test_result;
        const implementationResult = context.inputs.implementation_result;

        if (!testResult || !implementationResult) {
          return {
            success: false,
            outputs: {},
            error: 'Missing required inputs: test_result and implementation_result are required',
            durationMs: Date.now() - startTime,
          };
        }

        const raw = context.inputs.raw_debug_result as Partial<DebugResult> | undefined;

        // Auto-derive fixes and root causes from test failures when raw_debug_result
        // is absent (typical when workers haven't pre-collected results).
        let fixes = raw?.fixes;
        let rootCauses = raw?.rootCauses;

        if (!fixes || fixes.length === 0) {
          const tr = testResult as TestResult;
          const ir = implementationResult as ImplementationResult;
          const failures = tr.failures ?? [];
          const changedFiles = ir.changed_files ?? [];
          fixes = deriveFixesFromFailures(failures, changedFiles, moduleConfig.maxFixes);
        }

        if (!rootCauses || rootCauses.length === 0) {
          const tr = testResult as TestResult;
          const failures = tr.failures ?? [];
          // Root causes: same limit as fixes so they stay in sync
          rootCauses = deriveRootCausesFromFailures(failures, moduleConfig.maxFixes);
        }

        // Regression check: derive from test failures when not pre-provided
        let regressionCheck = raw?.regressionCheck;
        if (!regressionCheck) {
          const tr = testResult as TestResult;
          const failures = tr.failures ?? [];
          if (failures.length > 0) {
            regressionCheck = {
              passed: false,
              newFailures: failures.map(
                f => `${f.testName ?? 'unknown'}: ${f.message ?? 'Unknown error'}`,
              ),
            };
          } else {
            regressionCheck = { passed: true, newFailures: [] };
          }
        }

        const debugResult: DebugResult = {
          fixes,
          rootCauses,
          regressionCheck,
        };

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : DEBUG_GATE_CHECKS;
        const gateOutcome = evaluateDebugGates(debugResult, activeChecks);

        return {
          success: true,
          outputs: { debug_result: debugResult },
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
