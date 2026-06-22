/**
 * SwarmAdapter - local V3 swarm coordination helpers
 *
 * Provides conversion and routing helpers for Hive Flow v3 swarm state.
 *
 * Key Alignments:
 * - Topology: mesh, hierarchical, ring, star (maps V3's centralized -> star)
 * - AgentOutput: { agentId, agentType, embedding, value, confidence }
 * - SpecializedAgent: { id, type, specialization, capabilities, load }
 * - Expert routing via MoE attention for task assignment
 * - GraphRoPE for topology-aware coordination
 *
 * @module v3/integration/swarm-adapter
 * @version 3.0.0-alpha.1
 */

import { EventEmitter } from 'events';

// ============================================================================
// Hive Flow Swarm Pattern Types
// ============================================================================

/**
 * V3's 'centralized' maps to 'star', 'hybrid' is represented as 'mesh' with hierarchical overlay.
 */
export type HiveTopology = 'mesh' | 'hierarchical' | 'ring' | 'star';

/**
 * Attention mechanism types
 */
export type HiveAttentionMechanism =
  | 'flash'       // Flash Attention with memory reduction
  | 'linear'      // Linear attention for long sequences
  | 'hyperbolic'  // Hyperbolic attention for hierarchical data
  | 'moe'         // Mixture of Experts attention
  | 'multi-head'; // Standard multi-head attention

/**
 * Agent output interface used by Hive Flow swarms.
 */
