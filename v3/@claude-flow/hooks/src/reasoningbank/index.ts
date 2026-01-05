/**
 * V3 ReasoningBank - Pattern Learning with AgentDB
 *
 * Connects hooks to persistent vector storage using AgentDB adapter.
 * No JSON - all patterns stored as vectors in memory.db
 *
 * @module @claude-flow/hooks/reasoningbank
 */

import { EventEmitter } from 'node:events';
import type { HookContext, HookEvent } from '../types.js';

/**
 * Pattern stored in AgentDB
 */
export interface GuidancePattern {
  id: string;
  strategy: string;
  domain: string;
  embedding: Float32Array;
  quality: number;
  usageCount: number;
  successCount: number;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

/**
 * Guidance result from pattern search
 */
export interface GuidanceResult {
  patterns: Array<{
    pattern: GuidancePattern;
    similarity: number;
  }>;
  context: string;
  recommendations: string[];
  agentSuggestion?: {
    agent: string;
    confidence: number;
    reasoning: string;
  };
  searchTimeMs: number;
}

/**
 * Agent routing result
 */
export interface RoutingResult {
  agent: string;
  confidence: number;
  alternatives: Array<{ agent: string; confidence: number }>;
  reasoning: string;
  historicalPerformance?: {
    successRate: number;
    avgQuality: number;
    taskCount: number;
  };
}

/**
 * ReasoningBank configuration
 */
export interface ReasoningBankConfig {
  /** Vector dimensions (384 for MiniLM, 1536 for OpenAI) */
  dimensions: number;
  /** HNSW M parameter */
  hnswM: number;
  /** HNSW ef construction */
  hnswEfConstruction: number;
  /** HNSW ef search */
  hnswEfSearch: number;
  /** Maximum patterns in short-term memory */
  maxShortTerm: number;
  /** Maximum patterns in long-term memory */
  maxLongTerm: number;
  /** Promotion threshold (usage count) */
  promotionThreshold: number;
  /** Quality threshold for promotion */
  qualityThreshold: number;
  /** Deduplication similarity threshold */
  dedupThreshold: number;
  /** Database path */
  dbPath: string;
}

/**
 * ReasoningBank metrics
 */
export interface ReasoningBankMetrics {
  patternsStored: number;
  patternsRetrieved: number;
  searchCount: number;
  totalSearchTime: number;
  promotions: number;
}

const DEFAULT_CONFIG: ReasoningBankConfig = {
  dimensions: 384,
  hnswM: 16,
  hnswEfConstruction: 200,
  hnswEfSearch: 100,
  maxShortTerm: 1000,
  maxLongTerm: 5000,
  promotionThreshold: 3,
  qualityThreshold: 0.6,
  dedupThreshold: 0.95,
  dbPath: '.claude-flow/memory.db',
};

/**
 * Agent mapping for routing
 */
const AGENT_PATTERNS: Record<string, RegExp> = {
  'security-architect': /security|auth|cve|vuln|encrypt|password|token/i,
  'test-architect': /test|spec|mock|coverage|tdd|assert/i,
  'performance-engineer': /perf|optim|fast|memory|cache|speed|slow/i,
  'core-architect': /architect|design|ddd|domain|refactor|struct/i,
  'swarm-specialist': /swarm|agent|coordinate|orchestrat|parallel/i,
  'memory-specialist': /memory|agentdb|hnsw|vector|embedding/i,
  'coder': /fix|bug|implement|create|add|build|error|code/i,
  'reviewer': /review|quality|lint|check|audit/i,
};

/**
 * Domain-specific guidance templates
 */
const DOMAIN_GUIDANCE: Record<string, string[]> = {
  security: [
    'Validate all inputs at system boundaries',
    'Use parameterized queries (no string concatenation)',
    'Store secrets in environment variables only',
    'Apply principle of least privilege',
    'Check OWASP Top 10 patterns',
  ],
  testing: [
    'Write test first, then implementation (TDD)',
    'Mock external dependencies',
    'Test behavior, not implementation',
    'One assertion per test concept',
    'Use descriptive test names',
  ],
  performance: [
    'Use HNSW for vector search (not brute-force)',
    'Batch database operations',
    'Implement caching at appropriate layers',
    'Profile before optimizing',
    'Target: <1ms searches, <100ms operations',
  ],
  architecture: [
    'Respect bounded context boundaries',
    'Use domain events for cross-module communication',
    'Keep domain logic in domain layer',
    'Infrastructure adapters for external services',
    'Follow ADR decisions (ADR-001 through ADR-010)',
  ],
  debugging: [
    'Reproduce the issue first',
    'Check recent changes in git log',
    'Add logging before fixing',
    'Write regression test',
    "Verify fix doesn't break other tests",
  ],
};

/**
 * ReasoningBank - Vector-based pattern storage and retrieval
 *
 * Uses AgentDB adapter for HNSW-indexed pattern storage.
 * Provides guidance generation from learned patterns.
 */
export class ReasoningBank extends EventEmitter {
  private config: ReasoningBankConfig;
  private agentDB: any; // AgentDBAdapter from @claude-flow/memory
  private embeddingService: EmbeddingService;
  private initialized = false;

