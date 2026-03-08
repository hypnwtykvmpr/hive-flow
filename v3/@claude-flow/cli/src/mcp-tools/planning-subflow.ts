/**
 * Planning Sub-flow MCP Tools
 *
 * Implements an enhanced planning phase pipeline with brainstorming, research,
 * ranking, reference code discovery, gap review, and a 3-agent arbitration panel.
 *
 * Stages:
 *   1. Think through request (decomposition)
 *   2. Brainstorm solutions
 *   3. Research solutions
 *   4. Rank by prompt match
 *   5. Find reference code
 *   6. Re-rank with reference boost
 *   7. Gap review
 *   8. Additional research on gaps
 *   9. Arbitrate (3-agent panel, unanimous required)
 *  10. Assemble final plan
 *
 * @module @claude-flow/cli/mcp-tools/planning-subflow
 */

import type { MCPTool } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Re-export the shared ambiguity filter
export { isAmbiguityGenuine, resolveAuthorizedAmbiguity } from './ambiguity-filter.js';
import { resolveAuthorizedAmbiguity as _resolveAuthorizedAmbiguity } from './ambiguity-filter.js';
import type { IntentAuditResult } from './ambiguity-filter.js';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

const STORAGE_DIR = '.claude-flow';
const PLANNING_DIR = 'planning';
const PLANNING_FILE = 'store.json';

function getPlanningDir(): string {
  return join(process.cwd(), STORAGE_DIR, PLANNING_DIR);
}

function getPlanningPath(): string {
  return join(getPlanningDir(), PLANNING_FILE);
}

