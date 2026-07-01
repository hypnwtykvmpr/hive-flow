/**
 * Investigation Module
 *
 * Self-contained workflow module for codebase investigation.
 * Spawns a hive of workers to investigate focus areas, collect findings,
 * and synthesize results into a finding registry.
 *
 * Implements the WorkflowModule interface.
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';

/**
 * Individual finding from an investigation.
 */
export interface InvestigationFinding {
  /** Unique finding ID */
  id: string;
  /** Category of finding */
  category: string;
  /** Description of what was found */
  description: string;
  /** File path where the finding was located */
  filePath: string;
  /** Line number (or range) */
  lineNumber: number;
  /** End line number (for ranges) */
  lineNumberEnd?: number;
  /** Severity: info, warning, error, critical */
  severity: 'info' | 'warning' | 'error' | 'critical';
  /** The focus area this finding relates to */
  focusArea: string;
  /** Worker role that produced this finding */
  producedBy: string;
  /** Raw evidence (code snippet, log excerpt, etc.) */
  evidence?: string;
  /** Timestamp */
  foundAt: string;
}

/**
 * Lenient shape for worker / bridge payloads (normalized into {@link InvestigationFinding}).
 */
export type RawInvestigationFinding = {
  id?: string;
  category?: string;
  description?: string;
  filePath?: string;
  file_path?: string;
  lineNumber?: number;
  line_number?: number;
  lineNumberEnd?: number;
  line_number_end?: number;
  severity?: InvestigationFinding['severity'];
  focusArea?: string;
  focus_area?: string;
  producedBy?: string;
  produced_by?: string;
  evidence?: string;
  foundAt?: string;
  found_at?: string;
};

/**
 * The finding registry is the output of the investigation module.
 */
export interface FindingRegistry {
  /** All findings collected */
  findings: InvestigationFinding[];
  /** Focus areas that were investigated */
  focusAreas: string[];
  /** Summary statistics */
  summary: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    byFocusArea: Record<string, number>;
  };
  /** Investigation metadata */
  metadata: {
    codebasePath: string;
    investigatedAt: string;
    durationMs: number;
    workersUsed: number;
  };
}

// ---------------------------------------------------------------------------
// Normalization, dedupe, gates
// ---------------------------------------------------------------------------

const SEVERITIES: InvestigationFinding['severity'][] = ['info', 'warning', 'error', 'critical'];

function coalesceString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function simpleDedupeKey(parts: string[]): string {
  return parts.join('\u241e'); // RECORD SEPARATOR — unlikely in paths
}

function fingerprintFinding(f: Omit<InvestigationFinding, 'id'>): string {
  return simpleDedupeKey([
    f.filePath,
    String(f.lineNumber),
    f.category,
    f.description.slice(0, 200),
    f.focusArea,
  ]);
}

function stableIdFromFingerprint(fp: string): string {
  let h = 2166136261;
  for (let i = 0; i < fp.length; i++) {
    h ^= fp.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `inv-${(h >>> 0).toString(36)}`;
}

function normalizeSeverity(v: unknown): InvestigationFinding['severity'] {
  if (typeof v === 'string' && (SEVERITIES as string[]).includes(v)) {
    return v as InvestigationFinding['severity'];
  }
  return 'info';
}

/**
 * Normalize a single raw worker finding into the strict registry shape.
 */
export function normalizeRawInvestigationFinding(
  raw: unknown,
  defaults: { focusArea: string; producedBy: string },
): InvestigationFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawInvestigationFinding;

  const filePath = coalesceString(r.filePath ?? r.file_path);
  const description = coalesceString(r.description);
  const category = coalesceString(r.category) || 'general';
  const lineNumberRaw = r.lineNumber ?? r.line_number;
  const lineNumber =
    typeof lineNumberRaw === 'number' && Number.isFinite(lineNumberRaw) ? Math.trunc(lineNumberRaw) : 0;
  const lineEndRaw = r.lineNumberEnd ?? r.line_number_end;
  const lineNumberEnd =
    typeof lineEndRaw === 'number' && Number.isFinite(lineEndRaw) ? Math.trunc(lineEndRaw) : undefined;

  const focusArea = coalesceString(r.focusArea ?? r.focus_area) || defaults.focusArea;
  const producedBy = coalesceString(r.producedBy ?? r.produced_by) || defaults.producedBy;

  const base: Omit<InvestigationFinding, 'id'> = {
    category,
    description: description || '(no description)',
    filePath,
    lineNumber,
    lineNumberEnd,
    severity: normalizeSeverity(r.severity),
    focusArea,
    producedBy,
    evidence: r.evidence !== undefined ? coalesceString(r.evidence) : undefined,
    foundAt: coalesceString(r.foundAt ?? r.found_at) || new Date().toISOString(),
  };

  const idRaw = coalesceString(r.id);
  const id = idRaw || stableIdFromFingerprint(fingerprintFinding(base));

  return { id, ...base };
}

/**
 * Deduplicate findings: prefer explicit `id` collisions first, then structural fingerprint.
 */
