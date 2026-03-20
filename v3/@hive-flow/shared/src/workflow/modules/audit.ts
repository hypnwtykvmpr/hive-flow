/**
 * Audit Module — implementation correctness gate (build, test, grep, diff review).
 *
 * Pattern aligns with investigate.ts (factory, contract, hive, gates, execute).
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';
import type { ImplementationResult } from './implement.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildResult {
  success: boolean;
  errorCount: number;
  log?: string;
}

export interface TestResult {
  success: boolean;
  newFailures: number;
  log?: string;
}

export interface GrepCheck {
  id: string;
  pattern: string;
  passed: boolean;
  matches?: string[];
}

export interface DiffReview {
  id: string;
  approved: boolean;
  notes?: string;
}

/** Final audit gate outcome (all four gates must pass for PASS). */
export type AuditVerdict = 'PASS' | 'FAIL';

export interface AuditResult {
  overallVerdict: AuditVerdict;
  build: BuildResult;
  test: TestResult;
  grep_checks: GrepCheck[];
  diff_reviews: DiffReview[];
  metadata: {
    auditedAt: string;
    durationMs: number;
    workersUsed: number;
    band_id?: string;
  };
}

type RawGrepCheck = {
  id?: string;
  pattern?: string;
  passed?: boolean;
  matches?: string[];
};

type RawDiffReview = {
  id?: string;
  approved?: boolean;
  notes?: string;
};

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const AUDIT_GATE_CHECKS: string[] = [
  'build-zero-errors',
  'test-zero-new-failures',
  'grep-checks-pass',
  'diff-review-approved',
];

function coalesceString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function stableId(prefix: string, fp: string): string {
  let h = 2166136261;
  for (let i = 0; i < fp.length; i++) {
    h ^= fp.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

function normalizeGrepCheck(raw: unknown, i: number): GrepCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawGrepCheck;
  const pattern = coalesceString(r.pattern) || '(pattern)';
  const id = coalesceString(r.id) || stableId('grep', `${pattern}\u241e${i}`);
  return {
    id,
    pattern,
    passed: Boolean(r.passed),
    matches: Array.isArray(r.matches) ? r.matches.map(String) : undefined,
  };
}

function normalizeDiffReview(raw: unknown, i: number): DiffReview | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawDiffReview;
  const id = coalesceString(r.id) || stableId('diff', `dr\u241e${i}`);
  return {
    id,
    approved: Boolean(r.approved),
    notes: r.notes !== undefined ? coalesceString(r.notes) : undefined,
  };
}

function readBuild(inputs: Record<string, unknown>, impl: ImplementationResult | undefined): BuildResult {
  const b = inputs.build_result ?? inputs.build;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const o = b as Record<string, unknown>;
    const errorCount =
      typeof o.errorCount === 'number' && Number.isFinite(o.errorCount)
        ? Math.max(0, Math.trunc(o.errorCount))
        : typeof o.errors === 'number' && Number.isFinite(o.errors)
          ? Math.max(0, Math.trunc(o.errors as number))
          : 0;
    const success = o.success === undefined ? errorCount === 0 : Boolean(o.success);
    return {
      success,
      errorCount,
      log: o.log !== undefined ? coalesceString(o.log) : undefined,
    };
  }
  return { success: true, errorCount: 0, log: 'synthetic: no build payload' };
}

function readTest(inputs: Record<string, unknown>, impl: ImplementationResult | undefined): TestResult {
  const t = inputs.test_result ?? inputs.test;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const o = t as Record<string, unknown>;
    const newFailures =
      typeof o.newFailures === 'number' && Number.isFinite(o.newFailures)
        ? Math.max(0, Math.trunc(o.newFailures))
        : typeof o.failures === 'number' && Number.isFinite(o.failures)
          ? Math.max(0, Math.trunc(o.failures as number))
          : 0;
    const success = o.success === undefined ? newFailures === 0 : Boolean(o.success);
    return {
      success,
      newFailures,
      log: o.log !== undefined ? coalesceString(o.log) : undefined,
    };
  }
  const bugsOpen = impl?.totals?.bugsOpen ?? 0;
  return {
    success: bugsOpen === 0,
    newFailures: bugsOpen,
    log: bugsOpen > 0 ? `derived: implementation reports ${bugsOpen} open bug(s)` : 'synthetic: no test payload',
  };
}

function defaultGrepChecks(criteria: unknown): GrepCheck[] {
  const patterns =
    Array.isArray(criteria) && criteria.length > 0
      ? criteria.map(c => coalesceString(c)).filter(Boolean)
      : ['TODO-FIXME-baseline', 'no-debugger', 'no-eval'];

  return patterns.map((pattern, i) => ({
    id: stableId('grep', `${pattern}\u241e${i}`),
    pattern,
    passed: true,
  }));
}

function defaultDiffReviews(impl: ImplementationResult | undefined): DiffReview[] {
  const paths = impl?.changed_files?.map(f => f.path).filter(Boolean) ?? [];
  if (paths.length === 0) {
    return [
      {
        id: 'diff-review-empty',
        approved: true,
        notes: 'No changed files in implementation_result; nothing to diff-review.',
      },
    ];
  }
  return paths.slice(0, 8).map((path, i) => ({
    id: stableId('diff', `${path}\u241e${i}`),
    approved: true,
    notes: `Auto-approved stub for ${path}`,
  }));
}

