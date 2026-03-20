/**
 * Design Module — translate verified findings into an implementation plan.
 *
 * Pattern aligns with investigate.ts (factory, contract, hive, gates, execute).
 * When `verified_findings` includes `items[]`, only CONFIRMED verdicts are turned
 * into design changes (merged with `finding_registry` / research inputs by id).
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';
import { extractRegistryItems } from './verify.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a design change will be validated. */
export interface DesignTestStrategy {
  /** e.g. unit, integration, contract, manual */
  approach: string;
  /** Concrete cases or scenarios */
  cases?: string[];
  /** Coverage, fixtures, or data notes */
  notes?: string;
}

/** Per-change risk view for implementation. */
export interface DesignRiskAssessment {
  level: 'low' | 'medium' | 'high' | 'critical';
  /** What could go wrong / impact */
  summary: string;
  mitigations?: string[];
}

export interface DesignChange {
  id: string;
  file: string;
  line: number;
  action: string;
  testStrategy: DesignTestStrategy;
  riskAssessment: DesignRiskAssessment;
  /** Upstream registry id when sourced from verification */
  sourceOriginalId?: string;
}

export type RawDesignChange = {
  id?: string;
  file?: string;
  filePath?: string;
  line?: number;
  line_number?: number;
  action?: string;
  testStrategy?: unknown;
  test_strategy?: unknown;
  testPlan?: string;
  test_plan?: string;
  riskAssessment?: unknown;
  risk_assessment?: unknown;
  risk?: string;
  sourceOriginalId?: string;
  source_original_id?: string;
};

export interface ImplementationPlan {
  changes: DesignChange[];
  sourceSummary: {
    upstreamItemCount: number;
    changeCount: number;
    /** True when inputs used verified_findings.items filtered to CONFIRMED */
    fromConfirmedOnly?: boolean;
  };
  constraints?: Record<string, unknown>;
  metadata: {
    designedAt: string;
    durationMs: number;
    workersUsed: number;
  };
}

// ---------------------------------------------------------------------------
// Normalization, dedupe, gates
// ---------------------------------------------------------------------------

const DESIGN_GATE_CHECKS: string[] = [
  'file-level-changes',
  'test-plan-present',
  'risk-assessment',
  'feasibility',
];

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

function coalesceString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function isConfirmedVerdict(v: unknown): boolean {
  return v === 'CONFIRMED';
}

function severityToRiskLevel(s: unknown): DesignRiskAssessment['level'] {
  const x = coalesceString(s).toLowerCase();
  if (x === 'critical') return 'critical';
  if (x === 'error') return 'high';
  if (x === 'warning') return 'medium';
  if (x === 'info') return 'low';
  return 'medium';
}

function normalizeRiskLevel(v: unknown): DesignRiskAssessment['level'] {
  if (typeof v === 'string' && (RISK_LEVELS as readonly string[]).includes(v)) {
    return v as DesignRiskAssessment['level'];
  }
  return 'medium';
}

function normalizeTestStrategy(
  raw: unknown,
  fallbackApproach: string,
  fallbackNotes?: string,
): DesignTestStrategy {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const approach = coalesceString(r.approach) || fallbackApproach;
    const cases = Array.isArray(r.cases)
      ? r.cases.map(x => coalesceString(x)).filter(Boolean)
      : undefined;
    const notes =
      r.notes !== undefined ? coalesceString(r.notes) : coalesceString(fallbackNotes || undefined);
    const out: DesignTestStrategy = { approach };
    if (cases?.length) out.cases = cases;
    if (notes) out.notes = notes;
    return out;
  }
  const s = coalesceString(raw);
  if (s) return { approach: s };
  return {
    approach: fallbackApproach,
    ...(fallbackNotes ? { notes: fallbackNotes } : {}),
  };
}

function normalizeRiskAssessment(
  raw: unknown,
  fallbackSummary: string,
  severityHint?: unknown,
): DesignRiskAssessment {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const level = normalizeRiskLevel(r.level || severityHint);
    const summary = coalesceString(r.summary) || fallbackSummary;
    const mitigations = Array.isArray(r.mitigations)
      ? r.mitigations.map(x => coalesceString(x)).filter(Boolean)
      : undefined;
    const out: DesignRiskAssessment = { level, summary };
    if (mitigations?.length) out.mitigations = mitigations;
    return out;
  }
  const rs = coalesceString(raw);
  if (rs) {
    return { level: severityToRiskLevel(severityHint), summary: rs };
  }
  return {
    level: severityToRiskLevel(severityHint),
    summary: fallbackSummary,
  };
}

