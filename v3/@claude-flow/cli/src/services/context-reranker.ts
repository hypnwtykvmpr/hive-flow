/**
 * Context Re-Ranking Engine
 *
 * Continuously ranks shadow copy entries using a 4-factor composite score.
 * Operates in three phases based on context window usage:
 *   - tracking (<70%): build/refresh ranking index
 *   - warning (70-85%): summarize low-ranked, prepare cull plan
 *   - critical (85%+): finalize cull plan for hook consumption
 *
 * @module v3/cli/services/context-reranker
 */

import type { ContextShadow, ShadowEntry, ShadowState } from './context-shadow.js';

// ============================================================================
// Types
// ============================================================================

export interface RankingConfig {
  recencyWeight: number;
  frequencyWeight: number;
  richnessWeight: number;
  semanticRelevanceWeight: number;
  trackingThreshold: number;
  warningThreshold: number;
  criticalThreshold: number;
  maxCullRatio: number;
}

export interface CullPlan {
  sessionId: string;
  createdAt: number;
  phase: 'warning' | 'critical';
  entriesToCull: Array<{
    id: string;
    rank: number;
    score: number;
    tokenEstimate: number;
    summaryShort: string;
  }>;
  entriesToSummarize: Array<{
    id: string;
    rank: number;
    summaryLong: string;
  }>;
  tokensFreed: number;
  tokensRetained: number;
  totalEntries: number;
}

export interface RerankResult {
  phase: 'tracking' | 'warning' | 'critical';
  entriesRanked: number;
  cullPlan: CullPlan | null;
  durationMs: number;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: RankingConfig = {
  recencyWeight: 0.30,
  frequencyWeight: 0.20,
  richnessWeight: 0.20,
  semanticRelevanceWeight: 0.30,
  trackingThreshold: 0.70,
  warningThreshold: 0.70,
  criticalThreshold: 0.85,
  maxCullRatio: 0.20,
};

// ============================================================================
// ContextReranker
// ============================================================================

export class ContextReranker {
  private shadow: ContextShadow;
  private config: RankingConfig;