export function dedupeInvestigationFindings(findings: InvestigationFinding[]): InvestigationFinding[] {
  const byId = new Set<string>();
  const byFp = new Set<string>();
  const out: InvestigationFinding[] = [];

  for (const f of findings) {
    if (byId.has(f.id)) continue;
    const fp = fingerprintFinding(f);
    if (byFp.has(fp)) continue;
    byId.add(f.id);
    byFp.add(fp);
    out.push(f);
  }
  return out;
}

const INVESTIGATE_GATE_CHECKS: string[] = ['file-paths', 'line-numbers', 'completeness'];

function evaluateInvestigateGates(
  findings: InvestigationFinding[],
  checks: string[],
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];

  if (checks.includes('file-paths')) {
    const ok = findings.every(f => f.filePath.length > 0);
    if (!ok) failed.push('file-paths');
  }
  if (checks.includes('line-numbers')) {
    const ok = findings.every(f => f.lineNumber > 0);
    if (!ok) failed.push('line-numbers');
  }
  if (checks.includes('completeness')) {
    const ok = findings.every(
      f =>
        f.category.length > 0 &&
        f.description.length > 0 &&
        f.focusArea.length > 0 &&
        f.producedBy.length > 0,
    );
    if (!ok) failed.push('completeness');
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

/**
 * Create the investigation module.
 */
export function createInvestigateModule(): WorkflowModule {
  return {
    name: 'investigate',
    description: 'Investigate codebase focus areas, collect findings with file paths and line numbers',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          codebase_path: {
            type: 'string',
            description: 'Root path of the codebase to investigate',
            required: true,
          },
          focus_areas: {
            type: 'array',
            description: 'List of focus areas to investigate (e.g., "security", "performance")',
            required: true,
          },
          raw_findings: {
            type: 'array',
            description:
              'Optional pre-collected findings from workers; normalized, deduplicated, and gate-checked',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          finding_registry: {
            type: 'object',
            description: 'JSON finding registry with all investigation results',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_hive: Spawn investigation workers for each focus area',
      'distribute_tasks: Assign focus areas to workers',
      'collect_findings: Gather findings from all workers',
      'synthesize: Merge and deduplicate findings into a unified registry',
    ],

    hooks: {
      pre: 'pre_investigate',
      post: 'post_investigate',
      onError: 'investigate_error',
    },

    gates: {
      enabled: true,
      checks: [...INVESTIGATE_GATE_CHECKS],
      minAgents: 1,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 4,
      roles: [
        {
          name: 'scanner',
          agentType: 'researcher',
          modelPreference: 'sonnet',
          taskTemplate: 'Scan codebase at {codebase_path} for {focus_area} issues. Report findings with file paths and line numbers.',
        },
        {
          name: 'analyzer',
          agentType: 'coder',
          modelPreference: 'sonnet',
          taskTemplate: 'Analyze scanner findings for {focus_area}. Validate file paths and add context.',
        },
        {
          name: 'synthesizer',
          agentType: 'reviewer',
          modelPreference: 'opus',
          taskTemplate: 'Synthesize all findings into a unified registry. Deduplicate and categorize.',
        },
      ],
      workerDependencies: {
        scanner: [],
        analyzer: ['scanner'],
        synthesizer: ['analyzer'],
      },
      consensusStrategy: 'weighted',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const codebasePath = (context.inputs.codebase_path as string) || process.cwd();
        const focusAreas = (context.inputs.focus_areas as string[]) || [];

        if (focusAreas.length === 0) {
          return {
            success: false,
            outputs: {},
            error: 'No focus areas provided for investigation',
            durationMs: Date.now() - startTime,
          };
        }

        const normalized: InvestigationFinding[] = [];

        const raw = context.inputs.raw_findings;
        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length; i++) {
            const item = raw[i];
            const focusFallback = focusAreas[i % focusAreas.length] ?? focusAreas[0] ?? 'general';
            const normalizedOne = normalizeRawInvestigationFinding(item, {
              focusArea: focusFallback,
              producedBy: 'worker',
            });
            if (normalizedOne) normalized.push(normalizedOne);
          }
        }

        const findings = dedupeInvestigationFindings(normalized);

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : INVESTIGATE_GATE_CHECKS;
        const gateOutcome = evaluateInvestigateGates(findings, activeChecks);

        const registry: FindingRegistry = {
          findings,
          focusAreas,
          summary: {
            total: findings.length,
            byCategory: buildCountMap(findings, 'category'),
            bySeverity: buildCountMap(findings, 'severity'),
            byFocusArea: buildCountMap(findings, 'focusArea'),
          },
          metadata: {
            codebasePath,
            investigatedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            workersUsed: 0,
          },
        };

        return {
          success: true,
          outputs: { finding_registry: registry },
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

/**
 * Build a count map from an array of findings by a given key.
 */
function buildCountMap(
  findings: InvestigationFinding[],
  key: keyof InvestigationFinding,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const f of findings) {
    const val = String(f[key]);
    map[val] = (map[val] || 0) + 1;
  }
  return map;
}
