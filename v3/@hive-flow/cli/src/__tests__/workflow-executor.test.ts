import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (must be hoisted before imports) ──────────────────────────

// Mock verification-gate
vi.mock('../mcp-tools/verification-gate.js', () => ({
  executeVerificationGate: vi.fn(),
  getDefaultGateConfig: vi.fn(),
  shouldEscalate: vi.fn(),
  createEscalationRecord: vi.fn(),
}));

// Mock planning-subflow
vi.mock('../mcp-tools/planning-subflow.js', () => ({
  executePlanningSubflow: vi.fn(),
}));

// Mock bug-hunter
vi.mock('../mcp-tools/bug-hunter.js', () => ({
  executeBugHunterScan: vi.fn(),
}));

import {
  executeWorkflowStep,
  calculateComplexity,
  handleGateRejection,
} from '../mcp-tools/workflow-executor.js';
import type { WorkflowStepContext, StepExecutionResult } from '../mcp-tools/workflow-executor.js';

import {
  executeVerificationGate,
  getDefaultGateConfig,
  shouldEscalate,
  createEscalationRecord,
} from '../mcp-tools/verification-gate.js';
import type { VerificationGateResult } from '../mcp-tools/verification-gate.js';

import { executePlanningSubflow } from '../mcp-tools/planning-subflow.js';
import { executeBugHunterScan } from '../mcp-tools/bug-hunter.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<WorkflowStepContext> = {}): WorkflowStepContext {
  return {
    workflowId: 'wf-test-1',
    step: {
      stepId: 'step-1',
      name: 'Test Step',
      type: 'task',
      config: {},
      status: 'pending',
    },
    variables: {},
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('workflow-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================================
  // calculateComplexity
  // ========================================================================

  describe('calculateComplexity', () => {
    it('returns base complexity of 1 for empty context', () => {
      expect(calculateComplexity({})).toBe(1);
    });

    it('1-2 files = low complexity (base + 1)', () => {
      const result = calculateComplexity({ files: ['a.ts', 'b.ts'] });
      expect(result).toBe(2); // 1 base + 1 for 1-2 files
    });

    it('3-5 files = moderate complexity (base + 3)', () => {
      const result = calculateComplexity({ files: ['a.ts', 'b.ts', 'c.ts'] });
      expect(result).toBe(4); // 1 base + 3 for 3-5 files
    });

    it('6+ files = high complexity (base + 5)', () => {
      const result = calculateComplexity({
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      });
      expect(result).toBe(6); // 1 base + 5 for 6+ files
    });

    it('security requirements increase complexity by 2', () => {
      const withSecurity = calculateComplexity({ description: 'implement security auth' });
      const withoutSecurity = calculateComplexity({ description: 'implement feature' });
      expect(withSecurity - withoutSecurity).toBe(2);
    });

    it('auth keyword also triggers security bump', () => {
      const result = calculateComplexity({ task: 'add auth middleware' });
      expect(result).toBe(3); // 1 base + 2 security
    });

    it('encrypt keyword also triggers security bump', () => {
      const result = calculateComplexity({ data: 'encrypt user passwords' });
      expect(result).toBe(3); // 1 base + 2 security
    });

    it('step count adds complexity', () => {
      const steps = [1, 2, 3];
      const result = calculateComplexity({ steps });
      expect(result).toBe(3); // 1 base + 2 for 3-5 steps
    });

    it('6+ steps adds higher complexity', () => {
      const steps = [1, 2, 3, 4, 5, 6];
      const result = calculateComplexity({ steps });
      expect(result).toBe(4); // 1 base + 3 for 6+ steps
    });

    it('combines file count, security, and step count', () => {
      const result = calculateComplexity({
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
        steps: [1, 2, 3, 4, 5, 6],
        task: 'security audit',
      });
      // 1 base + 5 (6 files) + 2 (security) + 3 (6 steps) = 11
      expect(result).toBe(11);
    });
  });

  // ========================================================================
  // executeWorkflowStep — Planning dispatch
  // ========================================================================

  describe('executeWorkflowStep — Planning tasks', () => {
    it('dispatches Planning tasks to planning subflow', async () => {
      const planResult = { plan: 'test plan', stages: [] };
      (executePlanningSubflow as ReturnType<typeof vi.fn>).mockResolvedValue(planResult);

      const ctx = makeCtx({
        step: {
          stepId: 'step-plan',
          name: 'Planning: Design API',
          type: 'task',
          config: { task: 'Design the REST API' },
          status: 'pending',
        },
      });

      const result = await executeWorkflowStep(ctx);

      expect(executePlanningSubflow).toHaveBeenCalledTimes(1);
      expect(executePlanningSubflow).toHaveBeenCalledWith(
        'Design the REST API',
        expect.objectContaining({ workflowId: 'wf-test-1' }),
      );
      expect(result.stepId).toBe('step-plan');
      expect(result.status).toBe('completed');
      expect(result.result).toBe(planResult);
    });

    it('uses step name as fallback when config.task is missing', async () => {
      (executePlanningSubflow as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const ctx = makeCtx({
        step: {
          stepId: 'step-plan-2',
          name: 'Planning: Quick Plan',
          type: 'task',
          config: {},
          status: 'pending',
        },
      });

      await executeWorkflowStep(ctx);

      expect(executePlanningSubflow).toHaveBeenCalledWith(
        'Planning: Quick Plan',
        expect.any(Object),
      );
    });
  });

  // ========================================================================
  // executeWorkflowStep — Implementation/Testing/Review with bug-hunter
  // ========================================================================

  describe('executeWorkflowStep — Phase tasks with bug-hunter', () => {
    it('dispatches Implementation tasks with bug-hunter in parallel', async () => {
      (executeBugHunterScan as ReturnType<typeof vi.fn>).mockResolvedValue({
        huntId: 'hunt-1',
        bugs: [],
        summary: { total: 0 },
      });

      const ctx = makeCtx({
        step: {
          stepId: 'step-impl',
          name: 'Implementation: Build Feature',
          type: 'task',
          config: { files: ['/src/feature.ts'] },
          status: 'pending',
        },
      });

      const result = await executeWorkflowStep(ctx);

      expect(executeBugHunterScan).toHaveBeenCalledTimes(1);
      expect(result.stepId).toBe('step-impl');
      expect(result.status).toBe('completed');
      expect(result).toHaveProperty('bugReport');
    });

    it('dispatches Testing tasks with bug-hunter in parallel', async () => {
      (executeBugHunterScan as ReturnType<typeof vi.fn>).mockResolvedValue({
        huntId: 'hunt-2',
        bugs: [],
      });

      const ctx = makeCtx({
        step: {
          stepId: 'step-test',
          name: 'Testing: Write Unit Tests',
          type: 'task',
          config: { files: [] },
          status: 'pending',
        },
      });

      const result = await executeWorkflowStep(ctx);

      expect(executeBugHunterScan).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('completed');
    });

    it('dispatches Review tasks with bug-hunter in parallel', async () => {
      (executeBugHunterScan as ReturnType<typeof vi.fn>).mockResolvedValue({
        huntId: 'hunt-3',
        bugs: [{ bugId: 'bug-1', title: 'Found issue' }],
      });

      const ctx = makeCtx({
        step: {
          stepId: 'step-review',
          name: 'Review: Code Quality',
          type: 'task',
          config: { files: ['/src/a.ts'] },
          status: 'pending',
        },
      });

      const result = await executeWorkflowStep(ctx);

      expect(executeBugHunterScan).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('completed');
      expect(result.bugReport).toBeDefined();
    });
  });

  // ========================================================================
  // executeWorkflowStep — Verification gate
  // ========================================================================

  describe('executeWorkflowStep — Verification steps', () => {
    it('dispatches verification steps to executeVerificationGate', async () => {
      const gateResult: VerificationGateResult = {
        gateId: 'gate-1',
        fromPhase: 'Implementation',
        toPhase: 'Testing',
        status: 'passed',
        checks: [],
        iterations: 1,
        concerns: [],
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:00:01Z',
      };

      (getDefaultGateConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        fromPhase: 'Implementation',
        toPhase: 'Testing',
        checks: ['syntax', 'semantic'],
        minAgents: 1,
        escalationThreshold: 3,
      });
      (executeVerificationGate as ReturnType<typeof vi.fn>).mockResolvedValue(gateResult);

      const ctx = makeCtx({
        step: {
          stepId: 'step-verify',
          name: 'Verify Implementation',
          type: 'verification',
          config: {
            fromPhase: 'Implementation',
            toPhase: 'Testing',
            phaseOutput: { code: 'done' },
          },
          status: 'pending',
        },
      });

      const result = await executeWorkflowStep(ctx);

      expect(executeVerificationGate).toHaveBeenCalledTimes(1);
      expect(result.stepId).toBe('step-verify');
      expect(result.status).toBe('completed');
      expect(result.gateResult).toBe(gateResult);
    });

    it('returns waiting status on gate rejection without escalation', async () => {
      const gateResult: VerificationGateResult = {
        gateId: 'gate-2',
        fromPhase: 'Implementation',
        toPhase: 'Testing',
        status: 'waiting',
        checks: [
          {
            checkId: 'chk-1',
            category: 'syntax',
            description: 'Syntax check',
            status: 'failed',
            findings: ['Missing semicolon'],
            severity: 'critical',
          },
        ],
        iterations: 1,
        concerns: [],
        startedAt: '2025-01-01T00:00:00Z',
      };

      (getDefaultGateConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        fromPhase: 'Implementation',
        toPhase: 'Testing',
        checks: ['syntax'],
        minAgents: 1,
        escalationThreshold: 3,
      });
      (executeVerificationGate as ReturnType<typeof vi.fn>).mockResolvedValue(gateResult);
      (shouldEscalate as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const ctx = makeCtx({
        step: {
          stepId: 'step-verify-fail',
          name: 'Verify',
          type: 'verification',
          config: { fromPhase: 'Implementation', toPhase: 'Testing' },
          status: 'pending',
        },
      });

      const result = await executeWorkflowStep(ctx);

      expect(result.status).toBe('waiting');
      expect((result.result as any).verified).toBe(false);
    });

    it('returns completed when escalation decision is pass-with-caveats', async () => {
      const gateResult: VerificationGateResult = {
        gateId: 'gate-3',
        fromPhase: 'Planning',
        toPhase: 'Implementation',
        status: 'waiting',
        checks: [
          {
            checkId: 'chk-2',
            category: 'semantic',
            description: 'Semantic check',
            status: 'failed',
            findings: ['Minor issue'],
            severity: 'warning',
          },
        ],
        iterations: 5,
        concerns: [],
        startedAt: '2025-01-01T00:00:00Z',
      };

      const escalation = {
        arbiterAgentId: 'arbiter-1',
        decision: 'pass-with-caveats' as const,
        rationale: 'Minor issues only',
        caveats: ['Monitor in production'],
        decidedAt: '2025-01-01T00:00:02Z',
      };

      (getDefaultGateConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        fromPhase: 'Planning',
        toPhase: 'Implementation',
        checks: ['semantic'],
        minAgents: 1,
        escalationThreshold: 3,
      });
      (executeVerificationGate as ReturnType<typeof vi.fn>).mockResolvedValue(gateResult);
      (shouldEscalate as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (createEscalationRecord as ReturnType<typeof vi.fn>).mockReturnValue(escalation);

      const ctx = makeCtx({
        step: {
          stepId: 'step-verify-esc',
          name: 'Verify',
          type: 'verification',
          config: { fromPhase: 'Planning', toPhase: 'Implementation' },
          status: 'pending',
        },
      });

      const result = await executeWorkflowStep(ctx);

      expect(shouldEscalate).toHaveBeenCalledTimes(1);
      expect(createEscalationRecord).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('completed');
      expect((result.result as any).passedWithCaveats).toBe(true);
      expect((result.result as any).caveats).toEqual(['Monitor in production']);
    });
  });

  // ========================================================================
  // handleGateRejection
  // ========================================================================

  describe('handleGateRejection', () => {
    it('packages concerns into a ConcernPackage with remediation request', async () => {
      const gate: VerificationGateResult = {
        gateId: 'gate-rej',
        fromPhase: 'Implementation',
        toPhase: 'Testing',
        status: 'waiting',
        checks: [
          {
            checkId: 'chk-fail-1',
            category: 'syntax',
            description: 'Missing error handling',
            status: 'failed',
            findings: ['No try/catch around JSON.parse', 'Unhandled promise rejection'],
            severity: 'critical',
          },
          {
            checkId: 'chk-pass-1',
            category: 'semantic',
            description: 'Logic check',
            status: 'passed',
            findings: [],
            severity: 'info',
          },
        ],
        iterations: 2,
        concerns: [],
        startedAt: '2025-01-01T00:00:00Z',
      };

      const concern = await handleGateRejection(gate, 'team-coder');

      expect(concern).toHaveProperty('iteration', 2);
      expect(concern).toHaveProperty('failedChecks');
      expect(concern.failedChecks).toHaveLength(1); // only the failed check
      expect(concern.failedChecks[0].checkId).toBe('chk-fail-1');
      expect(concern).toHaveProperty('remediationRequest');
      expect(typeof concern.remediationRequest).toBe('string');
      expect(concern.remediationRequest).toContain('rejected');
      expect(concern.remediationRequest).toContain('Missing error handling');
      expect(concern.remediationRequest).toContain('No try/catch around JSON.parse');
      expect(concern.remediationRequest).toContain('resubmit');
      expect(concern).toHaveProperty('submittedAt');
    });
  });

  // ========================================================================
  // Other step types
  // ========================================================================

  describe('executeWorkflowStep — Other step types', () => {
    const otherTypes: Array<WorkflowStepContext['step']['type']> = [
      'condition',
      'parallel',
      'loop',
      'wait',
    ];

    for (const stepType of otherTypes) {
      it(`'${stepType}' step returns completed status`, async () => {
        const ctx = makeCtx({
          step: {
            stepId: `step-${stepType}`,
            name: `Some ${stepType} step`,
            type: stepType,
            config: {},
            status: 'pending',
          },
        });

        const result = await executeWorkflowStep(ctx);

        expect(result.stepId).toBe(`step-${stepType}`);
        expect(result.status).toBe('completed');
        expect((result.result as any).executed).toBe(true);
      });
    }

    it('generic task (not Planning/Implementation/Testing/Review) returns completed', async () => {
      const ctx = makeCtx({
        step: {
          stepId: 'step-generic',
          name: 'Cleanup Artifacts',
          type: 'task',
          config: {},
          status: 'pending',
        },
      });

      const result = await executeWorkflowStep(ctx);

      expect(result.status).toBe('completed');
      expect((result.result as any).executed).toBe(true);
      // Should NOT call planning or bug-hunter
      expect(executePlanningSubflow).not.toHaveBeenCalled();
      expect(executeBugHunterScan).not.toHaveBeenCalled();
    });
  });
});
