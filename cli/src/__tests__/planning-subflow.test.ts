import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  thinkThroughRequest,
  brainstormSolutions,
  rankByPromptMatch,
  reRank,
  gapReview,
  arbitrate,
  assembleFinalPlan,
  executePlanningSubflow,
  researchSolutions,
  findReferenceCode,
  additionalResearch,
  type TaskDecomposition,
  type Solution,
  type GapAnalysis,
  type ArbitrationResult,
} from '../mcp-tools/planning-subflow.js';
import { isAmbiguityGenuine, resolveAuthorizedAmbiguity } from '../mcp-tools/ambiguity-filter.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function setupStoreMocks() {
  let currentStore = { subflows: {} as Record<string, unknown>, version: '1.0.0' };

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) return true;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
    JSON.stringify(currentStore),
  );

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      currentStore = JSON.parse(data);
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedStore: () => currentStore,
  };
}

function makeSolution(overrides: Partial<Solution> = {}): Solution {
  return {
    solutionId: 'sol-test-1',
    description: 'Incremental: Make targeted changes.',
    approach: 'Apply the "Incremental" strategy to: fix the bug',
    pros: ['Low risk', 'Fast'],
    cons: ['May not address root cause'],
    referenceCode: [],
    researchFindings: ['Finding 1', 'Finding 2'],
    rank: 1,
    promptMatchScore: 0.5,
    ...overrides,
  };
}