export interface HiveAgentOutput {
  /** Agent identifier */
  agentId: string;
  /** Agent type/role */
  agentType: string;
  /** Embedding vector for the agent's output (semantic representation) */
  embedding: number[] | Float32Array;
  /** The actual value/result produced by the agent */
  value: unknown;
  /** Confidence score for this output (0.0 - 1.0) */
  confidence: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Represents an expert agent with specific capabilities
 */
export interface HiveSpecializedAgent {
  /** Agent identifier */
  id: string;
  /** Agent type */
  type: string;
  /** Specialization area */
  specialization: string;
  /** List of capabilities */
  capabilities: string[];
  /** Current load (0.0 - 1.0) */
  load: number;
  /** Embedding for expert matching */
  embedding?: number[];
  /** Performance score */
  performanceScore?: number;
}

/**
 * Expert routing result
 */
export interface HiveExpertRoute {
  /** Selected expert IDs */
  selectedExperts: HiveSpecializedAgent[];
  /** Routing scores for each expert */
  scores: Map<string, number>;
  /** Routing mechanism used */
  mechanism: 'moe' | 'similarity' | 'load-balanced';
  /** Routing latency in ms */
  latencyMs: number;
}

/**
 * Attention coordination result
 */
export interface HiveAttentionResult {
  /** Consensus output */
  consensus: unknown;
  /** Attention weights for each agent */
  attentionWeights: Map<string, number>;
  /** Top contributing agents */
  topAgents: Array<{ id: string; name: string; weight: number }>;
  /** Coordination mechanism used */
  mechanism: HiveAttentionMechanism;
  /** Execution time in ms */
  executionTimeMs: number;
}

/**
 * GraphRoPE coordination context
 * Topology-aware positional encoding for better coordination
 */
export interface GraphRoPEContext {
  /** Node positions in the topology graph */
  nodePositions: Map<string, number[]>;
  /** Edge weights between nodes */
  edgeWeights: Map<string, Map<string, number>>;
  /** Rotary position encoding dimension */
  ropeDimension: number;
  /** Whether to use relative positions */
  useRelativePositions: boolean;
}

// ============================================================================
// V3 Swarm Types (Source Interface from @hive-flow/cli/swarm)
// ============================================================================

/**
 * V3 Topology types (from @hive-flow/cli/swarm)
 */
export type V3TopologyType = 'mesh' | 'hierarchical' | 'centralized' | 'hybrid';

/**
 * V3 Agent Domain types (from @hive-flow/cli/swarm)
 */
export type V3AgentDomain = 'queen' | 'security' | 'core' | 'integration' | 'support';

/**
 * V3 Agent State interface (simplified from @hive-flow/cli/swarm)
 */
export interface V3AgentState {
  id: { id: string; swarmId: string; type: string; instance: number };
  name: string;
  type: string;
  status: string;
  capabilities: {
    codeGeneration: boolean;
    codeReview: boolean;
    testing: boolean;
    documentation: boolean;
    research: boolean;
    analysis: boolean;
    coordination: boolean;
    languages: string[];
    frameworks: string[];
    domains: string[];
    tools: string[];
    maxConcurrentTasks: number;
    reliability: number;
    speed: number;
    quality: number;
  };
  metrics: {
    tasksCompleted: number;
    tasksFailed: number;
    successRate: number;
    averageExecutionTime: number;
    health: number;
  };
  workload: number;
  health: number;
  lastHeartbeat: Date;
  topologyRole?: 'queen' | 'worker' | 'coordinator' | 'peer';
}

/**
 * V3 Task Definition interface (simplified from @hive-flow/cli/swarm)
 */
export interface V3TaskDefinition {
  id: { id: string; swarmId: string; sequence: number; priority: string };
  type: string;
  name: string;
  description: string;
  priority: string;
  status: string;
  assignedTo?: { id: string };
  metadata: Record<string, unknown>;
}

// ============================================================================
// Adapter Configuration
// ============================================================================

/**
 * SwarmAdapter configuration options
 */
export interface SwarmAdapterConfig {
  /** Enable attention-based coordination */
  enableAttentionCoordination: boolean;
  /** Enable MoE expert routing */
  enableMoERouting: boolean;
  /** Enable GraphRoPE topology awareness */
  enableGraphRoPE: boolean;
  /** Default attention mechanism */
  defaultAttentionMechanism: HiveAttentionMechanism;
  /** Number of experts for MoE routing */
  moeTopK: number;
  /** GraphRoPE dimension */
  ropeDimension: number;
  /** Debug mode */
  debug: boolean;
}

/**
 * Default adapter configuration
 */
const DEFAULT_CONFIG: SwarmAdapterConfig = {
  enableAttentionCoordination: true,
  enableMoERouting: true,
  enableGraphRoPE: true,
  defaultAttentionMechanism: 'flash',
  moeTopK: 3,
  ropeDimension: 64,
  debug: false,
};

// ============================================================================
// SwarmAdapter Class
// ============================================================================

/**
 * SwarmAdapter - local V3 swarm routing and coordination utilities.
 *
 * Key Features:
 * - Topology conversion
 * - Agent output format conversion
 * - Specialized agent wrapping
 * - MoE expert routing integration
 * - Attention-based consensus coordination
 * - GraphRoPE topology-aware positioning
 *
 * Usage:
 * ```typescript
 * import { SwarmAdapter, createSwarmAdapter } from '@hive-flow/cli/integration';
 *
 * const adapter = await createSwarmAdapter({
 *   enableAttentionCoordination: true,
 *   enableMoERouting: true,
 * });
 *
 * // Convert V3 agents to specialized format
 * const specializedAgents = adapter.toSpecializedAgents(v3Agents);
 *
 * // Route task to experts using MoE
 * const routes = await adapter.routeToExperts(taskEmbedding, specializedAgents);
 *
 * // Coordinate agent outputs with attention
 * const consensus = await adapter.coordinateWithAttention(agentOutputs);
 * ```
 */
export class SwarmAdapter extends EventEmitter {
  private config: SwarmAdapterConfig;
  private initialized: boolean = false;

  /**
   * GraphRoPE context for topology-aware coordination
   */
  private graphRoPEContext: GraphRoPEContext | null = null;

  /**
   * Cached topology mapping
   */
  private topologyCache: Map<string, number[]> = new Map();

  constructor(config: Partial<SwarmAdapterConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Initialize the SwarmAdapter
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.emit('initializing');

    try {
      // Initialize GraphRoPE context if enabled
      if (this.config.enableGraphRoPE) {
        this.graphRoPEContext = {
          nodePositions: new Map(),
          edgeWeights: new Map(),
          ropeDimension: this.config.ropeDimension,
          useRelativePositions: true,
        };
      }

      this.initialized = true;
      this.emit('initialized', {
        attentionCoordination: this.config.enableAttentionCoordination,
      });
    } catch (error) {
      this.emit('initialization-failed', { error });
      throw error;
    }
  }

  /**
   * Shutdown the adapter
   */
  async shutdown(): Promise<void> {
    this.topologyCache.clear();
    this.graphRoPEContext = null;
    this.initialized = false;
    this.emit('shutdown');
  }

