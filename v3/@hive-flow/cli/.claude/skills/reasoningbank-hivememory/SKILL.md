---
name: "ReasoningBank with HiveMemory"
description: "Implement ReasoningBank adaptive learning with HiveMemory's fast vector database. Includes trajectory tracking, verdict judgment, memory distillation, and pattern recognition. Use when building self-learning agents, optimizing decision-making, or implementing experience replay systems."
---

# ReasoningBank with HiveMemory

## What This Skill Does

Provides ReasoningBank adaptive learning patterns using HiveMemory's high-performance backend (fast HNSW-indexed). Enables agents to learn from experiences, judge outcomes, distill memories, and improve decision-making over time with 100% backward compatibility.

**Performance**: fast pattern retrieval, high-throughput batch operations, <1ms memory access.

## Prerequisites

- Node.js 18+
- HiveMemory v1.0.7+ (via hive-flow)
- Understanding of reinforcement learning concepts (optional)

---

## Quick Start with CLI

### Initialize ReasoningBank Database

```bash
# Initialize HiveMemory for ReasoningBank
npx hivememory@latest init ./.hivememory/reasoningbank.db --dimension 1536

# Start MCP server for Claude Code integration
npx hivememory@latest mcp
claude mcp add hivememory npx hivememory@latest mcp
```

### Migrate from Legacy ReasoningBank

```bash
# Automatic migration with validation
npx hivememory@latest migrate --source .swarm/memory.db

# Verify migration
npx hivememory@latest stats ./.hivememory/reasoningbank.db
```

---

## Quick Start with API

```typescript
import { createHiveMemoryAdapter, computeEmbedding } from 'hive-flow/reasoningbank';

// Initialize ReasoningBank with HiveMemory
const rb = await createHiveMemoryAdapter({
  dbPath: '.hivememory/reasoningbank.db',
  enableLearning: true,      // Enable learning plugins
  enableReasoning: true,      // Enable reasoning agents
  cacheSize: 1000,            // 1000 pattern cache
});

// Store successful experience
const query = "How to optimize database queries?";
const embedding = await computeEmbedding(query);

await rb.insertPattern({
  id: '',
  type: 'experience',
  domain: 'database-optimization',
  pattern_data: JSON.stringify({
    embedding,
    pattern: {
      query,
      approach: 'indexing + query optimization',
      outcome: 'success',
      metrics: { latency_reduction: 0.85 }
    }
  }),
  confidence: 0.95,
  usage_count: 1,
  success_count: 1,
  created_at: Date.now(),
  last_used: Date.now(),
});

// Retrieve similar experiences with reasoning
const result = await rb.retrieveWithReasoning(embedding, {
  domain: 'database-optimization',
  k: 5,
  useMMR: true,              // Diverse results
  synthesizeContext: true,    // Rich context synthesis
});

console.log('Memories:', result.memories);
console.log('Context:', result.context);
console.log('Patterns:', result.patterns);
```

---

## Core ReasoningBank Concepts

### 1. Trajectory Tracking

Track agent execution paths and outcomes:

```typescript
// Record trajectory (sequence of actions)
const trajectory = {
  task: 'optimize-api-endpoint',
  steps: [
    { action: 'analyze-bottleneck', result: 'found N+1 query' },
    { action: 'add-eager-loading', result: 'reduced queries' },
    { action: 'add-caching', result: 'improved latency' }
  ],
  outcome: 'success',
  metrics: { latency_before: 2500, latency_after: 150 }
};

const embedding = await computeEmbedding(JSON.stringify(trajectory));

await rb.insertPattern({
  id: '',
  type: 'trajectory',
  domain: 'api-optimization',
  pattern_data: JSON.stringify({ embedding, pattern: trajectory }),
  confidence: 0.9,
  usage_count: 1,
  success_count: 1,
  created_at: Date.now(),
  last_used: Date.now(),
});
```

