/**
 * ReasoningBank Integration
 *
 * Implements the 4-step learning pipeline:
 * 1. RETRIEVE - Top-k memory injection with MMR diversity
 * 2. JUDGE - LLM-as-judge trajectory evaluation
 * 3. DISTILL - Extract strategy memories from trajectories
 * 4. CONSOLIDATE - Dedup, detect contradictions, prune old patterns
 *
 * Performance Target: <10ms for learning step
 */

import type {
  Trajectory,
  TrajectoryStep,
  TrajectoryVerdict,
  DistilledMemory,
  Pattern,
  PatternEvolution,
  NeuralEvent,
  NeuralEventListener,
} from './types.js';

/**
 * Configuration for ReasoningBank
 */
export interface ReasoningBankConfig {
  /** Maximum number of trajectories to store */
  maxTrajectories: number;

  /** Minimum quality threshold for distillation */
  distillationThreshold: number;

  /** Number of similar memories to retrieve */
  retrievalK: number;

  /** Diversity factor for MMR (0-1) */
  mmrLambda: number;

  /** Maximum age of patterns in days */
  maxPatternAgeDays: number;

  /** Similarity threshold for deduplication */
  dedupThreshold: number;

  /** Enable contradiction detection */
  enableContradictionDetection: boolean;
}

/**
 * Default ReasoningBank configuration
 */
const DEFAULT_CONFIG: ReasoningBankConfig = {
  maxTrajectories: 5000,
  distillationThreshold: 0.6,
  retrievalK: 3,
  mmrLambda: 0.7,
  maxPatternAgeDays: 30,
  dedupThreshold: 0.95,
  enableContradictionDetection: true,
};

/**
 * Memory entry with metadata
 */
interface MemoryEntry {
  memory: DistilledMemory;
  trajectory: Trajectory;
  verdict: TrajectoryVerdict;
  consolidated: boolean;
}

/**
 * Retrieval result with diversity scoring
 */
export interface RetrievalResult {
  memory: DistilledMemory;
  relevanceScore: number;
  diversityScore: number;
  combinedScore: number;
}

/**
 * Consolidation result
 */
export interface ConsolidationResult {
  removedDuplicates: number;
  contradictionsDetected: number;
  prunedPatterns: number;
  mergedPatterns: number;
}

/**
 * ReasoningBank - Trajectory storage and learning pipeline
 */
export class ReasoningBank {
  private config: ReasoningBankConfig;
  private trajectories: Map<string, Trajectory> = new Map();
  private memories: Map<string, MemoryEntry> = new Map();
  private patterns: Map<string, Pattern> = new Map();
  private eventListeners: Set<NeuralEventListener> = new Set();

  // Performance tracking
  private retrievalCount = 0;
  private totalRetrievalTime = 0;
  private distillationCount = 0;
  private totalDistillationTime = 0;

  constructor(config: Partial<ReasoningBankConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==========================================================================
  // STEP 1: RETRIEVE - Top-k memory injection with MMR diversity
  // ==========================================================================

  /**
   * Retrieve relevant memories using Maximal Marginal Relevance (MMR)
   */
  async retrieve(queryEmbedding: Float32Array, k?: number): Promise<RetrievalResult[]> {
    const startTime = performance.now();
    const retrieveK = k ?? this.config.retrievalK;

    if (this.memories.size === 0) {
      return [];
    }

    // Get all memories with relevance scores
    const candidates: Array<{ entry: MemoryEntry; relevance: number }> = [];

    for (const entry of this.memories.values()) {
      const relevance = this.cosineSimilarity(queryEmbedding, entry.memory.embedding);
      candidates.push({ entry, relevance });
    }

    // Sort by relevance
    candidates.sort((a, b) => b.relevance - a.relevance);

    // Apply MMR for diversity
    const results: RetrievalResult[] = [];
    const selected: MemoryEntry[] = [];

    while (results.length < retrieveK && candidates.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];

        // Compute MMR score: lambda * relevance - (1 - lambda) * max_similarity_to_selected
        const relevance = candidate.relevance;
        let maxSimilarity = 0;

        for (const sel of selected) {
          const sim = this.cosineSimilarity(
            candidate.entry.memory.embedding,
            sel.memory.embedding
          );
          maxSimilarity = Math.max(maxSimilarity, sim);
        }

        const diversityScore = 1 - maxSimilarity;
        const mmrScore = this.config.mmrLambda * relevance +
          (1 - this.config.mmrLambda) * diversityScore;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = i;
        }
      }