  // ==========================================================================
  // Topology Conversion
  // ==========================================================================

  /**
   * Convert V3 topology type to Hive Flow topology
   *
   * Mapping:
   * - mesh -> mesh
   * - hierarchical -> hierarchical
   * - centralized -> star (Hive Flow uses 'star' for central coordinator pattern)
   * - hybrid -> mesh (treated as mesh with additional hierarchical overlay)
   */
  convertTopology(v3Topology: V3TopologyType): HiveTopology {
    const mapping: Record<V3TopologyType, HiveTopology> = {
      mesh: 'mesh',
      hierarchical: 'hierarchical',
      centralized: 'star',
      hybrid: 'mesh', // Hybrid is treated as mesh with hierarchical overlay
    };

    return mapping[v3Topology] || 'mesh';
  }

  /**
   * Convert Hive Flow topology to V3 topology type
   */
  convertTopologyToV3(topology: HiveTopology): V3TopologyType {
    const mapping: Record<HiveTopology, V3TopologyType> = {
      mesh: 'mesh',
      hierarchical: 'hierarchical',
      ring: 'mesh', // Ring is treated as mesh in V3
      star: 'centralized',
    };

    return mapping[topology] || 'mesh';
  }

  // ==========================================================================
  // Agent Conversion
  // ==========================================================================

  /**
   * Convert V3 Agent to Hive Flow AgentOutput format
   *
   * Creates the embedding from agent capabilities and produces
   * the standardized AgentOutput interface expected by Hive Flow.
   */
  toAgentOutput(
    agent: V3AgentState,
    value: unknown,
    confidence?: number
  ): HiveAgentOutput {
    // Generate embedding from agent capabilities
    const embedding = this.generateAgentEmbedding(agent);

    // Calculate confidence from agent metrics if not provided
    const calculatedConfidence = confidence ??
      agent.metrics.successRate * agent.health;

    return {
      agentId: agent.id.id,
      agentType: agent.type,
      embedding,
      value,
      confidence: Math.min(1.0, Math.max(0.0, calculatedConfidence)),
      metadata: {
        domain: this.inferDomain(agent),
        capabilities: agent.capabilities.domains,
        workload: agent.workload,
        successRate: agent.metrics.successRate,
      },
    };
  }

  /**
   * Convert V3 Agent to Hive Flow SpecializedAgent format
   *
   * Creates an expert representation suitable for MoE routing
   */
  toSpecializedAgent(agent: V3AgentState): HiveSpecializedAgent {
    const embedding = this.generateAgentEmbedding(agent);

    // Determine specialization from capabilities
    const specialization = this.determineSpecialization(agent);

    // Collect capabilities as strings
    const capabilities = this.collectCapabilities(agent);

    return {
      id: agent.id.id,
      type: agent.type,
      specialization,
      capabilities,
      load: agent.workload,
      embedding,
      performanceScore: agent.metrics.successRate * agent.health,
    };
  }

  /**
   * Convert multiple V3 agents to SpecializedAgents
   */
  toSpecializedAgents(agents: V3AgentState[]): HiveSpecializedAgent[] {
    return agents.map((agent) => this.toSpecializedAgent(agent));
  }

  /**
   * Convert Hive Flow SpecializedAgent back to partial V3 format
   * (for updates/sync)
   */
  fromSpecializedAgent(
    specializedAgent: HiveSpecializedAgent
  ): Partial<V3AgentState> {
    return {
      id: {
        id: specializedAgent.id,
        swarmId: 'converted',
        type: specializedAgent.type,
        instance: 0,
      },
      name: specializedAgent.id,
      type: specializedAgent.type,
      workload: specializedAgent.load,
      capabilities: {
        codeGeneration: specializedAgent.capabilities.includes('code-generation'),
        codeReview: specializedAgent.capabilities.includes('code-review'),
        testing: specializedAgent.capabilities.includes('testing'),
        documentation: specializedAgent.capabilities.includes('documentation'),
        research: specializedAgent.capabilities.includes('research'),
        analysis: specializedAgent.capabilities.includes('analysis'),
        coordination: specializedAgent.capabilities.includes('coordination'),
        languages: [],
        frameworks: [],
        domains: [specializedAgent.specialization],
        tools: [],
        maxConcurrentTasks: 3,
        reliability: specializedAgent.performanceScore ?? 0.9,
        speed: 1.0,
        quality: specializedAgent.performanceScore ?? 0.9,
      },
      health: specializedAgent.performanceScore ?? 1.0,
    };
  }