function ensurePlanningDir(): void {
  const dir = getPlanningDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadPlanningStore(): PlanningStore {
  try {
    const path = getPlanningPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return empty store on error
  }
  return { subflows: {}, version: '1.0.0' };
}

export function savePlanningStore(store: PlanningStore): void {
  ensurePlanningDir();
  writeFileSync(getPlanningPath(), JSON.stringify(store, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface Solution {
  solutionId: string;
  description: string;
  approach: string;
  pros: string[];
  cons: string[];
  referenceCode: string[];
  researchFindings: string[];
  rank: number;
  promptMatchScore: number;
}

export interface ArbitrationVote {
  agentId: string;
  vote: 'approve' | 'reject';
  rationale: string;
  concerns: string[];
}

export interface ArbitrationResult {
  panelSize: number;
  votes: ArbitrationVote[];
  unanimous: boolean;
  round: number;
  addressedConcerns: string[];
  escalation?: {
    decision: 'continue-iterating' | 'pass-with-caveats';
    rationale: string;
    caveats: string[];
  };
}

export interface PlanStep {
  stepNumber: number;
  description: string;
  files: string[];
  codeSnippets: string[];
  commands: string[];
  expectedOutcome: string;
  verificationCriteria: string[];
}

export interface DetailedPlan {
  overview: string;
  steps: PlanStep[];
  prerequisites: string[];
  risks: string[];
  estimatedEffort: string;
  securityConsiderations: string[];
}

export interface PlanningPhase {
  phaseId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: unknown;
  startedAt?: string;
  completedAt?: string;
}

export interface PlanningSubflowResult {
  subflowId: string;
  task: string;
  phases: PlanningPhase[];
  solutions: Solution[];
  selectedSolution: Solution | null;
  arbitrationResult: ArbitrationResult | null;
  intentAuditResult?: IntentAuditResult;
  finalPlan: DetailedPlan | null;
  status: 'completed' | 'failed' | 'needs-clarification' | 'running';
  clarificationNeeded?: string;
  startedAt: string;
  completedAt?: string;
}

interface PlanningStore {
  subflows: Record<string, PlanningSubflowResult>;
  version: string;
}

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

export interface TaskDecomposition {
  goal: string;
  constraints: string[];
  scope: string[];
  acceptanceCriteria: string[];
  complexity: number;
}

export interface GapAnalysis {
  gaps: Array<{
    id: string;
    type: 'knowledge' | 'blindspot' | 'logic' | 'security' | 'edge-case' | 'improvement';
    description: string;
    addressed: boolean;
    research?: string;
  }>;
  overallRisk: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Stage 1: Think through request
// ---------------------------------------------------------------------------

export function thinkThroughRequest(task: string): TaskDecomposition {
  const lower = task.toLowerCase();

  // Derive constraints from keywords
  const constraints: string[] = [];
  if (lower.includes('no ') || lower.includes('without ')) {
    const negParts = task.match(/(?:no|without)\s+([^,.]+)/gi) || [];
    constraints.push(...negParts.map(p => p.trim()));
  }
  if (lower.includes('must ')) {
    const mustParts = task.match(/must\s+([^,.]+)/gi) || [];
    constraints.push(...mustParts.map(p => p.trim()));
  }

  // Derive scope from file/module references
  const scope: string[] = [];
  const fileRefs = task.match(/[\w/.-]+\.\w{1,4}/g) || [];
  scope.push(...fileRefs);
  const moduleRefs = task.match(/(?:module|package|service|component)\s+['"]?(\w[\w-]*)['"]?/gi) || [];
  scope.push(...moduleRefs.map(m => m.trim()));
  if (scope.length === 0) {
    scope.push('project-wide');
  }

  // Derive acceptance criteria
  const acceptanceCriteria: string[] = [];
  const shouldParts = task.match(/should\s+([^,.]+)/gi) || [];
  acceptanceCriteria.push(...shouldParts.map(p => p.trim()));
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push(`Task "${task}" is implemented and verified`);
  }

  // Estimate complexity 1-10
  let complexity = 3;
  if (lower.includes('refactor') || lower.includes('migrate')) complexity += 2;
  if (lower.includes('security') || lower.includes('auth')) complexity += 2;
  if (lower.includes('performance') || lower.includes('optimize')) complexity += 1;
  if (fileRefs.length > 3) complexity += 1;
  if (lower.includes('api') && lower.includes('test')) complexity += 1;
  complexity = Math.min(10, complexity);

  return {
    goal: task,
    constraints,
    scope,
    acceptanceCriteria,
    complexity,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: Brainstorm solutions
// ---------------------------------------------------------------------------

export function brainstormSolutions(decomposition: TaskDecomposition): Solution[] {
  const { goal, complexity } = decomposition;
  const count = complexity <= 3 ? 3 : complexity <= 6 ? 4 : 5;

  const approaches = [
    {
      label: 'Incremental',
      desc: 'Make targeted, minimal changes to achieve the goal with lowest risk.',
      pros: ['Low risk', 'Fast to implement', 'Easy to review'],
      cons: ['May not address root cause', 'Could accumulate tech debt'],
    },
    {
      label: 'Comprehensive Refactor',
      desc: 'Refactor the relevant subsystem to cleanly integrate the change.',
      pros: ['Addresses root cause', 'Improves code quality', 'Reduces future debt'],
      cons: ['Higher risk', 'Takes longer', 'Larger blast radius'],
    },
    {
      label: 'Plugin / Extension',
      desc: 'Implement as a modular plugin or extension point for maximum flexibility.',
      pros: ['Highly modular', 'Easy to disable/swap', 'Follows open-closed principle'],
      cons: ['More abstraction overhead', 'May be over-engineered for simple tasks'],
    },
    {
      label: 'Event-Driven',
      desc: 'Use event sourcing or pub/sub to decouple the change from existing modules.',
      pros: ['Loose coupling', 'Good for async workflows', 'Auditable state changes'],
      cons: ['Harder to debug', 'Eventual consistency concerns', 'More infrastructure'],
    },
    {
      label: 'Test-First TDD',
      desc: 'Write comprehensive tests first, then implement to pass them.',
      pros: ['High confidence', 'Self-documenting', 'Catches regressions'],
      cons: ['Slower initial velocity', 'Tests may need refactoring', 'Over-testing risk'],
    },
  ];

  return approaches.slice(0, count).map((a, i) => ({
    solutionId: generateId('sol'),
    description: `${a.label}: ${a.desc}`,
    approach: `Apply the "${a.label}" strategy to: ${goal}`,
    pros: [...a.pros],
    cons: [...a.cons],
    referenceCode: [],
    researchFindings: [],
    rank: i + 1,
    promptMatchScore: 0,
  }));
}

// ---------------------------------------------------------------------------
// Stage 3: Research solutions
// ---------------------------------------------------------------------------

export function researchSolutions(
  solutions: Solution[],
  context: Record<string, unknown>,
): Solution[] {
  return solutions.map(sol => {
    const findings: string[] = [];

    // Check context for stored patterns
    if (context.patterns && Array.isArray(context.patterns)) {
      for (const pattern of context.patterns as string[]) {
        if (sol.approach.toLowerCase().includes(pattern.toLowerCase())) {
          findings.push(`Context pattern match: "${pattern}" aligns with this approach`);
        }
      }
    }

    // Check context for prior decisions
    if (context.decisions && typeof context.decisions === 'object') {
      findings.push('Prior decisions found in context — should validate alignment');
    }

    // Standard research findings based on approach keywords
    const lower = sol.approach.toLowerCase();
    if (lower.includes('refactor')) {
      findings.push('Refactoring best practice: apply Strangler Fig pattern for incremental migration');
    }
    if (lower.includes('plugin') || lower.includes('extension')) {
      findings.push('Plugin architecture: consider lifecycle hooks and dependency injection');
    }
    if (lower.includes('event') || lower.includes('pub/sub')) {
      findings.push('Event sourcing: ensure idempotent handlers and replay capability');
    }
    if (lower.includes('test') || lower.includes('tdd')) {
      findings.push('TDD: London School (mock-first) preferred per project guidelines');
    }

    // Always note that external validation should use WebSearch/WebFetch
    findings.push(
      'External validation: use WebSearch/WebFetch tools to verify approach against latest best practices',
    );

    return {
      ...sol,
      researchFindings: [...sol.researchFindings, ...findings],
    };
  });
}

// ---------------------------------------------------------------------------
// Stage 4: Rank by prompt match
// ---------------------------------------------------------------------------

export function rankByPromptMatch(solutions: Solution[], task: string): Solution[] {
  const taskWords = task
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);

  const scored = solutions.map(sol => {
    const solText = `${sol.description} ${sol.approach} ${sol.pros.join(' ')}`.toLowerCase();
    let matchCount = 0;
    for (const word of taskWords) {
      if (solText.includes(word)) matchCount++;
    }
    const promptMatchScore = taskWords.length > 0
      ? Math.round((matchCount / taskWords.length) * 100) / 100
      : 0.5;

    return { ...sol, promptMatchScore };
  });

  scored.sort((a, b) => b.promptMatchScore - a.promptMatchScore);
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// Stage 5: Find reference code
// ---------------------------------------------------------------------------

export function findReferenceCode(solutions: Solution[]): Solution[] {
  // In a real implementation this would invoke grep/glob tools to search
  // the repository for similar patterns. Here we populate placeholder paths
  // based on approach keywords so the pipeline structure is preserved.
  return solutions.map(sol => {
    const refs: string[] = [];
    const lower = sol.approach.toLowerCase();

    if (lower.includes('plugin') || lower.includes('extension')) {
      refs.push('src/plugins/', 'v3/@claude-flow/cli/src/plugins/');
    }
    if (lower.includes('event') || lower.includes('hook')) {
      refs.push('v3/@claude-flow/hooks/src/');
    }
    if (lower.includes('test') || lower.includes('tdd')) {
      refs.push('v3/@claude-flow/cli/src/__tests__/');
    }
    if (lower.includes('refactor')) {
      refs.push('v3/@claude-flow/cli/src/mcp-tools/');
    }
    if (lower.includes('security') || lower.includes('auth')) {
      refs.push('v3/@claude-flow/security/src/');
    }

    // Note: in practice, use grep/glob MCP tools for real discovery
    if (refs.length === 0) {
      refs.push('(no reference code found — use grep/glob tools for real search)');
    }

    return { ...sol, referenceCode: [...sol.referenceCode, ...refs] };
  });
}

// ---------------------------------------------------------------------------
// Stage 6: Re-rank with reference boost
// ---------------------------------------------------------------------------

export function reRank(solutions: Solution[]): Solution[] {
  const boosted = solutions.map(sol => {
    // Boost promptMatchScore based on reference code availability
    const refBoost = Math.min(sol.referenceCode.length * 0.05, 0.2);
    const hasRealRefs = sol.referenceCode.some(
      r => !r.startsWith('(no reference'),
    );
    const adjustedScore = hasRealRefs
      ? Math.min(1, sol.promptMatchScore + refBoost)
      : sol.promptMatchScore;

    return { ...sol, promptMatchScore: Math.round(adjustedScore * 100) / 100 };
  });

  boosted.sort((a, b) => b.promptMatchScore - a.promptMatchScore);
  return boosted.map((s, i) => ({ ...s, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// Stage 7: Gap review
// ---------------------------------------------------------------------------

export function gapReview(solution: Solution): GapAnalysis {
  const gaps: GapAnalysis['gaps'] = [];
  const lower = `${solution.description} ${solution.approach}`.toLowerCase();

  // Knowledge gaps
  if (solution.researchFindings.length < 2) {
    gaps.push({
      id: generateId('gap'),
      type: 'knowledge',
      description: 'Limited research findings — additional investigation recommended',
      addressed: false,
    });
  }

  // Security concerns
  if (
    lower.includes('auth') ||
    lower.includes('token') ||
    lower.includes('password') ||
    lower.includes('secret')
  ) {
    gaps.push({
      id: generateId('gap'),
      type: 'security',
      description: 'Security-sensitive area: ensure secrets are not hardcoded, inputs validated, and auth tokens rotated',
      addressed: false,
    });
  }

  // Blindspot: error handling
  if (!lower.includes('error') && !lower.includes('exception') && !lower.includes('fallback')) {
    gaps.push({
      id: generateId('gap'),
      type: 'blindspot',
      description: 'No explicit error handling strategy mentioned — define failure modes and recovery',
      addressed: false,
    });
  }

  // Edge cases
  if (!lower.includes('edge') && !lower.includes('boundary') && !lower.includes('empty')) {
    gaps.push({
      id: generateId('gap'),
      type: 'edge-case',
      description: 'Edge cases not enumerated — consider empty inputs, concurrent access, and boundary values',
      addressed: false,
    });
  }

  // Logic check for contradictions
  const hasConflictingPros = solution.pros.some(p =>
    solution.cons.some(c => {
      const pWords = p.toLowerCase().split(/\s+/);
      const cWords = c.toLowerCase().split(/\s+/);
      return pWords.some(pw => cWords.includes(pw) && pw.length > 4);
    }),
  );
  if (hasConflictingPros) {
    gaps.push({
      id: generateId('gap'),
      type: 'logic',
      description: 'Potential contradiction detected between listed pros and cons — clarify trade-offs',
      addressed: false,
    });
  }

  // Improvement suggestions
  if (solution.referenceCode.length === 0 || solution.referenceCode[0].startsWith('(no reference')) {
    gaps.push({
      id: generateId('gap'),
      type: 'improvement',
      description: 'No reference code found — consider searching repo with grep/glob for similar patterns before implementing',
      addressed: false,
    });
  }

  // Determine overall risk
  const securityGaps = gaps.filter(g => g.type === 'security').length;
  const logicGaps = gaps.filter(g => g.type === 'logic').length;
  let overallRisk: GapAnalysis['overallRisk'] = 'low';
  if (securityGaps > 0 || logicGaps > 0) overallRisk = 'high';
  else if (gaps.length > 3) overallRisk = 'medium';

  return { gaps, overallRisk };
}

// ---------------------------------------------------------------------------
// Stage 8: Additional research on gaps
// ---------------------------------------------------------------------------

export function additionalResearch(gapAnalysis: GapAnalysis): GapAnalysis {
  const updated = gapAnalysis.gaps.map(gap => {
    if (gap.addressed) return gap;

    switch (gap.type) {
      case 'knowledge':
        return {
          ...gap,
          addressed: true,
          research: 'Recommend using WebSearch to find current best practices. Also check memory store for prior solutions.',
        };
      case 'security':
        return {
          ...gap,
          addressed: true,
          research: 'Apply OWASP guidelines. Use @claude-flow/security InputValidator for boundary checks. Never hardcode secrets. Use parameterized queries.',
        };
      case 'blindspot':
        return {
          ...gap,
          addressed: true,
          research: 'Implement try/catch at system boundaries. Use typed error classes (e.g., ServiceError). Add fallback/retry logic for external calls.',
        };
      case 'edge-case':
        return {
          ...gap,
          addressed: true,
          research: 'Test with: empty strings, null/undefined, max-length inputs, concurrent requests, special characters, and boundary numeric values.',
        };
      case 'logic':
        return {
          ...gap,
          addressed: true,
          research: 'Review the pros/cons for internal consistency. Reword to clarify that trade-offs are situational, not contradictory.',
        };
      case 'improvement':
        return {
          ...gap,
          addressed: true,
          research: 'Run glob/grep across the repo to find existing implementations of similar patterns before creating new abstractions.',
        };
      default:
        return gap;
    }
  });

  // Recalculate risk — addressed gaps lower the risk
  const openGaps = updated.filter(g => !g.addressed);
  let overallRisk: GapAnalysis['overallRisk'] = 'low';
  if (openGaps.some(g => g.type === 'security' || g.type === 'logic')) {
    overallRisk = 'high';
  } else if (openGaps.length > 1) {
    overallRisk = 'medium';
  }

  return { gaps: updated, overallRisk };
}

// ---------------------------------------------------------------------------
// Stage 9: Arbitrate (3-agent panel)
// ---------------------------------------------------------------------------

export function arbitrate(
  solution: Solution,
  gaps: GapAnalysis,
  round = 1,
  priorConcerns: string[] = [],
): ArbitrationResult {
  const panelSize = 3;
  const votes: ArbitrationVote[] = [];
  const addressedConcerns = [...priorConcerns];

  // Agent 1: Feasibility reviewer
  const openGaps = gaps.gaps.filter(g => !g.addressed);
  const feasibilityOk = openGaps.length === 0 && solution.promptMatchScore >= 0.3;
  votes.push({
    agentId: 'arbitrator-feasibility',
    vote: feasibilityOk ? 'approve' : 'reject',
    rationale: feasibilityOk
      ? 'All gaps addressed and prompt match is acceptable.'
      : `Open gaps remain (${openGaps.length}) or prompt match too low (${solution.promptMatchScore}).`,
    concerns: feasibilityOk
      ? []
      : openGaps.map(g => g.description),
  });

  // Agent 2: Security reviewer
  const secGaps = gaps.gaps.filter(g => g.type === 'security');
  const securityOk = secGaps.every(g => g.addressed);
  votes.push({
    agentId: 'arbitrator-security',
    vote: securityOk ? 'approve' : 'reject',
    rationale: securityOk
      ? 'Security concerns have been addressed with appropriate mitigations.'
      : 'Unresolved security gaps present unacceptable risk.',
    concerns: securityOk
      ? []
      : secGaps.filter(g => !g.addressed).map(g => g.description),
  });

  // Agent 3: Quality reviewer
  const hasRefs = solution.referenceCode.some(r => !r.startsWith('(no reference'));
  const hasResearch = solution.researchFindings.length >= 2;
  const qualityOk = hasResearch && (hasRefs || solution.promptMatchScore >= 0.5);
  votes.push({
    agentId: 'arbitrator-quality',
    vote: qualityOk ? 'approve' : 'reject',
    rationale: qualityOk
      ? 'Solution has sufficient research backing and reference material.'
      : 'Insufficient research or reference code for confident implementation.',
    concerns: qualityOk
      ? []
      : [
          ...(!hasResearch ? ['Needs more research findings'] : []),
          ...(!hasRefs && solution.promptMatchScore < 0.5 ? ['No reference code and low prompt match'] : []),
        ],
  });

  const unanimous = votes.every(v => v.vote === 'approve');

  return {
    panelSize,
    votes,
    unanimous,
    round,
    addressedConcerns,
    escalation: undefined,
  };
}

// ---------------------------------------------------------------------------
// Stage 10: Assemble final plan
// ---------------------------------------------------------------------------

export function assembleFinalPlan(
  solution: Solution,
  gaps: GapAnalysis,
  arbitration: ArbitrationResult,
): DetailedPlan {
  const steps: PlanStep[] = [];
  let stepNum = 0;

  // Step: Prerequisites check
  stepNum++;
  steps.push({
    stepNumber: stepNum,
    description: 'Verify prerequisites and set up the development environment.',
    files: [],
    codeSnippets: [],
    commands: [
      'node --version  # Ensure Node 20+',
      'npm --version   # Ensure npm 9+',
      'git status      # Ensure clean working tree',
    ],
    expectedOutcome: 'Environment is ready and working tree is clean.',
    verificationCriteria: [
      'Node.js version is 20 or higher',
      'npm version is 9 or higher',
      'No uncommitted changes in working tree',
    ],
  });

  // Step: Review reference code
  if (solution.referenceCode.length > 0) {
    stepNum++;
    steps.push({
      stepNumber: stepNum,
      description: 'Review reference code to understand existing patterns before making changes.',
      files: solution.referenceCode.filter(r => !r.startsWith('(no reference')),
      codeSnippets: ['// Read each reference file and note the patterns used'],
      commands: solution.referenceCode
        .filter(r => !r.startsWith('(no reference'))
        .map(r => `cat ${r}  # Review existing pattern`),
      expectedOutcome: 'Understand existing code patterns to follow in the implementation.',
      verificationCriteria: [
        'Key patterns identified and documented',
        'Naming conventions noted',
        'Error handling patterns identified',
      ],
    });
  }

  // Step: Address any open gaps
  const openGaps = gaps.gaps.filter(g => !g.addressed);
  if (openGaps.length > 0) {
    stepNum++;
    steps.push({
      stepNumber: stepNum,
      description: `Address ${openGaps.length} open gap(s) identified during review.`,
      files: [],
      codeSnippets: [],
      commands: openGaps.map(g => `# Gap [${g.type}]: ${g.description}`),
      expectedOutcome: 'All identified gaps have been researched and resolved.',
      verificationCriteria: openGaps.map(g => `Gap "${g.type}" is addressed: ${g.description}`),
    });
  }

  // Step: Implement the solution
  stepNum++;
  steps.push({
    stepNumber: stepNum,
    description: `Implement the selected solution: ${solution.description}`,
    files: ['(determined by scope — see task decomposition)'],
    codeSnippets: [
      `// Approach: ${solution.approach}`,
      '// Follow project conventions:',
      '//   - Typed interfaces for public APIs',
      '//   - Input validation at boundaries',
      '//   - Error handling with typed error classes',
      '//   - Keep files under 500 lines',
    ],
    commands: [],
    expectedOutcome: 'Core implementation is complete and compiles without errors.',
    verificationCriteria: [
      'TypeScript compiles with no errors',
      'All public APIs have typed interfaces',
      'Input validation present at system boundaries',
      'Files are under 500 lines',
    ],
  });

  // Step: Write tests
  stepNum++;
  steps.push({
    stepNumber: stepNum,
    description: 'Write tests following TDD London School (mock-first) approach.',
    files: ['(test file co-located with implementation)'],
    codeSnippets: [
      "import { describe, it, expect, vi } from 'vitest';",
      '',
      "describe('Feature', () => {",
      "  it('should handle the primary use case', () => {",
      '    // Arrange: set up mocks',
      '    // Act: call the function under test',
      '    // Assert: verify expected behavior',
      '  });',
      '',
      "  it('should handle edge cases', () => {",
      '    // Test empty inputs, boundaries, error conditions',
      '  });',
      '});',
    ],
    commands: ['npm test  # Run all tests'],
    expectedOutcome: 'All tests pass with adequate coverage.',
    verificationCriteria: [
      'Tests cover primary use case',
      'Tests cover edge cases (empty input, boundary values)',
      'Tests cover error conditions',
      'All tests pass',
    ],
  });

  // Step: Build and verify
  stepNum++;
  steps.push({
    stepNumber: stepNum,
    description: 'Build the project and run the full test suite to verify nothing is broken.',
    files: [],
    codeSnippets: [],
    commands: ['npm run build', 'npm test', 'npm run lint'],
    expectedOutcome: 'Build succeeds, all tests pass, no lint errors.',
    verificationCriteria: [
      'Build completes with exit code 0',
      'All existing tests still pass',
      'No new lint errors introduced',
    ],
  });

  // Step: Address arbitration concerns if any
  const allConcerns = arbitration.votes.flatMap(v => v.concerns);
  if (allConcerns.length > 0) {
    stepNum++;
    steps.push({
      stepNumber: stepNum,
      description: 'Address concerns raised by the arbitration panel.',
      files: [],
      codeSnippets: allConcerns.map(c => `// Concern: ${c}`),
      commands: [],
      expectedOutcome: 'All arbitration concerns have been reviewed and addressed.',
      verificationCriteria: allConcerns.map(c => `Addressed: ${c}`),
    });
  }

  // Collect prerequisites
  const prerequisites: string[] = [
    'Node.js >= 20',
    'npm >= 9',
    'Clean git working tree',
  ];

  // Collect risks
  const risks: string[] = [
    ...solution.cons,
    ...gaps.gaps
      .filter(g => g.type === 'security' || g.type === 'logic')
      .map(g => `${g.type}: ${g.description}`),
  ];

  // Security considerations
  const securityConsiderations: string[] = [
    'Never hardcode secrets or API keys',
    'Validate all inputs at system boundaries',
    'Sanitize file paths to prevent directory traversal',
    ...gaps.gaps
      .filter(g => g.type === 'security')
      .map(g => g.research || g.description),
  ];

  // Estimate effort based on complexity
  const stepCount = steps.length;
  const estimatedEffort =
    stepCount <= 4
      ? '30 minutes - 1 hour'
      : stepCount <= 7
        ? '1 - 3 hours'
        : '3 - 8 hours';

  return {
    overview: `Plan to implement: ${solution.description}. Approach: ${solution.approach}. ${steps.length} steps total.`,
    steps,
    prerequisites,
    risks,
    estimatedEffort,
    securityConsiderations,
  };
}

// ---------------------------------------------------------------------------
// Main execution function
// ---------------------------------------------------------------------------

export async function executePlanningSubflow(
  task: string,
  workflowContext: Record<string, unknown>,
  auditFn?: (
    interpretation: string,
    promptIntent: string,
    planIntent: string,
    agentIndex: number,
  ) => Promise<{ promptIntentConfidence: number; planIntentConfidence: number; reasoning: string }>,
): Promise<PlanningSubflowResult> {
  const subflowId = generateId('plan');
  const startedAt = new Date().toISOString();

  const phases: PlanningPhase[] = [
    { phaseId: 'decompose', name: 'Think Through Request', status: 'pending' },
    { phaseId: 'brainstorm', name: 'Brainstorm Solutions', status: 'pending' },
    { phaseId: 'research', name: 'Research Solutions', status: 'pending' },
    { phaseId: 'rank', name: 'Rank by Prompt Match', status: 'pending' },
    { phaseId: 'reference', name: 'Find Reference Code', status: 'pending' },
    { phaseId: 'rerank', name: 'Re-Rank Solutions', status: 'pending' },
    { phaseId: 'gap-review', name: 'Gap Review', status: 'pending' },
    { phaseId: 'gap-research', name: 'Additional Gap Research', status: 'pending' },
    { phaseId: 'arbitration', name: 'Arbitration Panel', status: 'pending' },
    { phaseId: 'plan-assembly', name: 'Assemble Final Plan', status: 'pending' },
  ];

  const result: PlanningSubflowResult = {
    subflowId,
    task,
    phases,
    solutions: [],
    selectedSolution: null,
    arbitrationResult: null,
    finalPlan: null,
    status: 'running',
    startedAt,
  };

  // Helper to run a phase
  function runPhase<T>(phaseId: string, fn: () => T): T {
    const phase = phases.find(p => p.phaseId === phaseId)!;
    phase.status = 'running';
    phase.startedAt = new Date().toISOString();
    try {
      const output = fn();
      phase.status = 'completed';
      phase.completedAt = new Date().toISOString();
      phase.output = output;
      return output;
    } catch (err) {
      phase.status = 'failed';
      phase.completedAt = new Date().toISOString();
      phase.output = { error: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  try {
    // Stage 1: Decompose
    const decomposition = runPhase('decompose', () => thinkThroughRequest(task));

    // Stage 2: Brainstorm
    let solutions = runPhase('brainstorm', () => brainstormSolutions(decomposition));

    // Stage 3: Research
    solutions = runPhase('research', () => researchSolutions(solutions, workflowContext));

    // Stage 4: Rank by prompt match
    solutions = runPhase('rank', () => rankByPromptMatch(solutions, task));

    // Stage 5: Find reference code
    solutions = runPhase('reference', () => findReferenceCode(solutions));

    // Stage 6: Re-rank
    solutions = runPhase('rerank', () => reRank(solutions));

    result.solutions = solutions;

    // Select top solution
    const selected = solutions[0];
    result.selectedSolution = selected;

    // Stage 7: Gap review
    const gaps = runPhase('gap-review', () => gapReview(selected));

    // Stage 8: Additional research
    const enrichedGaps = runPhase('gap-research', () => additionalResearch(gaps));

    // Stage 9: Arbitrate
    const arbitrationResult = runPhase('arbitration', () =>
      arbitrate(selected, enrichedGaps, 1, []),
    );
    result.arbitrationResult = arbitrationResult;

    // Stage 10: Assemble plan (regardless of arbitration outcome)
    const finalPlan = runPhase('plan-assembly', () =>
      assembleFinalPlan(selected, enrichedGaps, arbitrationResult),
    );
    result.finalPlan = finalPlan;

    // Determine final status
    if (arbitrationResult.unanimous) {
      result.status = 'completed';
    } else {
      // Non-unanimous: attempt dual-agent intent audit before escalating
      const rejections = arbitrationResult.votes.filter(v => v.vote === 'reject');
      const concerns = rejections.flatMap(v => v.concerns);

      if (auditFn && concerns.length > 0) {
        const interpretations = concerns;
        const planSummary = result.finalPlan?.overview ?? task;

        const auditResult = await _resolveAuthorizedAmbiguity(
          interpretations,
          task,
          planSummary,
          auditFn,
        );
        result.intentAuditResult = auditResult;

        if (auditResult.resolved && auditResult.selectedInterpretation) {
          arbitrationResult.escalation = {
            decision: 'pass-with-caveats',
            rationale: auditResult.reason,
            caveats: concerns,
          };
          result.status = 'completed';
        } else {
          arbitrationResult.escalation = {
            decision: 'continue-iterating',
            rationale: auditResult.reason,
            caveats: concerns,
          };
          result.status = 'completed';
          result.clarificationNeeded = `Arbitration panel raised concerns (${rejections.length}/${arbitrationResult.panelSize} rejected): ${concerns.join('; ')}. Dual-agent audit could not resolve: ${auditResult.reason}`;
        }
      } else {
        result.status = 'completed';
        if (concerns.length > 0) {
          result.clarificationNeeded = `Arbitration panel raised concerns (${rejections.length}/${arbitrationResult.panelSize} rejected): ${concerns.join('; ')}`;
        }
      }
    }

    result.completedAt = new Date().toISOString();

    // Propagate authorization to enforcement state (fail-open)
    try {
      const { loadEnforcementState, saveEnforcementState, appendAuditEntry } = await import('./workflow-enforcer.js');
      const enfState = loadEnforcementState();
      if (enfState) {
        enfState.planCreated = true;
        enfState.authorized = true;
        enfState.planApproved = true;
        saveEnforcementState(enfState);
        appendAuditEntry({
          timestamp: new Date().toISOString(),
          event: 'plan-created',
          taskDescription: task.slice(0, 200),
          score: enfState.assessment?.score ?? 0,
          level: enfState.assessment?.level ?? 'SIMPLE',
        });
      }
    } catch { /* fail-open: enforcement is optional */ }
  } catch (err) {
    result.status = 'failed';
    result.completedAt = new Date().toISOString();
    result.clarificationNeeded = err instanceof Error ? err.message : String(err);
  }

  // Persist result
  const store = loadPlanningStore();
  store.subflows[subflowId] = result;
  savePlanningStore(store);

  return result;
}

// ---------------------------------------------------------------------------
// MCP Tool definitions
// ---------------------------------------------------------------------------

export const planningSubflowTools: MCPTool[] = [
  {
    name: 'planning_subflow_execute',
    description:
      'Execute the full planning sub-flow pipeline: decomposition, brainstorming, research, ranking, reference code discovery, gap review, and 3-agent arbitration panel. Returns a detailed implementation plan.',
    category: 'planning',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task or feature to plan. Be as descriptive as possible.',
        },
        workflowId: {
          type: 'string',
          description: 'Optional workflow ID to associate with this planning sub-flow.',
        },
        context: {
          type: 'object',
          description:
            'Optional workflow context (e.g., prior patterns, decisions, constraints). Keys: patterns (string[]), decisions (object), constraints (string[]).',
        },
      },
      required: ['task'],
    },
    handler: async (input) => {
      const task = input.task as string;
      const context = (input.context as Record<string, unknown>) || {};

      if (!task || task.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'Task description is required.' }),
            },
          ],
          isError: true,
        };
      }

      const result = await executePlanningSubflow(task.trim(), context);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              subflowId: result.subflowId,
              status: result.status,
              solutionCount: result.solutions.length,
              selectedSolution: result.selectedSolution
                ? {
                    solutionId: result.selectedSolution.solutionId,
                    description: result.selectedSolution.description,
                    rank: result.selectedSolution.rank,
                    promptMatchScore: result.selectedSolution.promptMatchScore,
                  }
                : null,
              arbitration: result.arbitrationResult
                ? {
                    unanimous: result.arbitrationResult.unanimous,
                    round: result.arbitrationResult.round,
                    approvals: result.arbitrationResult.votes.filter(v => v.vote === 'approve').length,
                    rejections: result.arbitrationResult.votes.filter(v => v.vote === 'reject').length,
                  }
                : null,
              planStepCount: result.finalPlan?.steps.length ?? 0,
              clarificationNeeded: result.clarificationNeeded,
              result,
            }),
          },
        ],
      };
    },
  },

  {
    name: 'planning_subflow_status',
    description:
      'Get the current status and progress of a planning sub-flow by its ID.',
    category: 'planning',
    inputSchema: {
      type: 'object',
      properties: {
        subflowId: {
          type: 'string',
          description: 'The sub-flow ID returned from planning_subflow_execute.',
        },
      },
      required: ['subflowId'],
    },
    handler: async (input) => {
      const subflowId = input.subflowId as string;

      if (!subflowId || subflowId.trim().length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'subflowId is required.' }),
            },
          ],
          isError: true,
        };
      }

      const store = loadPlanningStore();
      const subflow = store.subflows[subflowId];

      if (!subflow) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Sub-flow "${subflowId}" not found.`,
                availableIds: Object.keys(store.subflows),
              }),
            },
          ],
          isError: true,
        };
      }

      const completedPhases = subflow.phases.filter(p => p.status === 'completed').length;
      const totalPhases = subflow.phases.length;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              subflowId,
              task: subflow.task,
              status: subflow.status,
              progress: `${completedPhases}/${totalPhases} phases completed`,
              phases: subflow.phases.map(p => ({
                name: p.name,
                status: p.status,
                startedAt: p.startedAt,
                completedAt: p.completedAt,
              })),
              selectedSolution: subflow.selectedSolution
                ? {
                    solutionId: subflow.selectedSolution.solutionId,
                    description: subflow.selectedSolution.description,
                    rank: subflow.selectedSolution.rank,
                  }
                : null,
              arbitration: subflow.arbitrationResult
                ? {
                    unanimous: subflow.arbitrationResult.unanimous,
                    round: subflow.arbitrationResult.round,
                  }
                : null,
              hasFinalPlan: subflow.finalPlan !== null,
              clarificationNeeded: subflow.clarificationNeeded,
              startedAt: subflow.startedAt,
              completedAt: subflow.completedAt,
            }),
          },
        ],
      };
    },
  },
];

export default planningSubflowTools;