  constructor(shadow: ContextShadow, config?: Partial<RankingConfig>) {
    this.shadow = shadow;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a full re-ranking cycle. Determines phase from shadow state.
   */
  async rerank(sessionId: string): Promise<RerankResult> {
    const start = Date.now();
    const state = await this.shadow.getState(sessionId);

    if (state.contextPercentage >= this.config.criticalThreshold) {
      const plan = await this.criticalPhase(sessionId, state);
      return { phase: 'critical', entriesRanked: state.totalEntries, cullPlan: plan, durationMs: Date.now() - start };
    }

    if (state.contextPercentage >= this.config.warningThreshold) {
      const plan = await this.warningPhase(sessionId, state);
      return { phase: 'warning', entriesRanked: state.totalEntries, cullPlan: plan, durationMs: Date.now() - start };
    }

    await this.trackPhase(sessionId, state);
    return { phase: 'tracking', entriesRanked: state.totalEntries, cullPlan: null, durationMs: Date.now() - start };
  }

  /**
   * Tracking phase: compute scores, update rankings
   */
  async trackPhase(sessionId: string, state?: ShadowState): Promise<void> {
    if (!state) state = await this.shadow.getState(sessionId);
    const entries = await this.shadow.getAll(sessionId);
    if (entries.length === 0) return;

    const recentEmbeddings = this.extractRecentEmbeddings(entries, 5);
    const now = Date.now();

    const scored = entries.map(entry => ({
      id: entry.id,
      score: this.computeCompositeScore(entry, recentEmbeddings, now),
    }));

    // Sort by score descending, assign ranks
    scored.sort((a, b) => b.score - a.score);
    const rankings = scored.map((s, i) => ({
      id: s.id,
      score: s.score,
      rank: i + 1,
    }));

    await this.shadow.updateRankings(rankings);
  }

  /**
   * Warning phase: rank + generate summaries for bottom entries + prepare cull plan
   */
  async warningPhase(sessionId: string, state?: ShadowState): Promise<CullPlan> {
    if (!state) state = await this.shadow.getState(sessionId);

    // First, do a full ranking pass
    await this.trackPhase(sessionId, state);

    // Get all entries sorted by rank
    const entries = await this.shadow.getAll(sessionId);
    const sorted = [...entries].sort((a, b) => b.importanceScore - a.importanceScore);

    // Generate extractive summaries for entries without them
    const needSummary = sorted.filter(e => !e.summaryShort);
    if (needSummary.length > 0) {
      const summaries = needSummary.map(e => ({
        id: e.id,
        summaryShort: extractiveSummary(e.content, 80),
        summaryLong: extractiveSummary(e.content, 300),
      }));
      await this.shadow.updateSummaries(summaries);
    }

    return this.buildCullPlan(sessionId, sorted, 'warning');
  }

  /**
   * Critical phase: rank + finalize cull plan
   */
  async criticalPhase(sessionId: string, state?: ShadowState): Promise<CullPlan> {
    if (!state) state = await this.shadow.getState(sessionId);
    await this.trackPhase(sessionId, state);

    const entries = await this.shadow.getAll(sessionId);
    const sorted = [...entries].sort((a, b) => b.importanceScore - a.importanceScore);

    // Generate summaries for ALL entries in critical mode
    const needSummary = sorted.filter(e => !e.summaryShort);
    if (needSummary.length > 0) {
      const summaries = needSummary.map(e => ({
        id: e.id,
        summaryShort: extractiveSummary(e.content, 80),
        summaryLong: extractiveSummary(e.content, 300),
      }));
      await this.shadow.updateSummaries(summaries);
    }

    return this.buildCullPlan(sessionId, sorted, 'critical');
  }

  // ============================================================================
  // Scoring
  // ============================================================================

  private computeCompositeScore(
    entry: ShadowEntry,
    recentEmbeddings: Float32Array[],
    now: number,
  ): number {
    const ageDays = (now - entry.createdAt) / 86_400_000;

    // Recency: exponential decay, 7-day half-life
    const recency = Math.exp(-0.693 * ageDays / 7);

    // Frequency: confidence-based (boosted on access)
    const frequency = Math.log2(entry.confidence * 10 + 1) + 1;

    // Richness: tool calls and file paths add value
    const toolBoost = entry.toolNames.length > 0 ? 0.5 : 0;
    const fileBoost = entry.filePaths.length > 0 ? 0.3 : 0;
    const richness = 1.0 + toolBoost + fileBoost;

    // Semantic relevance: cosine similarity to recent turns
    let semanticRelevance = 0.5;
    if (entry.embedding && recentEmbeddings.length > 0) {
      const entryEmb = new Float32Array(entry.embedding.buffer, entry.embedding.byteOffset, entry.embedding.byteLength / 4);
      let maxSim = 0;
      for (const recent of recentEmbeddings) {
        let dot = 0;
        for (let i = 0; i < Math.min(entryEmb.length, recent.length); i++) {
          dot += entryEmb[i] * recent[i];
        }
        maxSim = Math.max(maxSim, dot);
      }
      semanticRelevance = Math.max(0, Math.min(1, maxSim));
    }

    // Weighted composite (normalized to 0-1 range)
    const raw =
      recency * this.config.recencyWeight +
      frequency * this.config.frequencyWeight +
      richness * this.config.richnessWeight +
      semanticRelevance * this.config.semanticRelevanceWeight;

    // Normalize: max possible is roughly recencyWeight*1 + frequencyWeight*~4 + richnessWeight*1.8 + semanticWeight*1
    // Clamp to [0, 1] for safety
    return Math.max(0, Math.min(1, raw / 2.0));
  }

  private extractRecentEmbeddings(entries: ShadowEntry[], count: number): Float32Array[] {
    const recent = entries.slice(-count);
    const embeddings: Float32Array[] = [];
    for (const e of recent) {
      if (e.embedding) {
        embeddings.push(new Float32Array(e.embedding.buffer, e.embedding.byteOffset, e.embedding.byteLength / 4));
      }
    }
    return embeddings;
  }

  // ============================================================================
  // Cull Plan
  // ============================================================================

  private buildCullPlan(sessionId: string, sorted: ShadowEntry[], phase: 'warning' | 'critical'): CullPlan {
    const cullCount = Math.ceil(sorted.length * this.config.maxCullRatio);
    const summarizeCount = Math.ceil(sorted.length * this.config.maxCullRatio);

    // Bottom 20% are cull candidates
    const cullCandidates = sorted.slice(-cullCount);
    // Next 20% are summarize candidates
    const summarizeCandidates = sorted.slice(-(cullCount + summarizeCount), -cullCount);

    let tokensFreed = 0;
    const entriesToCull = cullCandidates.map(e => {
      tokensFreed += e.tokenEstimate;
      return {
        id: e.id,
        rank: e.importanceRank,
        score: e.importanceScore,
        tokenEstimate: e.tokenEstimate,
        summaryShort: e.summaryShort || extractiveSummary(e.content, 80),
      };
    });

    const entriesToSummarize = summarizeCandidates.map(e => ({
      id: e.id,
      rank: e.importanceRank,
      summaryLong: e.summaryLong || extractiveSummary(e.content, 300),
    }));

    const totalTokens = sorted.reduce((sum, e) => sum + e.tokenEstimate, 0);

    return {
      sessionId,
      createdAt: Date.now(),
      phase,
      entriesToCull,
      entriesToSummarize,
      tokensFreed,
      tokensRetained: totalTokens - tokensFreed,
      totalEntries: sorted.length,
    };
  }
}

// ============================================================================
// Extractive Summary
// ============================================================================

/**
 * Simple extractive summary: take first N characters, break at word boundary
 */
function extractiveSummary(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  const truncated = content.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

export default ContextReranker;