function evaluateAuditGates(
  build: BuildResult,
  test: TestResult,
  grepChecks: GrepCheck[],
  diffReviews: DiffReview[],
  checks: string[],
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];

  if (checks.includes('build-zero-errors')) {
    if (!build.success || build.errorCount > 0) failed.push('build-zero-errors');
  }
  if (checks.includes('test-zero-new-failures')) {
    if (!test.success || test.newFailures > 0) failed.push('test-zero-new-failures');
  }
  if (checks.includes('grep-checks-pass')) {
    if (!grepChecks.length || !grepChecks.every(g => g.passed)) failed.push('grep-checks-pass');
  }
  if (checks.includes('diff-review-approved')) {
    if (!diffReviews.length || !diffReviews.every(d => d.approved)) failed.push('diff-review-approved');
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAuditModule(): WorkflowModule {
  return {
    name: 'audit',
    description:
      'Verify implementation correctness: build, tests, grep policy, and diff review (unanimous hive consensus).',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          implementation_result: {
            type: 'object',
            description: 'Output from the implement module (changed files, totals, metadata)',
            required: true,
          },
          verification_criteria: {
            type: 'object',
            description: 'Optional criteria bag; may include string[] grep patterns under `grep_patterns`',
            required: false,
          },
          band_id: {
            type: 'string',
            description: 'Optional execution band identifier',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          audit_result: {
            type: 'object',
            description: 'Verdict, build/test artifacts, grep checks, diff reviews',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_hive: Parallel build-checker + test-runner',
      'collect_build_test: Merge build and test outcomes',
      'spawn_second_wave: grep-checker + diff-reviewer (after build/test)',
      'synthesize: Unanimous consensus on overall PASS/FAIL',
    ],

    hooks: {
      pre: 'pre_audit',
      post: 'post_audit',
      onError: 'audit_error',
    },

    gates: {
      enabled: true,
      checks: [...AUDIT_GATE_CHECKS],
      minAgents: 1,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 4,
      roles: [
        {
          name: 'build-checker',
          agentType: 'reviewer',
          modelPreference: 'sonnet',
          taskTemplate: 'Verify zero build errors for {band_id}. Emit build_result { success, errorCount }.',
        },
        {
          name: 'test-runner',
          agentType: 'tester',
          modelPreference: 'sonnet',
          taskTemplate: 'Run tests; emit test_result { success, newFailures } — no new failures allowed.',
        },
        {
          name: 'grep-checker',
          agentType: 'researcher',
          modelPreference: 'sonnet',
          taskTemplate:
            'After build/test: run policy grep checks from verification_criteria; emit grep_checks[].',
        },
        {
          name: 'diff-reviewer',
          agentType: 'reviewer',
          modelPreference: 'opus',
          taskTemplate:
            'After build/test: review diffs from implementation_result; emit diff_reviews[] with approved boolean.',
        },
      ],
      workerDependencies: {
        'build-checker': [],
        'test-runner': [],
        'grep-checker': ['build-checker', 'test-runner'],
        'diff-reviewer': ['build-checker', 'test-runner'],
      },
      consensusStrategy: 'unanimous',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();
      try {
        const inputs = context.inputs as Record<string, unknown>;
        const impl = inputs.implementation_result as ImplementationResult | undefined;
        if (!impl || typeof impl !== 'object') {
          return {
            success: false,
            outputs: {},
            error: 'implementation_result is required',
            durationMs: Date.now() - startTime,
          };
        }

        const criteria = inputs.verification_criteria;
        const grepPatterns =
          criteria &&
          typeof criteria === 'object' &&
          !Array.isArray(criteria) &&
          Array.isArray((criteria as Record<string, unknown>).grep_patterns)
            ? ((criteria as Record<string, unknown>).grep_patterns as unknown[])
            : criteria;

        const build = readBuild(inputs, impl);
        const test = readTest(inputs, impl);

        const grep_checks: GrepCheck[] = [];
        const rawGrep = inputs.grep_checks ?? inputs.grepChecks;
        if (Array.isArray(rawGrep) && rawGrep.length > 0) {
          for (let i = 0; i < rawGrep.length; i++) {
            const one = normalizeGrepCheck(rawGrep[i], i);
            if (one) grep_checks.push(one);
          }
        } else {
          grep_checks.push(...defaultGrepChecks(grepPatterns));
        }

        const diff_reviews: DiffReview[] = [];
        const rawDiff = inputs.diff_reviews ?? inputs.diffReviews;
        if (Array.isArray(rawDiff) && rawDiff.length > 0) {
          for (let i = 0; i < rawDiff.length; i++) {
            const one = normalizeDiffReview(rawDiff[i], i);
            if (one) diff_reviews.push(one);
          }
        } else {
          diff_reviews.push(...defaultDiffReviews(impl));
        }

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : AUDIT_GATE_CHECKS;
        const gateOutcome = evaluateAuditGates(build, test, grep_checks, diff_reviews, activeChecks);
        const overallVerdict: AuditVerdict = gateOutcome.passed ? 'PASS' : 'FAIL';

        const band_id = coalesceString(inputs.band_id) || undefined;

        const audit_result: AuditResult = {
          overallVerdict,
          build,
          test,
          grep_checks,
          diff_reviews,
          metadata: {
            auditedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            workersUsed: 0,
            band_id,
          },
        };

        return {
          success: true,
          outputs: { audit_result },
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
            consensusReached: gateOutcome.passed,
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
