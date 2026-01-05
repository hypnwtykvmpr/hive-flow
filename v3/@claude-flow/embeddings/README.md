# @claude-flow/embeddings

Embedding generation and management module for Claude-Flow V3.

## Overview

This module provides embedding generation, caching, and management for semantic search and memory systems.

## Features

- **Multiple Providers**: OpenAI, Anthropic, local models
- **Caching**: LRU cache for frequently used embeddings
- **Batch Processing**: Efficient batch embedding generation
- **Dimensionality**: Support for various embedding dimensions

## Installation

```bash
npm install @claude-flow/embeddings
```

## Usage

```typescript
import { EmbeddingService } from '@claude-flow/embeddings';

const embeddings = new EmbeddingService({
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
});

// Generate embedding
const vector = await embeddings.embed('Hello world');

// Batch embed
const vectors = await embeddings.embedBatch([
  'First text',
  'Second text',
  'Third text',
]);

// Calculate similarity
const similarity = embeddings.cosineSimilarity(vector1, vector2);
```

## API Reference

### EmbeddingService

Main class for embedding operations.

#### Methods

- `embed(text: string)` - Generate embedding for text
- `embedBatch(texts: string[])` - Batch embedding generation
- `cosineSimilarity(a, b)` - Calculate similarity score

## Configuration

```typescript
interface EmbeddingConfig {
  provider: 'openai' | 'anthropic' | 'local';
  model?: string;
  dimensions?: number;
  cacheEnabled?: boolean;
  cacheSize?: number;
}
```

## Supported Providers

| Provider | Models | Dimensions |
|----------|--------|------------|
| OpenAI | text-embedding-3-small/large | 1536/3072 |
| Anthropic | claude-embed | 1024 |
| Local | sentence-transformers | 384-768 |

## License

MIT
