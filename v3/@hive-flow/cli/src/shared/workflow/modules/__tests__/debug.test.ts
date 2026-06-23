import { describe, expect, it } from 'vitest';

import { createDebugModule } from '../debug.js';

describe('createDebugModule', () => {
  it('defines the expected contract, gates, and hive roles', () => {
    const module = createDebugModule();

    expect(module.contract.inputs.fields).toMatchObject({
      test_result: {
        type: 'object',
        required: true,
      },
      implementation_result: {
        type: 'object',
        required: true,
      },
    });

    expect(module.contract.outputs.fields).toMatchObject({
      debug_result: {
        type: 'object',
        required: true,
      },
    });

    expect(module.gates.checks).toEqual([
      'root-cause-identified',
      'fix-validated',
      'no-regressions',
    ]);

    expect(module.hiveConfig?.roles.map(role => role.name)).toEqual([
      'debugger',
      'regression-tester',
    ]);
  });

  it('matches test failures to implementation files and produces fixes with regression status', async () => {
    const module = createDebugModule({ maxFixes: 1 });

    const result = await module.execute({
      workflowId: 'wf-debug-1',
      moduleInstanceId: 'debug-1',
      inputs: {
        test_result: {
          success: false,
          failures: [
            {
              testName: 'renders task list',
              message: 'Expected 200 received 500',
              file: 'src/api/tasks.ts',
              line: 28,
              stack: 'Error: Expected 200 received 500\n    at src/api/tasks.ts:28:13',
            },
            {
              testName: 'saves metadata',
              message: 'Cannot read properties of undefined',
              stack: 'TypeError: Cannot read properties of undefined\n    at src/workflow/runner.ts:91:5',
            },
          ],
        },
        implementation_result: {
          changed_files: [
            { id: 'cf-1', path: 'src/api/tasks.ts', changeKind: 'edit' },
            { id: 'cf-2', path: 'src/workflow/runner.ts', changeKind: 'edit' },
          ],
          bug_reports: [],
          totals: {
            filesTouched: 2,
            packagesCompleted: 1,
            bugsOpen: 2,
          },
          metadata: {
            implementedAt: '2026-03-20T00:00:00.000Z',
            durationMs: 10,
            workersUsed: 1,
          },
        },
      },
      variables: {},
    });

    expect(result.success).toBe(true);
    expect(result.gateResult).toEqual({
      passed: false,
      failedChecks: ['no-regressions'],
      iterations: 1,
    });

    const debugResult = result.outputs.debug_result as {
      fixes: Array<{ file: string; line: number; description: string; diff: string }>;
      rootCauses: Array<{ id: string; description: string; evidence: string }>;
      regressionCheck: { passed: boolean; newFailures: string[] };
    };

    expect(debugResult.fixes).toHaveLength(1);
    expect(debugResult.fixes[0]).toMatchObject({
      file: 'src/api/tasks.ts',
      line: 28,
    });
    expect(debugResult.fixes[0].description).toContain('renders task list');
    expect(debugResult.fixes[0].diff).toContain('+++ b/src/api/tasks.ts');

    expect(debugResult.rootCauses).toHaveLength(1);
    expect(debugResult.rootCauses[0].id).toMatch(/^rc-/);
    expect(debugResult.rootCauses[0].description).toContain('Expected 200 received 500');
    expect(debugResult.rootCauses[0].evidence).toContain('src/api/tasks.ts:28:13');

    expect(debugResult.regressionCheck).toEqual({
      passed: false,
      newFailures: ['renders task list: Expected 200 received 500', 'saves metadata: Cannot read properties of undefined'],
    });
  });
});