function fingerprintChange(c: Omit<DesignChange, 'id'>): string {
  const ts = `${c.testStrategy.approach}\u241e${(c.testStrategy.cases ?? []).join(',')}`;
  const rs = `${c.riskAssessment.level}\u241e${c.riskAssessment.summary.slice(0, 120)}`;
  return [c.file, String(c.line), c.action.slice(0, 200), ts, rs].join('\u241e');
}

function stableChangeId(fp: string): string {
  let h = 2166136261;
  for (let i = 0; i < fp.length; i++) {
    h ^= fp.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `des-${(h >>> 0).toString(36)}`;
}

export function normalizeRawDesignChange(raw: unknown): DesignChange | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawDesignChange;

  const file = coalesceString(r.file ?? r.filePath);
  const lineRaw = r.line ?? r.line_number;
  const line =
    typeof lineRaw === 'number' && Number.isFinite(lineRaw) ? Math.trunc(lineRaw) : 0;
  const action = coalesceString(r.action) || '(no action)';
  const fallbackTest =
    coalesceString(r.testPlan ?? r.test_plan) ||
    (file ? `Regression / unit coverage for ${file}` : 'Define automated coverage for this change');
  const testStrategy = normalizeTestStrategy(
    r.testStrategy ?? r.test_strategy ?? r.testPlan ?? r.test_plan,
    fallbackTest,
  );

  const sev = (r as Record<string, unknown>).severity;
  const fallbackRisk =
    coalesceString(r.risk) ||
    (typeof sev === 'string' ? `Severity-derived review: ${sev}` : 'Review required before implement');
  const riskAssessment = normalizeRiskAssessment(
    r.riskAssessment ?? r.risk_assessment ?? r.risk,
    fallbackRisk,
    sev,
  );

  const base: Omit<DesignChange, 'id'> = {
    file,
    line,
    action,
    testStrategy,
    riskAssessment,
  };
  const soc = coalesceString(r.sourceOriginalId ?? r.source_original_id);
  if (soc) base.sourceOriginalId = soc;

  const idRaw = coalesceString(r.id);
  const id = idRaw || stableChangeId(fingerprintChange(base));

  return { id, ...base };
}

export function dedupeDesignChanges(changes: DesignChange[]): DesignChange[] {
  const byId = new Set<string>();
  const byFp = new Set<string>();
  const out: DesignChange[] = [];

  for (const c of changes) {
    if (byId.has(c.id)) continue;
    const fp = fingerprintChange(c);
    if (byFp.has(fp)) continue;
    byId.add(c.id);
    byFp.add(fp);
    out.push(c);
  }
  return out;
}