      // Add best candidate
      const best = candidates[bestIdx];
      selected.push(best.entry);
      results.push({
        memory: best.entry.memory,
        relevanceScore: best.relevance,
        diversityScore: 1 - this.computeMaxSimilarity(best.entry, selected.slice(0, -1)),
        combinedScore: bestScore,
      });

      // Remove from candidates
      candidates.splice(bestIdx, 1);
    }

    // Update stats
    this.retrievalCount++;
    this.totalRetrievalTime += performance.now() - startTime;

    return results;
  }

  // ==========================================================================
  // STEP 2: JUDGE - LLM-as-judge trajectory evaluation
  // ==========================================================================

  /**
   * Judge a trajectory and produce a verdict
   */
  async judge(trajectory: Trajectory): Promise<TrajectoryVerdict> {
    if (!trajectory.isComplete) {
      throw new Error('Cannot judge incomplete trajectory');
    }

    // Analyze trajectory steps
    const stepAnalysis = this.analyzeSteps(trajectory.steps);

    // Compute success based on quality and step analysis
    const success = trajectory.qualityScore >= this.config.distillationThreshold &&
      stepAnalysis.positiveRatio > 0.6;

    // Identify strengths and weaknesses
    const strengths = this.identifyStrengths(trajectory, stepAnalysis);
    const weaknesses = this.identifyWeaknesses(trajectory, stepAnalysis);

    // Generate improvement suggestions
    const improvements = this.generateImprovements(weaknesses);

    // Compute relevance for similar future tasks
    const relevanceScore = this.computeRelevanceScore(trajectory);

    const verdict: TrajectoryVerdict = {
      success,
      confidence: this.computeConfidence(trajectory, stepAnalysis),
      strengths,
      weaknesses,
      improvements,
      relevanceScore,
    };

    // Store verdict with trajectory
    trajectory.verdict = verdict;

    return verdict;
  }

  // ==========================================================================
  // STEP 3: DISTILL - Extract strategy memories from trajectories
  // ==========================================================================

  /**
   * Distill a trajectory into a reusable memory
   */
  async distill(trajectory: Trajectory): Promise<DistilledMemory | null> {
    const startTime = performance.now();

    // Must be judged first
    if (!trajectory.verdict) {
      await this.judge(trajectory);
    }

    // Only distill successful trajectories
    if (!trajectory.verdict!.success ||
        trajectory.qualityScore < this.config.distillationThreshold) {
      return null;
    }

    // Extract strategy from trajectory
    const strategy = this.extractStrategy(trajectory);

    // Extract key learnings
    const keyLearnings = this.extractKeyLearnings(trajectory);

    // Compute aggregated embedding
    const embedding = this.computeAggregateEmbedding(trajectory);

    const memory: DistilledMemory = {
      memoryId: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      trajectoryId: trajectory.trajectoryId,
      strategy,
      keyLearnings,
      embedding,
      quality: trajectory.qualityScore,
      usageCount: 0,
      lastUsed: Date.now(),
    };

    // Store the memory
    const entry: MemoryEntry = {
      memory,
      trajectory,
      verdict: trajectory.verdict!,
      consolidated: false,
    };
    this.memories.set(memory.memoryId, entry);

    // Also store trajectory reference
    trajectory.distilledMemory = memory;

    // Update stats
    this.distillationCount++;
    this.totalDistillationTime += performance.now() - startTime;

    return memory;
  }

  // ==========================================================================
  // STEP 4: CONSOLIDATE - Dedup, detect contradictions, prune old patterns
  // ==========================================================================

  /**
   * Consolidate memories: deduplicate, detect contradictions, prune old
   */
  async consolidate(): Promise<ConsolidationResult> {
    const result: ConsolidationResult = {
      removedDuplicates: 0,
      contradictionsDetected: 0,
      prunedPatterns: 0,
      mergedPatterns: 0,
    };

    // 1. Deduplicate similar memories
    result.removedDuplicates = await this.deduplicateMemories();

    // 2. Detect contradictions
    if (this.config.enableContradictionDetection) {
      result.contradictionsDetected = await this.detectContradictions();
    }

    // 3. Prune old patterns
    result.prunedPatterns = await this.pruneOldPatterns();

    // 4. Merge similar patterns
    result.mergedPatterns = await this.mergePatterns();

    // Emit consolidation event
    this.emitEvent({
      type: 'memory_consolidated',
      memoriesCount: this.memories.size,
    });

    return result;
  }

  // ==========================================================================
  // Pattern Management
  // ==========================================================================

  /**
   * Convert a distilled memory to a pattern
   */
  memoryToPattern(memory: DistilledMemory): Pattern {
    const pattern: Pattern = {
      patternId: `pat_${memory.memoryId}`,
      name: this.generatePatternName(memory),
      domain: this.inferDomain(memory),
      embedding: memory.embedding,
      strategy: memory.strategy,
      successRate: memory.quality,
      usageCount: memory.usageCount,
      qualityHistory: [memory.quality],
      evolutionHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.patterns.set(pattern.patternId, pattern);
    return pattern;
  }

  /**
   * Evolve a pattern based on new experience
   */
  evolvePattern(patternId: string, newExperience: Trajectory): void {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return;

    const previousQuality = pattern.successRate;

    // Update quality history
    pattern.qualityHistory.push(newExperience.qualityScore);
    if (pattern.qualityHistory.length > 100) {
      pattern.qualityHistory = pattern.qualityHistory.slice(-100);
    }

    // Update success rate
    pattern.successRate = pattern.qualityHistory.reduce((a, b) => a + b, 0) /
      pattern.qualityHistory.length;

    pattern.usageCount++;
    pattern.updatedAt = Date.now();

    // Record evolution
    const evolutionType = this.determineEvolutionType(previousQuality, pattern.successRate);
    pattern.evolutionHistory.push({
      timestamp: Date.now(),
      type: evolutionType,
      previousQuality,
      newQuality: pattern.successRate,
      description: `Updated based on trajectory ${newExperience.trajectoryId}`,
    });

    // Emit event
    this.emitEvent({
      type: 'pattern_evolved',
      patternId,
      evolutionType,
    });
  }

  /**
   * Get all patterns
   */
  getPatterns(): Pattern[] {
    return Array.from(this.patterns.values());
  }

  // ==========================================================================
  // Trajectory Management
  // ==========================================================================

  /**
   * Store a trajectory
   */
  storeTrajectory(trajectory: Trajectory): void {
    this.trajectories.set(trajectory.trajectoryId, trajectory);

    // Prune if over capacity
    if (this.trajectories.size > this.config.maxTrajectories) {
      this.pruneTrajectories();
    }
  }

  /**
   * Get trajectory by ID
   */
  getTrajectory(trajectoryId: string): Trajectory | undefined {
    return this.trajectories.get(trajectoryId);
  }

  /**
   * Get all trajectories
   */
  getTrajectories(): Trajectory[] {
    return Array.from(this.trajectories.values());
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  /**
   * Get ReasoningBank statistics
   */
  getStats(): Record<string, number> {
    return {
      trajectoryCount: this.trajectories.size,
      memoryCount: this.memories.size,
      patternCount: this.patterns.size,
      avgRetrievalTimeMs: this.retrievalCount > 0
        ? this.totalRetrievalTime / this.retrievalCount
        : 0,
      avgDistillationTimeMs: this.distillationCount > 0
        ? this.totalDistillationTime / this.distillationCount
        : 0,
      consolidatedMemories: Array.from(this.memories.values())
        .filter(e => e.consolidated).length,
    };
  }

  // ==========================================================================
  // Event System
  // ==========================================================================

  addEventListener(listener: NeuralEventListener): void {
    this.eventListeners.add(listener);
  }

  removeEventListener(listener: NeuralEventListener): void {
    this.eventListeners.delete(listener);
  }

  private emitEvent(event: NeuralEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in ReasoningBank event listener:', error);
      }
    }
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;

    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  private computeMaxSimilarity(entry: MemoryEntry, selected: MemoryEntry[]): number {
    let maxSim = 0;
    for (const sel of selected) {
      const sim = this.cosineSimilarity(entry.memory.embedding, sel.memory.embedding);
      maxSim = Math.max(maxSim, sim);
    }
    return maxSim;
  }

  private analyzeSteps(steps: TrajectoryStep[]): StepAnalysis {
    const rewardSum = steps.reduce((s, step) => s + step.reward, 0);
    const positiveSteps = steps.filter(s => s.reward > 0.5).length;

    return {
      totalSteps: steps.length,
      avgReward: steps.length > 0 ? rewardSum / steps.length : 0,
      positiveRatio: steps.length > 0 ? positiveSteps / steps.length : 0,
      trajectory: steps.length > 1
        ? (steps[steps.length - 1].reward - steps[0].reward)
        : 0,
    };
  }

  private identifyStrengths(trajectory: Trajectory, analysis: StepAnalysis): string[] {
    const strengths: string[] = [];

    if (analysis.avgReward > 0.7) {
      strengths.push('High average reward across steps');
    }
    if (analysis.trajectory > 0.2) {
      strengths.push('Positive reward trajectory');
    }
    if (trajectory.qualityScore > 0.8) {
      strengths.push('High overall quality');
    }
    if (analysis.totalSteps < 5 && trajectory.qualityScore > 0.6) {
      strengths.push('Efficient solution (few steps)');
    }

    return strengths;
  }

  private identifyWeaknesses(trajectory: Trajectory, analysis: StepAnalysis): string[] {
    const weaknesses: string[] = [];

    if (analysis.avgReward < 0.4) {
      weaknesses.push('Low average reward');
    }
    if (analysis.trajectory < -0.1) {
      weaknesses.push('Declining reward trajectory');
    }
    if (analysis.positiveRatio < 0.5) {
      weaknesses.push('Many negative/neutral steps');
    }
    if (analysis.totalSteps > 10 && trajectory.qualityScore < 0.7) {
      weaknesses.push('Long trajectory with mediocre outcome');
    }

    return weaknesses;
  }

  private generateImprovements(weaknesses: string[]): string[] {
    const improvements: string[] = [];

    for (const weakness of weaknesses) {
      if (weakness.includes('Low average reward')) {
        improvements.push('Consider alternative strategies for each step');
      }
      if (weakness.includes('Declining')) {
        improvements.push('Re-evaluate approach when reward decreases');
      }
      if (weakness.includes('negative/neutral')) {
        improvements.push('Focus on steps with clearer positive signals');
      }
      if (weakness.includes('Long trajectory')) {
        improvements.push('Look for shortcuts or more direct approaches');
      }
    }

    return improvements;
  }

  private computeRelevanceScore(trajectory: Trajectory): number {
    // Base relevance on quality and recency
    const qualityFactor = trajectory.qualityScore;
    const ageDays = (Date.now() - trajectory.startTime) / (1000 * 60 * 60 * 24);
    const recencyFactor = Math.exp(-ageDays / 30); // Decay over 30 days

    return qualityFactor * 0.7 + recencyFactor * 0.3;
  }

  private computeConfidence(trajectory: Trajectory, analysis: StepAnalysis): number {
    // More steps = more confidence
    const stepFactor = Math.min(analysis.totalSteps / 10, 1);
    // Consistent rewards = more confidence
    const consistencyFactor = analysis.positiveRatio;
    // Clear outcome = more confidence
    const outcomeFactor = Math.abs(trajectory.qualityScore - 0.5) * 2;

    return (stepFactor * 0.3 + consistencyFactor * 0.4 + outcomeFactor * 0.3);
  }

  private extractStrategy(trajectory: Trajectory): string {
    const actions = trajectory.steps.map(s => s.action);
    const uniqueActions = [...new Set(actions)];

    if (uniqueActions.length <= 3) {
      return `Apply ${uniqueActions.join(' -> ')}`;
    }

    return `Multi-step approach: ${uniqueActions.slice(0, 3).join(', ')}...`;
  }

  private extractKeyLearnings(trajectory: Trajectory): string[] {
    const learnings: string[] = [];
    const verdict = trajectory.verdict!;

    // Add key success factors
    if (verdict.success) {
      learnings.push(`Successful approach for ${trajectory.domain} domain`);
      for (const strength of verdict.strengths.slice(0, 2)) {
        learnings.push(`Strength: ${strength}`);
      }
    } else {
      learnings.push(`Approach needs refinement`);
      for (const improvement of verdict.improvements.slice(0, 2)) {
        learnings.push(`Improvement: ${improvement}`);
      }
    }

    return learnings;
  }

  private computeAggregateEmbedding(trajectory: Trajectory): Float32Array {
    if (trajectory.steps.length === 0) {
      return new Float32Array(768);
    }

    const dim = trajectory.steps[0].stateAfter.length;
    const aggregate = new Float32Array(dim);

    // Weighted average of step embeddings (higher weight for later steps)
    let totalWeight = 0;
    for (let i = 0; i < trajectory.steps.length; i++) {
      const weight = (i + 1) / trajectory.steps.length;
      totalWeight += weight;
      const step = trajectory.steps[i];
      for (let j = 0; j < dim; j++) {
        aggregate[j] += step.stateAfter[j] * weight;
      }
    }

    // Normalize
    for (let j = 0; j < dim; j++) {
      aggregate[j] /= totalWeight;
    }

    return aggregate;
  }

  private async deduplicateMemories(): Promise<number> {
    let removed = 0;
    const entries = Array.from(this.memories.entries());

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const sim = this.cosineSimilarity(
          entries[i][1].memory.embedding,
          entries[j][1].memory.embedding
        );

        if (sim > this.config.dedupThreshold) {
          // Keep the higher quality one
          if (entries[i][1].memory.quality >= entries[j][1].memory.quality) {
            this.memories.delete(entries[j][0]);
          } else {
            this.memories.delete(entries[i][0]);
          }
          removed++;
        }
      }
    }

    return removed;
  }

  private async detectContradictions(): Promise<number> {
    let contradictions = 0;
    const entries = Array.from(this.memories.values());

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        // Similar context but opposite outcomes
        const sim = this.cosineSimilarity(
          entries[i].memory.embedding,
          entries[j].memory.embedding
        );

        if (sim > 0.8) {
          const qualityDiff = Math.abs(
            entries[i].memory.quality - entries[j].memory.quality
          );

          if (qualityDiff > 0.4) {
            contradictions++;
            // Mark lower quality as consolidated (to exclude from retrieval)
            if (entries[i].memory.quality < entries[j].memory.quality) {
              entries[i].consolidated = true;
            } else {
              entries[j].consolidated = true;
            }
          }
        }
      }
    }

    return contradictions;
  }

  private async pruneOldPatterns(): Promise<number> {
    const now = Date.now();
    const maxAge = this.config.maxPatternAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    for (const [id, pattern] of this.patterns) {
      const age = now - pattern.updatedAt;
      if (age > maxAge && pattern.usageCount < 5) {
        this.patterns.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  private async mergePatterns(): Promise<number> {
    let merged = 0;
    const patterns = Array.from(this.patterns.entries());

    for (let i = 0; i < patterns.length; i++) {
      for (let j = i + 1; j < patterns.length; j++) {
        const sim = this.cosineSimilarity(
          patterns[i][1].embedding,
          patterns[j][1].embedding
        );

        if (sim > 0.9 && patterns[i][1].domain === patterns[j][1].domain) {
          // Merge into higher quality pattern
          const [keepId, keep] = patterns[i][1].successRate >= patterns[j][1].successRate
            ? patterns[i]
            : patterns[j];
          const [removeId, remove] = patterns[i][1].successRate < patterns[j][1].successRate
            ? patterns[i]
            : patterns[j];

          // Combine statistics
          keep.usageCount += remove.usageCount;
          keep.qualityHistory.push(...remove.qualityHistory);
          keep.evolutionHistory.push({
            timestamp: Date.now(),
            type: 'merge',
            previousQuality: keep.successRate,
            newQuality: (keep.successRate + remove.successRate) / 2,
            description: `Merged with pattern ${removeId}`,
          });

          this.patterns.delete(removeId);
          merged++;
        }
      }
    }

    return merged;
  }

  private pruneTrajectories(): void {
    const entries = Array.from(this.trajectories.entries())
      .sort((a, b) => a[1].qualityScore - b[1].qualityScore);

    const toRemove = entries.length - Math.floor(this.config.maxTrajectories * 0.8);
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.trajectories.delete(entries[i][0]);
    }
  }

  private generatePatternName(memory: DistilledMemory): string {
    const words = memory.strategy.split(' ').slice(0, 4);
    return words.join('_').toLowerCase().replace(/[^a-z0-9_]/g, '');
  }

  private inferDomain(memory: DistilledMemory): string {
    const trajectory = this.trajectories.get(memory.trajectoryId);
    return trajectory?.domain || 'general';
  }

  private determineEvolutionType(
    prev: number,
    curr: number
  ): 'improvement' | 'merge' | 'split' | 'prune' {
    const delta = curr - prev;
    if (delta > 0.05) return 'improvement';
    if (delta < -0.1) return 'prune';
    return 'improvement';
  }
}

/**
 * Step analysis result
 */
interface StepAnalysis {
  totalSteps: number;
  avgReward: number;
  positiveRatio: number;
  trajectory: number;
}

/**
 * Factory function for creating ReasoningBank
 */
export function createReasoningBank(
  config?: Partial<ReasoningBankConfig>
): ReasoningBank {
  return new ReasoningBank(config);
}
