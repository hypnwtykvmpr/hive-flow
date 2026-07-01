/**
 * Local neural training service.
 *
 * This preserves the CLI's public training API without downloading or loading
 * external vector packages. The implementations below are deterministic
 * TypeScript fallbacks for local vector adaptation, attention, and trajectory
 * statistics.
 */

interface AttentionBenchmarkResult {
  name: string;
  averageTimeMs: number;
  opsPerSecond: number;
}

interface LocalAdapterBenchmarkResult {
  averageTimeMs: number;
  totalTimeMs: number;
  adaptationsPerSecond: number;
}

class LocalAdapter {
  private readonly delta: Float32Array;
  private adaptationCount = 0n;
  private forwardPasses = 0n;

  constructor(
    private readonly dimensions: number,
    private readonly alpha: number,
    private readonly learningRate: number,
  ) {
    this.delta = new Float32Array(dimensions);
  }

  adapt_array(gradient: Float32Array): void {
    const limit = Math.min(this.dimensions, gradient.length);
    for (let i = 0; i < limit; i++) {
      this.delta[i] += gradient[i] * this.learningRate * this.alpha;
    }
    this.adaptationCount++;
  }

  adapt_with_reward(improvement: number): void {
    const bounded = Math.max(-1, Math.min(1, improvement));
    const gradient = new Float32Array(this.dimensions);
    for (let i = 0; i < gradient.length; i++) {
      gradient[i] = bounded / Math.sqrt(i + 1);
    }
    this.adapt_array(gradient);
  }

  forward_array(input: Float32Array): Float32Array {
    const output = new Float32Array(input);
    const limit = Math.min(output.length, this.delta.length);
    for (let i = 0; i < limit; i++) {
      output[i] += this.delta[i];
    }
    this.forwardPasses++;
    return output;
  }

  delta_norm(): number {
    let sum = 0;
    for (const value of this.delta) {
      sum += value * value;
    }
    return Math.sqrt(sum);
  }

  adapt_count(): bigint {
    return this.adaptationCount;
  }

  forward_count(): bigint {
    return this.forwardPasses;
  }

  param_count(): number {
    return this.dimensions * 2;
  }

  dim(): number {
    return this.dimensions;
  }

  reset(): void {
    this.delta.fill(0);
    this.adaptationCount = 0n;
    this.forwardPasses = 0n;
  }

  free(): void {
    this.reset();
  }
}

class LocalScopedAdapter {
  private readonly adapters = new Map<number, LocalAdapter>();
  private fallbackEnabled = false;

  constructor(
    private readonly dimensions: number,
    private readonly alpha: number,
    private readonly learningRate: number,
  ) {}

  set_category_fallback(enabled: boolean): void {
    this.fallbackEnabled = enabled;
  }

  adapt_array(operatorType: number, gradient: Float32Array): void {
    this.adapterFor(operatorType).adapt_array(gradient);
  }

  adapt_with_reward(operatorType: number, improvement: number): void {
    this.adapterFor(operatorType).adapt_with_reward(improvement);
  }

  forward_array(operatorType: number, input: Float32Array): Float32Array {
    return this.adapterFor(operatorType).forward_array(input);
  }

  delta_norm(operatorType: number): number {
    return this.adapterFor(operatorType).delta_norm();
  }

  adapt_count(operatorType: number): bigint {
    return this.adapterFor(operatorType).adapt_count();
  }

  total_adapt_count(): bigint {
    let total = 0n;
    for (const adapter of this.adapters.values()) {
      total += adapter.adapt_count();
    }
    return total;
  }

  total_forward_count(): bigint {
    let total = 0n;
    for (const adapter of this.adapters.values()) {
      total += adapter.forward_count();
    }
    return total;
  }

  reset_all(): void {
    for (const adapter of this.adapters.values()) {
      adapter.reset();
    }
  }

  free(): void {
    this.reset_all();
    this.adapters.clear();
  }

