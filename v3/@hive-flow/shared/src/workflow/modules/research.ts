/**
 * Research Module
 *
 * Workflow module for structured research: topics, evidence, and brief synthesis.
 * Mirrors the investigation module pattern (factory, contract, hive, gates).
 */

import type {
  WorkflowModule,
  ModuleExecutionContext,
  ModuleExecutionResult,
} from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchNote {
  id: string;
  topic: string;
  summary: string;
  /** URLs, citations, or file paths supporting the note */
  sources: string[];
  /** 0–1 confidence in the summary */
  confidence: number;
  producedBy: string;
  recordedAt: string;
}

export type RawResearchNote = {
  id?: string;
  topic?: string;
  summary?: string;
  sources?: unknown;
  source?: string;
  confidence?: number;
  producedBy?: string;
  produced_by?: string;
  recordedAt?: string;
  recorded_at?: string;
};

export interface ResearchBrief {
  notes: ResearchNote[];
  topics: string[];
  summary: {
    total: number;
    byTopic: Record<string, number>;
    avgConfidence: number;
  };
  metadata: {
    scope?: string;
    researchedAt: string;
    durationMs: number;
    workersUsed: number;
  };
}

// ---------------------------------------------------------------------------
// Normalization, dedupe, gates
// ---------------------------------------------------------------------------

const RESEARCH_GATE_CHECKS: string[] = ['topics-aligned', 'sources-present', 'completeness'];

function coalesceString(v: unknown): string {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function fingerprintNote(n: Omit<ResearchNote, 'id'>): string {
  return [n.topic, n.summary.slice(0, 200), n.sources.join(',')].join('\u241e');
}

function stableNoteId(fp: string): string {
  let h = 2166136261;
  for (let i = 0; i < fp.length; i++) {
    h ^= fp.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `res-${(h >>> 0).toString(36)}`;
}

function normalizeSources(raw: unknown, single: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const s of raw) {
      const t = coalesceString(s);
      if (t) out.push(t);
    }
  }
  const one = coalesceString(single);
  if (one) out.push(one);
  return [...new Set(out)];
}

/**
 * Normalize a worker-supplied note into {@link ResearchNote}.
 */
export function normalizeRawResearchNote(
  raw: unknown,
  defaults: { topicFallback: string; producedBy: string },
): ResearchNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawResearchNote;

  const topic = coalesceString(r.topic) || defaults.topicFallback;
  const summary = coalesceString(r.summary) || '(no summary)';
  const sourcesRaw = (r as { sources?: unknown }).sources;
  const sources = normalizeSources(sourcesRaw, r.source);
  const producedBy = coalesceString(r.producedBy ?? r.produced_by) || defaults.producedBy;

  let confidence = 0.5;
  if (r.confidence !== undefined && typeof r.confidence === 'number' && Number.isFinite(r.confidence)) {
    confidence = Math.max(0, Math.min(1, r.confidence));
  }

  const base: Omit<ResearchNote, 'id'> = {
    topic,
    summary,
    sources,
    confidence,
    producedBy,
    recordedAt: coalesceString(r.recordedAt ?? r.recorded_at) || new Date().toISOString(),
  };

  const idRaw = coalesceString(r.id);
  const id = idRaw || stableNoteId(fingerprintNote(base));

  return { id, ...base };
}

export function dedupeResearchNotes(notes: ResearchNote[]): ResearchNote[] {
  const byId = new Set<string>();
  const byFp = new Set<string>();
  const out: ResearchNote[] = [];
  for (const n of notes) {
    if (byId.has(n.id)) continue;
    const fp = fingerprintNote(n);
    if (byFp.has(fp)) continue;
    byId.add(n.id);
    byFp.add(fp);
    out.push(n);
  }
  return out;
}

function evaluateResearchGates(
  notes: ResearchNote[],
  topicUniverse: string[],
  checks: string[],
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];
  const universe = new Set(topicUniverse.map(t => coalesceString(t)).filter(Boolean));

  if (checks.includes('topics-aligned')) {
    const ok = notes.every(n => n.topic.length > 0 && (universe.size === 0 || universe.has(n.topic)));
    if (!ok) failed.push('topics-aligned');
  }
  if (checks.includes('sources-present')) {
    const ok = notes.every(n => n.sources.length > 0 && n.sources.every(s => s.length > 0));
    if (!ok) failed.push('sources-present');
  }
  if (checks.includes('completeness')) {
    const ok = notes.every(
      n =>
        n.topic.length > 0 &&
        n.summary.length > 0 &&
        n.producedBy.length > 0,
    );
    if (!ok) failed.push('completeness');
  }

  return { passed: failed.length === 0, failedChecks: failed };
}