  // ==========================================================================
  // MoE Expert Routing
  // ==========================================================================

  /**
   * Route a task to the best experts using MoE attention
   *
   * Uses cosine similarity with load balancing for optimal routing.
   */
  async routeToExperts(
    taskEmbedding: number[],
    experts: HiveSpecializedAgent[],
    topK?: number
  ): Promise<HiveExpertRoute> {
    this.ensureInitialized();
    const startTime = performance.now();
    const k = topK ?? this.config.moeTopK;

    // Local implementation: similarity + load balancing
    const scores = new Map<string, number>();

    for (const expert of experts) {
      if (!expert.embedding) {
        scores.set(expert.id, 0);
        continue;
      }

      // Compute cosine similarity
      const similarity = this.cosineSimilarity(taskEmbedding, expert.embedding);

      // Adjust for load (prefer less loaded experts)
      const loadFactor = 1 - expert.load * 0.3;

      // Boost by performance score
      const perfFactor = expert.performanceScore ?? 0.9;

      const finalScore = similarity * loadFactor * perfFactor;
      scores.set(expert.id, finalScore);
    }

    // Sort by score and select top K
    const sortedExperts = experts
      .filter((e) => scores.get(e.id) !== undefined)
      .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));

    const selectedExperts = sortedExperts.slice(0, k);