function evaluateDesignGates(
  changes: DesignChange[],
  checks: string[],
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];

  if (checks.includes('file-level-changes')) {
    const ok = changes.length > 0 && changes.every(c => c.file.length > 0);
    if (!ok) failed.push('file-level-changes');
  }
  if (checks.includes('test-plan-present')) {
    const ok = changes.every(c => coalesceString(c.testStrategy.approach).length > 0);
    if (!ok) failed.push('test-plan-present');
  }
  if (checks.includes('risk-assessment')) {
    const ok = changes.every(c => coalesceString(c.riskAssessment.summary).length > 0);
    if (!ok) failed.push('risk-assessment');
  }
  if (checks.includes('feasibility')) {
    const ok = changes.every(
      c =>
        c.action.length > 0 &&
        c.line >= 0 &&
        !c.action.startsWith('(no action)'),
    );
    if (!ok) failed.push('feasibility');
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

function buildOriginalIdLookup(inputs: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  const sources = [
    inputs.finding_registry,
    inputs.research_registry,
    inputs.research_brief,
  ];

  for (const reg of sources) {
    for (const row of extractRegistryItems(reg)) {
      const id = coalesceString(row.id ?? row.originalId ?? row.original_id);
      if (id) m.set(id, row);
    }
  }
  return m;
}

function mergeVerificationRowWithSource(
  vi: Record<string, unknown>,
  lookup: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const oid = coalesceString(vi.originalId ?? vi.original_id);
  const base = oid ? lookup.get(oid) : undefined;
  return { ...(base ?? {}), ...vi, ...(oid ? { originalId: oid } : {}) };
}

function hasVerifiedFindingsItems(inputs: Record<string, unknown>): boolean {
  const vf = inputs.verified_findings;
  return !!(vf && typeof vf === 'object' && Array.isArray((vf as Record<string, unknown>).items));
}

/**
 * Collect upstream rows for design: CONFIRMED-only when `verified_findings.items` exists;
 * otherwise same discovery order as investigate-style registries.
 */
function collectUpstreamRecords(inputs: Record<string, unknown>): {
  rows: Array<Record<string, unknown>>;
  fromConfirmedOnly: boolean;
} {
  if (hasVerifiedFindingsItems(inputs)) {
    const rec = inputs.verified_findings as Record<string, unknown>;
    const items = rec.items as unknown[];
    const confirmed = items.filter(
      (row): row is Record<string, unknown> =>
        !!row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        isConfirmedVerdict((row as Record<string, unknown>).verdict),
    );
    const lookup = buildOriginalIdLookup(inputs);
    return {
      rows: confirmed.map(vi => mergeVerificationRowWithSource(vi, lookup)),
      fromConfirmedOnly: true,
    };
  }

  const rows = collectUpstreamRecordsLegacy(inputs);
  return { rows, fromConfirmedOnly: false };
}

function collectUpstreamRecordsLegacy(inputs: Record<string, unknown>): Array<Record<string, unknown>> {
  const vf = inputs.verified_findings;
  if (vf && typeof vf === 'object') {
    const rec = vf as Record<string, unknown>;
    const items = rec.items;
    if (Array.isArray(items)) return items as Array<Record<string, unknown>>;
  }

  const rb = inputs.research_registry ?? inputs.research_brief;
  if (rb && typeof rb === 'object') {
    const rec = rb as Record<string, unknown>;
    const notes = rec.notes;
    if (Array.isArray(notes)) return notes as Array<Record<string, unknown>>;
  }

  const fr = inputs.finding_registry;
  if (fr && typeof fr === 'object') {
    const rec = fr as Record<string, unknown>;
    const findings = rec.findings;
    if (Array.isArray(findings)) return findings as Array<Record<string, unknown>>;
  }

  for (const key of ['verified_findings', 'research_brief', 'research_registry', 'finding_registry'] as const) {
    const bag = inputs[key];
    if (bag) {
      const ex = extractRegistryItems(bag);
      if (ex.length > 0) return ex;
    }
  }

  return [];
}

function inferDesignChangeFromUpstream(row: Record<string, unknown>, index: number): DesignChange | null {
  const file = coalesceString(
    row.file ?? row.filePath ?? row.file_path ?? row.path ?? '',
  );
  const lineRaw = row.line ?? row.lineNumber ?? row.line_number;
  const line =
    typeof lineRaw === 'number' && Number.isFinite(lineRaw) ? Math.trunc(lineRaw as number) : 1;

  const action =
    coalesceString(row.action ?? row.description ?? row.summary) ||
    `Resolve upstream item #${index + 1}`;

  const testPlan =
    coalesceString(row.testPlan ?? row.test_plan) ||
    `Regression test for ${file || 'target'}:${line}`;

  const risk =
    coalesceString(row.risk) ||
    (typeof row.severity === 'string' ? `severity:${row.severity}` : 'review required');

  const idSeed =
    coalesceString(row.id ?? row.originalId ?? row.original_id) ||
    coalesceString(row.originalId) ||
    undefined;

  return normalizeRawDesignChange(
    {
      id: idSeed,
      file: file || `src/upstream-${index + 1}.ts`,
      line,
      action,
      testPlan,
      risk,
      sourceOriginalId: coalesceString(row.originalId ?? row.original_id) || idSeed,
    },
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDesignModule(): WorkflowModule {
  return {
    name: 'design',
    description:
      'Transform verified findings (or research / investigation registries) into a file-level implementation plan',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          verified_findings: {
            type: 'object',
            description:
              'Optional verified registry (items with verdicts). When present with items[], only CONFIRMED rows become changes.',
            required: false,
          },
          research_registry: {
            type: 'object',
            description: 'Optional research brief / registry (alias of research_brief)',
            required: false,
          },
          research_brief: {
            type: 'object',
            description: 'Optional research brief with notes[]',
            required: false,
          },
          finding_registry: {
            type: 'object',
            description:
              'Optional finding registry from investigate; used to enrich CONFIRMED verification rows by id',
            required: false,
          },
          constraints: {
            type: 'object',
            description: 'Optional constraints object carried into the plan metadata',
            required: false,
          },
          design_changes: {
            type: 'array',
            description: 'Optional worker-proposed design changes (normalized and deduped)',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          implementation_plan: {
            type: 'object',
            description: 'Implementation plan with DesignChange[] under `changes`',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_hive: architect → detail-planner → risk-assessor chain',
      'ingest_findings: CONFIRMED-only when verified_findings.items is set; else research / investigation',
      'draft_changes: Produce file-level DesignChange rows with testStrategy and riskAssessment',
      'gate: file, tests, risk, feasibility',
    ],

    hooks: {
      pre: 'pre_design',
      post: 'post_design',
      onError: 'design_error',
    },

    gates: {
      enabled: true,
      checks: [...DESIGN_GATE_CHECKS],
      minAgents: 1,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 4,
      roles: [
        {
          name: 'architect',
          agentType: 'architect',
          modelPreference: 'opus',
          taskTemplate:
            'From upstream verified findings, propose architecture-level file touch points and ordering for constraints: {constraints}.',
        },
        {
          name: 'detail-planner',
          agentType: 'planner',
          modelPreference: 'sonnet',
          taskTemplate:
            'Expand architect outline into DesignChange rows: file, line, action, testStrategy { approach, cases?, notes? }, riskAssessment { level, summary, mitigations? }.',
        },
        {
          name: 'risk-assessor',
          agentType: 'reviewer',
          modelPreference: 'opus',
          taskTemplate:
            'Challenge the plan for feasibility; ensure each change has a concrete testStrategy.approach and riskAssessment.summary.',
        },
      ],
      workerDependencies: {
        architect: [],
        'detail-planner': ['architect'],
        'risk-assessor': ['detail-planner'],
      },
      consensusStrategy: 'weighted',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const inputs = context.inputs as Record<string, unknown>;
        const { rows: upstream, fromConfirmedOnly } = collectUpstreamRecords(inputs);

        const normalized: DesignChange[] = [];
        const rawChanges =
          inputs.design_changes ?? inputs.raw_design_changes ?? inputs.raw_changes;

        if (Array.isArray(rawChanges)) {
          for (const row of rawChanges) {
            const one = normalizeRawDesignChange(row);
            if (one) normalized.push(one);
          }
        }

        if (normalized.length === 0 && upstream.length > 0) {
          upstream.forEach((row, i) => {
            const one = inferDesignChangeFromUpstream(row, i);
            if (one) normalized.push(one);
          });
        }

        const changes = dedupeDesignChanges(normalized);

        if (changes.length === 0) {
          return {
            success: false,
            outputs: {},
            error:
              'No design changes produced — supply design_changes[] or upstream registry (CONFIRMED items when using verified_findings.items, or research/finding registry)',
            durationMs: Date.now() - startTime,
          };
        }

        const constraints =
          inputs.constraints && typeof inputs.constraints === 'object'
            ? (inputs.constraints as Record<string, unknown>)
            : undefined;

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : DESIGN_GATE_CHECKS;
        const gateOutcome = evaluateDesignGates(changes, activeChecks);

        const implementation_plan: ImplementationPlan = {
          changes,
          sourceSummary: {
            upstreamItemCount: upstream.length,
            changeCount: changes.length,
            fromConfirmedOnly,
          },
          constraints,
          metadata: {
            designedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            workersUsed: 0,
          },
        };

        return {
          success: true,
          outputs: { implementation_plan },
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
