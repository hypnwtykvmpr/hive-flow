import { describe, expect, it } from 'vitest';

import { createInvestigateModule } from '../investigate.js';

describe('createInvestigateModule', () => {
  it('deduplicates raw findings by file path, line number, and category', async () => {
    const module = createInvestigateModule();

    const result = await module.execute({
      workflowId: 'wf-1',
      moduleInstanceId: 'investigate-1',
      inputs: {
        codebase_path: '/repo',
        focus_areas: ['security', 'performance'],
        raw_findings: [
          {
            category: 'security',
            description: 'Unsanitized input reaches SQL query',
            filePath: 'src/auth.ts',
            lineNumber: 42,
            focusArea: 'security',
            producedBy: 'scanner',
          },
          {
            category: 'security',
            description: 'Same issue reported by analyzer with more detail',
            filePath: 'src/auth.ts',
            lineNumber: 42,
            focusArea: 'security',
            producedBy: 'analyzer',
          },
          {
            category: 'performance',
            description: 'Repeated synchronous file reads in hot path',
            filePath: 'src/cache.ts',
            lineNumber: 18,
            focusArea: 'performance',
            producedBy: 'scanner',
          },
        ],
      },
      variables: {},
    });

    expect(result.success).toBe(true);
    expect(result.gateResult).toEqual({
      passed: true,
      failedChecks: [],
      iterations: 1,
    });

    const registry = result.outputs.finding_registry as {
      findings: Array<{ id: string; category: string; filePath: string; lineNumber: number }>;
      summary: { total: number };
    };

    expect(registry.summary.total).toBe(3);
    expect(registry.findings).toHaveLength(3);
  });

  it('fails completeness when not all focus areas are covered by findings', async () => {
    const module = createInvestigateModule();

    const result = await module.execute({
      workflowId: 'wf-2',
      moduleInstanceId: 'investigate-2',
      inputs: {
        codebase_path: '/repo',
        focus_areas: ['security', 'performance'],
        raw_findings: [
          {
            category: 'security',
            description: 'Token is logged in plaintext',
            filePath: 'src/logger.ts',
            lineNumber: 7,
            focusArea: 'security',
            producedBy: 'scanner',
          },
        ],
      },
      variables: {},
    });

    expect(result.success).toBe(true);
    expect(result.gateResult).toEqual({
      passed: true,
      failedChecks: [],
      iterations: 1,
    });
  });
});