### 2. Verdict Judgment

Judge whether a trajectory was successful:

```typescript
// Retrieve similar past trajectories
const similar = await rb.retrieveWithReasoning(queryEmbedding, {
  domain: 'api-optimization',
  k: 10,
});

// Judge based on similarity to successful patterns
const verdict = similar.memories.filter(m =>
  m.pattern.outcome === 'success' &&
  m.similarity > 0.8
).length > 5 ? 'likely_success' : 'needs_review';

console.log('Verdict:', verdict);
console.log('Confidence:', similar.memories[0]?.similarity || 0);
```

### 3. Memory Distillation

Consolidate similar experiences into patterns:

```typescript
// Get all experiences in domain
const experiences = await rb.retrieveWithReasoning(embedding, {
  domain: 'api-optimization',
  k: 100,
  optimizeMemory: true,  // Automatic consolidation
});

// Distill into high-level pattern
const distilledPattern = {
  domain: 'api-optimization',
  pattern: 'For N+1 queries: add eager loading, then cache',
  success_rate: 0.92,
  sample_size: experiences.memories.length,
  confidence: 0.95
};

await rb.insertPattern({
  id: '',
  type: 'distilled-pattern',
  domain: 'api-optimization',
  pattern_data: JSON.stringify({
    embedding: await computeEmbedding(JSON.stringify(distilledPattern)),
    pattern: distilledPattern
  }),
  confidence: 0.95,
  usage_count: 0,
  success_count: 0,
  created_at: Date.now(),
  last_used: Date.now(),
});
```

---

## Integration with Reasoning Agents

HiveMemory provides 4 reasoning modules that enhance ReasoningBank:

### 1. PatternMatcher

Find similar successful patterns:

```typescript
const result = await rb.retrieveWithReasoning(queryEmbedding, {
  domain: 'problem-solving',
  k: 10,
  useMMR: true,  // Maximal Marginal Relevance for diversity
});

// PatternMatcher returns diverse, relevant memories
result.memories.forEach(mem => {
  console.log(`Pattern: ${mem.pattern.approach}`);
  console.log(`Similarity: ${mem.similarity}`);
  console.log(`Success Rate: ${mem.success_count / mem.usage_count}`);
});
```

### 2. ContextSynthesizer

Generate rich context from multiple memories:

```typescript
const result = await rb.retrieveWithReasoning(queryEmbedding, {
  domain: 'code-optimization',
  synthesizeContext: true,  // Enable context synthesis
  k: 5,
});

// ContextSynthesizer creates coherent narrative
console.log('Synthesized Context:', result.context);
// "Based on 5 similar optimizations, the most effective approach
//  involves profiling, identifying bottlenecks, and applying targeted
//  improvements. Success rate: 87%"
```

### 3. MemoryOptimizer

Automatically consolidate and prune:

```typescript
const result = await rb.retrieveWithReasoning(queryEmbedding, {
  domain: 'testing',
  optimizeMemory: true,  // Enable automatic optimization
});

// MemoryOptimizer consolidates similar patterns and prunes low-quality
console.log('Optimizations:', result.optimizations);
// { consolidated: 15, pruned: 3, improved_quality: 0.12 }
```

### 4. ExperienceCurator

Filter by quality and relevance:

```typescript
const result = await rb.retrieveWithReasoning(queryEmbedding, {
  domain: 'debugging',
  k: 20,
  minConfidence: 0.8,  // Only high-confidence experiences
});

// ExperienceCurator returns only quality experiences
result.memories.forEach(mem => {
  console.log(`Confidence: ${mem.confidence}`);
  console.log(`Success Rate: ${mem.success_count / mem.usage_count}`);
});
```

---

## Legacy API Compatibility

HiveMemory maintains 100% backward compatibility with legacy ReasoningBank:

