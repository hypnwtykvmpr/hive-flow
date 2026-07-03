import { describe, it, beforeAll as before, afterAll as after, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use dynamic imports so the test can run against the compiled JS output.
// Adjust the import path if your build emits to a different directory.
const {
  createDatabase,
  getAvailableProviders,
} = await import('../cli/src/memory/database-provider.js');

type MemoryEntry = import('../cli/src/memory/types.js').MemoryEntry;
type IMemoryBackend = import('../cli/src/memory/types.js').IMemoryBackend;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  id: string,
  namespace: string,
  key: string,
  content: string,
  embedding?: number[],
): MemoryEntry {
  return {
    id,
    namespace,
    key,
    content,
    type: 'knowledge' as any,
    accessLevel: 'shared' as any,
    tags: [],
    metadata: {},
    embedding: embedding ? new Float32Array(embedding) : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    version: 1,
    ownerId: 'test',
    references: [],
  };
}

let tmpDir: string;

// ---------------------------------------------------------------------------
// 1. Provider Selection
// ---------------------------------------------------------------------------

describe('Provider Selection', () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'binary-prov-'));
  });
  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createDatabase with provider "binary" creates an BinaryBackend', async () => {
    const db = await createDatabase(join(tmpDir, 'test-binary.hfdb'), {
      provider: 'binary',
    });
    // BinaryBackend exposes healthCheck that reports index component
    const health = await db.healthCheck();
    assert.ok(health);
    assert.equal(health.status, 'healthy');
    await db.shutdown();
  });

  it('createDatabase with provider "json" creates a JsonBackend', async () => {
    const db = await createDatabase(join(tmpDir, 'test-json.json'), {
      provider: 'json',
    });
    const health = await db.healthCheck();
    assert.ok(health);
    // JsonBackend always returns 'healthy' and recommends SQLite
    assert.equal(health.status, 'healthy');
    assert.ok(
      health.recommendations.some((r: string) =>
        r.toLowerCase().includes('sqlite'),
      ),
    );
    await db.shutdown();
  });

  it('createDatabase with provider "auto" selects Binary', async () => {
    const db = await createDatabase(join(tmpDir, 'test-auto.db'), {
      provider: 'auto',
    });
    // The pure TypeScript binary backend is always available, so auto should pick it.
    // Store + get round-trip proves it initialised correctly.
    const entry = makeEntry('auto-1', 'ns', 'k', 'hello');
    await db.store(entry);
    const got = await db.get('auto-1');
    assert.ok(got);
    assert.equal(got.content, 'hello');
    await db.shutdown();
  });

  it('getAvailableProviders returns binary: true and json: true', async () => {
    const providers = await getAvailableProviders();
    assert.equal(providers.binary, true);
    assert.equal(providers.json, true);
  });
});

// ---------------------------------------------------------------------------
// 2. Binary Path Extension
// ---------------------------------------------------------------------------

describe('Binary Path Extension', () => {
  let db: IMemoryBackend;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'binary-ext-'));
    db = await createDatabase(join(dir, 'foo.db'), { provider: 'binary' });
  });
  after(async () => {
    await db.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('input path foo.db is converted to foo.hfdb for binary provider', async () => {
    // Store an entry and shutdown to force persist, then check file exists.
    const entry = makeEntry('ext-1', 'ns', 'k', 'data');
    await db.store(entry);
    await db.shutdown();

    const { existsSync } = await import('node:fs');
    // The .db extension should have been replaced with .hfdb
    assert.ok(
      existsSync(join(dir, 'foo.hfdb')),
      'Expected foo.hfdb to exist on disk',
    );
    assert.ok(
      !existsSync(join(dir, 'foo.db')),
      'foo.db should NOT exist (path was rewritten)',
    );

    // Re-open for later cleanup
    db = await createDatabase(join(dir, 'foo.db'), { provider: 'binary' });
  });
});

// ---------------------------------------------------------------------------
// 3. Full IMemoryBackend Contract (Binary via createDatabase)
// ---------------------------------------------------------------------------

