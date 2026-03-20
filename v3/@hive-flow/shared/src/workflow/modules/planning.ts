/**
 * Planning Module — organize a design into execution bands and work packages.
 *
 * Pattern aligns with investigate.ts (factory, contract, hive, gates, execute).
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';
import type { DesignChange, ImplementationPlan } from './design.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkPackage {
  id: string;
  bandId: string;
  title: string;
  /** Design change ids covered by this package */
  sourceChangeIds: string[];
  files: string[];
  estimatedHours: number;
  notes?: string;
}

export interface ExecutionBand {
  id: string;
  name: string;
  order: number;
  dependsOn: string[];
  packageIds: string[];
}

/** Explicit out-of-scope design change, recorded during triage. */
export interface WontFixItem {
  /** Design change id excluded from execution */
  changeId: string;
  reason?: string;
  triagedAt?: string;
}

export interface ExecutionPlan {
  bands: ExecutionBand[];
  work_packages: WorkPackage[];
  effort: {
    totalHours: number;
    byBand: Record<string, number>;
  };
  wont_fix: WontFixItem[];
  /** Risk / scope buckets produced while categorizing (for audit) */
  change_categories?: string[];
  sourcePlanSummary?: ImplementationPlan['sourceSummary'];
  metadata: {
    plannedAt: string;
    durationMs: number;
    workersUsed: number;
  };
}

export type RawWorkPackage = {
  id?: string;
  bandId?: string;
  band_id?: string;
  title?: string;
  sourceChangeIds?: string[];
  source_change_ids?: string[];
  files?: unknown;
  estimatedHours?: number;
  estimated_hours?: number;
  notes?: string;
};

export type RawWontFixItem = {
  changeId?: string;
  change_id?: string;
  id?: string;
  reason?: string;
  triagedAt?: string;
  triaged_at?: string;
};

// ---------------------------------------------------------------------------
// Gates + helpers
// ---------------------------------------------------------------------------

const PLANNING_GATE_CHECKS: string[] = [
  'all-findings-addressed',
  'effort-estimates-present',
  'band-dependencies-valid',
];

function coalesceString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function normalizeFileList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    const s = coalesceString(x);
    if (s) out.push(s);
  }
  return [...new Set(out)];
}

export function normalizeRawWorkPackage(
  raw: unknown,
  defaults: { bandId: string; index: number },
): WorkPackage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawWorkPackage;

  const id = coalesceString(r.id) || `wp-${defaults.index}`;
  const bandId = coalesceString(r.bandId ?? r.band_id) || defaults.bandId;
  const title = coalesceString(r.title) || `Package ${id}`;
  const src = (r.sourceChangeIds ?? r.source_change_ids) as unknown;
  const sourceChangeIds = Array.isArray(src)
    ? src.map(x => coalesceString(x)).filter(Boolean)
    : [];
  const files = normalizeFileList(r.files);
  const ehRaw = r.estimatedHours ?? r.estimated_hours;
  const estimatedHours =
    typeof ehRaw === 'number' && Number.isFinite(ehRaw) ? Math.max(0.25, ehRaw) : 1;
  const notes = r.notes !== undefined ? coalesceString(r.notes) : undefined;

  return {
    id,
    bandId,
    title,
    sourceChangeIds,
    files: files.length > 0 ? files : [],
    estimatedHours,
    notes,
  };
}

/**
 * Normalize a wont-fix row from workers or CLI (string id or object).
 */
export function normalizeRawWontFixItem(raw: unknown): WontFixItem | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const changeId = coalesceString(raw);
    return changeId ? { changeId, triagedAt: new Date().toISOString() } : null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as RawWontFixItem;
  const changeId = coalesceString(r.changeId ?? r.change_id ?? r.id);
  if (!changeId) return null;
  const reason = r.reason !== undefined ? coalesceString(r.reason) : undefined;
  const triagedAt =
    coalesceString(r.triagedAt ?? r.triaged_at) || new Date().toISOString();
  const out: WontFixItem = { changeId, triagedAt };
  if (reason) out.reason = reason;
  return out;
}

export function normalizeWontFixList(raw: unknown): WontFixItem[] {
  if (!Array.isArray(raw)) return [];
  const out: WontFixItem[] = [];
  for (const row of raw) {
    const one = normalizeRawWontFixItem(row);
    if (one) out.push(one);
  }
  return out;
}

const RISK_ORDER: Record<DesignChange['riskAssessment']['level'], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** One planning slice: changes sharing the same risk band (ordered low → critical). */
export interface ChangeSlice {
  categoryKey: string;
  displayName: string;
  riskRank: number;
  changes: DesignChange[];
}

/**
 * Categorize design changes by risk level for band boundaries.
 */