```typescript
import {
  retrieveMemories,
  judgeTrajectory,
  distillMemories
} from 'hive-flow/reasoningbank';

// Legacy API works unchanged (uses HiveMemory backend automatically)
const memories = await retrieveMemories(query, {
  domain: 'code-generation',
  agent: 'coder'
});

const verdict = await judgeTrajectory(trajectory, query);

const newMemories = await distillMemories(
  trajectory,
  verdict,
  query,
  { domain: 'code-generation' }
);
```

---

## Performance Characteristics

- **Pattern Search**: fast (100µs vs 15ms)
- **Memory Retrieval**: <1ms (with cache)
- **Batch Insert**: substantially faster (2ms vs 1s for 100 patterns)
- **Trajectory Judgment**: <5ms (including retrieval + analysis)
- **Memory Distillation**: <50ms (consolidate 100 patterns)

---

## Advanced Patterns

### Hierarchical Memory

Organize memories by abstraction level:

```typescript
// Low-level: Specific implementation
await rb.insertPattern({
  type: 'concrete',
  domain: 'debugging/null-pointer',
  pattern_data: JSON.stringify({
    embedding,
    pattern: { bug: 'NPE in UserService.getUser()', fix: 'Add null check' }
  }),
  confidence: 0.9,
  // ...
});

// Mid-level: Pattern across similar cases
await rb.insertPattern({
  type: 'pattern',
  domain: 'debugging',
  pattern_data: JSON.stringify({
    embedding,
    pattern: { category: 'null-pointer', approach: 'defensive-checks' }
  }),
  confidence: 0.85,
  // ...
});

// High-level: General principle
await rb.insertPattern({
  type: 'principle',
  domain: 'software-engineering',
  pattern_data: JSON.stringify({
    embedding,
    pattern: { principle: 'fail-fast with clear errors' }
  }),
  confidence: 0.95,
  // ...
});
```

### Multi-Domain Learning

Transfer learning across domains:

```typescript
// Learn from backend optimization
const backendExperience = await rb.retrieveWithReasoning(embedding, {
  domain: 'backend-optimization',
  k: 10,
});

// Apply to frontend optimization
const transferredKnowledge = backendExperience.memories.map(mem => ({
  ...mem,
  domain: 'frontend-optimization',
  adapted: true,
}));
```

---

## CLI Operations

### Database Management

```bash
# Export trajectories and patterns
npx hivememory@latest export ./.hivememory/reasoningbank.db ./backup.json

# Import experiences
npx hivememory@latest import ./experiences.json

# Get statistics
npx hivememory@latest stats ./.hivememory/reasoningbank.db
# Shows: total patterns, domains, confidence distribution
```

### Migration

```bash
# Migrate from legacy ReasoningBank
npx hivememory@latest migrate --source .swarm/memory.db --target .hivememory/reasoningbank.db

# Validate migration
npx hivememory@latest stats .hivememory/reasoningbank.db
```

---

## Troubleshooting

### Issue: Migration fails
```bash
# Check source database exists
ls -la .swarm/memory.db

# Run with verbose logging
DEBUG=hivememory:* npx hivememory@latest migrate --source .swarm/memory.db
```

### Issue: Low confidence scores
```typescript
// Enable context synthesis for better quality
const result = await rb.retrieveWithReasoning(embedding, {
  synthesizeContext: true,
  useMMR: true,
  k: 10,
});
```

### Issue: Memory growing too large
```typescript
// Enable automatic optimization
const result = await rb.retrieveWithReasoning(embedding, {
  optimizeMemory: true,  // Consolidates similar patterns
});

// Or manually optimize
await rb.optimize();
```

---

## Learn More

- **HiveMemory Integration**: node_modules/hive-flow/docs/HIVEMEMORY_INTEGRATION.md
- **MCP Integration**: `npx hivememory@latest mcp`

---

**Category**: Machine Learning / Reinforcement Learning
**Difficulty**: Intermediate
**Estimated Time**: 20-30 minutes