describe('IMemoryBackend Contract (Binary)', () => {
  let db: IMemoryBackend;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'binary-contract-'));
    db = await createDatabase(join(dir, 'contract.hfdb'), { provider: 'binary' });
  });
  after(async () => {
    await db.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('store + get round-trip', async () => {
    const entry = makeEntry('c-1', 'ns1', 'key1', 'value1');
    await db.store(entry);
    const got = await db.get('c-1');
    assert.ok(got);
    assert.equal(got.id, 'c-1');
    assert.equal(got.content, 'value1');
  });

  it('store + getByKey round-trip', async () => {
    const entry = makeEntry('c-2', 'ns1', 'key2', 'value2');
    await db.store(entry);
    const got = await db.getByKey('ns1', 'key2');
    assert.ok(got);
    assert.equal(got.id, 'c-2');
    assert.equal(got.content, 'value2');
  });

  it('update changes version', async () => {
    const entry = makeEntry('c-3', 'ns1', 'key3', 'original');
    await db.store(entry);
    const updated = await db.update('c-3', { content: 'modified' });
    assert.ok(updated);
    assert.equal(updated.version, 2);
    assert.equal(updated.content, 'modified');
    assert.ok(updated.updatedAt >= entry.updatedAt);
  });

  it('delete removes entry', async () => {
    const entry = makeEntry('c-4', 'ns1', 'key4', 'to-delete');
    await db.store(entry);
    const deleted = await db.delete('c-4');
    assert.equal(deleted, true);
    const got = await db.get('c-4');
    assert.equal(got, null);
  });

  it('delete returns false for non-existent id', async () => {
    const deleted = await db.delete('non-existent');
    assert.equal(deleted, false);
  });

  it('bulkInsert + count', async () => {
    const entries = [
      makeEntry('b-1', 'bulk', 'bk1', 'bulk1'),
      makeEntry('b-2', 'bulk', 'bk2', 'bulk2'),
      makeEntry('b-3', 'bulk', 'bk3', 'bulk3'),
    ];
    await db.bulkInsert(entries);
    const c = await db.count('bulk');
    assert.equal(c, 3);
  });

  it('bulkDelete removes entries', async () => {
    const removed = await db.bulkDelete(['b-1', 'b-2']);
    assert.equal(removed, 2);
    const c = await db.count('bulk');
    assert.equal(c, 1);
  });

  it('listNamespaces returns unique namespaces', async () => {
    const namespaces = await db.listNamespaces();
    assert.ok(namespaces.includes('ns1'));
    assert.ok(namespaces.includes('bulk'));
    // Each namespace appears exactly once
    const unique = new Set(namespaces);
    assert.equal(unique.size, namespaces.length);
  });

  it('clearNamespace removes entries for that namespace', async () => {
    // Add entries to a fresh namespace
    await db.store(makeEntry('cn-1', 'clearme', 'ck1', 'v1'));
    await db.store(makeEntry('cn-2', 'clearme', 'ck2', 'v2'));
    const cleared = await db.clearNamespace('clearme');
    assert.equal(cleared, 2);
    const c = await db.count('clearme');
    assert.equal(c, 0);
  });

  it('search returns results sorted by score', async () => {
    const dim = 4;
    const e1 = makeEntry('s-1', 'search', 'sk1', 'apple', [1, 0, 0, 0]);
    const e2 = makeEntry('s-2', 'search', 'sk2', 'banana', [0.9, 0.1, 0, 0]);
    const e3 = makeEntry('s-3', 'search', 'sk3', 'cherry', [0, 0, 1, 0]);
    await db.bulkInsert([e1, e2, e3]);

    const query = new Float32Array([1, 0, 0, 0]);
    const results = await db.search(query, { k: 3 });

    assert.ok(results.length >= 2);
    // Results should be sorted descending by score
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        `results[${i - 1}].score (${results[i - 1].score}) should be >= results[${i}].score (${results[i].score})`,
      );
    }
    // The closest match to [1,0,0,0] should be s-1 or s-2
    assert.ok(['s-1', 's-2'].includes(results[0].entry.id));
  });

  it('healthCheck returns healthy status', async () => {
    const health = await db.healthCheck();
    assert.equal(health.status, 'healthy');
    assert.ok(health.timestamp > 0);
    assert.ok(health.components.storage.status === 'healthy');
  });
});