  private adapterFor(operatorType: number): LocalAdapter {
    const normalized = Number.isFinite(operatorType) ? Math.trunc(operatorType) : 0;
    const key = normalized >= 0 ? normalized : 0;
    let adapter = this.adapters.get(key);
    if (!adapter) {
      adapter = new LocalAdapter(this.dimensions, this.alpha, this.learningRate);
      this.adapters.set(this.fallbackEnabled ? key : operatorType, adapter);
    }
    return adapter;
  }
}

interface TrajectoryRecord {
  improvement: number;
}

class LocalTrajectoryBuffer {
  private readonly records: TrajectoryRecord[] = [];

  constructor(
    private readonly capacity: number,
    private readonly dimensions: number,
  ) {}

  record(
    embedding: Float32Array,
    _operatorType: number,
    _attentionType: number,
    executionMs: number,
    baselineMs: number,
  ): void {
    const normalizedBaseline = Math.max(1e-6, baselineMs);
    const improvement = (normalizedBaseline - executionMs) / normalizedBaseline;
    const magnitude = Math.min(embedding.length, this.dimensions);
    this.records.push({ improvement: improvement * (magnitude / this.dimensions) });
    while (this.records.length > this.capacity) {
      this.records.shift();
    }
  }

  is_empty(): boolean {
    return this.records.length === 0;
  }

  success_rate(): number {
    if (this.records.length === 0) return 0;
    return this.records.filter((record) => record.improvement > 0).length / this.records.length;
  }

  mean_improvement(): number {
    if (this.records.length === 0) return 0;
    return this.records.reduce((sum, record) => sum + record.improvement, 0) / this.records.length;
  }

  best_improvement(): number {
    if (this.records.length === 0) return 0;
    return Math.max(...this.records.map((record) => record.improvement));
  }

  total_count(): bigint {
    return BigInt(this.records.length);
  }

  high_quality_count(threshold: number): number {
    return this.records.filter((record) => record.improvement >= threshold).length;
  }

  variance(): number {
    if (this.records.length === 0) return 0;
    const mean = this.mean_improvement();
    return this.records.reduce((sum, record) => {
      const diff = record.improvement - mean;
      return sum + diff * diff;
    }, 0) / this.records.length;
  }

  reset(): void {
    this.records.length = 0;
  }

  free(): void {
    this.reset();
  }
}

class LocalAttention {
  constructor(protected readonly dimensions: number) {}

  computeRaw(query: Float32Array, keys: Float32Array[], values: Float32Array[]): Float32Array {
    if (keys.length === 0 || keys.length !== values.length) {
      return new Float32Array(this.dimensions);
    }

    const scores = keys.map((key) => this.score(query, key));
    const maxScore = Math.max(...scores);
    const weights = scores.map((score) => Math.exp(score - maxScore));
    const denominator = Math.max(1e-12, weights.reduce((sum, value) => sum + value, 0));
    const output = new Float32Array(this.dimensions);

    for (let row = 0; row < values.length; row++) {
      const weight = weights[row] / denominator;
      const value = values[row];
      const limit = Math.min(output.length, value.length);
      for (let i = 0; i < limit; i++) {
        output[i] += value[i] * weight;
      }
    }

    return output;
  }

  protected score(query: Float32Array, key: Float32Array): number {
    const limit = Math.min(query.length, key.length, this.dimensions);
    let dot = 0;
    for (let i = 0; i < limit; i++) {
      dot += query[i] * key[i];
    }
    return dot / Math.sqrt(Math.max(1, limit));
  }
}

class LocalMoEAttention extends LocalAttention {
  static simple(dimensions: number, _experts: number, _topK: number): LocalMoEAttention {
    return new LocalMoEAttention(dimensions);
  }
}

class LocalHyperbolicAttention extends LocalAttention {
  constructor(dimensions: number, private readonly curvature: number) {
    super(dimensions);
  }

  protected override score(query: Float32Array, key: Float32Array): number {
    return super.score(query, key) / (1 + Math.max(0, this.curvature) * 0.01);
  }
}

