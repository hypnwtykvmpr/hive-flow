/**
 * Implement Module — track implementation results for work packages.
 *
 * Pattern aligns with investigate.ts (factory, contract, hive, gates, execute).
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';
import type { ExecutionPlan, WorkPackage } from './planning.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChangedFile {
  id: string;
  path: string;
  changeKind: 'edit' | 'add' | 'delete' | string;
  packageId?: string;
  synthetic?: boolean;
}

export interface BugReport {
  id: string;
  packageId?: string;
  description: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
}

export interface ImplementationResult {
  changed_files: ChangedFile[];
  bug_reports: BugReport[];
  totals: {
    filesTouched: number;
    packagesCompleted: number;
    bugsOpen: number;
  };
  metadata: {
    implementedAt: string;
    durationMs: number;
    workersUsed: number;
  };
}

export type RawChangedFile = {
  id?: string;
  path?: string;
  file?: string;
  changeKind?: string;
  change_kind?: string;
  packageId?: string;
  package_id?: string;
  synthetic?: boolean;
};

export type RawBugReport = {
  id?: string;
  packageId?: string;
  package_id?: string;
  description?: string;
  severity?: BugReport['severity'];
};

const BUG_SEVERITIES: BugReport['severity'][] = ['info', 'warning', 'error', 'critical'];

// ---------------------------------------------------------------------------
// Gates + normalization
// ---------------------------------------------------------------------------

const IMPLEMENT_GATE_CHECKS: string[] = ['syntax', 'semantic', 'security', 'edge-case', 'real-work'];

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

export function normalizeRawChangedFile(raw: unknown): ChangedFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawChangedFile;
  const path = coalesceString(r.path ?? r.file);
  const changeKind = coalesceString(r.changeKind ?? r.change_kind) || 'edit';
  const packageId = coalesceString(r.packageId ?? r.package_id) || undefined;
  const synthetic = r.synthetic === true ? true : undefined;
  const id = coalesceString(r.id) || stableId('cf', `${path}\u241e${changeKind}\u241e${packageId ?? ''}`);
  if (!path) return null;
  return { id, path, changeKind, packageId, synthetic };
}

export function normalizeRawBugReport(raw: unknown): BugReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawBugReport;
  const description = coalesceString(r.description) || '(no description)';
  const sev = r.severity;
  const severity =
    typeof sev === 'string' && (BUG_SEVERITIES as string[]).includes(sev)
      ? (sev as BugReport['severity'])
      : 'warning';
  const packageId = coalesceString(r.packageId ?? r.package_id) || undefined;
  const id = coalesceString(r.id) || stableId('bug', `${description.slice(0, 120)}\u241e${packageId ?? ''}`);
  return { id, packageId, description, severity };
}

function pathLooksValid(path: string): boolean {
  if (path.length === 0) return false;
  if (path === '.' || path === '..') return false;
  if (path.includes('\0')) return false;
  return true;
}

function isEnvPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.env') ||
    lower.includes('/.env') ||
    lower.includes('\\.env') ||
    lower.split('/').pop() === '.env' ||
    lower.split('\\').pop() === '.env'
  );
}

function evaluateImplementGates(
  packages: WorkPackage[],
  changedFiles: ChangedFile[],
  bugReports: BugReport[],
  checks: string[],
  outputSynthetic: boolean,
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];

  if (checks.includes('syntax')) {
    const ok = changedFiles.every(f => pathLooksValid(f.path));
    if (!ok) failed.push('syntax');
  }

  if (checks.includes('semantic')) {
    const ok =
      packages.length === 0 ||
      packages.every(p => Array.isArray(p.files) && p.files.length > 0);
    if (!ok) failed.push('semantic');
  }

  if (checks.includes('security')) {
    const ok = changedFiles.every(f => !isEnvPath(f.path));
    if (!ok) failed.push('security');
  }

  if (checks.includes('edge-case')) {
    const touchedByPkg = new Set<string>();
    for (const f of changedFiles) {
      if (f.packageId) touchedByPkg.add(f.packageId);
    }
    const ok =
      packages.length === 0 ||
      packages.every(p => touchedByPkg.has(p.id) || p.files.length === 0);
    if (!ok) failed.push('edge-case');
  }

  if (checks.includes('real-work')) {
    if (outputSynthetic === true) failed.push('real-work');
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

function syntheticChangedFiles(packages: WorkPackage[]): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const p of packages) {
    for (const file of p.files) {
      const path = coalesceString(file);
      if (!path) continue;
      out.push({
        id: stableId('cf', `${p.id}\u241e${path}`),
        path,
        changeKind: 'edit',
        packageId: p.id,
        synthetic: true,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createImplementModule(): WorkflowModule {
  return {
    name: 'implement',
    description: 'Apply and record implementation outcomes per execution plan work packages',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          execution_plan: {
            type: 'object',
            description: 'Planning output: work_packages[], bands[], etc.',
            required: false,
          },
          approved_plan: {
            type: 'object',
            description: 'Alias for execution_plan after approval',
            required: false,
          },
          band_config: {
            type: 'object',
            description: 'Optional band-level overrides (recorded in metadata only here)',
            required: false,
          },
          changed_files: {
            type: 'array',
            description: 'Optional worker-supplied changed file rows',
            required: false,
          },
          bug_reports: {
            type: 'array',
            description: 'Optional worker bug findings',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          implementation_result: {
            type: 'object',
            description: 'changed_files, bug_reports, totals',
            required: true,
          },
          _synthetic: {
            type: 'boolean',
            description: 'True when implementation output is synthetic rather than worker-produced',
            required: false,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_hive: Four parallel coders plus bug-hunter',
      'assign_packages: Map work packages to coders',
      'record_changes: Aggregate ChangedFile rows',
      'track_bugs: Merge bug-hunter BugReport rows',
    ],

    hooks: {
      pre: 'pre_implement',
      post: 'post_implement',
      onError: 'implement_error',
    },

    gates: {
      enabled: true,
      checks: [...IMPLEMENT_GATE_CHECKS],
      minAgents: 1,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 5,
      roles: [
        {
          name: 'coder-alpha',
          agentType: 'coder',
          modelPreference: 'sonnet',
          taskTemplate: 'Implement assigned work packages; emit changed_files with packageId.',
        },
        {
          name: 'coder-beta',
          agentType: 'coder',
          modelPreference: 'sonnet',
          taskTemplate: 'Implement assigned work packages; emit changed_files with packageId.',
        },
        {
          name: 'coder-gamma',
          agentType: 'coder',
          modelPreference: 'sonnet',
          taskTemplate: 'Implement assigned work packages; emit changed_files with packageId.',
        },
        {
          name: 'coder-delta',
          agentType: 'coder',
          modelPreference: 'sonnet',
          taskTemplate: 'Implement assigned work packages; emit changed_files with packageId.',
        },
        {
          name: 'bug-hunter',
          agentType: 'tester',
          modelPreference: 'opus',
          taskTemplate:
            'Parallel review: hunt regressions for active packages; return concise bug_reports.',
        },
      ],
      workerDependencies: {
        'coder-alpha': [],
        'coder-beta': [],
        'coder-gamma': [],
        'coder-delta': [],
        'bug-hunter': [],
      },
      consensusStrategy: 'weighted',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const inputs = context.inputs as Record<string, unknown>;
        const plan = (inputs.execution_plan ?? inputs.approved_plan) as ExecutionPlan | undefined;
        if (!plan || !Array.isArray(plan.work_packages)) {
          return {
            success: false,
            outputs: {},
            error: 'execution_plan or approved_plan with work_packages[] is required',
            durationMs: Date.now() - startTime,
          };
        }

        const packages = plan.work_packages;
        const changed: ChangedFile[] = [];
        const rawCf = inputs.changed_files ?? inputs.changedFiles;
        if (Array.isArray(rawCf)) {
          for (const row of rawCf) {
            const one = normalizeRawChangedFile(row);
            if (one) changed.push(one);
          }
        }

        if (changed.length === 0) {
          changed.push(...syntheticChangedFiles(packages));
        }

        const bugs: BugReport[] = [];
        const rawBugs = inputs.bug_reports ?? inputs.bugReports;
        if (Array.isArray(rawBugs)) {
          for (const row of rawBugs) {
            const one = normalizeRawBugReport(row);
            if (one) bugs.push(one);
          }
        }

        const bugsOpen = bugs.filter(b => b.severity === 'error' || b.severity === 'critical').length;
        const outputSynthetic = changed.length > 0 && changed.every(file => file.synthetic === true);

        const implementation_result: ImplementationResult = {
          changed_files: changed,
          bug_reports: bugs,
          totals: {
            filesTouched: changed.length,
            packagesCompleted: outputSynthetic ? 0 : packages.length,
            bugsOpen,
          },
          metadata: {
            implementedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            workersUsed: 0,
          },
        };

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : IMPLEMENT_GATE_CHECKS;
        const outputs = { implementation_result, _synthetic: outputSynthetic };
        const gateOutcome = evaluateImplementGates(
          packages,
          changed,
          bugs,
          activeChecks,
          outputs._synthetic === true,
        );

        void inputs.band_config;

        return {
          success: true,
          outputs,
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