function makeDecomposition(overrides: Partial<TaskDecomposition> = {}): TaskDecomposition {
  return {
    goal: 'Implement feature X',
    constraints: [],
    scope: ['project-wide'],
    acceptanceCriteria: ['Task is implemented'],
    complexity: 5,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('planning-subflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // 1. thinkThroughRequest produces valid TaskDecomposition
  // ------------------------------------------------------------------
  describe('thinkThroughRequest', () => {
    it('produces a valid TaskDecomposition with all required fields', () => {
      const result = thinkThroughRequest('Implement user authentication with OAuth');

      expect(result.goal).toBe('Implement user authentication with OAuth');
      expect(Array.isArray(result.constraints)).toBe(true);
      expect(Array.isArray(result.scope)).toBe(true);
      expect(Array.isArray(result.acceptanceCriteria)).toBe(true);
      expect(typeof result.complexity).toBe('number');
      expect(result.complexity).toBeGreaterThanOrEqual(1);
      expect(result.complexity).toBeLessThanOrEqual(10);
    });

    it('extracts constraints from "no" and "must" keywords', () => {
      const result = thinkThroughRequest('Refactor auth module, no breaking changes, must maintain backwards compatibility');

      expect(result.constraints.length).toBeGreaterThan(0);
      expect(result.constraints.some(c => c.toLowerCase().includes('no breaking'))).toBe(true);
      expect(result.constraints.some(c => c.toLowerCase().includes('must maintain'))).toBe(true);
    });

    it('extracts scope from file references', () => {
      const result = thinkThroughRequest('Fix the bug in auth.service.ts and user.controller.ts');

      expect(result.scope).toContain('auth.service.ts');
      expect(result.scope).toContain('user.controller.ts');
    });

    it('increases complexity for security-related tasks', () => {
      const simple = thinkThroughRequest('add a button');
      const security = thinkThroughRequest('implement security authentication');

      expect(security.complexity).toBeGreaterThan(simple.complexity);
    });
  });

  // ------------------------------------------------------------------
  // 2. brainstormSolutions generates 3-5 solutions
  // ------------------------------------------------------------------
  describe('brainstormSolutions', () => {
    it('generates 3 solutions for low complexity', () => {
      const decomp = makeDecomposition({ complexity: 2 });
      const solutions = brainstormSolutions(decomp);

      expect(solutions.length).toBe(3);
    });

    it('generates 4 solutions for medium complexity', () => {
      const decomp = makeDecomposition({ complexity: 5 });
      const solutions = brainstormSolutions(decomp);

      expect(solutions.length).toBe(4);
    });

    it('generates 5 solutions for high complexity', () => {
      const decomp = makeDecomposition({ complexity: 8 });
      const solutions = brainstormSolutions(decomp);

      expect(solutions.length).toBe(5);
    });

    it('produces solutions with all required fields', () => {
      const decomp = makeDecomposition();
      const solutions = brainstormSolutions(decomp);

      for (const sol of solutions) {
        expect(sol.solutionId).toBeDefined();
        expect(sol.description).toBeDefined();
        expect(sol.approach).toBeDefined();
        expect(Array.isArray(sol.pros)).toBe(true);
        expect(Array.isArray(sol.cons)).toBe(true);
        expect(Array.isArray(sol.referenceCode)).toBe(true);
        expect(Array.isArray(sol.researchFindings)).toBe(true);
        expect(typeof sol.rank).toBe('number');
        expect(typeof sol.promptMatchScore).toBe('number');
      }
    });
  });

  // ------------------------------------------------------------------
  // 3. rankByPromptMatch sorts by score descending
  // ------------------------------------------------------------------
  describe('rankByPromptMatch', () => {
    it('sorts solutions by promptMatchScore descending', () => {
      const solutions = [
        makeSolution({ solutionId: 'a', description: 'Unrelated approach', approach: 'Something else' }),
        makeSolution({ solutionId: 'b', description: 'Implement test validation', approach: 'Test and verify the fix' }),
      ];

      const ranked = rankByPromptMatch(solutions, 'test and verify the implementation');

      expect(ranked[0].promptMatchScore).toBeGreaterThanOrEqual(ranked[1].promptMatchScore);
      expect(ranked[0].rank).toBe(1);
      expect(ranked[1].rank).toBe(2);
    });

    it('assigns rank numbers starting from 1', () => {
      const decomp = makeDecomposition();
      const solutions = brainstormSolutions(decomp);
      const ranked = rankByPromptMatch(solutions, 'refactor the code');

      for (let i = 0; i < ranked.length; i++) {
        expect(ranked[i].rank).toBe(i + 1);
      }
    });
  });

  // ------------------------------------------------------------------
  // 4. reRank boosts solutions with reference code
  // ------------------------------------------------------------------
  describe('reRank', () => {
    it('boosts score for solutions with real reference code', () => {
      const withRefs = makeSolution({
        solutionId: 'with-refs',
        promptMatchScore: 0.5,
        referenceCode: ['src/auth/', 'src/utils/'],
      });
      const withoutRefs = makeSolution({
        solutionId: 'without-refs',
        promptMatchScore: 0.5,
        referenceCode: ['(no reference code found — use grep/glob tools for real search)'],
      });

      const reRanked = reRank([withoutRefs, withRefs]);

      const boosted = reRanked.find(s => s.solutionId === 'with-refs')!;
      const notBoosted = reRanked.find(s => s.solutionId === 'without-refs')!;

      expect(boosted.promptMatchScore).toBeGreaterThan(notBoosted.promptMatchScore);
    });

    it('re-assigns ranks after boosting', () => {
      const solutions = [
        makeSolution({ solutionId: 'a', promptMatchScore: 0.3, referenceCode: ['src/'] }),
        makeSolution({ solutionId: 'b', promptMatchScore: 0.4, referenceCode: [] }),
      ];

      const reRanked = reRank(solutions);

      expect(reRanked[0].rank).toBe(1);
      expect(reRanked[1].rank).toBe(2);
    });
  });

  // ------------------------------------------------------------------
  // 5. gapReview identifies gaps of various types
  // ------------------------------------------------------------------
  describe('gapReview', () => {
    it('identifies knowledge gap when few research findings', () => {
      const sol = makeSolution({ researchFindings: [] });
      const analysis = gapReview(sol);

      const knowledgeGaps = analysis.gaps.filter(g => g.type === 'knowledge');
      expect(knowledgeGaps.length).toBeGreaterThan(0);
    });

    it('identifies security gap for auth-related solutions', () => {
      const sol = makeSolution({
        description: 'Implement token-based authentication',
        approach: 'Use auth tokens for user sessions',
      });
      const analysis = gapReview(sol);

      const secGaps = analysis.gaps.filter(g => g.type === 'security');
      expect(secGaps.length).toBeGreaterThan(0);
    });

    it('identifies blindspot gap when no error handling mentioned', () => {
      const sol = makeSolution({
        description: 'Add a simple feature',
        approach: 'Implement the feature',
      });
      const analysis = gapReview(sol);

      const blindspotGaps = analysis.gaps.filter(g => g.type === 'blindspot');
      expect(blindspotGaps.length).toBeGreaterThan(0);
    });

    it('identifies edge-case gap when not mentioned', () => {
      const sol = makeSolution({
        description: 'Simple implementation',
        approach: 'Build the feature',
      });
      const analysis = gapReview(sol);

      const edgeCaseGaps = analysis.gaps.filter(g => g.type === 'edge-case');
      expect(edgeCaseGaps.length).toBeGreaterThan(0);
    });

    it('identifies improvement gap when no real reference code', () => {
      const sol = makeSolution({
        referenceCode: ['(no reference code found — use grep/glob tools for real search)'],
      });
      const analysis = gapReview(sol);

      const improvementGaps = analysis.gaps.filter(g => g.type === 'improvement');
      expect(improvementGaps.length).toBeGreaterThan(0);
    });

    it('sets overallRisk to high when security gaps present', () => {
      const sol = makeSolution({
        description: 'Handle auth tokens and passwords',
        approach: 'Use secret management',
      });
      const analysis = gapReview(sol);

      expect(analysis.overallRisk).toBe('high');
    });
  });

  // ------------------------------------------------------------------
  // 6. arbitrate passes with 3/3 unanimous approval
  // ------------------------------------------------------------------
  describe('arbitrate', () => {
    it('passes unanimously when all conditions are met', () => {
      const sol = makeSolution({
        promptMatchScore: 0.5,
        researchFindings: ['Research 1', 'Research 2'],
        referenceCode: ['src/real-file.ts'],
      });
      const gaps: GapAnalysis = {
        gaps: [
          { id: 'g1', type: 'knowledge', description: 'minor', addressed: true },
        ],
        overallRisk: 'low',
      };

      const result = arbitrate(sol, gaps);

      expect(result.panelSize).toBe(3);
      expect(result.votes).toHaveLength(3);
      expect(result.unanimous).toBe(true);
      expect(result.votes.every(v => v.vote === 'approve')).toBe(true);
    });

    // ------------------------------------------------------------------
    // 7. arbitrate rejects when any agent votes reject
    // ------------------------------------------------------------------
    it('rejects when feasibility check fails (open gaps)', () => {
      const sol = makeSolution({ promptMatchScore: 0.1 });
      const gaps: GapAnalysis = {
        gaps: [
          { id: 'g1', type: 'security', description: 'Unresolved security issue', addressed: false },
        ],
        overallRisk: 'high',
      };

      const result = arbitrate(sol, gaps);

      expect(result.unanimous).toBe(false);
      const rejections = result.votes.filter(v => v.vote === 'reject');
      expect(rejections.length).toBeGreaterThan(0);

      // Concerns should be present on rejecting votes
      const allConcerns = rejections.flatMap(v => v.concerns);
      expect(allConcerns.length).toBeGreaterThan(0);
    });

    it('rejects when security gaps are unaddressed', () => {
      const sol = makeSolution({
        promptMatchScore: 0.5,
        researchFindings: ['R1', 'R2'],
        referenceCode: ['src/file.ts'],
      });
      const gaps: GapAnalysis = {
        gaps: [
          { id: 'g1', type: 'security', description: 'Auth vulnerability', addressed: false },
        ],
        overallRisk: 'high',
      };

      const result = arbitrate(sol, gaps);

      const securityVote = result.votes.find(v => v.agentId === 'arbitrator-security');
      expect(securityVote!.vote).toBe('reject');
    });

    it('tracks round number and prior concerns', () => {
      const sol = makeSolution();
      const gaps: GapAnalysis = { gaps: [], overallRisk: 'low' };

      const result = arbitrate(sol, gaps, 3, ['prior concern 1']);

      expect(result.round).toBe(3);
      expect(result.addressedConcerns).toContain('prior concern 1');
    });
  });

  // ------------------------------------------------------------------
  // 8. assembleFinalPlan produces a plan with all required PlanStep fields
  // ------------------------------------------------------------------
  describe('assembleFinalPlan', () => {
    it('produces a plan with all required fields', () => {
      const sol = makeSolution({ referenceCode: ['src/auth.ts'] });
      const gaps: GapAnalysis = { gaps: [], overallRisk: 'low' };
      const arb: ArbitrationResult = {
        panelSize: 3,
        votes: [
          { agentId: 'a1', vote: 'approve', rationale: 'ok', concerns: [] },
          { agentId: 'a2', vote: 'approve', rationale: 'ok', concerns: [] },
          { agentId: 'a3', vote: 'approve', rationale: 'ok', concerns: [] },
        ],
        unanimous: true,
        round: 1,
        addressedConcerns: [],
      };

      const plan = assembleFinalPlan(sol, gaps, arb);

      expect(plan.overview).toBeDefined();
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(Array.isArray(plan.prerequisites)).toBe(true);
      expect(Array.isArray(plan.risks)).toBe(true);
      expect(typeof plan.estimatedEffort).toBe('string');
      expect(Array.isArray(plan.securityConsiderations)).toBe(true);

      // Verify each step has all required PlanStep fields
      for (const step of plan.steps) {
        expect(typeof step.stepNumber).toBe('number');
        expect(typeof step.description).toBe('string');
        expect(Array.isArray(step.files)).toBe(true);
        expect(Array.isArray(step.codeSnippets)).toBe(true);
        expect(Array.isArray(step.commands)).toBe(true);
        expect(typeof step.expectedOutcome).toBe('string');
        expect(Array.isArray(step.verificationCriteria)).toBe(true);
      }
    });

    it('includes a step for addressing arbitration concerns', () => {
      const sol = makeSolution();
      const gaps: GapAnalysis = { gaps: [], overallRisk: 'low' };
      const arb: ArbitrationResult = {
        panelSize: 3,
        votes: [
          { agentId: 'a1', vote: 'approve', rationale: 'ok', concerns: [] },
          { agentId: 'a2', vote: 'reject', rationale: 'needs work', concerns: ['Missing edge cases'] },
          { agentId: 'a3', vote: 'approve', rationale: 'ok', concerns: [] },
        ],
        unanimous: false,
        round: 1,
        addressedConcerns: [],
      };

      const plan = assembleFinalPlan(sol, gaps, arb);

      const concernStep = plan.steps.find(s =>
        s.description.toLowerCase().includes('arbitration'),
      );
      expect(concernStep).toBeDefined();
      expect(concernStep!.codeSnippets.some(s => s.includes('Missing edge cases'))).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 9. isAmbiguityGenuine (from shared utility) filters obvious vs genuine
  // ------------------------------------------------------------------
  describe('isAmbiguityGenuine', () => {
    it('returns not genuine for empty options', () => {
      const result = isAmbiguityGenuine([], {});
      expect(result.genuine).toBe(false);
    });

    it('auto-selects the only option when one is provided', () => {
      const result = isAmbiguityGenuine(['Implement the feature'], {});
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Implement the feature');
    });

    it('auto-selects coherent option over absurd one', () => {
      const result = isAmbiguityGenuine(
        ['Implement and test the feature', 'Skip everything and ignore all errors'],
        { goal: 'Build a feature' },
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Implement and test the feature');
    });

    it('detects genuine ambiguity between equally viable options', () => {
      const result = isAmbiguityGenuine(
        ['Implement using approach A with refactoring', 'Implement using approach B with optimization'],
        {},
      );
      expect(result.genuine).toBe(true);
    });

    it('auto-selects first option when all are sequential phases', () => {
      const result = isAmbiguityGenuine(
        ['Phase B2: Live E2E tests', 'Phase C: Self-audit'],
        {},
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Phase B2: Live E2E tests');
      expect(result.confidence).toBe(1.0);
    });

    it('flags auditRequired for authorized non-sequential ambiguous options', () => {
      const result = isAmbiguityGenuine(
        ['Run unit tests', 'Deploy to staging'],
        { authorized: true },
      );
      // Non-sequential authorized options flow through scoring;
      // close scores trigger dual-agent audit, not human escalation
      expect(result.genuine).toBe(true);
      expect(result.auditRequired).toBe(true);
    });

    it('auto-selects first option when plan is approved', () => {
      const result = isAmbiguityGenuine(
        ['Proceed with implementation', 'Continue to review'],
        { planApproved: true },
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Proceed with implementation');
    });

    it('uses context to break ties', () => {
      const result = isAmbiguityGenuine(
        ['Fix the authentication bug', 'Fix the rendering bug'],
        { goal: 'Fix the authentication module' },
      );

      // With context favoring authentication, the first option should score higher
      if (!result.genuine) {
        expect(result.autoSelected).toBe('Fix the authentication bug');
      }
    });
  });

  // ------------------------------------------------------------------
  // 9b. resolveAuthorizedAmbiguity — dual-agent intent audit protocol
  // ------------------------------------------------------------------
  describe('resolveAuthorizedAmbiguity', () => {
    it('auto-resolves when both agents score ≥95% on both intents', async () => {
      const auditFn = async () => ({
        promptIntentConfidence: 0.97,
        planIntentConfidence: 0.96,
        reasoning: 'Matches both intents clearly.',
      });

      const result = await resolveAuthorizedAmbiguity(
        ['Use approach A', 'Use approach B'],
        'Build the feature',
        'Phase 1: implement, Phase 2: test',
        auditFn,
      );

      expect(result.resolved).toBe(true);
      expect(result.escalateToHuman).toBe(false);
      expect(result.selectedInterpretation).toBe('Use approach A');
    });

    it('escalates when no interpretation reaches 95% from both agents', async () => {
      const auditFn = async () => ({
        promptIntentConfidence: 0.80,
        planIntentConfidence: 0.70,
        reasoning: 'Unclear alignment.',
      });

      const result = await resolveAuthorizedAmbiguity(
        ['Interpretation X', 'Interpretation Y'],
        'Ambiguous request',
        'Ambiguous plan',
        auditFn,
      );

      expect(result.resolved).toBe(false);
      expect(result.escalateToHuman).toBe(true);
    });

    it('selects highest-rated viable interpretation', async () => {
      let callCount = 0;
      const auditFn = async (interp: string) => {
        callCount++;
        if (interp === 'Better option') {
          return { promptIntentConfidence: 0.99, planIntentConfidence: 0.98, reasoning: 'Strong match.' };
        }
        return { promptIntentConfidence: 0.95, planIntentConfidence: 0.95, reasoning: 'Acceptable match.' };
      };

      const result = await resolveAuthorizedAmbiguity(
        ['Okay option', 'Better option'],
        'prompt', 'plan', auditFn,
      );

      expect(result.resolved).toBe(true);
      expect(result.selectedInterpretation).toBe('Better option');
      expect(callCount).toBe(4); // 2 interpretations × 2 agents
    });

    it('fails if one agent scores below 95% even if other is above', async () => {
      const auditFn = async (_i: string, _p: string, _pl: string, agentIndex: number) => {
        if (agentIndex === 0) {
          return { promptIntentConfidence: 0.99, planIntentConfidence: 0.99, reasoning: 'Agent 1 confident.' };
        }
        return { promptIntentConfidence: 0.85, planIntentConfidence: 0.99, reasoning: 'Agent 2 unsure on prompt.' };
      };

      const result = await resolveAuthorizedAmbiguity(
        ['Only option'], 'prompt', 'plan', auditFn,
      );

      expect(result.resolved).toBe(false);
      expect(result.escalateToHuman).toBe(true);
    });

    it('fails if plan intent is below 95% even if prompt intent is high', async () => {
      const auditFn = async () => ({
        promptIntentConfidence: 0.99,
        planIntentConfidence: 0.90,
        reasoning: 'Prompt matches but plan is unclear.',
      });

      const result = await resolveAuthorizedAmbiguity(
        ['Interpretation A'], 'prompt', 'plan', auditFn,
      );

      expect(result.resolved).toBe(false);
      expect(result.escalateToHuman).toBe(true);
    });

    it('returns agent scores for transparency', async () => {
      const auditFn = async (_i: string, _p: string, _pl: string, agentIndex: number) => ({
        promptIntentConfidence: 0.96,
        planIntentConfidence: 0.97,
        reasoning: `Agent ${agentIndex} analysis.`,
      });

      const result = await resolveAuthorizedAmbiguity(
        ['Option 1', 'Option 2'], 'prompt', 'plan', auditFn,
      );

      expect(result.agentScores.agent1).toHaveLength(2);
      expect(result.agentScores.agent2).toHaveLength(2);
      expect(result.agentScores.agent1[0].reasoning).toContain('Agent 0');
      expect(result.agentScores.agent2[0].reasoning).toContain('Agent 1');
    });
  });

  // ------------------------------------------------------------------
  // 9c. isAmbiguityGenuine flags auditRequired for authorized ambiguous work
  // ------------------------------------------------------------------
  describe('isAmbiguityGenuine with authorized context', () => {
    it('flags auditRequired when authorized work has genuine ambiguity', () => {
      const result = isAmbiguityGenuine(
        ['Implement using approach A with refactoring', 'Implement using approach B with optimization'],
        { authorized: true },
      );
      // Authorized non-sequential ambiguity must reach the audit path, not auto-select
      expect(result.genuine).toBe(true);
      expect(result.auditRequired).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 10. executePlanningSubflow runs all phases sequentially
  // ------------------------------------------------------------------
  describe('executePlanningSubflow', () => {
    it('runs all phases and produces a complete result', async () => {
      setupStoreMocks();

      const result = await executePlanningSubflow('Implement a login feature', {});

      expect(result.subflowId).toBeDefined();
      expect(result.task).toBe('Implement a login feature');
      expect(result.phases).toHaveLength(10);
      expect(result.solutions.length).toBeGreaterThan(0);
      expect(result.selectedSolution).toBeDefined();
      expect(result.arbitrationResult).toBeDefined();
      expect(result.finalPlan).toBeDefined();
      expect(result.status).toBe('completed');
      expect(result.startedAt).toBeDefined();
      expect(result.completedAt).toBeDefined();

      // All phases should be completed
      for (const phase of result.phases) {
        expect(phase.status).toBe('completed');
      }
    });

    it('persists the result to the store', async () => {
      const { getPersistedStore } = setupStoreMocks();

      const result = await executePlanningSubflow('Test persistence', {});

      const store = getPersistedStore();
      expect(store.subflows[result.subflowId]).toBeDefined();
    });

    it('selects the top-ranked solution', async () => {
      setupStoreMocks();

      const result = await executePlanningSubflow('Build a feature', {});

      expect(result.selectedSolution).toBeDefined();
      expect(result.selectedSolution!.rank).toBe(1);
    });

    it('includes clarification when arbitration is not unanimous', async () => {
      setupStoreMocks();

      // A security-related task will likely trigger non-unanimous arbitration
      // due to security gaps in the generated solutions
      const result = await executePlanningSubflow(
        'Implement token authentication with secret management',
        {},
      );

      // Whether clarification is needed depends on the arbitration outcome
      if (result.arbitrationResult && !result.arbitrationResult.unanimous) {
        expect(result.clarificationNeeded).toBeDefined();
      }
    });

    it('wires dual-agent audit when arbitration is non-unanimous and auditFn provided', async () => {
      setupStoreMocks();

      const auditFn = async () => ({
        promptIntentConfidence: 0.96,
        planIntentConfidence: 0.97,
        reasoning: 'Clear intent',
      });

      // Security task triggers non-unanimous arbitration
      const result = await executePlanningSubflow(
        'Implement token authentication with secret management',
        {},
        auditFn,
      );

      // Only assert audit wiring when arbitration was actually non-unanimous
      if (result.arbitrationResult && !result.arbitrationResult.unanimous) {
        expect(result.intentAuditResult).toBeDefined();
        expect(result.intentAuditResult!.resolved).toBe(true);
        expect(result.arbitrationResult.escalation).toBeDefined();
        expect(result.arbitrationResult.escalation!.decision).toBe('pass-with-caveats');
      }
    });

    it('escalates when audit cannot resolve', async () => {
      setupStoreMocks();

      const auditFn = async () => ({
        promptIntentConfidence: 0.5,
        planIntentConfidence: 0.5,
        reasoning: 'Unclear alignment',
      });

      const result = await executePlanningSubflow(
        'Implement token authentication with secret management',
        {},
        auditFn,
      );

      if (result.arbitrationResult && !result.arbitrationResult.unanimous) {
        expect(result.intentAuditResult).toBeDefined();
        expect(result.intentAuditResult!.resolved).toBe(false);
        expect(result.arbitrationResult.escalation).toBeDefined();
        expect(result.arbitrationResult.escalation!.decision).toBe('continue-iterating');
        expect(result.clarificationNeeded).toBeDefined();
        expect(result.clarificationNeeded).toContain('Dual-agent audit could not resolve');
      }
    });

    it('preserves original behavior when auditFn is omitted', async () => {
      setupStoreMocks();

      const result = await executePlanningSubflow(
        'Implement token authentication with secret management',
        {},
      );

      // intentAuditResult should never be set without an auditFn
      expect(result.intentAuditResult).toBeUndefined();

      // escalation should not be set without an auditFn
      if (result.arbitrationResult) {
        expect(result.arbitrationResult.escalation).toBeUndefined();
      }
    });
  });
});