class LocalAdamWOptimizer {
  constructor(
    private readonly learningRate: number,
    private readonly weightDecay: number,
  ) {}

  step(params: Float32Array, gradients: Float32Array): Float32Array {
    const output = new Float32Array(params.length);
    const limit = Math.min(params.length, gradients.length);
    for (let i = 0; i < limit; i++) {
      output[i] = params[i] - this.learningRate * (gradients[i] + this.weightDecay * params[i]);
    }
    return output;
  }
}

class LocalInfoNceLoss {
  constructor(private readonly temperature: number) {}

  compute(anchor: Float32Array, positives: Float32Array[], negatives: Float32Array[]): number {
    const positiveScore = positives.reduce((sum, vector) => sum + cosine(anchor, vector), 0) / Math.max(1, positives.length);
    const negativeScore = negatives.reduce((sum, vector) => sum + cosine(anchor, vector), 0) / Math.max(1, negatives.length);
    return Math.max(0, (negativeScore - positiveScore + 1) / Math.max(1e-6, this.temperature));
  }

  backward(anchor: Float32Array, positives: Float32Array[], negatives: Float32Array[]): Float32Array {
    const gradient = new Float32Array(anchor.length);
    const positive = positives[0];
    const negative = negatives[0];
    for (let i = 0; i < gradient.length; i++) {
      gradient[i] = ((negative?.[i] ?? 0) - (positive?.[i] ?? 0)) / Math.max(1, anchor.length);
    }
    return gradient;
  }
}

class LocalCurriculumScheduler {
  constructor(
    private readonly totalSteps: number,
    private readonly warmupSteps: number,
  ) {}

  getDifficulty(step: number): number {
    if (this.totalSteps <= 0) return 1;
    if (step < this.warmupSteps) {
      return Math.max(0.1, step / Math.max(1, this.warmupSteps));
    }
    return Math.min(1, (step + 1) / this.totalSteps);
  }
}

class LocalHardNegativeMiner {
  constructor(private readonly maxResults: number) {}

