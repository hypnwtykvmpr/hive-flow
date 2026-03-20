/**
 * Commit Module — final commit gate after a passing audit.
 *
 * Pattern aligns with investigate.ts (factory, contract, hive, gates, execute).
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';
import type { AuditResult } from './audit.js';
import type { ImplementationResult } from './implement.js';

// ---------------------------------------------------------------------------
// Secret scanning (deterministic regex gates)
// ---------------------------------------------------------------------------

/** Eight deterministic secret/leak patterns scanned on the diff surface before commit. */
export const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN.*PRIVATE KEY/,
  /password\s*[:=]/,
  /bearer\s+\S+/i,
  /\.env/,
  /credentials/,
  /api[_-]?key\s*[:=]/i,
  /connection[_-]?string\s*[:=]/i,
];

export interface CommitResult {
  hash: string;
  message: string;
  files: string[];
  metadata: {
    committedAt: string;
    durationMs: number;
    band_id?: string;
    finding_count: number;
  };
}

const COMMIT_GATE_CHECKS: string[] = ['audit-passed', 'pipeline-stages-complete', 'no-secrets-in-diff'];

function coalesceString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function hashCommitPayload(message: string, files: string[]): string {
  const payload = `${message}\n${files.slice().sort().join('\n')}`;
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `sha256-synth-${(h >>> 0).toString(16)}`;
}

function collectDiffSurface(
  impl: ImplementationResult,
  inputs: Record<string, unknown>,
): string {
  const chunks: string[] = [];
  const diffText = inputs.diff_text ?? inputs.diffText ?? inputs.staged_diff ?? inputs.stagedDiff;
  if (typeof diffText === 'string' && diffText.length > 0) chunks.push(diffText);

  for (const f of impl.changed_files ?? []) {
    chunks.push(f.path);
  }
  const findingPart = JSON.stringify(inputs.finding_ids ?? inputs.findingIds ?? []);
  chunks.push(findingPart);
  return chunks.join('\n');
}

function secretsDetectedInText(text: string): boolean {
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

function evaluateCommitGates(params: {
  audit: AuditResult;
  diffSurface: string;
  pipelineComplete: unknown;
  checks: string[];
}): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];
  const { audit, diffSurface, pipelineComplete, checks } = params;

  if (checks.includes('audit-passed')) {
    if (audit.overallVerdict !== 'PASS') failed.push('audit-passed');
  }
  if (checks.includes('pipeline-stages-complete')) {
    if (pipelineComplete !== true) failed.push('pipeline-stages-complete');
  }
  if (checks.includes('no-secrets-in-diff')) {
    if (secretsDetectedInText(diffSurface)) failed.push('no-secrets-in-diff');
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

export function createCommitModule(): WorkflowModule {
  return {
    name: 'commit',
    description: 'Final commit gate: audit PASS, pipeline stages, and secret scan on diff surface (single committer).',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          audit_result: {
            type: 'object',
            description: 'Audit module output; overallVerdict must be PASS',
            required: true,
          },
          implementation_result: {
            type: 'object',
            description: 'Implement module output (files list for commit message)',
            required: true,
          },
          band_id: {
            type: 'string',
            description: 'Band / stream identifier for the commit message',
            required: true,
          },
          finding_ids: {
            type: 'array',
            description: 'Finding IDs closed or referenced by this commit',
            required: true,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          commit_result: {
            type: 'object',
            description: 'Synthetic commit hash, conventional message, and file paths',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_hive: Single committer (sonnet)',
      'validate_gates: audit PASS, pipeline complete, no secrets in diff',
      'synthesize_commit: Build message + file list + deterministic hash',
    ],

    hooks: {
      pre: 'pre_commit',
      post: 'post_commit',
      onError: 'commit_error',
    },

    gates: {
      enabled: true,
      checks: [...COMMIT_GATE_CHECKS],
      minAgents: 1,
      blocking: true,
      maxRetries: 0,
    },

    hiveConfig: {
      maxWorkers: 1,
      roles: [
        {
          name: 'committer',
          agentType: 'coder',
          modelPreference: 'sonnet',
          taskTemplate:
            'Prepare conventional commit for band {band_id} covering files from implementation_result; respect governance hooks.',
        },
      ],
      workerDependencies: {
        committer: [],
      },
      consensusStrategy: 'unanimous',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();
      try {
        const inputs = context.inputs as Record<string, unknown>;
        const audit = inputs.audit_result as AuditResult | undefined;
        if (!audit || typeof audit !== 'object') {
          return {
            success: false,
            outputs: {},
            error: 'audit_result is required',
            durationMs: Date.now() - startTime,
          };
        }

        const impl = inputs.implementation_result as ImplementationResult | undefined;
        if (!impl || typeof impl !== 'object' || !Array.isArray(impl.changed_files)) {
          return {
            success: false,
            outputs: {},
            error: 'implementation_result with changed_files[] is required',
            durationMs: Date.now() - startTime,
          };
        }

        const band_id = coalesceString(inputs.band_id);
        if (!band_id) {
          return {
            success: false,
            outputs: {},
            error: 'band_id is required',
            durationMs: Date.now() - startTime,
          };
        }

        const rawFinding = inputs.finding_ids ?? inputs.findingIds;
        if (!Array.isArray(rawFinding)) {
          return {
            success: false,
            outputs: {},
            error: 'finding_ids array is required',
            durationMs: Date.now() - startTime,
          };
        }
        const finding_ids = rawFinding.map(v => coalesceString(v)).filter(Boolean);

        const diffSurface = collectDiffSurface(impl, inputs);
        const pipelineComplete = context.variables.pipelineComplete;

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : COMMIT_GATE_CHECKS;
        const gateOutcome = evaluateCommitGates({
          audit,
          diffSurface,
          pipelineComplete,
          checks: activeChecks,
        });

        const files = impl.changed_files.map(f => f.path).filter(p => coalesceString(p).length > 0);
        const message = `chore(${band_id}): complete workflow band — ${files.length} file(s), findings [${finding_ids.join(', ') || 'none'}]`;

        const commit_result: CommitResult = {
          hash: hashCommitPayload(message, files),
          message,
          files,
          metadata: {
            committedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            band_id,
            finding_count: finding_ids.length,
          },
        };

        return {
          success: gateOutcome.passed,
          outputs: { commit_result },
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
          error: gateOutcome.passed ? undefined : `Commit gates failed: ${gateOutcome.failedChecks.join(', ')}`,
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
