/**
 * Verification Module (Parameterized)
 *
 * Generic verification module that can verify the output of any source module.
 * Spawns a verification hive to cross-reference, challenge, and produce verdicts
 * for each item in the source module's registry.
 *
 * Implements the WorkflowModule interface.
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Verification Types
// ---------------------------------------------------------------------------

export type VerificationVerdict = 'CONFIRMED' | 'DISPUTED' | 'UNVERIFIED';

export interface VerificationItem {
  /** ID of the original item being verified */
  originalId: string;
  /** Verdict for this item */
  verdict: VerificationVerdict;
  /** Confidence in the verdict (0-1) */
  confidence: number;
  /** Counter-evidence (required for DISPUTED items) */
  counterEvidence?: string;
  /** Supporting evidence (for CONFIRMED items) */
  supportingEvidence?: string;
  /** Verifier role that produced this verdict */
  verifiedBy: string;
  /** Timestamp */
  verifiedAt: string;
}

/**
 * Optional worker-supplied verification rows merged by {@link mergeVerificationResults}.
 */
export type VerificationResultInput = {
  originalId?: string;
  original_id?: string;
  verdict?: VerificationVerdict;
  confidence?: number;
  counterEvidence?: string;
  counter_evidence?: string;
  supportingEvidence?: string;
  supporting_evidence?: string;
  verifiedBy?: string;
  verified_by?: string;
  verifiedAt?: string;
  verified_at?: string;
};

export interface VerifiedRegistry {
  /** Source module that produced the original data */
  sourceModule: string;
  /** Verification items with verdicts */
  items: VerificationItem[];
  /** Summary statistics */
  summary: {
    total: number;
    confirmed: number;
    disputed: number;
    unverified: number;
    overallConfidence: number;
    /** originalIds still UNVERIFIED after merging `verification_results` */
    unverifiedOriginalIds: string[];
  };
  /** Verification metadata */
  metadata: {
    verifiedAt: string;
    durationMs: number;
    workersUsed: number;
  };
}

// ---------------------------------------------------------------------------
// Registry extraction (handles Maps + Object.entries-style bags)
// ---------------------------------------------------------------------------

const REGISTRY_METADATA_KEYS = new Set([
  'summary',
  'metadata',
  'focusAreas',
  'focus_areas',
  'sourceModule',
  'topics',
  'research_topics',
  'codebasePath',
  'codebase_path',
  'bands',
  'effort',
  'wont_fix',
  'wontFix',
  'sourcePlanSummary',
  'sourceSummary',
  'constraints',
  'totals',
]);

/**
 * Extract a flat list of registry item objects from diverse source-module shapes.
 * Uses `Object.entries` for plain objects (never `registry.entries`, which is only valid on Map).
 */
export function extractRegistryItems(registry: unknown): Array<Record<string, unknown>> {
  if (!registry || typeof registry !== 'object') return [];

  if (registry instanceof Map) {
    const out: Array<Record<string, unknown>> = [];
    for (const [, value] of registry.entries()) {
      if (Array.isArray(value)) {
        for (const el of value) {
          if (el && typeof el === 'object' && !Array.isArray(el)) {
            out.push(el as Record<string, unknown>);
          }
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        out.push(value as Record<string, unknown>);
      }
    }
    return out;
  }

  const r = registry as Record<string, unknown>;

  // Audit module: flatten build, test, grep_checks, diff_reviews into verifiable rows (ids for verify-audit)
  if (
    typeof r.overallVerdict === 'string' &&
    (r.build !== undefined ||
      r.test !== undefined ||
      Array.isArray(r.grep_checks) ||
      Array.isArray(r.diff_reviews))
  ) {
    const out: Array<Record<string, unknown>> = [];
    if (r.build && typeof r.build === 'object' && !Array.isArray(r.build)) {
      out.push({ id: 'audit-build', ...(r.build as Record<string, unknown>) });
    }
    if (r.test && typeof r.test === 'object' && !Array.isArray(r.test)) {
      out.push({ id: 'audit-test', ...(r.test as Record<string, unknown>) });
    }
    if (Array.isArray(r.grep_checks)) {
      for (const el of r.grep_checks) {
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          out.push(el as Record<string, unknown>);
        }
      }
    }
    if (Array.isArray(r.diff_reviews)) {
      for (const el of r.diff_reviews) {
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          out.push(el as Record<string, unknown>);
        }
      }
    }
    if (out.length > 0) return out;
  }

  for (const key of [
    'findings',
    'items',
    'notes',
    'entries',
    'changes',
    'work_packages',
    'changed_files',
    'bug_reports',
  ] as const) {
    const v = r[key];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  }

  const collected: Array<Record<string, unknown>> = [];
  const entries = Object.entries(r);
  for (const [key, value] of entries) {
    if (REGISTRY_METADATA_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const el of value) {
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          collected.push(el as Record<string, unknown>);
        }
      }
    }
  }

  return collected;
}

