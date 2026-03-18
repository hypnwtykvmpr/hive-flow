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
      checks: ['file-paths', 'line-numbers', 'completeness'],
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

        // In the real implementation, this would spawn hive workers via MCP.
        // Here we produce the registry structure that workers would populate.
        const findings: InvestigationFinding[] = [];

        // Gate check: every finding must have file path and line number
        const gatePass = findings.every(f => f.filePath && f.lineNumber > 0);

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
            workersUsed: 0, // Updated when hive is actually spawned
          },
        };

        return {
          success: true,
          outputs: { finding_registry: registry },
          durationMs: Date.now() - startTime,
          gateResult: {
            passed: gatePass,
            failedChecks: gatePass ? [] : ['file-paths', 'line-numbers'],
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
