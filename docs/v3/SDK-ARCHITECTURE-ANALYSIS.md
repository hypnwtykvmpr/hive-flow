# Claude-Flow v3 SDK Architecture Analysis

## Deep Review: agentic-flow@alpha + ruvector Ecosystem

This document provides a comprehensive analysis of using `agentic-flow@2.0.1-alpha.50` as the SDK foundation for Claude-Flow v3, including additional capabilities from the ruvector ecosystem.

---

## 1. Executive Summary

### Key Findings

**agentic-flow@alpha provides a complete, production-ready SDK** that wraps and fixes the raw @ruvector/* alpha packages. Claude-Flow v3 should use agentic-flow as its primary SDK rather than importing @ruvector/* packages directly.

| Aspect | agentic-flow@alpha | Raw @ruvector/* |
|--------|-------------------|------------------|
| Stability | Production wrappers | Alpha APIs (broken) |
| Performance | 11-200x improvements | Variable |
| Cross-platform | Linux/macOS/Windows | NAPI failures on some |
| Integration | Unified API | Fragmented |
| Learning | 9 RL algorithms | Manual SONA only |

### Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude-Flow v3                               │
├─────────────────────────────────────────────────────────────────┤
│  Thin Integration Layer (~500 lines)                            │
│  - Hook event mapping                                           │
│  - Configuration bridge                                         │
│  - CLI commands                                                 │
├─────────────────────────────────────────────────────────────────┤
│               agentic-flow@alpha SDK                            │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐     │
│  │   Hooks     │  Learning   │   Swarm     │Intelligence │     │
│  │  (19 tools) │  (9 algos)  │   (QUIC)    │   (Store)   │     │
│  └─────────────┴─────────────┴─────────────┴─────────────┘     │
├─────────────────────────────────────────────────────────────────┤
│               Production Wrappers (core/)                       │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐     │
│  │ GNN Wrapper │ AgentDB Fast│ Attention   │ Embedding   │     │
│  │  (11-22x)   │  (50-200x)  │  (Native)   │  (ONNX)     │     │
│  └─────────────┴─────────────┴─────────────┴─────────────┘     │
├─────────────────────────────────────────────────────────────────┤
│                @ruvector/* Packages (underlying)                │
│  ┌─────────────┬─────────────┬─────────────┬─────────────┐     │
│  │  ruvector   │ @ruvector/  │ @ruvector/  │ @ruvector/  │     │
│  │   core      │    sona     │  attention  │     gnn     │     │
│  └─────────────┴─────────────┴─────────────┴─────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Package Ecosystem Overview

### 2.1 ruvector@0.1.95 (Core Package)

The base package providing high-performance vector operations with native Rust bindings.

**Dependencies:**
```json
{
  "@ruvector/core": "^0.1.30",      // Native Rust HNSW (150x faster)
  "@ruvector/sona": "^0.1.5",       // SONA continual learning
  "@ruvector/attention": "^0.1.3", // Attention mechanisms
  "@ruvector/gnn": "^0.1.22"       // Graph Neural Networks
}
```

**Key Exports:**
- `IntelligenceEngine` - Full-stack learning (VectorDB + SONA + AgentDB + Attention)
- `LearningEngine` - SONA + Micro-LoRA integration
- `TensorCompress` - Tiered compression (50-97% memory savings)
- `ParallelIntelligence` - Worker pool parallelization
- `OnnxEmbedder` - ONNX runtime embeddings

### 2.2 @ruvector/core@0.1.30

Native Rust bindings via NAPI with WASM fallback.

**Capabilities:**
- HNSW indexing (150x faster than brute force)
- 4 distance metrics: cosine, euclidean, manhattan, dot
- Memory-mapped storage for large datasets
- Quantization support (4-32x memory reduction)

**Platform Support:**
| Platform | Method | Status |
|----------|--------|--------|
| Linux x64 | NAPI | ✅ Primary |
| macOS x64/ARM | NAPI | ✅ Universal |
| Windows x64 | WASM | ✅ Fallback |

### 2.3 @ruvector/sona@0.1.5

SONA (Self-Organizing Neural Architecture) continual learning system.

**Performance:**
- Micro-LoRA adaptation: ~0.05ms (rank 2)
- Base LoRA updates: ~0.45ms (rank 16)
- Decision throughput: 761 decisions/second
- Memory per adaptation: ~12KB

**Features:**
- EWC++ (Elastic Weight Consolidation)
- Trajectory tracking
- Pattern clustering
- Automatic learning cycle management

### 2.4 @ruvector/attention@0.1.3

Multiple attention mechanism implementations.

**Available Mechanisms:**
| Mechanism | Latency | Use Case |
|-----------|---------|----------|
| Flash Attention | 0.7ms | Real-time, memory efficient |
| Multi-Head | 1.2ms | General purpose |
| Linear | 0.3ms | Long sequences |
| Hyperbolic | 2.1ms | Hierarchical data |
| MoE (Mixture of Experts) | 1.8ms | Expert routing |
| Graph (GraphRoPE) | 5.4ms | Topology-aware |

### 2.5 @ruvector/gnn@0.1.22

Graph Neural Network operations.

**Features:**
- Differentiable search layers
- Hierarchical forward passes
- TensorCompress integration
- Float32Array auto-conversion

---

## 3. agentic-flow@alpha SDK Structure

### 3.1 Package Organization

```
agentic-flow/dist/
├── core/                     # Production wrappers
│   ├── index.js              # Unified exports
│   ├── gnn-wrapper.js        # GNN with 11-22x speedup
│   ├── agentdb-fast.js       # 50-200x faster AgentDB
│   ├── attention-native.js   # Fixed Rust attention
│   ├── attention-fallbacks.js# JS fallbacks
│   └── embedding-service.js  # Multi-provider embeddings
│
├── mcp/                      # MCP Tools
│   └── fastmcp/tools/hooks/
│       ├── index.js          # 19 hook tools export
│       ├── pre-edit.js       # Pre-edit validation
│       ├── post-edit.js      # Post-edit learning
│       ├── route.js          # Intelligent routing
│       ├── pretrain.js       # Pattern pretraining
│       └── intelligence-*.js # RuVector integration
│
├── reasoningbank/            # Memory system
│   ├── index.js              # Hybrid backend
│   ├── HybridBackend.js      # AgentDB + SQLite
│   └── core/                 # Retrieve, judge, distill
│
├── swarm/                    # Swarm coordination
│   ├── index.js              # QUIC swarm init
│   ├── quic-coordinator.js   # QUIC transport
│   └── transport-router.js   # Protocol selection
│
├── coordination/             # Attention coordination
│   └── attention-coordinator.js
│
├── services/                 # Learning services
│   ├── sona-agentdb-integration.js  # SONA + AgentDB
│   └── sona-service.js       # SONA wrapper
│
├── workers/                  # Background workers
│   └── ruvector-integration.js  # Worker learning
│
├── intelligence/             # Persistence
│   └── IntelligenceStore.js  # SQLite storage
│
└── hooks/                    # CLI hooks
    └── swarm-learning-optimizer.js
```

### 3.2 Core Wrappers Performance

The `core/` wrappers provide production-stable alternatives to broken @ruvector/* alpha APIs:

| Wrapper | Raw Package | Speedup | Status |
|---------|-------------|---------|--------|
| `gnn-wrapper.js` | @ruvector/gnn | 11-22x | ✅ Verified |
| `agentdb-fast.js` | agentdb-cli | 50-200x | ✅ Verified |
| `attention-native.js` | @ruvector/attention | Fixed | ✅ Verified |
| `embedding-service.js` | Multiple | N/A | ✅ Verified |

**Usage Pattern:**
```typescript
// ✅ CORRECT: Use agentic-flow wrappers
import {
  differentiableSearch,
  AgentDBFast,
  MultiHeadAttention,
  createEmbeddingService
} from 'agentic-flow/core';

// ❌ WRONG: Don't use raw @ruvector/* packages directly
import { GNN } from '@ruvector/gnn'; // Broken API
```

---

## 4. Learning System Architecture

### 4.1 SONA + AgentDB Integration

The `SONAAgentDBTrainer` class provides unified learning with:

```typescript
// Configuration profiles
const profiles = {
  realtime: { microLoraRank: 2, hnswM: 8 },      // <2ms latency
  balanced: { microLoraRank: 2, hnswM: 16 },     // Speed + quality
  quality: { microLoraRank: 2, hnswM: 32 },      // Max accuracy
  largescale: { patternClusters: 200, hnswM: 16 } // Millions of patterns
};
```

**Training Flow (1.25ms total):**
1. SONA trajectory recording + LoRA adaptation (0.45ms)
2. AgentDB HNSW indexing (0.8ms)

**Query Flow:**
1. AgentDB HNSW search (125x faster)
2. SONA pattern matching (761 decisions/sec)
3. SONA LoRA adaptation (0.45ms)

### 4.2 ReasoningBank Hybrid Backend

Combines SQLite persistence with AgentDB vector search:

```typescript
// Re-exported controllers
export { ReflexionMemory } from 'agentdb/controllers/ReflexionMemory';
export { SkillLibrary } from 'agentdb/controllers/SkillLibrary';
export { CausalMemoryGraph } from 'agentdb/controllers/CausalMemoryGraph';
export { NightlyLearner } from 'agentdb/controllers/NightlyLearner';
```

**Capabilities:**
- Memory retrieval with MMR selection
- Trajectory judgment (success/partial/failure)
- Memory distillation (extract learnings)
- Automatic consolidation scheduling
- PII scrubbing

### 4.3 9 Reinforcement Learning Algorithms

Available through the hooks system:

| Algorithm | Best For |
|-----------|----------|
| Q-Learning | Simple, discrete actions |
| SARSA | Safe exploration |
| DQN | Complex state spaces |
| A2C | Continuous actions |
| PPO | Stable training |
| Actor-Critic | Balanced approach |
| Decision Transformer | Sequence modeling |
| TD3 | Continuous control |
| SAC | Maximum entropy |

---

## 5. Swarm Coordination

### 5.1 QUIC Transport

The swarm system supports QUIC protocol for low-latency coordination:

```typescript
const swarm = await initSwarm({
  swarmId: 'my-swarm',
  topology: 'mesh',      // mesh, hierarchical, ring, star
  transport: 'quic',     // quic, http2, auto
  maxAgents: 10,
  quicPort: 4433
});
```

**Transport Fallback Chain:**
1. QUIC (primary - lowest latency)
2. HTTP/2 (fallback - widely supported)
3. WebSocket (legacy fallback)

### 5.2 Attention-Based Coordination

The `AttentionCoordinator` provides intelligent agent consensus:

```typescript
// Standard consensus with Flash attention
const result = await coordinator.coordinateAgents(agentOutputs, 'flash');

// Expert routing with MoE
const experts = await coordinator.routeToExperts(task, agents, topK);

// Topology-aware coordination
const result = await coordinator.topologyAwareCoordination(
  outputs, 'mesh', graphStructure
);

// Hierarchical with hyperbolic attention
const result = await coordinator.hierarchicalCoordination(
  queenOutputs, workerOutputs, curvature
);
```

### 5.3 Swarm Learning Optimizer

Adaptive swarm configuration based on learned patterns:

```typescript
const optimizer = new SwarmLearningOptimizer(reasoningBank);

// Get optimal configuration for task
const config = await optimizer.getOptimization(
  taskDescription,
  'high',  // complexity: low, medium, high, critical
  8        // estimated agent count
);

// Returns:
// {
//   recommendedTopology: 'hierarchical',
//   recommendedBatchSize: 7,
//   recommendedAgentCount: 8,
//   expectedSpeedup: 3.5,
//   confidence: 0.85,
//   alternatives: [...]
// }
```

---

## 6. Hook System

### 6.1 Available Hooks (19 Total)

**Original Hooks (10):**
| Hook | Purpose |
|------|---------|
| `hookPreEditTool` | Validate edits before execution |
| `hookPostEditTool` | Learn from completed edits |
| `hookPreCommandTool` | Validate commands |
| `hookPostCommandTool` | Learn from command results |
| `hookRouteTool` | Intelligent agent routing |
| `hookExplainTool` | Explain routing decisions |
| `hookPretrainTool` | Pattern pretraining |
| `hookBuildAgentsTool` | Dynamic agent generation |
| `hookMetricsTool` | Performance metrics |
| `hookTransferTool` | Cross-domain transfer |

**Intelligence Bridge Hooks (9):**
| Hook | Purpose |
|------|---------|
| `intelligenceRouteTool` | RuVector-enhanced routing |
| `intelligenceTrajectoryStartTool` | Begin trajectory tracking |
| `intelligenceTrajectoryStepTool` | Record trajectory step |
| `intelligenceTrajectoryEndTool` | Complete trajectory |
| `intelligencePatternStoreTool` | Store learned pattern |
| `intelligencePatternSearchTool` | Search patterns |
| `intelligenceStatsTool` | Intelligence stats |
| `intelligenceLearnTool` | Force learning cycle |
| `intelligenceAttentionTool` | Attention similarity |

### 6.2 Hook Event Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Event                         │
│                   (PreToolUse, etc.)                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Claude-Flow Hook Dispatcher                     │
│         (Maps Claude events → agentic-flow hooks)           │
└─────────────────────┬───────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│  agentic-flow   │     │  Intelligence   │
│  Original Hooks │     │  Bridge Hooks   │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                   RuVector Core                              │
│          (SONA, VectorDB, Attention, GNN)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 7. Intelligence Persistence

### 7.1 IntelligenceStore (SQLite)

Cross-platform persistence using better-sqlite3:

```typescript
// Database location (auto-detected)
// Priority 1: .agentic-flow/intelligence.db (project local)
// Priority 2: ~/.agentic-flow/intelligence.db (home dir)

const store = IntelligenceStore.getInstance();
```

**Schema:**
- `trajectories` - Task execution traces
- `patterns` - Learned patterns with embeddings
- `routings` - Agent routing decisions
- `stats` - Aggregate statistics

**Performance Settings:**
```sql
PRAGMA journal_mode = WAL;      -- Better concurrent access
PRAGMA synchronous = NORMAL;    -- Speed/safety balance
```

### 7.2 RuVectorWorkerIntegration

Background worker integration with full RuVector stack:

```typescript
const integration = new RuVectorWorkerIntegration({
  enableSona: true,
  enableReasoningBank: true,
  enableHnsw: true,
  sonaProfile: 'batch',
  embeddingDim: 384,
  qualityThreshold: 0.6
});

// Start trajectory
const trajectoryId = await integration.startTrajectory(
  workerId, trigger, topic
);

// Record steps
await integration.recordStep(trajectoryId, phase, metrics);

// Complete with learning
const result = await integration.completeTrajectory(trajectoryId, results);
// {
//   qualityScore: 0.85,
//   patternsLearned: 1,
//   sonaAdaptation: true
// }
```

---

## 8. Claude-Flow v3 Integration Strategy

### 8.1 Installation Tiers

**Tier 1: Core (~2MB)**
```bash
npm install claude-flow@3 agentic-flow@alpha
# Includes: hooks, routing, basic learning
```

**Tier 2: Learning (~8MB)**
```bash
npx claude-flow enable-learning
# Adds: SONA, AgentDB, ReasoningBank
```

**Tier 3: Full (~15MB)**
```bash
npx claude-flow enable-swarm
# Adds: QUIC, attention coordination, GNN
```

### 8.2 Integration Layer

Claude-Flow v3 needs a thin integration layer (~500 lines):

```typescript
// src/integrations/agentic-flow.ts

import {
  hookTools,
  allHookTools,
  SONAAgentDBTrainer,
  initSwarm,
  SwarmLearningOptimizer
} from 'agentic-flow';

// 1. Hook event mapping
const HOOK_MAP = {
  'PreToolUse': ['hookPreEditTool', 'hookPreCommandTool'],
  'PostToolUse': ['hookPostEditTool', 'hookPostCommandTool'],
  'TaskStart': ['intelligenceTrajectoryStartTool'],
  'TaskStep': ['intelligenceTrajectoryStepTool'],
  'TaskEnd': ['intelligenceTrajectoryEndTool']
};

// 2. Learning integration
export async function initLearning(profile = 'balanced') {
  const trainer = new SONAAgentDBTrainer(
    SONAAgentDBProfiles[profile]()
  );
  await trainer.initialize();
  return trainer;
}

// 3. Swarm integration
export async function initSwarmCoordination(config) {
  return initSwarm(config);
}
```

### 8.3 CLI Commands

```bash
# Learning
npx claude-flow learn status          # Show learning stats
npx claude-flow learn force           # Force learning cycle
npx claude-flow learn export <path>   # Export learned patterns

# Hooks
npx claude-flow hooks list            # List available hooks
npx claude-flow hooks enable <hook>   # Enable specific hook
npx claude-flow hooks metrics         # Show hook performance

# Swarm
npx claude-flow swarm init <topology> # Initialize swarm
npx claude-flow swarm status          # Show swarm status
npx claude-flow swarm optimize        # Get optimization recommendations
```

---

## 9. Performance Benchmarks

### 9.1 Expected Improvements

| Operation | Before (v2) | After (v3 with agentic-flow) |
|-----------|-------------|------------------------------|
| Agent routing | 50-100ms | 1-5ms (SONA) |
| Pattern search | 100-200ms | 0.8ms (HNSW) |
| Memory retrieval | 50ms | 10-50ms (AgentDB Fast) |
| Swarm coordination | N/A | 0.7-5.4ms (attention) |
| Learning update | N/A | 0.45ms (Micro-LoRA) |

### 9.2 Memory Usage

| Component | Memory |
|-----------|--------|
| Core SDK | ~2MB |
| SONA engine | ~12KB per adaptation |
| AgentDB | ~3KB per pattern |
| HNSW index | ~1MB per 10K vectors |
| IntelligenceStore | Variable (SQLite) |

---

## 10. Recommendations

### 10.1 DO Use

1. **agentic-flow@alpha as primary SDK** - Production wrappers fix alpha issues
2. **Core wrappers** - GNN, AgentDB Fast, Attention Native
3. **SONA + AgentDB integration** - Unified learning with 1.25ms latency
4. **Hook system** - All 19 hooks for comprehensive integration
5. **Swarm learning optimizer** - Adaptive topology selection

### 10.2 DON'T Use

1. **Raw @ruvector/* packages** - Alpha APIs are broken
2. **agentdb-cli** - Use AgentDB Fast instead (50-200x faster)
3. **Custom attention implementations** - Use native wrappers
4. **Manual learning loops** - Use SONAAgentDBTrainer

### 10.3 Future Considerations

1. **HuggingFace export** - Export trained LoRA adapters
2. **Federation** - Multi-node swarm coordination
3. **Custom RL algorithms** - Extend 9-algorithm system
4. **Edge deployment** - WASM-only builds

---

## 11. Claude-Flow v3 Modular Package Constellation

### 11.1 Overview

Claude-Flow v3 will be architected as a **modular constellation of npm packages** similar to the @ruvector/* collection. Each component can operate independently or integrate seamlessly within the ecosystem.

```
                        ┌─────────────────────────┐
                        │    @claude-flow/core    │
                        │   (Central Connector)   │
                        │       ~50KB base        │
                        └───────────┬─────────────┘
                                    │
       ┌────────────┬───────────────┼───────────────┬────────────┐
       │            │               │               │            │
       ▼            ▼               ▼               ▼            ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│  @claude-  │ │  @claude-  │ │  @claude-  │ │  @claude-  │ │  @claude-  │
│   flow/    │ │   flow/    │ │   flow/    │ │   flow/    │ │   flow/    │
│   hooks    │ │  learning  │ │   swarm    │ │   memory   │ │   agents   │
└────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘
       │            │               │               │            │
       ▼            ▼               ▼               ▼            ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│  @claude-  │ │  @claude-  │ │  @claude-  │ │  @claude-  │ │  @claude-  │
│   flow/    │ │   flow/    │ │   flow/    │ │   flow/    │ │   flow/    │
│    mcp     │ │   neural   │ │ attention  │ │   vector   │ │    cli     │
└────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘
```

### 11.2 Package Specifications

#### @claude-flow/core (Central Connector)

**Purpose:** Minimal core that connects all packages, provides unified configuration, and manages inter-package communication.

```typescript
// Package: @claude-flow/core
// Size: ~50KB (no dependencies on other @claude-flow/* packages)

export interface ClaudeFlowConfig {
  enabledModules: string[];
  sharedConfig: SharedConfig;
  eventBus: EventBus;
}

export class ClaudeFlowCore {
  // Module registry
  register(module: ClaudeFlowModule): void;
  unregister(moduleId: string): void;

  // Cross-module communication
  emit(event: string, data: any): void;
  on(event: string, handler: EventHandler): void;

  // Unified configuration
  configure(config: Partial<ClaudeFlowConfig>): void;

  // Module discovery
  getModule<T>(id: string): T | undefined;
  listModules(): ModuleInfo[];
}

// Usage:
import { ClaudeFlowCore } from '@claude-flow/core';
const core = new ClaudeFlowCore();
```

**Key Features:**
- Event bus for inter-module communication
- Shared configuration management
- Module lifecycle management
- Zero dependencies on other @claude-flow/* packages
- Can run standalone for minimal setups

---

#### @claude-flow/hooks

**Purpose:** Claude Code event hooks for pre/post operations with intelligent routing.

```typescript
// Package: @claude-flow/hooks
// Dependencies: @claude-flow/core (optional peer)
// SDK: agentic-flow/hooks

export interface HookConfig {
  enabled: boolean;
  events: ClaudeCodeEvent[];
  learning?: boolean;  // Requires @claude-flow/learning
}

// Standalone usage
import { createHookDispatcher } from '@claude-flow/hooks';
const dispatcher = createHookDispatcher();
dispatcher.register('PreToolUse', preEditHook);

// With core integration
import { ClaudeFlowCore } from '@claude-flow/core';
import { HooksModule } from '@claude-flow/hooks';
core.register(new HooksModule());
```

**Available Hooks:**
| Hook | Event | Purpose |
|------|-------|---------|
| `preEdit` | PreToolUse (Edit) | Validate edits |
| `postEdit` | PostToolUse (Edit) | Learn from edits |
| `preCommand` | PreToolUse (Bash) | Validate commands |
| `postCommand` | PostToolUse (Bash) | Learn from commands |
| `route` | TaskStart | Agent routing |
| `explain` | UserRequest | Explain decisions |
| `pretrain` | SystemInit | Pattern pretraining |
| `buildAgents` | SwarmInit | Dynamic agent creation |
| `metrics` | Any | Performance tracking |
| `transfer` | Any | Cross-domain transfer |

---

#### @claude-flow/learning

**Purpose:** Self-optimizing learning system with multiple RL algorithms.

```typescript
// Package: @claude-flow/learning
// Dependencies: @claude-flow/core (optional peer)
// SDK: agentic-flow (SONA + AgentDB)

export interface LearningConfig {
  algorithm: RLAlgorithm;
  profile: 'realtime' | 'balanced' | 'quality' | 'largescale';
  autoLearn: boolean;
  memoryPath?: string;
}

// Standalone usage
import { createLearningEngine } from '@claude-flow/learning';
const engine = createLearningEngine({ algorithm: 'PPO' });
await engine.train(pattern);
const similar = await engine.query(embedding);

// With core integration
import { LearningModule } from '@claude-flow/learning';
core.register(new LearningModule({ profile: 'balanced' }));
```

**Algorithms (9 Total):**
```typescript
type RLAlgorithm =
  | 'Q-Learning'      // Simple, discrete actions
  | 'SARSA'           // Safe exploration
  | 'DQN'             // Complex state spaces
  | 'A2C'             // Continuous actions
  | 'PPO'             // Stable training
  | 'Actor-Critic'    // Balanced approach
  | 'Decision-Transformer' // Sequence modeling
  | 'TD3'             // Continuous control
  | 'SAC';            // Maximum entropy
```

**Performance Profiles:**
| Profile | LoRA Rank | HNSW M | Latency |
|---------|-----------|--------|---------|
| realtime | 2 | 8 | <2ms |
| balanced | 2 | 16 | ~5ms |
| quality | 2 | 32 | ~10ms |
| largescale | 2 | 16 | ~5ms (millions) |

---

#### @claude-flow/swarm

**Purpose:** Multi-agent swarm coordination with topology support.

```typescript
// Package: @claude-flow/swarm
// Dependencies: @claude-flow/core (optional peer)
// SDK: agentic-flow/swarm

export interface SwarmConfig {
  topology: 'mesh' | 'hierarchical' | 'ring' | 'star' | 'adaptive';
  transport: 'quic' | 'http2' | 'websocket' | 'auto';
  maxAgents: number;
  coordinationMode: 'consensus' | 'voting' | 'attention';
}

// Standalone usage
import { createSwarm } from '@claude-flow/swarm';
const swarm = await createSwarm({
  topology: 'hierarchical',
  maxAgents: 10
});
await swarm.spawnAgent({ type: 'researcher' });

// With core integration
import { SwarmModule } from '@claude-flow/swarm';
core.register(new SwarmModule({ topology: 'mesh' }));
```

**Topology Selection:**
| Topology | Agents | Coordination | Use Case |
|----------|--------|--------------|----------|
| mesh | ≤5 | O(n²) | Small teams, full visibility |
| hierarchical | 6-50 | O(log n) | Large swarms, delegation |
| ring | ≤20 | O(n) | Sequential pipelines |
| star | ≤30 | O(n) | Central coordinator |
| adaptive | any | dynamic | Auto-selects based on load |

---

#### @claude-flow/memory

**Purpose:** Persistent memory and pattern storage.

```typescript
// Package: @claude-flow/memory
// Dependencies: @claude-flow/core (optional peer)
// SDK: agentic-flow/reasoningbank

export interface MemoryConfig {
  backend: 'sqlite' | 'agentdb' | 'hybrid';
  path?: string;
  maxPatterns?: number;
  consolidationInterval?: number;
}

// Standalone usage
import { createMemoryStore } from '@claude-flow/memory';
const memory = createMemoryStore({ backend: 'hybrid' });
await memory.store('task/123', pattern);
const similar = await memory.retrieve('code review', { k: 5 });

// With core integration
import { MemoryModule } from '@claude-flow/memory';
core.register(new MemoryModule());
```

**Features:**
- Trajectory storage
- Pattern retrieval with MMR
- Automatic consolidation
- PII scrubbing
- Cross-session persistence

---

#### @claude-flow/agents

**Purpose:** Agent definitions and dynamic agent generation.

```typescript
// Package: @claude-flow/agents
// Dependencies: @claude-flow/core (optional peer)

export interface AgentDefinition {
  id: string;
  type: AgentType;
  capabilities: string[];
  systemPrompt: string;
  tools?: Tool[];
}

// Standalone usage
import { defineAgent, loadAgents } from '@claude-flow/agents';
const researcher = defineAgent({
  type: 'researcher',
  capabilities: ['web-search', 'code-analysis']
});

// With core integration
import { AgentsModule } from '@claude-flow/agents';
core.register(new AgentsModule());
```

**Built-in Agent Types (54+):**
- Core: coder, reviewer, tester, planner, researcher
- Swarm: hierarchical-coordinator, mesh-coordinator
- Consensus: byzantine, raft, gossip, quorum
- GitHub: pr-manager, issue-tracker, code-review
- SPARC: specification, pseudocode, architecture

---

#### @claude-flow/mcp

**Purpose:** MCP server and tool definitions.

```typescript
// Package: @claude-flow/mcp
// Dependencies: @claude-flow/core (optional peer)

export interface MCPConfig {
  servers: MCPServerConfig[];
  autoStart?: boolean;
  port?: number;
}

// Standalone usage
import { startMCPServer } from '@claude-flow/mcp';
const server = await startMCPServer({
  tools: ['swarm_init', 'agent_spawn', 'task_orchestrate']
});

// With core integration
import { MCPModule } from '@claude-flow/mcp';
core.register(new MCPModule());
```

**MCP Tool Categories:**
- Coordination: swarm_init, agent_spawn, task_orchestrate
- Monitoring: swarm_status, agent_metrics, task_status
- Memory: memory_store, memory_retrieve, memory_consolidate
- Neural: neural_train, neural_patterns, neural_export
- GitHub: repo_analyze, pr_enhance, issue_triage

---

#### @claude-flow/neural

**Purpose:** Neural network operations and attention mechanisms.

```typescript
// Package: @claude-flow/neural
// Dependencies: @claude-flow/core (optional peer)
// SDK: @ruvector/attention, @ruvector/gnn

export interface NeuralConfig {
  attention: AttentionMechanism;
  embeddingDim: number;
  useGPU?: boolean;
}

// Standalone usage
import { createAttentionService } from '@claude-flow/neural';
const attention = createAttentionService({ mechanism: 'flash' });
const result = await attention.compute(Q, K, V);

// With core integration
import { NeuralModule } from '@claude-flow/neural';
core.register(new NeuralModule());
```

**Attention Mechanisms:**
| Mechanism | Latency | Memory | Use Case |
|-----------|---------|--------|----------|
| flash | 0.7ms | Low | Real-time |
| multi-head | 1.2ms | Medium | General |
| linear | 0.3ms | Low | Long sequences |
| hyperbolic | 2.1ms | Medium | Hierarchical |
| moe | 1.8ms | High | Expert routing |
| graph-rope | 5.4ms | High | Topology |

---

#### @claude-flow/attention

**Purpose:** Attention-based agent coordination and consensus.

```typescript
// Package: @claude-flow/attention
// Dependencies: @claude-flow/core, @claude-flow/neural (optional peers)

export interface AttentionCoordinatorConfig {
  mechanism: AttentionMechanism;
  consensusThreshold?: number;
}

// Standalone usage
import { createAttentionCoordinator } from '@claude-flow/attention';
const coordinator = createAttentionCoordinator({ mechanism: 'flash' });
const consensus = await coordinator.coordinateAgents(outputs);

// With core integration
import { AttentionModule } from '@claude-flow/attention';
core.register(new AttentionModule());
```

---

#### @claude-flow/vector

**Purpose:** Vector database operations with HNSW indexing.

```typescript
// Package: @claude-flow/vector
// Dependencies: @claude-flow/core (optional peer)
// SDK: @ruvector/core, agentdb

export interface VectorConfig {
  dimensions: number;
  metric: 'cosine' | 'euclidean' | 'dot';
  hnswM?: number;
  efConstruction?: number;
}

// Standalone usage
import { createVectorStore } from '@claude-flow/vector';
const vectors = createVectorStore({ dimensions: 384 });
await vectors.add('id', embedding, metadata);
const results = await vectors.search(query, { k: 5 });

// With core integration
import { VectorModule } from '@claude-flow/vector';
core.register(new VectorModule());
```

**Performance:**
- HNSW indexing: 150x faster than brute force
- Quantization: 4-32x memory reduction
- Batch operations: 10K vectors/second

---

#### @claude-flow/cli

**Purpose:** Command-line interface for all modules.

```typescript
// Package: @claude-flow/cli
// Dependencies: All @claude-flow/* packages (optional peers)

// Commands auto-detect installed modules
```

**Commands:**
```bash
# Core
npx @claude-flow/cli init           # Initialize project
npx @claude-flow/cli status         # Show module status
npx @claude-flow/cli config         # Configure modules

# Hooks (if @claude-flow/hooks installed)
npx @claude-flow/cli hooks list
npx @claude-flow/cli hooks enable <hook>

# Learning (if @claude-flow/learning installed)
npx @claude-flow/cli learn status
npx @claude-flow/cli learn train <patterns>
npx @claude-flow/cli learn export

# Swarm (if @claude-flow/swarm installed)
npx @claude-flow/cli swarm init <topology>
npx @claude-flow/cli swarm spawn <type>
npx @claude-flow/cli swarm status

# Memory (if @claude-flow/memory installed)
npx @claude-flow/cli memory stats
npx @claude-flow/cli memory consolidate

# MCP (if @claude-flow/mcp installed)
npx @claude-flow/cli mcp start
npx @claude-flow/cli mcp list-tools
```

---

### 11.3 Package Dependency Matrix

```
                 core  hooks  learn  swarm  memory  agents  mcp  neural  attn  vector  cli
@claude-flow/
  core            -     -      -      -      -       -      -     -       -     -      -
  hooks           P     -      P      -      P       -      -     -       -     -      -
  learning        P     -      -      -      P       -      -     P       -     P      -
  swarm           P     -      P      -      -       P      -     -       P     -      -
  memory          P     -      -      -      -       -      -     -       -     P      -
  agents          P     -      -      -      -       -      -     -       -     -      -
  mcp             P     P      P      P      P       P      -     P       P     P      -
  neural          P     -      -      -      -       -      -     -       -     -      -
  attention       P     -      -      -      -       -      -     P       -     -      -
  vector          P     -      -      -      -       -      -     -       -     -      -
  cli             P     P      P      P      P       P      P     P       P     P      -

P = Optional peer dependency (enhances features when present)
- = No dependency
```

### 11.4 Installation Combinations

#### Minimal (Core Only)
```bash
npm install @claude-flow/core
# 50KB, event bus and configuration only
```

#### Hooks Only
```bash
npm install @claude-flow/hooks
# Works standalone, no core required
# 200KB, Claude Code hook integration
```

#### Learning Stack
```bash
npm install @claude-flow/core @claude-flow/learning @claude-flow/memory @claude-flow/vector
# 3MB, full learning system
```

#### Swarm Stack
```bash
npm install @claude-flow/core @claude-flow/swarm @claude-flow/agents @claude-flow/attention
# 4MB, multi-agent coordination
```

#### Full Installation
```bash
npm install claude-flow
# Meta-package that includes all @claude-flow/* packages
# 15MB, everything included
```

#### Mix and Match Examples
```bash
# Hooks + Learning (self-optimizing hooks)
npm install @claude-flow/hooks @claude-flow/learning

# Swarm + Memory (persistent swarm state)
npm install @claude-flow/swarm @claude-flow/memory

# Neural + Vector (embeddings + search)
npm install @claude-flow/neural @claude-flow/vector

# CLI with specific modules
npm install @claude-flow/cli @claude-flow/hooks @claude-flow/swarm
```

### 11.5 Module Communication Protocol

All modules communicate through the core event bus:

```typescript
// Event types
interface ModuleEvents {
  // Lifecycle
  'module:registered': { moduleId: string; version: string };
  'module:unregistered': { moduleId: string };

  // Hooks
  'hook:triggered': { hookId: string; event: string; data: any };
  'hook:completed': { hookId: string; result: any };

  // Learning
  'learning:pattern-stored': { patternId: string; quality: number };
  'learning:cycle-complete': { patterns: number; improvements: number };

  // Swarm
  'swarm:agent-spawned': { agentId: string; type: string };
  'swarm:task-assigned': { taskId: string; agentId: string };
  'swarm:consensus-reached': { result: any; confidence: number };

  // Memory
  'memory:stored': { key: string; type: string };
  'memory:retrieved': { key: string; similarity: number };
  'memory:consolidated': { patterns: number };
}

// Cross-module communication example
// @claude-flow/hooks emits, @claude-flow/learning listens
core.on('hook:completed', async (data) => {
  if (data.hookId === 'postEdit') {
    await learningModule.train({
      task: data.result.task,
      outcome: data.result.success,
      embedding: data.result.embedding
    });
  }
});
```

### 11.6 SDK Mapping to Packages

Each @claude-flow/* package maps to specific agentic-flow SDK components:

| @claude-flow/* | agentic-flow SDK |
|----------------|------------------|
| hooks | `agentic-flow/hooks`, `agentic-flow/mcp/fastmcp/tools/hooks` |
| learning | `agentic-flow/services/sona-agentdb-integration`, `agentic-flow/hooks/swarm-learning-optimizer` |
| swarm | `agentic-flow/swarm`, `agentic-flow/coordination` |
| memory | `agentic-flow/reasoningbank`, `agentic-flow/intelligence/IntelligenceStore` |
| agents | `agentic-flow/agents` |
| mcp | `agentic-flow/mcp` |
| neural | `@ruvector/attention`, `@ruvector/gnn`, `agentic-flow/core` |
| attention | `agentic-flow/coordination/attention-coordinator` |
| vector | `@ruvector/core`, `agentic-flow/core/agentdb-fast` |
| cli | `agentic-flow/cli` |

### 11.7 Version Compatibility Matrix

```
@claude-flow/*  | agentic-flow | @ruvector/* | Node.js
----------------|--------------|-------------|--------
3.0.x           | 2.0.x-alpha  | 0.1.x       | ≥18.x
3.1.x           | 2.1.x-alpha  | 0.2.x       | ≥18.x
```

### 11.8 Standalone vs Integrated Usage

**Standalone (No Core):**
```typescript
// Each package works independently
import { createHookDispatcher } from '@claude-flow/hooks';
import { createLearningEngine } from '@claude-flow/learning';
import { createSwarm } from '@claude-flow/swarm';

// Manual coordination required
const dispatcher = createHookDispatcher();
const engine = createLearningEngine();

dispatcher.on('postEdit', async (data) => {
  // Manual integration
  await engine.train(data);
});
```

**Integrated (With Core):**
```typescript
// Automatic cross-module communication
import { ClaudeFlowCore } from '@claude-flow/core';
import { HooksModule } from '@claude-flow/hooks';
import { LearningModule } from '@claude-flow/learning';
import { SwarmModule } from '@claude-flow/swarm';

const core = new ClaudeFlowCore();
core.register(new HooksModule());
core.register(new LearningModule());
core.register(new SwarmModule());

// Automatic event routing between modules
// Hooks → Learning: postEdit events trigger training
// Learning → Memory: patterns stored automatically
// Swarm → Attention: coordination uses attention mechanisms
```

---

## 12. Conclusion

### 12.1 SDK Foundation

**agentic-flow@alpha provides everything Claude-Flow v3 needs:**

- ✅ 19 hook tools for comprehensive integration
- ✅ 9 RL algorithms for adaptive learning
- ✅ Production wrappers fixing alpha issues
- ✅ SONA + AgentDB with 1.25ms training latency
- ✅ QUIC swarm coordination with attention mechanisms
- ✅ Cross-platform SQLite persistence
- ✅ Modular installation tiers

### 12.2 Modular Package Architecture

**Claude-Flow v3 will be a modular constellation of 10 npm packages:**

| Package | Purpose | Size | Standalone |
|---------|---------|------|------------|
| `@claude-flow/core` | Central connector | ~50KB | ✅ |
| `@claude-flow/hooks` | Claude Code events | ~200KB | ✅ |
| `@claude-flow/learning` | Self-optimization | ~2MB | ✅ |
| `@claude-flow/swarm` | Multi-agent coordination | ~1MB | ✅ |
| `@claude-flow/memory` | Persistent storage | ~500KB | ✅ |
| `@claude-flow/agents` | Agent definitions | ~300KB | ✅ |
| `@claude-flow/mcp` | MCP server/tools | ~400KB | ✅ |
| `@claude-flow/neural` | Neural operations | ~1MB | ✅ |
| `@claude-flow/attention` | Agent consensus | ~200KB | ✅ |
| `@claude-flow/vector` | HNSW search | ~800KB | ✅ |
| `@claude-flow/cli` | CLI interface | ~100KB | ❌ |

### 12.3 Key Architectural Decisions

1. **Use agentic-flow@alpha as underlying SDK** - Don't reinvent, wrap
2. **Optional peer dependencies** - Packages work alone or together
3. **Event-driven communication** - Core provides event bus
4. **Progressive enhancement** - More packages = more features
5. **NOT directly import @ruvector/*** - Use agentic-flow wrappers

### 12.4 Implementation Roadmap

**Phase 1: Core Packages**
- `@claude-flow/core` - Event bus, configuration, module registry
- `@claude-flow/hooks` - Claude Code event mapping
- `@claude-flow/cli` - Basic CLI with init/status

**Phase 2: Learning Stack**
- `@claude-flow/learning` - SONA + AgentDB integration
- `@claude-flow/memory` - ReasoningBank wrapper
- `@claude-flow/vector` - HNSW indexing

**Phase 3: Swarm Stack**
- `@claude-flow/swarm` - QUIC coordination
- `@claude-flow/agents` - Agent definitions
- `@claude-flow/attention` - Consensus mechanisms

**Phase 4: Neural Stack**
- `@claude-flow/neural` - Attention mechanisms
- `@claude-flow/mcp` - Full MCP server

### 12.5 Final Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         claude-flow (meta-package)                       │
│                      npm install claude-flow@3                           │
├─────────────────────────────────────────────────────────────────────────┤
│  @claude-flow/*                                                          │
│  ┌───────┬─────────┬───────┬────────┬────────┬──────┬──────┬─────────┐ │
│  │ core  │  hooks  │ learn │ swarm  │ memory │agents│ mcp  │ neural  │ │
│  └───────┴─────────┴───────┴────────┴────────┴──────┴──────┴─────────┘ │
├─────────────────────────────────────────────────────────────────────────┤
│                    agentic-flow@2.0.1-alpha (SDK)                        │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ hooks │ swarm │ reasoningbank │ coordination │ services │ workers │ │
│  └────────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────┤
│                       @ruvector/* (underlying)                           │
│  ┌───────────────┬────────────────┬─────────────────┬─────────────────┐ │
│  │ @ruvector/core│ @ruvector/sona │ @ruvector/attn  │ @ruvector/gnn   │ │
│  │   (HNSW)      │   (LoRA)       │   (Attention)   │   (GNN)         │ │
│  └───────────────┴────────────────┴─────────────────┴─────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

This modular architecture enables:
- **Mix and match** - Use only what you need
- **Independent operation** - Each package works alone
- **Seamless integration** - Core connects everything
- **Progressive enhancement** - Add capabilities incrementally
- **Lightweight installs** - From 50KB (core) to 15MB (full)

---

*Document Version: 1.0.0*
*Last Updated: 2026-01-03*
*Based on: agentic-flow@2.0.1-alpha.50, ruvector@0.1.95*