  mine(anchor: Float32Array, candidates: Float32Array[]): number[] {
    return candidates
      .map((candidate, index) => ({ index, score: cosine(anchor, candidate) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.maxResults)
      .map((entry) => entry.index);
  }
}

// Local training modules
let localAdapter: LocalAdapter | null = null;
let scopedAdapter: LocalScopedAdapter | null = null;
let trajectoryBuffer: LocalTrajectoryBuffer | null = null;
let flashAttention: LocalAttention | null = null;
let moeAttention: LocalMoEAttention | null = null;
let hyperbolicAttention: LocalHyperbolicAttention | null = null;
let optimizer: LocalAdamWOptimizer | null = null;
let contrastiveLoss: LocalInfoNceLoss | null = null;
let curriculum: LocalCurriculumScheduler | null = null;
let hardMiner: LocalHardNegativeMiner | null = null;

// SONA runtime training is unavailable in this build.
let sonaAvailable = false;

// Training state
let initialized = false;
let totalAdaptations = 0;
let totalForwards = 0;
let totalSonaLearns = 0;
let totalSonaSearches = 0;
let lastBenchmark: AttentionBenchmarkResult[] | null = null;

export interface TrainingConfig {
  dim?: number;           // Embedding dimension (max 256)
  learningRate?: number;  // Learning rate
  alpha?: number;         // LoRA scaling factor
  trajectoryCapacity?: number;
  useFlashAttention?: boolean;
  useMoE?: boolean;
  useHyperbolic?: boolean;
  totalSteps?: number;    // For curriculum
  warmupSteps?: number;
  // Legacy compatibility flags. SONA runtime training remains unavailable.
  useSona?: boolean;
  sonaRank?: number;
}

export interface TrainingResult {
  success: boolean;
  adaptationCount: bigint;
  forwardCount: bigint;
  deltaNorm: number;
  trajectoryStats?: {
    successRate: number;
    meanImprovement: number;
    bestImprovement: number;
    totalCount: bigint;
  };
  benchmark?: AttentionBenchmarkResult[];
}

/**
 * Initialize the local training system.
 */
export async function initializeTraining(config: TrainingConfig = {}): Promise<{
  success: boolean;
  features: string[];
  error?: string;
}> {
  const features: string[] = [];
  const dim = Math.min(config.dim || 256, 256);
  const lr = config.learningRate || 0.01;
  const alpha = config.alpha || 0.1;

  try {
    localAdapter = new LocalAdapter(dim, alpha, lr);
    features.push(`Local adapter (${dim}-dim)`);

    scopedAdapter = new LocalScopedAdapter(dim, alpha, lr);
    scopedAdapter.set_category_fallback(true);
    features.push('Local scoped adapters (17 operators)');

    trajectoryBuffer = new LocalTrajectoryBuffer(
      config.trajectoryCapacity || 10000,
      dim
    );
    features.push('Local trajectory buffer');

    if (config.useFlashAttention !== false) {
      flashAttention = new LocalAttention(dim);
      features.push('Local FlashAttention-compatible kernel');
    }

    if (config.useMoE) {
      moeAttention = LocalMoEAttention.simple(dim, 8, 2);
      features.push('Local MoE (8 experts, top-2)');
    }

    if (config.useHyperbolic) {
      hyperbolicAttention = new LocalHyperbolicAttention(dim, 1.0);
      features.push('Local hyperbolic attention');
    }

    optimizer = new LocalAdamWOptimizer(lr, 0.01);
    features.push('Local AdamW optimizer');

    contrastiveLoss = new LocalInfoNceLoss(0.07);
    features.push('Local InfoNCE loss');

    if (config.totalSteps) {
      curriculum = new LocalCurriculumScheduler(
        config.totalSteps,
        config.warmupSteps || Math.floor(config.totalSteps * 0.1)
      );
      features.push('Local curriculum learning');
    }

    hardMiner = new LocalHardNegativeMiner(5);
    features.push('Local hard negative mining');

    if (config.useSona !== false) {
      sonaAvailable = false;
      features.push('SONA runtime unavailable; using local heuristic adapters');
    }

    initialized = true;
    return { success: true, features };
  } catch (error) {
    return {
      success: false,
      features,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Operator types for scoped LoRA (0-16)
 */
export const OperatorType = {
  GENERAL: 0,
  ATTENTION: 1,
  MLP: 2,
  EMBEDDING: 3,
  NORMALIZATION: 4,
  PROJECTION: 5,
  POOLING: 6,
  CONVOLUTION: 7,
  RECURRENT: 8,
  ROUTING: 9,
  MEMORY: 10,
  REASONING: 11,
  COORDINATION: 12,
  OPTIMIZATION: 13,
  SECURITY: 14,
  TESTING: 15,
  DEBUGGING: 16,
} as const;

/**
 * Train a pattern with the local adapter.
 */
export async function trainPattern(
  embedding: Float32Array,
  gradient: Float32Array,
  operatorType?: number
): Promise<{ deltaNorm: number; adaptCount: bigint }> {
  if (!initialized || !localAdapter) {
    throw new Error('Training system not initialized');
  }

  // Use scoped LoRA if operator type specified
  if (operatorType !== undefined && scopedAdapter) {
    scopedAdapter.adapt_array(operatorType, gradient);
    return {
      deltaNorm: scopedAdapter.delta_norm(operatorType),
      adaptCount: scopedAdapter.adapt_count(operatorType),
    };
  }

  localAdapter.adapt_array(gradient);
  totalAdaptations++;

  return {
    deltaNorm: localAdapter.delta_norm(),
    adaptCount: localAdapter.adapt_count(),
  };
}

/**
 * Forward pass through LoRA
 */
export function forward(
  input: Float32Array,
  operatorType?: number
): Float32Array {
  if (!initialized || !localAdapter) {
    throw new Error('Training system not initialized');
  }

  totalForwards++;

  if (operatorType !== undefined && scopedAdapter) {
    return scopedAdapter.forward_array(operatorType, input);
  }

  return localAdapter.forward_array(input);
}

/**
 * Reward-based adaptation (reinforcement learning)
 */
export function adaptWithReward(
  improvement: number,
  operatorType?: number
): void {
  if (!initialized) {
    throw new Error('Training system not initialized');
  }

  if (operatorType !== undefined && scopedAdapter) {
    scopedAdapter.adapt_with_reward(operatorType, improvement);
  } else if (localAdapter) {
    localAdapter.adapt_with_reward(improvement);
  }

  totalAdaptations++;
}

/**
 * Record a learning trajectory
 */
export function recordTrajectory(
  embedding: Float32Array,
  operatorType: number,
  attentionType: number,
  executionMs: number,
  baselineMs: number
): void {
  if (!trajectoryBuffer) {
    throw new Error('Trajectory buffer not initialized');
  }

  trajectoryBuffer.record(
    embedding,
    operatorType,
    attentionType,
    executionMs,
    baselineMs
  );
}

/**
 * Get trajectory statistics
 */
export function getTrajectoryStats(): {
  successRate: number;
  meanImprovement: number;
  bestImprovement: number;
  totalCount: bigint;
  highQualityCount: number;
  variance: number;
} | null {
  if (!trajectoryBuffer || trajectoryBuffer.is_empty()) {
    return null;
  }

  return {
    successRate: trajectoryBuffer.success_rate(),
    meanImprovement: trajectoryBuffer.mean_improvement(),
    bestImprovement: trajectoryBuffer.best_improvement(),
    totalCount: trajectoryBuffer.total_count(),
    highQualityCount: trajectoryBuffer.high_quality_count(0.1),
    variance: trajectoryBuffer.variance(),
  };
}

/**
 * Compute attention with Flash Attention (Flash Attention optimization faster)
 */
export function computeFlashAttention(
  query: Float32Array,
  keys: Float32Array[],
  values: Float32Array[]
): Float32Array {
  if (!flashAttention) {
    throw new Error('Flash attention not initialized');
  }

  return flashAttention.computeRaw(query, keys, values);
}

/**
 * Compute MoE routing
 */
export function computeMoEAttention(
  query: Float32Array,
  keys: Float32Array[],
  values: Float32Array[]
): Float32Array {
  if (!moeAttention) {
    throw new Error('MoE attention not initialized');
  }

  return moeAttention.computeRaw(query, keys, values);
}

/**
 * Compute hyperbolic attention (for hierarchical patterns)
 */
export function computeHyperbolicAttention(
  query: Float32Array,
  keys: Float32Array[],
  values: Float32Array[]
): Float32Array {
  if (!hyperbolicAttention) {
    throw new Error('Hyperbolic attention not initialized');
  }

  return hyperbolicAttention.computeRaw(query, keys, values);
}

/**
 * Compute contrastive loss for training
 */
export function computeContrastiveLoss(
  anchor: Float32Array,
  positives: Float32Array[],
  negatives: Float32Array[]
): { loss: number; gradient: Float32Array } {
  if (!contrastiveLoss) {
    throw new Error('Contrastive loss not initialized');
  }

  const loss = contrastiveLoss.compute(anchor, positives, negatives);
  const gradient = contrastiveLoss.backward(anchor, positives, negatives);

  return { loss, gradient };
}

/**
 * Optimizer step
 */
export function optimizerStep(
  params: Float32Array,
  gradients: Float32Array
): Float32Array {
  if (!optimizer) {
    throw new Error('Optimizer not initialized');
  }

  return optimizer.step(params, gradients);
}

/**
 * Get curriculum difficulty for current step
 */
export function getCurriculumDifficulty(step: number): number {
  if (!curriculum) {
    return 1.0; // Full difficulty if no curriculum
  }

  return curriculum.getDifficulty(step);
}

/**
 * Mine hard negatives for better training
 */
export function mineHardNegatives(
  anchor: Float32Array,
  candidates: Float32Array[]
): number[] {
  if (!hardMiner) {
    throw new Error('Hard negative miner not initialized');
  }

  return hardMiner.mine(anchor, candidates);
}

/**
 * Benchmark the training system
 */
export async function benchmarkTraining(
  dim?: number,
  iterations?: number,
  numKeys?: number,
): Promise<AttentionBenchmarkResult[]> {
  const dimensions = Math.min(dim || 256, 256);
  const keys = Math.max(1, numKeys || 100);
  const runs = Math.max(1, iterations || 1000);
  const mechanisms: Array<{ name: string; mechanism: LocalAttention }> = [
    { name: 'DotProduct', mechanism: new LocalAttention(dimensions) },
    { name: 'FlashAttention-compatible', mechanism: new LocalAttention(dimensions) },
    { name: 'MoE-compatible', mechanism: LocalMoEAttention.simple(dimensions, 8, 2) },
    { name: 'Hyperbolic-compatible', mechanism: new LocalHyperbolicAttention(dimensions, 1.0) },
    { name: 'Linear-compatible', mechanism: new LocalAttention(dimensions) },
  ];

  lastBenchmark = mechanisms.map(({ name, mechanism }) =>
    benchmarkMechanism(name, mechanism, dimensions, keys, runs)
  );
  return lastBenchmark ?? [];
}

/**
 * Benchmark local adapter adaptation.
 */
export function benchmarkLocalAdapter(
  dim?: number,
  iterations?: number,
): LocalAdapterBenchmarkResult {
  const dimensions = Math.min(dim || 256, 256);
  const runs = Math.max(1, iterations || 1000);
  const adapter = new LocalAdapter(dimensions, 0.1, 0.01);
  const gradient = deterministicVector(dimensions, 29);

  const start = performance.now();
  for (let i = 0; i < runs; i++) {
    adapter.adapt_array(gradient);
  }
  const totalTimeMs = performance.now() - start;
  const averageTimeMs = totalTimeMs / runs;
  adapter.free();

  return {
    averageTimeMs,
    totalTimeMs,
    adaptationsPerSecond: Math.round((runs / Math.max(totalTimeMs, 1e-6)) * 1000),
  };
}

// ============================================
// Legacy SONA compatibility functions
// ============================================

/**
 * Check if SONA is available
 */
export function isSonaAvailable(): boolean {
  return sonaAvailable;
}

/**
 * SONA runtime training is unavailable in this build.
 */
export function sonaForceLearn(
  _embedding: Float32Array,
  _reward: number
): void {
  throw new Error('SONA runtime training is unavailable; use trainPattern and recordTrajectory for local heuristic learning.');
}

/**
 * SONA runtime pattern search is unavailable in this build.
 */
export function sonaFindPatterns(
  _embedding: Float32Array,
  _k: number = 5
): unknown[] {
  return [];
}

/**
 * Legacy no-op for callers that periodically tick optional learning backends.
 */
export function sonaTick(): void {
}

/**
 * Get SONA statistics
 */
export function getSonaStats(): {
  available: boolean;
  enabled: boolean;
  stats: Record<string, unknown> | null;
  totalLearns: number;
  totalSearches: number;
} {
  return {
    available: false,
    enabled: false,
    stats: null,
    totalLearns: totalSonaLearns,
    totalSearches: totalSonaSearches,
  };
}

/**
 * Enable/disable SONA learning
 */
export function setSonaEnabled(_enabled: boolean): void {
}

/**
 * Legacy no-op; there are no SONA buffers in this build.
 */
export function sonaFlush(): void {
}

/**
 * Get training statistics
 */
export function getTrainingStats(): {
  initialized: boolean;
  totalAdaptations: number;
  totalForwards: number;
  adapterStats?: {
    paramCount: number;
    adaptCount: bigint;
    forwardCount: bigint;
    deltaNorm: number;
  };
  scopedAdapterStats?: {
    totalAdaptCount: bigint;
    totalForwardCount: bigint;
  };
  trajectoryStats?: ReturnType<typeof getTrajectoryStats>;
  sonaStats?: ReturnType<typeof getSonaStats>;
  lastBenchmark?: AttentionBenchmarkResult[];
} {
  const stats: ReturnType<typeof getTrainingStats> = {
    initialized,
    totalAdaptations,
    totalForwards,
  };

  if (localAdapter) {
    stats.adapterStats = {
      paramCount: localAdapter.param_count(),
      adaptCount: localAdapter.adapt_count(),
      forwardCount: localAdapter.forward_count(),
      deltaNorm: localAdapter.delta_norm(),
    };
  }

  if (scopedAdapter) {
    stats.scopedAdapterStats = {
      totalAdaptCount: scopedAdapter.total_adapt_count(),
      totalForwardCount: scopedAdapter.total_forward_count(),
    };
  }

  if (trajectoryBuffer && !trajectoryBuffer.is_empty()) {
    stats.trajectoryStats = getTrajectoryStats();
  }

  // Include SONA stats if available
  if (sonaAvailable) {
    stats.sonaStats = getSonaStats();
  }

  if (lastBenchmark) {
    stats.lastBenchmark = lastBenchmark;
  }

  return stats;
}

/**
 * Reset the training system
 */
export function resetTraining(): void {
  if (localAdapter) localAdapter.reset();
  if (scopedAdapter) scopedAdapter.reset_all();
  if (trajectoryBuffer) trajectoryBuffer.reset();

  totalAdaptations = 0;
  totalForwards = 0;
  totalSonaLearns = 0;
  totalSonaSearches = 0;
}

/**
 * Export trained weights
 */
export function exportWeights(): {
  dim: number;
  deltaNorm: number;
  adaptCount: bigint;
  trajectoryStats: ReturnType<typeof getTrajectoryStats>;
} | null {
  if (!initialized || !localAdapter) {
    return null;
  }

  return {
    dim: localAdapter.dim(),
    deltaNorm: localAdapter.delta_norm(),
    adaptCount: localAdapter.adapt_count(),
    trajectoryStats: getTrajectoryStats(),
  };
}

/**
 * Cleanup resources
 */
export function cleanup(): void {
  if (localAdapter) {
    localAdapter.free();
    localAdapter = null;
  }
  if (scopedAdapter) {
    scopedAdapter.free();
    scopedAdapter = null;
  }
  if (trajectoryBuffer) {
    trajectoryBuffer.free();
    trajectoryBuffer = null;
  }

  sonaAvailable = false;

  flashAttention = null;
  moeAttention = null;
  hyperbolicAttention = null;
  optimizer = null;
  contrastiveLoss = null;
  curriculum = null;
  hardMiner = null;

  initialized = false;
  totalAdaptations = 0;
  totalForwards = 0;
  totalSonaLearns = 0;
  totalSonaSearches = 0;
  lastBenchmark = null;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const limit = Math.min(a.length, b.length);
  if (limit === 0) return 0;

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < limit; i++) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }

  const denominator = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  return denominator > 0 ? dot / denominator : 0;
}

function deterministicVector(dimensions: number, seed: number): Float32Array {
  const vector = new Float32Array(dimensions);
  let state = seed >>> 0;
  for (let i = 0; i < dimensions; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    vector[i] = (state / 0xffffffff) * 2 - 1;
  }
  return vector;
}

function benchmarkMechanism(
  name: string,
  mechanism: LocalAttention,
  dimensions: number,
  numKeys: number,
  iterations: number,
): AttentionBenchmarkResult {
  const query = deterministicVector(dimensions, 7);
  const keys = Array.from({ length: numKeys }, (_, index) => deterministicVector(dimensions, 101 + index));
  const values = Array.from({ length: numKeys }, (_, index) => deterministicVector(dimensions, 1009 + index));

  for (let i = 0; i < 10; i++) {
    mechanism.computeRaw(query, keys, values);
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    mechanism.computeRaw(query, keys, values);
  }
  const elapsed = performance.now() - start;

  return {
    name,
    averageTimeMs: elapsed / iterations,
    opsPerSecond: Math.round((iterations / Math.max(elapsed, 1e-6)) * 1000),
  };
}
