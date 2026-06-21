---
name: embeddings
description: >
  Vector embeddings with HNSW indexing, sql.js persistence, and hyperbolic support. Fast local embeddings with hive-flow integration.
  Use when: semantic search, pattern matching, similarity queries, knowledge retrieval.
  Skip when: exact text matching, simple lookups, no semantic understanding needed.
---

# Embeddings Skill

## Purpose
Vector embeddings for semantic search and pattern matching with HNSW indexing.

## Features

| Feature | Description |
|---------|-------------|
| **sql.js** | Cross-platform SQLite persistent cache (WASM) |
| **HNSW** | fast HNSW-indexed search |
| **Hyperbolic** | Poincare ball model for hierarchical data |
| **Normalization** | L2, L1, min-max, z-score |
| **Chunking** | Configurable overlap and size |
| **Local ONNX embeddings** | With hive-flow ONNX integration |

## Commands

### Initialize Embeddings
```bash
hive-flow embeddings init --backend sqlite
```

### Embed Text
```bash
hive-flow embeddings embed --text "authentication patterns"
```

### Batch Embed
```bash
hive-flow embeddings batch --file documents.json
```

### Semantic Search
```bash
hive-flow embeddings search --query "security best practices" --top-k 5
```

## Memory Integration

```bash
# Store with embeddings
hive-flow memory store --key "pattern-1" --value "description" --embed

# Search with embeddings
hive-flow memory search --query "related patterns" --semantic
```

## Quantization

| Type | Memory Usage | Speed |
|------|--------------|-------|
| Int8 | Lower | Fast |
| Int4 | Lower | Fast |
| Binary | Lowest | Fast |

## Best Practices
1. Use HNSW for large pattern databases
2. Enable quantization for memory efficiency
3. Use hyperbolic for hierarchical relationships
4. Normalize embeddings for consistency