function parseVerificationVerdict(v: unknown): VerificationVerdict | undefined {
  if (v === 'CONFIRMED' || v === 'DISPUTED' || v === 'UNVERIFIED') return v;
  return undefined;
}

/**
 * Overlay worker `verification_results` onto base items (by originalId). Rows-only-in-results append.
 */
export function mergeVerificationResults(
  base: VerificationItem[],
  verification_results: unknown,
): VerificationItem[] {
  if (!Array.isArray(verification_results) || verification_results.length === 0) {
    return base;
  }

  const overlay = new Map<string, Partial<VerificationItem>>();
  for (const row of verification_results) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as VerificationResultInput;
    const oid = coalesceString(rec.originalId ?? rec.original_id);
    if (!oid) continue;

    const partial: Partial<VerificationItem> = {};
    const verdict = parseVerificationVerdict(rec.verdict);
    if (verdict !== undefined) partial.verdict = verdict;
    if (rec.confidence !== undefined && typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)) {
      partial.confidence = Math.max(0, Math.min(1, rec.confidence));
    }
    const ce = rec.counterEvidence ?? rec.counter_evidence;
    if (ce !== undefined) partial.counterEvidence = coalesceString(ce);
    const se = rec.supportingEvidence ?? rec.supporting_evidence;
    if (se !== undefined) partial.supportingEvidence = coalesceString(se);
    const vb = rec.verifiedBy ?? rec.verified_by;
    if (vb !== undefined) partial.verifiedBy = coalesceString(vb) || 'worker';
    const va = rec.verifiedAt ?? rec.verified_at;
    if (va !== undefined) partial.verifiedAt = coalesceString(va);

    const prev = overlay.get(oid) ?? {};
    overlay.set(oid, { ...prev, ...partial });
  }

  const seen = new Set<string>();
  const merged: VerificationItem[] = base.map((item) => {
    seen.add(item.originalId);
    const o = overlay.get(item.originalId);
    if (!o) return { ...item };
    return {
      ...item,
      ...o,
      verifiedAt: o.verifiedAt || item.verifiedAt,
      verifiedBy: o.verifiedBy || item.verifiedBy,
      confidence: o.confidence !== undefined ? o.confidence : item.confidence,
    };
  });

  for (const [originalId, partial] of overlay.entries()) {
    if (seen.has(originalId)) continue;
    merged.push({
      originalId,
      verdict: parseVerificationVerdict(partial.verdict) ?? 'UNVERIFIED',
      confidence: partial.confidence ?? 0,
      counterEvidence: partial.counterEvidence,
      supportingEvidence: partial.supportingEvidence,
      verifiedBy: partial.verifiedBy ?? 'worker',
      verifiedAt: partial.verifiedAt || new Date().toISOString(),
    });
  }

  return merged;
}

function coalesceString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

// ---------------------------------------------------------------------------
// Module Factory
// ---------------------------------------------------------------------------

/**
 * Configuration for creating a verification module instance.
 */
export interface VerifyModuleConfig {
  /** Name of the source module whose output will be verified */
  sourceModule: string;
  /** Key in the source module's outputs that contains the registry to verify */
  registryKey?: string;
  /** Key within each registry item that serves as the item ID */
  itemIdKey?: string;
}

const VERIFY_GATE_CHECKS: string[] = ['all-items-have-verdict', 'disputed-have-counter-evidence'];

/**
 * Create a parameterized verification module.
 *
 * @param config - Configuration specifying which source module to verify
 */
