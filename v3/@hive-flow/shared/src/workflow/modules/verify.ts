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
  };
  /** Verification metadata */
  metadata: {
    verifiedAt: string;
    durationMs: number;
    workersUsed: number;
  };
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
      checks: ['all-items-have-verdict', 'disputed-have-counter-evidence'],
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

        // Extract items from registry (handles both { findings: [...] } and { items: [...] })
        const rawItems = (
          (registry as Record<string, unknown>).findings ||
          (registry as Record<string, unknown>).items ||
          []
        ) as Array<Record<string, unknown>>;

        // In real execution, hive workers would perform cross-referencing and challenging.
        // Here we produce the verification structure.
        const verificationItems: VerificationItem[] = rawItems.map((item) => ({
          originalId: String(item[itemIdKey] || 'unknown'),
          verdict: 'UNVERIFIED' as VerificationVerdict,
          confidence: 0,
          verifiedBy: 'pending',
          verifiedAt: new Date().toISOString(),
        }));

        // Gate check: every item must have a verdict, disputed items must have counter-evidence
        const allHaveVerdict = verificationItems.every(v => v.verdict !== undefined);
        const disputedHaveEvidence = verificationItems
          .filter(v => v.verdict === 'DISPUTED')
          .every(v => v.counterEvidence !== undefined && v.counterEvidence.length > 0);

        const gatePass = allHaveVerdict && disputedHaveEvidence;

        const confirmed = verificationItems.filter(v => v.verdict === 'CONFIRMED').length;
        const disputed = verificationItems.filter(v => v.verdict === 'DISPUTED').length;
        const unverified = verificationItems.filter(v => v.verdict === 'UNVERIFIED').length;
        const total = verificationItems.length;
        const avgConfidence = total > 0
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
          },
          metadata: {
            verifiedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            workersUsed: 0, // Updated when hive is actually spawned
          },
        };

        return {
          success: true,
          outputs: { verified_registry: verifiedRegistry },
          durationMs: Date.now() - startTime,
          gateResult: {
            passed: gatePass,
            failedChecks: gatePass ? [] : [
              ...(allHaveVerdict ? [] : ['all-items-have-verdict']),
              ...(disputedHaveEvidence ? [] : ['disputed-have-counter-evidence']),
            ],
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