// ---------------------------------------------------------------------------
// 4. Data Migration Scenario (JSON -> Binary)
// ---------------------------------------------------------------------------

describe('Data Migration (JSON -> Binary)', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'binary-migrate-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('entries from JsonBackend can be migrated to BinaryBackend', async () => {
    // Step 1: Create JsonBackend with entries
    const jsonDb = await createDatabase(join(dir, 'source.json'), {
      provider: 'json',
    });
    const entries = [
      makeEntry('m-1', 'migrate', 'mk1', 'first'),
      makeEntry('m-2', 'migrate', 'mk2', 'second'),
      makeEntry('m-3', 'other', 'mk3', 'third'),
    ];
    await jsonDb.bulkInsert(entries);

    // Step 2: Create BinaryBackend
    const binaryDb = await createDatabase(join(dir, 'dest.hfdb'), {
      provider: 'binary',
    });

    // Step 3: Copy entries from JSON to Binary
    for (const entry of entries) {
      await binaryDb.store(entry);
    }

    // Step 4: Verify all entries accessible in Binary
    for (const entry of entries) {
      const got = await binaryDb.get(entry.id);
      assert.ok(got, `Entry ${entry.id} should exist in Binary`);
      assert.equal(got.content, entry.content);
      assert.equal(got.namespace, entry.namespace);
    }

    // Verify namespaces preserved
    const namespaces = await binaryDb.listNamespaces();
    assert.ok(namespaces.includes('migrate'));
    assert.ok(namespaces.includes('other'));

    // Verify counts
    assert.equal(await binaryDb.count('migrate'), 2);
    assert.equal(await binaryDb.count('other'), 1);

    await jsonDb.shutdown();
    await binaryDb.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrent Operations
// ---------------------------------------------------------------------------

describe('Concurrent Operations', () => {
  let db: IMemoryBackend;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'binary-concurrent-'));
    db = await createDatabase(join(dir, 'concurrent.hfdb'), {
      provider: 'binary',
    });
  });
  after(async () => {
    await db.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('multiple stores in parallel do not corrupt state', async () => {
    const count = 50;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      const entry = makeEntry(
        `par-${i}`,
        'parallel',
        `pk-${i}`,
        `value-${i}`,
      );
      promises.push(db.store(entry));
    }
    await Promise.all(promises);

    const total = await db.count('parallel');
    assert.equal(total, count);

    // Verify each entry is individually accessible
    for (let i = 0; i < count; i++) {
      const got = await db.get(`par-${i}`);
      assert.ok(got, `Entry par-${i} should exist`);
      assert.equal(got.content, `value-${i}`);
    }
  });

  it('store while search is running works correctly', async () => {
    // Seed entries with embeddings for search
    const dim = 4;
    for (let i = 0; i < 10; i++) {
      const vec = [0, 0, 0, 0];
      vec[i % dim] = 1;
      await db.store(
        makeEntry(`ss-${i}`, 'searchstore', `ssk-${i}`, `sv-${i}`, vec),
      );
    }

    // Run search and store concurrently
    const query = new Float32Array([1, 0, 0, 0]);
    const [searchResults] = await Promise.all([
      db.search(query, { k: 5 }),
      db.store(
        makeEntry('ss-new', 'searchstore', 'ssk-new', 'new-val', [1, 0, 0, 0]),
      ),
    ]);

    assert.ok(Array.isArray(searchResults));
    assert.ok(searchResults.length > 0);

    // The newly stored entry should be accessible afterwards
    const newEntry = await db.get('ss-new');
    assert.ok(newEntry);
    assert.equal(newEntry.content, 'new-val');
  });
});