function buildTopicCounts(notes: ResearchNote[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const n of notes) {
    m[n.topic] = (m[n.topic] || 0) + 1;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the research workflow module.
 */
export function createResearchModule(): WorkflowModule {
  return {
    name: 'research',
    description: 'Structured research across topics with cited sources and a synthesized brief',
    version: '1.0.0',

    contract: {
      inputs: {
        fields: {
          research_topics: {
            type: 'array',
            description: 'Topics to research (e.g. dependencies, APIs, prior art)',
            required: true,
          },
          scope: {
            type: 'string',
            description: 'Optional scope label (repo path, product area, or ticket)',
            required: false,
          },
          raw_notes: {
            type: 'array',
            description: 'Optional worker notes normalized, deduped, and gate-checked',
            required: false,
          },
        },
        additionalFields: true,
      },
      outputs: {
        fields: {
          research_brief: {
            type: 'object',
            description: 'Research brief with notes, topic rollups, and metadata',
            required: true,
          },
        },
        additionalFields: false,
      },
    },

    flow: [
      'spawn_hive: Spawn researchers per topic',
      'gather_sources: Collect citations and evidence',
      'synthesize_brief: Merge notes, dedupe, and compute rollups',
    ],

    hooks: {
      pre: 'pre_research',
      post: 'post_research',
      onError: 'research_error',
    },

    gates: {
      enabled: true,
      checks: [...RESEARCH_GATE_CHECKS],
      minAgents: 1,
      blocking: true,
      maxRetries: 2,
    },

    hiveConfig: {
      maxWorkers: 4,
      roles: [
        {
          name: 'scout',
          agentType: 'researcher',
          modelPreference: 'sonnet',
          taskTemplate: 'Research topic "{topic}" within scope {scope}. List concrete sources (paths, URLs, docs).',
        },
        {
          name: 'synthesizer',
          agentType: 'reviewer',
          modelPreference: 'sonnet',
          taskTemplate: 'Consolidate scout notes for {topic} into concise summaries with citations.',
        },
        {
          name: 'editor',
          agentType: 'reviewer',
          modelPreference: 'opus',
          taskTemplate: 'Produce a coherent research brief: no duplicate claims, clear topic attribution.',
        },
      ],
      workerDependencies: {
        scout: [],
        synthesizer: ['scout'],
        editor: ['synthesizer'],
      },
      consensusStrategy: 'weighted',
    },

    async execute(context: ModuleExecutionContext): Promise<ModuleExecutionResult> {
      const startTime = Date.now();

      try {
        const topics = (context.inputs.research_topics as string[]) || [];
        if (topics.length === 0) {
          return {
            success: false,
            outputs: {},
            error: 'No research_topics provided',
            durationMs: Date.now() - startTime,
          };
        }

        const scope = coalesceString(context.inputs.scope) || undefined;
        const normalized: ResearchNote[] = [];
        const raw = context.inputs.raw_notes;

        if (Array.isArray(raw)) {
          for (let i = 0; i < raw.length; i++) {
            const topicFallback = topics[i % topics.length] ?? topics[0] ?? 'general';
            const one = normalizeRawResearchNote(raw[i], {
              topicFallback,
              producedBy: 'worker',
            });
            if (one) normalized.push(one);
          }
        }

        const notes = dedupeResearchNotes(normalized);

        const gateChecks = context.metadata?.gateChecksOverride as string[] | undefined;
        const activeChecks = Array.isArray(gateChecks) ? gateChecks : RESEARCH_GATE_CHECKS;
        const gateOutcome = evaluateResearchGates(notes, topics, activeChecks);

        const total = notes.length;
        const avgConfidence =
          total > 0 ? notes.reduce((s, n) => s + n.confidence, 0) / total : 0;

        const brief: ResearchBrief = {
          notes,
          topics,
          summary: {
            total,
            byTopic: buildTopicCounts(notes),
            avgConfidence,
          },
          metadata: {
            scope,
            researchedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            workersUsed: 0,
          },
        };

        return {
          success: true,
          outputs: { research_brief: brief },
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
