import { describe, expect, it } from 'vitest';

import type { WorkflowDefinition, WorkflowModule } from '../types.js';
import { validateWorkflowDefinition } from '../validation.js';

function makeModule(
  name: string,
  requiredInputs: string[],
  outputFields: string[],
): WorkflowModule {
  return {
    name,
    description: `${name} module`,
    version: '1.0.0',
    contract: {
      inputs: {
        fields: Object.fromEntries(
          requiredInputs.map((field) => [
            field,
            { type: 'object', description: `${field} input`, required: true },
          ]),
        ),
        additionalFields: true,
      },
      outputs: {
        fields: Object.fromEntries(
          outputFields.map((field) => [
            field,
            { type: 'object', description: `${field} output`, required: true },
          ]),
        ),
        additionalFields: false,
      },
    },
    flow: [],
    hooks: {},
    gates: {
      enabled: false,
      checks: [],
      minAgents: 0,
      blocking: false,
    },
    async execute() {
      return {
        success: true,
        outputs: {},
        durationMs: 0,
      };
    },
  };
}

describe('validateWorkflowDefinition', () => {
  it('accepts a simple compatible workflow', () => {
    const registry = new Map<string, WorkflowModule>([
      ['source', makeModule('source', [], ['finding_registry'])],
      ['consumer', makeModule('consumer', ['finding_registry'], ['debug_result'])],
    ]);

    const definition: WorkflowDefinition = {
      name: 'valid-workflow',
      description: 'Valid workflow',
      version: '1.0.0',
      modules: [{ name: 'source' }, { name: 'consumer' }],
      sharedState: {
        namespace: 'workflow/valid',
      },
      maxParallelTracks: 1,
    };

    expect(validateWorkflowDefinition(definition, registry)).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
  });

  it('reports duplicate names, missing refs, and missing dependency modules', () => {
    const registry = new Map<string, WorkflowModule>([
      ['source', makeModule('source', [], ['finding_registry'])],
    ]);

    const definition: WorkflowDefinition = {
      name: 'invalid-refs',
      description: 'Invalid refs',
      version: '1.0.0',
      modules: [
        { name: 'source' },
        { name: 'source' },
        { name: 'consumer', dependsOn: ['missing-step'] },
      ],
      sharedState: {
        namespace: 'workflow/invalid-refs',
      },
    };

    const result = validateWorkflowDefinition(definition, registry);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate workflow step name "source".');
    expect(result.errors).toContain(
      'Workflow step "consumer" references missing dependency "missing-step".',
    );
    expect(result.errors).toContain(
      'Workflow step "consumer" references unregistered module "consumer".',
    );
  });

  it('detects dependency cycles and contract mismatches', () => {
    const registry = new Map<string, WorkflowModule>([
      ['source', makeModule('source', [], ['finding_registry'])],
      ['verify', makeModule('verify', ['finding_registry'], ['verified_registry'])],
      ['implement', makeModule('implement', ['execution_plan'], ['implementation_result'])],
      ['cycle-a', makeModule('cycle-a', [], ['a_out'])],
      ['cycle-b', makeModule('cycle-b', ['a_out'], ['b_out'])],
    ]);

    const definition: WorkflowDefinition = {
      name: 'invalid-graph',
      description: 'Invalid graph',
      version: '1.0.0',
      modules: [
        { name: 'source' },
        { name: 'verify' },
        { name: 'implement' },
        { name: 'cycle-a', dependsOn: ['cycle-b'] },
        { name: 'cycle-b', dependsOn: ['cycle-a'] },
      ],
      sharedState: {
        namespace: 'workflow/invalid-graph',
      },
    };

    const result = validateWorkflowDefinition(definition, registry);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'Workflow step "implement" requires inputs [execution_plan] but upstream outputs provide [verified_registry].',
    );
    expect(result.errors).toContain(
      'Dependency cycle detected: cycle-a -> cycle-b -> cycle-a.',
    );
  });
});