export function categorizeChangesForPlanning(changes: DesignChange[]): ChangeSlice[] {
  const byLevel = new Map<DesignChange['riskAssessment']['level'], DesignChange[]>();
  for (const c of changes) {
    const lvl = c.riskAssessment?.level ?? 'medium';
    const bucket = byLevel.get(lvl) ?? [];
    bucket.push(c);
    byLevel.set(lvl, bucket);
  }

  const levels: DesignChange['riskAssessment']['level'][] = ['low', 'medium', 'high', 'critical'];
  const slices: ChangeSlice[] = [];
  for (const lvl of levels) {
    const group = byLevel.get(lvl);
    if (!group?.length) continue;
    slices.push({
      categoryKey: `risk:${lvl}`,
      displayName: `${lvl[0]!.toUpperCase()}${lvl.slice(1)} risk`,
      riskRank: RISK_ORDER[lvl],
      changes: group,
    });
  }
  return slices;
}

function defaultTitleForSlice(slice: ChangeSlice): string {
  return `${slice.displayName} — ${slice.changes.length} change(s)`;
}

function estimateHoursForSlice(slice: ChangeSlice): number {
  const mult: Record<DesignChange['riskAssessment']['level'], number> = {
    low: 0.75,
    medium: 1,
    high: 1.5,
    critical: 2,
  };
  let total = 0;
  for (const c of slice.changes) {
    const lvl = c.riskAssessment?.level ?? 'medium';
    total += mult[lvl] ?? 1;
  }
  return Math.max(0.25, Math.round(total * 4) / 4);
}

/**
 * Build bands and packages from categorized slices; linear band dependencies.
 */
function buildBandsAndPackagesFromSlices(
  slices: ChangeSlice[],
  bandOrdering: string[] | undefined,
): { bands: ExecutionBand[]; work_packages: WorkPackage[] } {
  const bands: ExecutionBand[] = [];
  const work_packages: WorkPackage[] = [];

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]!;
    const bandId = `band-${i}`;
    const pkgId = `wp-${bandId}`;
    const name =
      bandOrdering?.[i] ?? `${slice.displayName} (${slice.categoryKey})`;

    bands.push({
      id: bandId,
      name,
      order: i,
      dependsOn: i === 0 ? [] : [`band-${i - 1}`],
      packageIds: [pkgId],
    });

    work_packages.push({
      id: pkgId,
      bandId,
      title: defaultTitleForSlice(slice),
      sourceChangeIds: slice.changes.map(c => c.id),
      files: [...new Set(slice.changes.map(c => c.file))],
      estimatedHours: estimateHoursForSlice(slice),
    });
  }

  return { bands, work_packages };
}

