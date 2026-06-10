/**
 * Context Offloader
 *
 * Prepares re-ranking requests for large-context providers (Gemini 1M, Codex 400K).
 * Pure data preparation layer — actual CLI execution is handled by HeadlessWorkerExecutor.
 *
 * @module v3/cli/services/context-offloader
 */

import type { ShadowEntry } from './context-shadow.js';

// ============================================================================
// Types
// ============================================================================

export interface ProviderAvailability {
  gemini: boolean;
  codex: boolean;
  cursor: boolean;
  recommended: string | null;
}

export interface OffloadRequest {
  sessionId: string;
  entries: Array<{
    id: string;
    role: string;
    content: string;
    tokenEstimate: number;
    currentScore: number;
    toolNames: string[];
    filePaths: string[];
  }>;
  currentPhase: 'warning' | 'critical';
  totalTokens: number;
}

export interface OffloadResponse {
  success: boolean;
  provider: string;
  rankings: Array<{
    id: string;
    score: number;
    category: 'critical' | 'important' | 'moderate' | 'low' | 'disposable';
    summary: string;
  }>;
  suggestedCulls: string[];
  suggestedSummarizations: string[];
  error?: string;
}

// ============================================================================
// ContextOffloader
// ============================================================================

export class ContextOffloader {
  private provider: string;
  private fallback: string;
  private enabled: boolean;

  constructor() {
    this.provider = process.env.HIVE_FLOW_OFFLOAD_PROVIDER || 'gemini-cli';
    this.fallback = process.env.HIVE_FLOW_OFFLOAD_FALLBACK || 'codex-cli';
    this.enabled = process.env.HIVE_FLOW_OFFLOAD_ENABLED !== 'false';
  }

  checkProviders(): ProviderAvailability {
    const gemini = !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
    const codex = !!process.env.OPENAI_API_KEY;
    const cursor = false;

    let recommended: string | null = null;
    if (gemini) recommended = 'gemini-cli';
    else if (codex) recommended = 'codex-cli';

    return { gemini, codex, cursor, recommended };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  buildRequest(sessionId: string, entries: ShadowEntry[], phase: 'warning' | 'critical'): OffloadRequest {
    return {
      sessionId,
      entries: entries.map(e => ({
        id: e.id,
        role: e.role,
        content: e.content.slice(0, 2000),
        tokenEstimate: e.tokenEstimate,
        currentScore: e.importanceScore,
        toolNames: e.toolNames,
        filePaths: e.filePaths,
      })),
      currentPhase: phase,
      totalTokens: entries.reduce((sum, e) => sum + e.tokenEstimate, 0),
    };
  }

  buildOffloadPrompt(request: OffloadRequest): string {
    const entrySummaries = request.entries.map(e =>
      `[${e.id}] role=${e.role} tokens=${e.tokenEstimate} score=${e.currentScore.toFixed(3)} tools=[${e.toolNames.join(',')}] files=[${e.filePaths.join(',')}]\n  "${e.content.slice(0, 200)}..."`
    ).join('\n');

    const phaseGuidance = request.currentPhase === 'critical'
      ? '85%+ storage-prune threshold; 80%+ is historically redlined for compaction planning, and 95%+ is the hard redline'
      : '70%+ warning zone; begin preserving clean compaction boundaries while optimizing context';

    return `You are a context window optimization agent. Analyze these conversation entries and re-rank by importance.

Phase: ${request.currentPhase} (${phaseGuidance})
Total tokens: ${request.totalTokens}
Entries: ${request.entries.length}

ENTRIES:
${entrySummaries}

INSTRUCTIONS:
1. Assign each entry a score from 0.0 to 1.0
2. Categorize as: critical, important, moderate, low, disposable
3. Write a 1-sentence summary for each
4. Suggest which entries to cull (remove entirely)
5. Suggest which entries to summarize (replace with summary)

RESPOND WITH VALID JSON ONLY:
{
  "rankings": [{"id": "...", "score": 0.85, "category": "critical", "summary": "..."}],
  "suggestedCulls": ["id1", "id2"],
  "suggestedSummarizations": ["id3", "id4"]
}`;
  }

  parseResponse(provider: string, rawOutput: string): OffloadResponse {
    try {
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { success: false, provider, rankings: [], suggestedCulls: [], suggestedSummarizations: [], error: 'No JSON found' };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        provider,
        rankings: parsed.rankings || [],
        suggestedCulls: parsed.suggestedCulls || [],
        suggestedSummarizations: parsed.suggestedSummarizations || [],
      };
    } catch (err) {
      return {
        success: false,
        provider,
        rankings: [],
        suggestedCulls: [],
        suggestedSummarizations: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getPreferredProvider(): string {
    const avail = this.checkProviders();
    return avail.recommended || this.provider;
  }

  getFallbackProvider(): string {
    return this.fallback;
  }
}

export default ContextOffloader;