    return {
      selectedExperts,
      scores,
      mechanism: 'load-balanced',
      latencyMs: performance.now() - startTime,
    };
  }

  // ==========================================================================
  // Attention-Based Coordination
  // ==========================================================================

  /**
   * Coordinate agent outputs using attention mechanisms
   *
   * Local attention-weighted consensus for multi-agent coordination.
   */
  async coordinateWithAttention(
    agentOutputs: HiveAgentOutput[],
    mechanism?: HiveAttentionMechanism
  ): Promise<HiveAttentionResult> {
    this.ensureInitialized();
    const startTime = performance.now();
    const useMechanism = mechanism ?? this.config.defaultAttentionMechanism;

    // Local implementation: weighted consensus based on confidence
    const attentionWeights = new Map<string, number>();

    // Compute attention weights from embeddings
    const n = agentOutputs.length;
    if (n === 0) {
      return {
        consensus: null,
        attentionWeights,
        topAgents: [],
        mechanism: useMechanism,
        executionTimeMs: performance.now() - startTime,
      };
    }

    // Compute pairwise similarity matrix
    const scores: number[] = [];
    for (let i = 0; i < n; i++) {
      let score = agentOutputs[i].confidence;

      // Add similarity bonus with other agents (agreement signal)
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          const embI = Array.isArray(agentOutputs[i].embedding)
            ? agentOutputs[i].embedding
            : Array.from(agentOutputs[i].embedding);
          const embJ = Array.isArray(agentOutputs[j].embedding)
            ? agentOutputs[j].embedding
            : Array.from(agentOutputs[j].embedding);
          score += this.cosineSimilarity(embI as number[], embJ as number[]) * 0.1;
        }
      }

      scores.push(score);
    }

    // Softmax for attention weights
    const maxScore = Math.max(...scores);
    const expScores = scores.map((s) => Math.exp(s - maxScore));
    const sumExp = expScores.reduce((a, b) => a + b, 0);

    for (let i = 0; i < n; i++) {
      const weight = expScores[i] / sumExp;
      attentionWeights.set(agentOutputs[i].agentId, weight);
    }

    // Select consensus as highest weighted output
    const maxWeightIdx = scores.indexOf(Math.max(...scores));
    const consensus = agentOutputs[maxWeightIdx].value;

    return {
      consensus,
      attentionWeights,
      topAgents: this.extractTopAgents(agentOutputs, attentionWeights),
      mechanism: useMechanism,
      executionTimeMs: performance.now() - startTime,
    };
  }

  // ==========================================================================
  // GraphRoPE Topology Awareness
  // ==========================================================================

  /**
   * Update GraphRoPE context with current topology
   *
   * Creates positional encodings based on agent positions
   * in the swarm topology graph.
   */
  updateGraphRoPEContext(
    agents: V3AgentState[],
    edges: Array<{ from: string; to: string; weight: number }>
  ): void {
    if (!this.config.enableGraphRoPE || !this.graphRoPEContext) {
      return;
    }

    const nodePositions = new Map<string, number[]>();
    const edgeWeights = new Map<string, Map<string, number>>();

    // Generate positional encoding for each agent
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const position = this.generatePositionalEncoding(i, this.config.ropeDimension);
      nodePositions.set(agent.id.id, position);
    }

    // Store edge weights
    for (const edge of edges) {
      if (!edgeWeights.has(edge.from)) {
        edgeWeights.set(edge.from, new Map());
      }
      edgeWeights.get(edge.from)!.set(edge.to, edge.weight);
    }

    this.graphRoPEContext.nodePositions = nodePositions;
    this.graphRoPEContext.edgeWeights = edgeWeights;

    this.emit('graphrope-updated', {
      nodeCount: nodePositions.size,
      edgeCount: edges.length,
    });
  }

  /**
   * Get topology-aware embedding for an agent
   *
   * Combines agent's base embedding with positional encoding
   * from the topology graph.
   */
  getTopologyAwareEmbedding(
    agent: V3AgentState,
    baseEmbedding?: number[]
  ): number[] {
    const embedding =
      baseEmbedding ?? this.generateAgentEmbedding(agent);

    if (!this.config.enableGraphRoPE || !this.graphRoPEContext) {
      return embedding;
    }

    const position = this.graphRoPEContext.nodePositions.get(agent.id.id);
    if (!position) {
      return embedding;
    }

    // Apply rotary position encoding
    return this.applyRoPE(embedding, position);
  }

  // ==========================================================================
  // Domain Mapping
  // ==========================================================================

  /**
   * Map V3 domain to Hive Flow specialization
   */
  mapDomainToSpecialization(domain: V3AgentDomain): string {
    const mapping: Record<V3AgentDomain, string> = {
      queen: 'coordination',
      security: 'security-analysis',
      core: 'architecture',
      integration: 'implementation',
      support: 'testing-performance',
    };

    return mapping[domain] || 'general';
  }

  /**
   * Map Hive Flow specialization to V3 domain
   */
  mapSpecializationToDomain(specialization: string): V3AgentDomain {
    const lower = specialization.toLowerCase();

    if (lower.includes('coord') || lower.includes('orchestrat')) {
      return 'queen';
    }
    if (lower.includes('security') || lower.includes('audit')) {
      return 'security';
    }
    if (lower.includes('arch') || lower.includes('design')) {
      return 'core';
    }
    if (lower.includes('impl') || lower.includes('code') || lower.includes('integrat')) {
      return 'integration';
    }
    if (
      lower.includes('test') ||
      lower.includes('perf') ||
      lower.includes('deploy')
    ) {
      return 'support';
    }

    return 'core'; // Default
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Get adapter configuration
   */
  getConfig(): SwarmAdapterConfig {
    return { ...this.config };
  }

  /**
   * Reconfigure the adapter
   */
  async reconfigure(config: Partial<SwarmAdapterConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    this.emit('reconfigured', { config: this.config });
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private generateAgentEmbedding(agent: V3AgentState): number[] {
    // Generate hash-based embedding from agent properties
    const embedding = new Array(128).fill(0);

    // Encode agent type
    const typeHash = this.simpleHash(agent.type);
    for (let i = 0; i < 16; i++) {
      embedding[i] = ((typeHash >> i) & 1) * 0.5;
    }

    // Encode capabilities
    const capString = agent.capabilities.domains.join(',');
    const capHash = this.simpleHash(capString);
    for (let i = 16; i < 32; i++) {
      embedding[i] = ((capHash >> (i - 16)) & 1) * 0.5;
    }

    // Encode metrics
    embedding[32] = agent.metrics.successRate;
    embedding[33] = agent.health;
    embedding[34] = 1 - agent.workload;
    embedding[35] = agent.metrics.tasksCompleted / 100;

    // Encode role
    const roleWeights: Record<string, number> = {
      queen: 1.0,
      coordinator: 0.9,
      worker: 0.5,
      peer: 0.5,
    };
    embedding[36] = roleWeights[agent.topologyRole ?? 'worker'] ?? 0.5;

    // Normalize
    const norm = Math.sqrt(
      embedding.reduce((sum, v) => sum + v * v, 0)
    );
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  private determineSpecialization(agent: V3AgentState): string {
    const caps = agent.capabilities;

    if (caps.coordination) return 'coordination';
    if (caps.codeGeneration && caps.codeReview) return 'development';
    if (caps.testing) return 'testing';
    if (caps.research || caps.analysis) return 'analysis';
    if (caps.documentation) return 'documentation';

    // Check domains
    if (caps.domains.includes('security')) return 'security';
    if (caps.domains.includes('performance')) return 'performance';
    if (caps.domains.includes('architecture')) return 'architecture';

    return agent.type;
  }

  private collectCapabilities(agent: V3AgentState): string[] {
    const caps: string[] = [];

    if (agent.capabilities.codeGeneration) caps.push('code-generation');
    if (agent.capabilities.codeReview) caps.push('code-review');
    if (agent.capabilities.testing) caps.push('testing');
    if (agent.capabilities.documentation) caps.push('documentation');
    if (agent.capabilities.research) caps.push('research');
    if (agent.capabilities.analysis) caps.push('analysis');
    if (agent.capabilities.coordination) caps.push('coordination');

    caps.push(...agent.capabilities.languages);
    caps.push(...agent.capabilities.frameworks);
    caps.push(...agent.capabilities.domains);

    return caps;
  }

  private inferDomain(agent: V3AgentState): V3AgentDomain {
    if (agent.type === 'queen' || agent.capabilities.coordination) {
      return 'queen';
    }

    const domains = agent.capabilities.domains;
    if (domains.includes('security')) return 'security';
    if (domains.includes('core') || domains.includes('architecture')) return 'core';
    if (domains.includes('integration')) return 'integration';
    if (domains.includes('testing') || domains.includes('performance')) {
      return 'support';
    }

    return 'core';
  }

  private extractTopAgents(
    outputs: HiveAgentOutput[],
    weights: Map<string, number>
  ): Array<{ id: string; name: string; weight: number }> {
    return outputs
      .map((o) => ({
        id: o.agentId,
        name: o.agentType,
        weight: weights.get(o.agentId) ?? 0,
      }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);

    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  private generatePositionalEncoding(
    position: number,
    dimension: number
  ): number[] {
    const encoding = new Array(dimension).fill(0);

    for (let i = 0; i < dimension; i++) {
      const angle = position / Math.pow(10000, (2 * Math.floor(i / 2)) / dimension);
      encoding[i] = i % 2 === 0 ? Math.sin(angle) : Math.cos(angle);
    }

    return encoding;
  }

  private applyRoPE(embedding: number[], position: number[]): number[] {
    const result = [...embedding];
    const dim = Math.min(embedding.length, position.length);

    // Apply rotary encoding (simplified)
    for (let i = 0; i < dim - 1; i += 2) {
      const cos = position[i];
      const sin = position[i + 1] ?? 0;

      const x1 = embedding[i];
      const x2 = embedding[i + 1] ?? 0;

      result[i] = x1 * cos - x2 * sin;
      result[i + 1] = x1 * sin + x2 * cos;
    }

    return result;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SwarmAdapter not initialized. Call initialize() first.');
    }
  }

  private logDebug(message: string, data?: unknown): void {
    if (this.config.debug) {
      console.debug(`[SwarmAdapter] ${message}`, data || '');
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create and initialize a SwarmAdapter
 */
export async function createSwarmAdapter(
  config?: Partial<SwarmAdapterConfig>
): Promise<SwarmAdapter> {
  const adapter = new SwarmAdapter(config);
  await adapter.initialize();
  return adapter;
}

/**
 * Singleton instance for simple usage
 */
let defaultAdapter: SwarmAdapter | null = null;

/**
 * Get the default adapter instance (creates if needed)
 */
export async function getDefaultSwarmAdapter(
  config?: Partial<SwarmAdapterConfig>
): Promise<SwarmAdapter> {
  if (!defaultAdapter) {
    defaultAdapter = new SwarmAdapter(config);
    await defaultAdapter.initialize();
  }
  return defaultAdapter;
}

/**
 * Reset the default adapter (useful for testing)
 */
export async function resetDefaultSwarmAdapter(): Promise<void> {
  if (defaultAdapter) {
    await defaultAdapter.shutdown();
    defaultAdapter = null;
  }
}

export default SwarmAdapter;