function evaluatePlanningGates(
  changeIds: Set<string>,
  packages: WorkPackage[],
  bands: ExecutionBand[],
  checks: string[],
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];

  if (checks.includes('all-findings-addressed')) {
    const covered = new Set<string>();
    for (const p of packages) {
      for (const id of p.sourceChangeIds) covered.add(id);
    }
    const ok = [...changeIds].every(id => covered.has(id));
    if (!ok) failed.push('all-findings-addressed');
  }

  if (checks.includes('effort-estimates-present')) {
    const ok = packages.length > 0 && packages.every(p => p.estimatedHours > 0);
    if (!ok) failed.push('effort-estimates-present');
  }

  if (checks.includes('band-dependencies-valid')) {
    const bandIds = new Set(bands.map(b => b.id));
    let ok = bands.every(b => b.dependsOn.every(d => !d || bandIds.has(d)));
    if (ok) {
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const dfs = (bid: string): boolean => {
        if (visiting.has(bid)) return false;
        if (visited.has(bid)) return true;
        visiting.add(bid);
        const band = bands.find(x => x.id === bid);
        if (band) {
          for (const d of band.dependsOn) {
            if (d && !dfs(d)) return false;
          }
        }
        visiting.delete(bid);
        visited.add(bid);
        return true;
      };
      ok = bands.every(b => dfs(b.id));
    }
    if (!ok) failed.push('band-dependencies-valid');
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

function dedupeWontFixItems(items: WontFixItem[]): WontFixItem[] {
  const seen = new Set<string>();
  const out: WontFixItem[] = [];
  for (const w of items) {
    if (seen.has(w.changeId)) continue;
    seen.add(w.changeId);
    out.push(w);
  }
  return out;
}

function recalcEffort(packages: WorkPackage[], bands: ExecutionBand[]): ExecutionPlan['effort'] {
  const byBand: Record<string, number> = {};
  for (const b of bands) byBand[b.id] = 0;
  for (const p of packages) {
    byBand[p.bandId] = (byBand[p.bandId] || 0) + p.estimatedHours;
  }
  const totalHours = packages.reduce((s, p) => s + p.estimatedHours, 0);
  return { totalHours, byBand };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlanningModule(): WorkflowModule {
  return {
    name: 'planning',
    description: 'Turn an implementation plan into ordered execution bands and work packages',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          implementation_plan: {
            type: 'object',
            description: 'Output from the design module (changes[], summaries, metadata)',
            required: true,
          },
          band_ordering: {
            type: 'array',
            description: 'Optional human-readable band names in execution order',
            required: false,
          },
          work_packages: {
            type: 'array',
            description: 'Optional worker-proposed packages (normalized)',
            required: false,
          },
          wont_fix: {
            type: 'array',
            description:
              'Optional out-of-scope change ids (strings) or WontFixItem objects { changeId, reason?, triagedAt? }',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          execution_plan: {
            type: 'object',
            description: 'Bands, work packages, effort, wont_fix',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_hive: strategist + estimator + triage-reviewer',
      'categorize: Group active changes by risk for band boundaries',
      'build_packages: One work package per slice (files + sourceChangeIds)',
      'order_bands: Linear execution order; band_ordering names override defaults',
      'estimate_effort: Per-package hours and band rollups',
      'triage: Record wont_fix exclusions and gate on full coverage',
    ],

    hooks: {
      pre: 'pre_planning',
      post: 'post_planning',
      onError: 'planning_error',
    },

    gates: {
      enabled: true,
      checks: [...PLANNING_GATE_CHECKS],
      minAgents: 1,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 4,
      roles: [
        {
          name: 'strategist',
          agentType: 'planner',
          modelPreference: 'opus',
          taskTemplate:
            'From implementation_plan.changes, propose execution bands with safe dependency ordering for {band_ordering}.',
        },
        {
          name: 'estimator',
          agentType: 'coder',
          modelPreference: 'sonnet',
          taskTemplate:
            'Produce WorkPackage rows with realistic estimatedHours, files[], and sourceChangeIds[] coverage.',
        },
        {
          name: 'triage-reviewer',
          agentType: 'reviewer',
          modelPreference: 'sonnet',
          taskTemplate:
            'Verify every change id is scheduled or explicitly wont_fix; adjust estimates if bands fight constraints.',
        },
      ],
      workerDependencies: {
        strategist: [],
        estimator: ['strategist'],
        'triage-reviewer': ['estimator'],
      },
      consensusStrategy: 'weighted',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const rawPlan = context.inputs.implementation_plan as ImplementationPlan | undefined;
        if (!rawPlan || !Array.isArray(rawPlan.changes)) {
          return {
            success: false,
            outputs: {},
            error: 'implementation_plan with non-empty changes[] is required',
            durationMs: Date.now() - startTime,
          };
        }

        const changes = rawPlan.changes;
        if (changes.length === 0) {
          return {
            success: false,
            outputs: {},
            error: 'implementation_plan.changes must contain at least one DesignChange',
            durationMs: Date.now() - startTime,
          };
        }

        const wontInput = context.inputs.wont_fix ?? context.inputs.wontFix;
        const wont_fix = dedupeWontFixItems(normalizeWontFixList(wontInput));
        const excludedIds = new Set(wont_fix.map(w => w.changeId));
        const activeChanges = changes.filter(c => !excludedIds.has(c.id));

        if (activeChanges.length === 0) {
          return {
            success: false,
            outputs: {},
            error: 'All design changes are marked wont_fix; nothing left to schedule',
            durationMs: Date.now() - startTime,
          };
        }

        const bandOrdering = context.inputs.band_ordering as string[] | undefined;
        let bands: ExecutionBand[] = [];
        let work_packages: WorkPackage[] = [];
        let change_categories: string[] | undefined;

        const customPackages = context.inputs.work_packages ?? context.inputs.raw_work_packages;

        if (Array.isArray(customPackages) && customPackages.length > 0) {
          work_packages = customPackages
            .map((row, i) =>
              normalizeRawWorkPackage(row, {
                bandId: 'band-0',
                index: i,
              }),
            )
            .filter((p): p is WorkPackage => p !== null);

          const bandIds = [...new Set(work_packages.map(p => p.bandId))];
          bands = bandIds.map((bid, order) => ({
            id: bid,
            name: bandOrdering?.[order] ?? bid,
            order,
            dependsOn: order === 0 ? [] : [bandIds[order - 1]!],
            packageIds: work_packages.filter(p => p.bandId === bid).map(p => p.id),
          }));
        } else {
          const slices = categorizeChangesForPlanning(activeChanges);
          change_categories = slices.map(s => s.categoryKey);
          const built = buildBandsAndPackagesFromSlices(slices, bandOrdering);
          bands = built.bands;
          work_packages = built.work_packages;

          for (const p of work_packages) {
            p.estimatedHours = Math.max(0.25, p.estimatedHours);
          }
        }

        const changeIds = new Set(activeChanges.map(c => c.id));

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : PLANNING_GATE_CHECKS;
        const gateOutcome = evaluatePlanningGates(changeIds, work_packages, bands, activeChecks);

        const effort = recalcEffort(work_packages, bands);

        const execution_plan: ExecutionPlan = {
          bands,
          work_packages,
          effort,
          wont_fix,
          ...(change_categories?.length ? { change_categories } : {}),
          sourcePlanSummary: rawPlan.sourceSummary,
          metadata: {
            plannedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            workersUsed: 0,
          },
        };

        return {
          success: true,
          outputs: { execution_plan },
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
