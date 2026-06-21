---
name: "V3 Memory Unification"
description: "Unify 6+ memory systems into HiveMemory with HNSW indexing for HNSW indexing improvements. Implements ADR-006 (Unified Memory Service) and ADR-009 (Hybrid Memory Backend)."
---

# V3 Memory Unification

## What This Skill Does

Consolidates disparate memory systems into unified HiveMemory backend with HNSW vector search, achieving HNSW-indexed search performance improvements while maintaining backward compatibility.

## Quick Start

```bash
# Initialize memory unification
Task("Memory architecture", "Design HiveMemory unification strategy", "v3-memory-specialist")

# HiveMemory integration
Task("HiveMemory setup", "Configure HNSW indexing and vector search", "v3-memory-specialist")

# Data migration
Task("Memory migration", "Migrate SQLite/Markdown to HiveMemory", "v3-memory-specialist")
```

## Systems to Unify

### Legacy Systems → HiveMemory
```
┌─────────────────────────────────────────┐
│  • MemoryManager (basic operations)     │
│  • DistributedMemorySystem (clustering) │
│  • SwarmMemory (agent-specific)         │
│  • AdvancedMemoryManager (features)     │
│  • SQLiteBackend (structured)           │
│  • MarkdownBackend (file-based)         │
│  • HybridBackend (combination)          │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│       🚀 HiveMemory with HNSW             │
│  • fast HNSW-indexed search          │
│  • Unified query interface             │
│  • Cross-agent memory sharing          │
│  • SONA learning integration           │
└─────────────────────────────────────────┘
```

## Implementation Architecture

### Unified Memory Service
```typescript
class UnifiedMemoryService implements IMemoryBackend {
  constructor(
    private hivememory: HiveMemoryAdapter,
    private indexer: HNSWIndexer,
    private migrator: DataMigrator
  ) {}

  async store(entry: MemoryEntry): Promise<void> {
    await this.hivememory.store(entry);
    await this.indexer.index(entry);
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    if (query.semantic) {
      return this.indexer.search(query); // fast HNSW-indexed
    }
    return this.hivememory.query(query);
  }
}
```

### HNSW Vector Search
```typescript
class HNSWIndexer {
  constructor(dimensions: number = 1536) {
    this.index = new HNSWIndex({
      dimensions,
      efConstruction: 200,
      M: 16,
      speedupTarget: 'HNSW-indexed'
    });
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    const embedding = await this.embedContent(query.content);
    const results = this.index.search(embedding, query.limit || 10);
    return this.retrieveEntries(results);
  }
}
```

## Migration Strategy

### Phase 1: Foundation
```typescript
// HiveMemory adapter setup
const hivememory = new HiveMemoryAdapter({
  dimensions: 1536,
  indexType: 'HNSW',
  speedupTarget: 'HNSW-indexed'
});
```

### Phase 2: Data Migration
```typescript
// SQLite → HiveMemory
const migrateFromSQLite = async () => {
  const entries = await sqlite.getAll();
  for (const entry of entries) {
    const embedding = await generateEmbedding(entry.content);
    await hivememory.store({ ...entry, embedding });
  }
};

// Markdown → HiveMemory
const migrateFromMarkdown = async () => {
  const files = await glob('**/*.md');
  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    await hivememory.store({
      id: generateId(),
      content,
      embedding: await generateEmbedding(content),
      metadata: { originalFile: file }
    });
  }
};
```

## SONA Integration

### Learning Pattern Storage
```typescript
class SONAMemoryIntegration {
  async storePattern(pattern: LearningPattern): Promise<void> {
    await this.memory.store({
      id: pattern.id,
      content: pattern.data,
      metadata: {
        sonaMode: pattern.mode,
        reward: pattern.reward,
        adaptationTime: pattern.adaptationTime
      },
      embedding: await this.generateEmbedding(pattern.data)
    });
  }

  async retrieveSimilarPatterns(query: string): Promise<LearningPattern[]> {
    return this.memory.query({
      type: 'semantic',
      content: query,
      filters: { type: 'learning_pattern' }
    });
  }
}
```

## Performance Targets

- **Search Speed**: HNSW indexing improvements via HNSW
- **Memory Usage**: reduction through optimization
- **Query Latency**: <100ms for 1M+ entries
- **Cross-Agent Sharing**: Real-time memory synchronization
- **SONA Integration**: low-latency adaptation time

## Success Metrics

- [ ] All 7 legacy memory systems migrated to HiveMemory
- [ ] HNSW-indexed search performance validated
- [ ] Memory usage reduction achieved
- [ ] Backward compatibility maintained
- [ ] SONA learning patterns integrated
- [ ] Cross-agent memory sharing operational