  // In-memory caches for fast access
  private shortTermPatterns: Map<string, GuidancePattern> = new Map();
  private longTermPatterns: Map<string, GuidancePattern> = new Map();

  // Metrics
  private metrics: ReasoningBankMetrics = {
    patternsStored: 0,
    patternsRetrieved: 0,
    searchCount: 0,
    totalSearchTime: 0,
    promotions: 0,
  };

  constructor(config: Partial<ReasoningBankConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingService = new EmbeddingService(this.config.dimensions);
  }

  /**
   * Initialize ReasoningBank with AgentDB backend
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Import from @claude-flow/memory
      const { AgentDBAdapter } = await import('@claude-flow/memory');

      this.agentDB = new AgentDBAdapter({
        dimensions: this.config.dimensions,
        hnswM: this.config.hnswM,
        hnswEfConstruction: this.config.hnswEfConstruction,
        maxEntries: this.config.maxShortTerm + this.config.maxLongTerm,
        persistenceEnabled: true,
        persistencePath: this.config.dbPath,
        embeddingGenerator: (text: string) => this.embeddingService.embed(text),
      });

      await this.agentDB.initialize();
      await this.loadPatterns();

      this.initialized = true;
      this.emit('initialized', {
        shortTermCount: this.shortTermPatterns.size,
        longTermCount: this.longTermPatterns.size,
      });
    } catch (error) {
      // Fallback to in-memory only mode
      console.warn('[ReasoningBank] AgentDB not available, using in-memory mode');
      this.initialized = true;
    }
  }

  /**
   * Store a new pattern from hook execution
   */
  async storePattern(
    strategy: string,
    domain: string,
    metadata: Record<string, unknown> = {}
  ): Promise<{ id: string; action: 'created' | 'updated' }> {
    await this.ensureInitialized();

    const embedding = await this.embeddingService.embed(strategy);

    // Check for duplicates using vector similarity
    const similar = await this.searchPatterns(embedding, 1);
    if (similar.length > 0 && similar[0].similarity > this.config.dedupThreshold) {
      // Update existing pattern
      const existing = similar[0].pattern;
      existing.usageCount++;
      existing.updatedAt = Date.now();
      existing.quality = this.calculateQuality(existing);

      await this.updateInStorage(existing);
      this.checkPromotion(existing);

      return { id: existing.id, action: 'updated' };
    }

    // Create new pattern
    const pattern: GuidancePattern = {
      id: `pat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      strategy,
      domain,
      embedding,
      quality: 0.5,
      usageCount: 1,
      successCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata,
    };

    this.shortTermPatterns.set(pattern.id, pattern);
    await this.storeInAgentDB(pattern, 'short_term');

    this.metrics.patternsStored++;
    this.emit('pattern:stored', { id: pattern.id, domain });

    return { id: pattern.id, action: 'created' };
  }

  /**
   * Search for similar patterns
   */
  async searchPatterns(
    query: string | Float32Array,
    k: number = 5
  ): Promise<Array<{ pattern: GuidancePattern; similarity: number }>> {
    await this.ensureInitialized();

    const startTime = performance.now();
    const embedding = typeof query === 'string'
      ? await this.embeddingService.embed(query)
      : query;

    const results: Array<{ pattern: GuidancePattern; similarity: number }> = [];

    // Search long-term first (higher quality)
    for (const pattern of this.longTermPatterns.values()) {
      const similarity = this.cosineSimilarity(embedding, pattern.embedding);
      results.push({ pattern, similarity });
    }

    // Search short-term
    for (const pattern of this.shortTermPatterns.values()) {
      const similarity = this.cosineSimilarity(embedding, pattern.embedding);
      results.push({ pattern, similarity });
    }

    // Sort by similarity and take top k
    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, k);

    const searchTime = performance.now() - startTime;
    this.metrics.searchCount++;
    this.metrics.totalSearchTime += searchTime;
    this.metrics.patternsRetrieved += topResults.length;

    return topResults;
  }

  /**
   * Generate guidance for a given context
   */
  async generateGuidance(context: HookContext): Promise<GuidanceResult> {
    await this.ensureInitialized();

    const startTime = performance.now();
    const query = this.buildQueryFromContext(context);
    const patterns = await this.searchPatterns(query, 5);

    // Detect domains from context
    const domains = this.detectDomains(query);

    // Build recommendations from domain templates
    const recommendations: string[] = [];
    for (const domain of domains) {
      if (DOMAIN_GUIDANCE[domain]) {
        recommendations.push(...DOMAIN_GUIDANCE[domain]);
      }
    }

    // Generate context string
    const contextParts: string[] = [];

    if (domains.length > 0) {
      contextParts.push(`**Detected Domains**: ${domains.join(', ')}`);
    }

    if (patterns.length > 0) {
      contextParts.push('**Relevant Patterns**:');
      for (const { pattern, similarity } of patterns.slice(0, 3)) {
        contextParts.push(`- ${pattern.strategy} (${(similarity * 100).toFixed(0)}% match)`);
      }
    }

    // Agent suggestion
    const agentSuggestion = this.suggestAgent(query);

    return {
      patterns,
      context: contextParts.join('\n'),
      recommendations: recommendations.slice(0, 5),
      agentSuggestion,
      searchTimeMs: performance.now() - startTime,
    };
  }

  /**
   * Route task to optimal agent based on learned patterns
   */
  async routeTask(task: string): Promise<RoutingResult> {
    await this.ensureInitialized();

    const suggestion = this.suggestAgent(task);

    // Get historical performance from patterns
    const taskPatterns = await this.searchPatterns(task, 10);
    const agentPerformance = new Map<string, { success: number; total: number; quality: number }>();

    for (const { pattern } of taskPatterns) {
      const agent = pattern.metadata.agent as string || 'coder';
      const perf = agentPerformance.get(agent) || { success: 0, total: 0, quality: 0 };
      perf.total++;
      perf.success += pattern.successCount / Math.max(pattern.usageCount, 1);
      perf.quality += pattern.quality;
      agentPerformance.set(agent, perf);
    }

    // Calculate historical performance for suggested agent
    const historicalPerf = agentPerformance.get(suggestion.agent);
    const historicalPerformance = historicalPerf
      ? {
          successRate: historicalPerf.success / historicalPerf.total,
          avgQuality: historicalPerf.quality / historicalPerf.total,
          taskCount: historicalPerf.total,
        }
      : undefined;

    // Build alternatives
    const alternatives = Object.entries(AGENT_PATTERNS)
      .filter(([agent]) => agent !== suggestion.agent)
      .map(([agent, pattern]) => ({
        agent,
        confidence: pattern.test(task) ? 85 : 60,
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    return {
      agent: suggestion.agent,
      confidence: suggestion.confidence,
      alternatives,
      reasoning: suggestion.reasoning,
      historicalPerformance,
    };
  }

  /**
   * Record pattern usage outcome
   */
  async recordOutcome(patternId: string, success: boolean): Promise<void> {
    const pattern =
      this.shortTermPatterns.get(patternId) ||
      this.longTermPatterns.get(patternId);

    if (!pattern) return;

    pattern.usageCount++;
    if (success) pattern.successCount++;
    pattern.quality = this.calculateQuality(pattern);
    pattern.updatedAt = Date.now();

    await this.updateInStorage(pattern);
    this.checkPromotion(pattern);

    this.emit('outcome:recorded', { patternId, success });
  }

  /**
   * Consolidate patterns (dedup, prune, promote)
   */
  async consolidate(): Promise<{
    duplicatesRemoved: number;
    patternsPruned: number;
    patternsPromoted: number;
  }> {
    await this.ensureInitialized();

    let duplicatesRemoved = 0;
    let patternsPruned = 0;
    let patternsPromoted = 0;

    // Check promotions
    for (const pattern of this.shortTermPatterns.values()) {
      if (this.shouldPromote(pattern)) {
        await this.promotePattern(pattern);
        patternsPromoted++;
      }
    }

    // Prune old low-quality short-term patterns
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    for (const [id, pattern] of this.shortTermPatterns) {
      if (now - pattern.createdAt > maxAge && pattern.usageCount < 2) {
        this.shortTermPatterns.delete(id);
        await this.deleteFromStorage(id);
        patternsPruned++;
      }
    }

    this.emit('consolidated', { duplicatesRemoved, patternsPruned, patternsPromoted });

    return { duplicatesRemoved, patternsPruned, patternsPromoted };
  }

  /**
   * Get statistics
   */
  getStats(): {
    shortTermCount: number;
    longTermCount: number;
    metrics: ReasoningBankMetrics;
    avgSearchTime: number;
  } {
    return {
      shortTermCount: this.shortTermPatterns.size,
      longTermCount: this.longTermPatterns.size,
      metrics: { ...this.metrics },
      avgSearchTime:
        this.metrics.searchCount > 0
          ? this.metrics.totalSearchTime / this.metrics.searchCount
          : 0,
    };
  }

  /**
   * Export patterns for backup/transfer
   */
  async exportPatterns(): Promise<{
    shortTerm: GuidancePattern[];
    longTerm: GuidancePattern[];
  }> {
    return {
      shortTerm: Array.from(this.shortTermPatterns.values()),
      longTerm: Array.from(this.longTermPatterns.values()),
    };
  }

  // ===== Private Methods =====

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private async loadPatterns(): Promise<void> {
    if (!this.agentDB) return;

    try {
      // Load from AgentDB namespaces
      const shortTermEntries = await this.agentDB.query({
        namespace: 'patterns:short_term',
        limit: this.config.maxShortTerm,
      });

      for (const entry of shortTermEntries) {
        const pattern = this.entryToPattern(entry);
        this.shortTermPatterns.set(pattern.id, pattern);
      }

      const longTermEntries = await this.agentDB.query({
        namespace: 'patterns:long_term',
        limit: this.config.maxLongTerm,
      });

      for (const entry of longTermEntries) {
        const pattern = this.entryToPattern(entry);
        this.longTermPatterns.set(pattern.id, pattern);
      }
    } catch (error) {
      console.warn('[ReasoningBank] Failed to load patterns:', error);
    }
  }

  private async storeInAgentDB(pattern: GuidancePattern, type: 'short_term' | 'long_term'): Promise<void> {
    if (!this.agentDB) return;

    try {
      await this.agentDB.storeEntry({
        key: pattern.id,
        namespace: `patterns:${type}`,
        content: pattern.strategy,
        embedding: pattern.embedding,
        tags: [pattern.domain, type],
        metadata: {
          quality: pattern.quality,
          usageCount: pattern.usageCount,
          successCount: pattern.successCount,
          createdAt: pattern.createdAt,
          updatedAt: pattern.updatedAt,
          ...pattern.metadata,
        },
      });
    } catch (error) {
      console.warn('[ReasoningBank] Failed to store pattern:', error);
    }
  }

  private async updateInStorage(pattern: GuidancePattern): Promise<void> {
    if (!this.agentDB) return;

    try {
      const namespace = this.longTermPatterns.has(pattern.id)
        ? 'patterns:long_term'
        : 'patterns:short_term';

      await this.agentDB.update(pattern.id, {
        metadata: {
          quality: pattern.quality,
          usageCount: pattern.usageCount,
          successCount: pattern.successCount,
          updatedAt: pattern.updatedAt,
        },
      });
    } catch (error) {
      console.warn('[ReasoningBank] Failed to update pattern:', error);
    }
  }

  private async deleteFromStorage(id: string): Promise<void> {
    if (!this.agentDB) return;

    try {
      await this.agentDB.delete(id);
    } catch (error) {
      console.warn('[ReasoningBank] Failed to delete pattern:', error);
    }
  }

  private entryToPattern(entry: any): GuidancePattern {
    return {
      id: entry.id,
      strategy: entry.content,
      domain: entry.tags?.[0] || 'general',
      embedding: entry.embedding,
      quality: entry.metadata?.quality || 0.5,
      usageCount: entry.metadata?.usageCount || 1,
      successCount: entry.metadata?.successCount || 0,
      createdAt: entry.metadata?.createdAt || entry.createdAt,
      updatedAt: entry.metadata?.updatedAt || entry.updatedAt,
      metadata: entry.metadata || {},
    };
  }

  private buildQueryFromContext(context: HookContext): string {
    const parts: string[] = [];

    if (context.file?.path) {
      parts.push(`file: ${context.file.path}`);
    }
    if (context.command?.raw) {
      parts.push(`command: ${context.command.raw}`);
    }
    if (context.task?.description) {
      parts.push(context.task.description);
    }
    if (context.routing?.task) {
      parts.push(context.routing.task);
    }

    return parts.join(' ');
  }

  private detectDomains(text: string): string[] {
    const domains: string[] = [];
    const lowerText = text.toLowerCase();

    if (/security|auth|password|token|secret|cve|vuln/i.test(lowerText)) {
      domains.push('security');
    }
    if (/test|spec|mock|coverage|tdd|assert/i.test(lowerText)) {
      domains.push('testing');
    }
    if (/perf|optim|fast|slow|memory|cache|speed/i.test(lowerText)) {
      domains.push('performance');
    }
    if (/architect|design|ddd|domain|refactor|struct/i.test(lowerText)) {
      domains.push('architecture');
    }
    if (/fix|bug|error|issue|broken|fail|debug/i.test(lowerText)) {
      domains.push('debugging');
    }

    return domains;
  }

  private suggestAgent(task: string): { agent: string; confidence: number; reasoning: string } {
    let bestAgent = 'coder';
    let bestConfidence = 70;
    let reasoning = 'Default agent for general tasks';

    for (const [agent, pattern] of Object.entries(AGENT_PATTERNS)) {
      if (pattern.test(task)) {
        const matches = task.match(pattern);
        const confidence = 85 + (matches ? Math.min(matches.length * 5, 13) : 0);

        if (confidence > bestConfidence) {
          bestAgent = agent;
          bestConfidence = confidence;
          reasoning = `Task matches ${agent} patterns`;
        }
      }
    }

    return { agent: bestAgent, confidence: bestConfidence, reasoning };
  }

  private calculateQuality(pattern: GuidancePattern): number {
    if (pattern.usageCount === 0) return 0.5;
    const successRate = pattern.successCount / pattern.usageCount;
    return 0.3 + successRate * 0.7; // Range: 0.3 to 1.0
  }

  private shouldPromote(pattern: GuidancePattern): boolean {
    return (
      pattern.usageCount >= this.config.promotionThreshold &&
      pattern.quality >= this.config.qualityThreshold
    );
  }

  private checkPromotion(pattern: GuidancePattern): void {
    if (this.shortTermPatterns.has(pattern.id) && this.shouldPromote(pattern)) {
      this.promotePattern(pattern);
    }
  }

  private async promotePattern(pattern: GuidancePattern): Promise<void> {
    // Move from short-term to long-term
    this.shortTermPatterns.delete(pattern.id);
    this.longTermPatterns.set(pattern.id, pattern);

    // Update storage
    await this.deleteFromStorage(pattern.id);
    await this.storeInAgentDB(pattern, 'long_term');

    this.metrics.promotions++;
    this.emit('pattern:promoted', { id: pattern.id });
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }
}

/**
 * Simple embedding service (hash-based fallback)
 */
class EmbeddingService {
  private dimensions: number;
  private cache: Map<string, Float32Array> = new Map();

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const cacheKey = text.slice(0, 200);
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Try agentic-flow ONNX embeddings first
    try {
      const { execSync } = await import('child_process');
      const result = execSync(
        `npx agentic-flow@alpha embeddings generate "${text.replace(/"/g, '\\"').slice(0, 500)}" --format json 2>/dev/null`,
        { encoding: 'utf-8', timeout: 10000 }
      );
      const parsed = JSON.parse(result);
      const embedding = new Float32Array(parsed.embedding || parsed);
      this.cache.set(cacheKey, embedding);
      return embedding;
    } catch {
      // Fallback to hash-based embedding
      return this.hashEmbed(text);
    }
  }

  private hashEmbed(text: string): Float32Array {
    const embedding = new Float32Array(this.dimensions);
    const normalized = text.toLowerCase().trim();

    for (let i = 0; i < this.dimensions; i++) {
      let hash = 0;
      for (let j = 0; j < normalized.length; j++) {
        hash = ((hash << 5) - hash + normalized.charCodeAt(j) * (i + 1)) | 0;
      }
      embedding[i] = (Math.sin(hash) + 1) / 2;
    }

    // Normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) {
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        embedding[i] /= norm;
      }
    }

    this.cache.set(text.slice(0, 200), embedding);
    return embedding;
  }
}

// Export singleton instance
export const reasoningBank = new ReasoningBank();

// Export types
export type { ReasoningBankConfig };
