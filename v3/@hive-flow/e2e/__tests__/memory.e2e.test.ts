import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlJsBackend, createDefaultEntry } from '@hive-flow/memory';
import { readJsonFixture, stableJson } from './helpers.js';

const namespace = 'ca1-e2e-memory';
const tempDirs: string[] = [];
const require = createRequire(import.meta.url);
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

describe('CA-1 memory seam', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('stores, queries, and reopens a persisted memory record through SqlJsBackend', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-flow-memory-e2e-'));
    tempDirs.push(dir);

    const backend = createMemoryBackend(dir);
    await backend.initialize();

    const entry = createDefaultEntry({
      key: 'ca1-foundation',
      content: 'CA-1 proves the real memory package seam with a persisted record.',
      namespace,
      tags: ['ca1', 'e2e'],
      metadata: { seam: 'memory', fixtureVersion: 1 },
      ownerId: 'codex-e2e',
      accessLevel: 'team',
      references: ['design-m5-freeze'],
    });
    entry.embedding = await deterministicEmbedding(entry.content);

    await backend.store(entry);

    const byKey = await backend.getByKey(namespace, entry.key);
    expect(byKey?.content).toBe(entry.content);

    const exactResults = await backend.query({
      type: 'exact',
      namespace,
      key: entry.key,
      limit: 1,
    });
    expect(exactResults).toHaveLength(1);

    const semanticResults = await backend.search(entry.embedding, { k: 1, threshold: 0 });
    expect(semanticResults[0]?.entry.key).toBe(entry.key);

    await backend.shutdown();

    const reopened = createMemoryBackend(dir);
    await reopened.initialize();
    try {
      const persisted = await reopened.getByKey(namespace, entry.key);
      expect(persisted).not.toBeNull();
      expect(stableJson(toMemoryFixture(persisted!))).toEqual(
        await readJsonFixture('memory/persisted-record.json')
      );
    } finally {
      await reopened.shutdown();
    }
  });
});

function createMemoryBackend(dir: string): SqlJsBackend {
  return new SqlJsBackend({
    defaultNamespace: namespace,
    embeddingGenerator: deterministicEmbedding,
    databasePath: join(dir, 'memory.db'),
    autoPersistInterval: 0,
    optimize: false,
    wasmPath,
  });
}

async function deterministicEmbedding(content: string): Promise<Float32Array> {
  const vector = new Float32Array(4);
  for (let index = 0; index < content.length; index += 1) {
    vector[index % vector.length] += content.charCodeAt(index) / 1000;
  }
  return vector;
}

function toMemoryFixture(entry: {
  key: string;
  content: string;
  type: string;
  namespace: string;
  tags: string[];
  metadata: Record<string, unknown>;
  ownerId?: string;
  accessLevel: string;
  version: number;
  references: string[];
}): Record<string, unknown> {
  return {
    accessLevel: entry.accessLevel,
    content: entry.content,
    key: entry.key,
    metadata: entry.metadata,
    namespace: entry.namespace,
    ownerId: entry.ownerId,
    references: entry.references,
    tags: entry.tags,
    type: entry.type,
    version: entry.version,
  };
}