export function createVerifyModule(config: VerifyModuleConfig): WorkflowModule {
  const {
    sourceModule,
    registryKey = 'finding_registry',
    itemIdKey = 'id',
  } = config;

  return {
    name: `verify-${sourceModule}`,
    description: `Verify outputs from the ${sourceModule} module. Cross-reference, challenge, and produce verdicts.`,
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          [registryKey]: {
            type: 'object',
            description: `Registry output from the ${sourceModule} module`,
            required: true,
          },
          verification_results: {
            type: 'array',
            description:
              'Optional worker verification rows merged by originalId (verdict, confidence, evidence)',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          verified_registry: {
            type: 'object',
            description: 'Verified registry with CONFIRMED/DISPUTED/UNVERIFIED verdicts per item',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_verification_hive: Spawn verification workers',
      'distribute_claims: Assign registry items to verifiers',
      'cross_reference: Cross-reference each item against codebase',
      'challenge_each: Challenge findings and look for counter-evidence',
      'synthesize_verdicts: Produce final verdicts for each item',
    ],

    hooks: {
      pre: `pre_verify_${sourceModule}`,
      post: `post_verify_${sourceModule}`,
      onError: `verify_${sourceModule}_error`,
    },

    gates: {
      enabled: true,
      checks: [...VERIFY_GATE_CHECKS],
      minAgents: 2,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 4,
      roles: [
        {
          name: 'cross-referencer',
          agentType: 'researcher',
          modelPreference: 'sonnet',
          taskTemplate: `Cross-reference findings from ${sourceModule} against the codebase. Validate each claim.`,
        },
        {
          name: 'challenger',
          agentType: 'reviewer',
          modelPreference: 'opus',
          taskTemplate: `Challenge each finding from ${sourceModule}. Look for counter-evidence and alternative explanations.`,
        },
        {
          name: 'verdict-synthesizer',
          agentType: 'reviewer',
          modelPreference: 'opus',
          taskTemplate: 'Synthesize cross-reference and challenge results into final verdicts per item.',
        },
      ],
      workerDependencies: {
        'cross-referencer': [],
        'challenger': [],
        'verdict-synthesizer': ['cross-referencer', 'challenger'],
      },
      consensusStrategy: 'unanimous',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const registry = context.inputs[registryKey] as Record<string, unknown> | undefined;

        if (!registry) {
          return {
            success: false,
            outputs: {},
            error: `No registry found at input key "${registryKey}" from source module "${sourceModule}"`,
            durationMs: Date.now() - startTime,
          };
        }

        const rawItems = extractRegistryItems(registry);

        const inputsRec = context.inputs as Record<string, unknown>;
        const verification_results =
          inputsRec.verification_results ??
          inputsRec.verificationResults;

        let verificationItems: VerificationItem[] = rawItems.map((item) => {
          const idRaw = coalesceString(item[itemIdKey]);
          return {
            originalId: idRaw || 'unknown',
            verdict: 'UNVERIFIED' as VerificationVerdict,
            confidence: 0,
            verifiedBy: 'pending',
            verifiedAt: new Date().toISOString(),
          };
        });

        verificationItems = mergeVerificationResults(verificationItems, verification_results);

        verificationItems = verificationItems.map((v) => {
          const c =
            typeof v.confidence === 'number' && Number.isFinite(v.confidence) ? v.confidence : 0;
          return {
            ...v,
            confidence: Math.max(0, Math.min(1, c)),
          };
        });

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : VERIFY_GATE_CHECKS;

        const unverifiedList = verificationItems.filter((v) => v.verdict === 'UNVERIFIED');
        const unverifiedOriginalIds = unverifiedList.map((v) => v.originalId);

        const allOriginalsAddressed =
          !activeChecks.includes('all-items-have-verdict') || unverifiedList.length === 0;

        const disputedHaveEvidence =
          !activeChecks.includes('disputed-have-counter-evidence') ||
          verificationItems
            .filter((v) => v.verdict === 'DISPUTED')
            .every((v) => coalesceString(v.counterEvidence).length > 0);

        const gatePass = allOriginalsAddressed && disputedHaveEvidence;

        const failedChecks: string[] = [];
        if (activeChecks.includes('all-items-have-verdict') && !allOriginalsAddressed) {
          failedChecks.push('all-items-have-verdict');
        }
        if (activeChecks.includes('disputed-have-counter-evidence') && !disputedHaveEvidence) {
          failedChecks.push('disputed-have-counter-evidence');
        }

        const confirmed = verificationItems.filter((v) => v.verdict === 'CONFIRMED').length;
        const disputed = verificationItems.filter((v) => v.verdict === 'DISPUTED').length;
        const unverified = unverifiedList.length;
        const total = verificationItems.length;
        const avgConfidence =
          total > 0
            ? verificationItems.reduce((sum, v) => sum + v.confidence, 0) / total
            : 0;

        const verifiedRegistry: VerifiedRegistry = {
          sourceModule,
          items: verificationItems,
          summary: {
            total,
            confirmed,
            disputed,
            unverified,
            overallConfidence: avgConfidence,
            unverifiedOriginalIds,
          },
          metadata: {
            verifiedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            workersUsed: 0,
          },
        };

        return {
          success: true,
          outputs: { verified_registry: verifiedRegistry },
          durationMs: Date.now() - startTime,
          gateResult: {
            passed: gatePass,
            failedChecks: gatePass ? [] : failedChecks,
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
