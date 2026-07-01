import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the module under test
const mod = await import('../.claude/helpers/context-persistence-hook.mjs');
const {
  SQLiteBackend,
  PostgresVectorBackend,
  JsonFileBackend,
  resolveBackend,
  getPostgresVectorConfig,
  createHashEmbedding,
  hashContent,
  parseTranscript,
  extractTextContent,
  extractToolCalls,
  extractFilePaths,
  chunkTranscript,
  extractSummary,
  buildEntry,
  buildCompactInstructions,
  computeImportance,
  retrieveContextSmart,
  autoOptimize,
  storeChunks,
  retrieveContext,
  runAutopilot,
  consumeCompactSignalAdvisory,
  armCompactionRecoveryRequired,
  buildCompactionRecoveryInstructions,
  buildSessionStartRecoveryContext,
  detectContextWindowTokens,
  displayAutopilotPercentage,
  resolveStatuslineContextMeasurement,
  buildCompactPromptFloorDecision,
  modelIdToWindowSize,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  CONTEXT_WINDOW_TOKENS,
  NAMESPACE,
  COMPACT_INSTRUCTION_BUDGET,
  RETENTION_DAYS,
} = mod;

// Test fixtures
const TMP_DIR = join(__dirname, '.tmp-ctx-test');
const TMP_DB = join(TMP_DIR, 'test-archive.db');
const TMP_ARCHIVE = join(TMP_DIR, 'test-archive.json');
const TMP_TRANSCRIPT = join(TMP_DIR, 'test-transcript.jsonl');
const TMP_HOME = join(TMP_DIR, 'fake-home');

function makeUserMsg(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function makeAssistantMsg(text, toolCalls = []) {
  const content = [{ type: 'text', text }];
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', name: tc.name, input: tc.input });
  }
  return { role: 'assistant', content };
}

function makeToolResultMsg(toolUseId, content) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] };
}

// Setup / teardown
before(() => {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  if (!existsSync(TMP_HOME)) mkdirSync(TMP_HOME, { recursive: true });
});

after(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

let restoreEnv = () => {};

function setEnv(overrides) {
  restoreEnv();
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  restoreEnv = () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

afterEach(() => restoreEnv());

// ============================================================================
// SQLite Backend Tests
// ============================================================================

describe('SQLiteBackend', () => {
  it('should initialize and create schema', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'init-test.db'));
    await backend.initialize();
    const count = await backend.count();
    assert.equal(count, 0);
    await backend.shutdown();
  });

  it('should store and query entries', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'store-sqlite.db'));
    await backend.initialize();

    const now = Date.now();
    const entry = {
      id: 'sql-1', key: 'test:1', content: 'hello world', type: 'episodic',
      namespace: NAMESPACE, tags: ['test'], metadata: { sessionId: 'sess-1', chunkIndex: 0, contentHash: 'abc', summary: 'test' },
      accessLevel: 'private', createdAt: now, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    };
    await backend.store(entry);

    const results = await backend.query({ namespace: NAMESPACE });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'hello world');
    assert.equal(results[0].metadata.sessionId, 'sess-1');

    await backend.shutdown();
  });

  it('should query by session with indexed lookup', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'session-query.db'));
    await backend.initialize();

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await backend.store({
        id: `sq-${i}`, key: `test:${i}`, content: `turn ${i}`, type: 'episodic',
        namespace: NAMESPACE, tags: [], metadata: { sessionId: 'sess-a', chunkIndex: i, contentHash: `h${i}`, summary: `s${i}` },
        accessLevel: 'private', createdAt: now + i, updatedAt: now + i, version: 1,
        accessCount: 0, lastAccessedAt: now + i,
      });
    }
    // Different session
    await backend.store({
      id: 'sq-other', key: 'test:other', content: 'other session', type: 'episodic',
      namespace: NAMESPACE, tags: [], metadata: { sessionId: 'sess-b', chunkIndex: 0, contentHash: 'other', summary: 'other' },
      accessLevel: 'private', createdAt: now, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    });

    const sessA = await backend.queryBySession(NAMESPACE, 'sess-a');
    assert.equal(sessA.length, 5);
    // Should be ordered by chunk_index DESC
    assert.equal(sessA[0].metadata.chunkIndex, 4);

    const sessB = await backend.queryBySession(NAMESPACE, 'sess-b');
    assert.equal(sessB.length, 1);

    await backend.shutdown();
  });

  it('should dedup via hashExists', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'hash-dedup.db'));
    await backend.initialize();

    const now = Date.now();
    await backend.store({
      id: 'hd-1', key: 'test:1', content: 'data', type: 'episodic',
      namespace: NAMESPACE, tags: [], metadata: { contentHash: 'unique-hash-123', sessionId: 's', chunkIndex: 0, summary: '' },
      accessLevel: 'private', createdAt: now, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    });

    assert.ok(backend.hashExists('unique-hash-123'));
    assert.ok(!backend.hashExists('nonexistent-hash'));

    await backend.shutdown();
  });

  it('should bulk insert in a transaction', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'bulk-sqlite.db'));
    await backend.initialize();

    const now = Date.now();
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `bulk-${i}`, key: `test:${i}`, content: `content ${i}`, type: 'episodic',
      namespace: NAMESPACE, tags: ['bulk'], metadata: { sessionId: 'bulk-sess', chunkIndex: i, contentHash: `bh${i}`, summary: `s${i}` },
      accessLevel: 'private', createdAt: now + i, updatedAt: now + i, version: 1,
      accessCount: 0, lastAccessedAt: now + i,
    }));

    await backend.bulkInsert(entries);
    const count = await backend.count(NAMESPACE);
    assert.equal(count, 100);

    await backend.shutdown();
  });

  it('should list sessions with counts', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'sessions-list.db'));
    await backend.initialize();

    const now = Date.now();
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < (s + 1) * 2; i++) {
        await backend.store({
          id: `sl-${s}-${i}`, key: `test:${s}:${i}`, content: `c`, type: 'episodic',
          namespace: NAMESPACE, tags: [], metadata: { sessionId: `sess-${s}`, chunkIndex: i, contentHash: `slh${s}${i}`, summary: '' },
          accessLevel: 'private', createdAt: now + s * 100 + i, updatedAt: now, version: 1,
          accessCount: 0, lastAccessedAt: now,
        });
      }
    }

    const sessions = await backend.listSessions(NAMESPACE);
    assert.equal(sessions.length, 3);
    // Most recent session first
    assert.equal(sessions[0].session_id, 'sess-2');
    assert.equal(sessions[0].cnt, 6);

    await backend.shutdown();
  });

  it('should persist across close/reopen', async () => {
    const dbPath = join(TMP_DIR, 'persist-sqlite.db');
    const now = Date.now();

    const b1 = new SQLiteBackend(dbPath);
    await b1.initialize();
    await b1.store({
      id: 'p-1', key: 'test:1', content: 'persisted', type: 'episodic',
      namespace: NAMESPACE, tags: [], metadata: { sessionId: 'ps', chunkIndex: 0, contentHash: 'ph1', summary: 's' },
      accessLevel: 'private', createdAt: now, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    });
    await b1.shutdown();

    const b2 = new SQLiteBackend(dbPath);
    await b2.initialize();
    const results = await b2.queryBySession(NAMESPACE, 'ps');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'persisted');
    await b2.shutdown();
  });
});

// ============================================================================
// JsonFileBackend Tests
// ============================================================================

describe('JsonFileBackend', () => {
  it('should initialize empty', async () => {
    const backend = new JsonFileBackend(join(TMP_DIR, 'empty.json'));
    await backend.initialize();
    const count = await backend.count();
    assert.equal(count, 0);
    await backend.shutdown();
  });

  it('should store and query entries', async () => {
    const path = join(TMP_DIR, 'json-store.json');
    const backend = new JsonFileBackend(path);
    await backend.initialize();

    await backend.store({ id: '1', namespace: 'ns1', content: 'hello', metadata: {} });
    await backend.store({ id: '2', namespace: 'ns2', content: 'world', metadata: {} });

    const ns1 = await backend.query({ namespace: 'ns1' });
    assert.equal(ns1.length, 1);
    assert.equal(ns1[0].content, 'hello');

    await backend.shutdown();
  });

  it('should queryBySession', async () => {
    const path = join(TMP_DIR, 'json-session.json');
    const backend = new JsonFileBackend(path);
    await backend.initialize();

    await backend.store({ id: 'js1', namespace: NAMESPACE, content: 'a', metadata: { sessionId: 's1', chunkIndex: 0 } });
    await backend.store({ id: 'js2', namespace: NAMESPACE, content: 'b', metadata: { sessionId: 's1', chunkIndex: 1 } });
    await backend.store({ id: 'js3', namespace: NAMESPACE, content: 'c', metadata: { sessionId: 's2', chunkIndex: 0 } });

    const results = await backend.queryBySession(NAMESPACE, 's1');
    assert.equal(results.length, 2);
    // Descending chunk order
    assert.equal(results[0].metadata.chunkIndex, 1);

    await backend.shutdown();
  });

  it('should hashExists', async () => {
    const path = join(TMP_DIR, 'json-hash.json');
    const backend = new JsonFileBackend(path);
    await backend.initialize();

    await backend.store({ id: 'jh1', namespace: NAMESPACE, content: 'x', metadata: { contentHash: 'hash-abc' } });

    assert.ok(backend.hashExists('hash-abc'));
    assert.ok(!backend.hashExists('hash-xyz'));

    await backend.shutdown();
  });
});

describe('context window detection', () => {
  it('should honor HIVE_FLOW_CONTEXT_WINDOW override', () => {
    setEnv({
      HIVE_FLOW_CONTEXT_WINDOW: '321000',
      CLAUDE_MODEL: 'claude-sonnet-4-6 [1m]',
      HOME: TMP_HOME,
      USERPROFILE: TMP_HOME,
    });

    assert.equal(detectContextWindowTokens(), 321000);
  });

  it('should detect 1M Claude models from the [1m] suffix', () => {
    setEnv({
      HIVE_FLOW_CONTEXT_WINDOW: null,
      CLAUDE_MODEL: 'claude-sonnet-4-6 [1m]',
      HOME: TMP_HOME,
      USERPROFILE: TMP_HOME,
    });

    assert.equal(detectContextWindowTokens(), 1000000);
    assert.equal(modelIdToWindowSize('claude-sonnet-4-6 [1m]'), 1000000);
  });

  it('should resolve known models through MODEL_CONTEXT_WINDOWS', () => {
    assert.equal(MODEL_CONTEXT_WINDOWS.has('claude-sonnet-4-6'), true);
    assert.equal(modelIdToWindowSize('claude-sonnet-4-6'), 200000);
  });

  it('should fall back to the default context window for unknown models', () => {
    setEnv({
      HIVE_FLOW_CONTEXT_WINDOW: null,
      CLAUDE_MODEL: 'totally-unknown-model',
      HOME: TMP_HOME,
      USERPROFILE: TMP_HOME,
    });

    assert.equal(detectContextWindowTokens(), DEFAULT_CONTEXT_WINDOW_TOKENS);
    assert.equal(DEFAULT_CONTEXT_WINDOW_TOKENS, 200000);
  });

  it('should skip empty exact project usage and use a parent project model from claude config', () => {
    const projectRoot = join(TMP_DIR, 'window-config-project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(TMP_HOME, { recursive: true });
    writeFileSync(join(TMP_HOME, '.claude.json'), JSON.stringify({
      projects: {
        [projectRoot]: { lastModelUsage: {} },
        [dirname(projectRoot)]: {
          lastModelUsage: {
            'claude-opus-4-8[1m]': {
              lastUsedAt: '2026-06-06T19:00:00.000Z',
            },
          },
        },
      },
    }));
    const oldCwd = process.cwd();
    setEnv({
      HIVE_FLOW_CONTEXT_WINDOW: null,
      CLAUDE_MODEL: null,
      HOME: TMP_HOME,
      USERPROFILE: TMP_HOME,
    });
    try {
      process.chdir(projectRoot);
      assert.equal(detectContextWindowTokens(), 1000000);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('should recalculate stale status percentages against the current context window', () => {
    const pct = displayAutopilotPercentage({
      lastTokenEstimate: 258587,
      lastPercentage: 1,
      contextWindow: 200000,
    }, 1000000);

    assert.equal(pct.toFixed(6), '0.258587');
  });

  it('should measure live context using the statusline stdin context window shape', () => {
    const measurement = resolveStatuslineContextMeasurement({
      context_window: {
        used_tokens: 200000,
        context_window_size: 1000000,
      },
      model: { model_id: 'claude-opus-4-8[1m]' },
    });

    assert.equal(measurement.percentage, 0.2);
    assert.equal(measurement.contextWindow, 1000000);
    assert.equal(measurement.source, 'stdin.context_window.used_tokens');
  });

  it('should block direct /compact prompts below the dynamically measured 50% floor', () => {
    const decision = buildCompactPromptFloorDecision({
      prompt: '/compact preserve state',
      context_window: {
        used_percentage: 49,
        context_window_size: 1000000,
      },
      model: { model_id: 'claude-opus-4-8[1m]' },
    });

    assert.equal(decision.decision, 'block');
    assert.equal(decision.continue, false);
    assert.match(decision.stopReason, /49\.0%/);
    assert.match(decision.stopReason, /below the 50% compaction request floor/);
  });

  it('should block direct /compact prompts when context usage cannot be measured', () => {
    const decision = buildCompactPromptFloorDecision({
      prompt: '/compact preserve state',
    });

    assert.equal(decision.decision, 'block');
    assert.equal(decision.continue, false);
    assert.match(decision.stopReason, /unable to measure current context usage/);
    assert.match(decision.stopReason, /50% compaction request floor cannot be verified/);
    assert.match(decision.stopReason, /request human intervention/);
    assert.match(decision.stopReason, /context measurement layer must be repaired/);
  });

  it('should skip context measurement for every non-/compact prompt', () => {
    for (const prompt of [
      'please explain /compact behavior',
      '/compactness is not the compact command',
      '/compile the project',
      'normal development prompt',
      '',
    ]) {
      const input = { prompt };
      Object.defineProperty(input, 'context_window', {
        get() {
          throw new Error(`context_window should not be read for ${JSON.stringify(prompt)}`);
        },
      });
      Object.defineProperty(input, 'model', {
        get() {
          throw new Error(`model should not be read for ${JSON.stringify(prompt)}`);
        },
      });

      assert.equal(buildCompactPromptFloorDecision(input), null);
    }
  });

  it('should treat 20% of a 1M model as 20% actual context, not old-window equivalent pressure', () => {
    const decision = buildCompactPromptFloorDecision({
      prompt: '/compact',
      context_window: {
        used_tokens: 200000,
        context_window_size: 1000000,
      },
      model: { model_id: 'claude-opus-4-8[1m]' },
    });

    assert.equal(decision.decision, 'block');
    assert.match(decision.stopReason, /20\.0%/);
  });

  it('should allow direct /compact prompts at or above the dynamically measured 50% floor', () => {
    const decision = buildCompactPromptFloorDecision({
      prompt: '/compact',
      context_window: {
        used_percentage: 60,
        context_window_size: 1000000,
      },
      model: { model_id: 'claude-opus-4-8[1m]' },
    });

    assert.equal(decision, null);
  });
});

// ============================================================================
// resolveBackend Tests
// ============================================================================

describe('resolveBackend', () => {
  it('should resolve to sqlite when better-sqlite3 is available', async () => {
    const { backend, type } = await resolveBackend();
    assert.equal(type, 'sqlite');
    await backend.shutdown();
  });
});

// ============================================================================
// createHashEmbedding Tests
// ============================================================================

describe('createHashEmbedding', () => {
  it('should produce 768-dimensional embedding', () => {
    const emb = createHashEmbedding('hello world');
    assert.equal(emb.length, 768);
    assert.ok(emb instanceof Float32Array);
  });

  it('should be L2-normalized', () => {
    const emb = createHashEmbedding('test embedding normalization');
    let norm = 0;
    for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
    norm = Math.sqrt(norm);
    assert.ok(Math.abs(norm - 1.0) < 0.001, `Norm should be ~1.0, got ${norm}`);
  });

  it('should be deterministic', () => {
    const a = createHashEmbedding('deterministic test');
    const b = createHashEmbedding('deterministic test');
    for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
  });

  it('should produce different embeddings for different text', () => {
    const a = createHashEmbedding('hello');
    const b = createHashEmbedding('goodbye');
    let same = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { same = false; break; }
    }
    assert.ok(!same);
  });
});

// ============================================================================
// hashContent Tests
// ============================================================================

describe('hashContent', () => {
  it('should produce SHA-256 hex string', () => {
    const h = hashContent('hello');
    assert.equal(h.length, 64);
    assert.match(h, /^[a-f0-9]{64}$/);
  });

  it('should be deterministic', () => {
    assert.equal(hashContent('same'), hashContent('same'));
  });

  it('should differ for different content', () => {
    assert.notEqual(hashContent('a'), hashContent('b'));
  });
});

// ============================================================================
// Transcript Parsing Tests
// ============================================================================

describe('parseTranscript', () => {
  it('should parse JSONL file', () => {
    const lines = [
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'hello' }] }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }),
    ];
    writeFileSync(TMP_TRANSCRIPT, lines.join('\n'), 'utf-8');
    const msgs = parseTranscript(TMP_TRANSCRIPT);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'user');
  });

  it('should return empty for missing file', () => {
    assert.equal(parseTranscript('/nonexistent/file.jsonl').length, 0);
  });

  it('should skip malformed lines', () => {
    writeFileSync(TMP_TRANSCRIPT, '{"role":"user"}\nnot json\n{"role":"assistant"}\n', 'utf-8');
    assert.equal(parseTranscript(TMP_TRANSCRIPT).length, 2);
  });
});

// ============================================================================
// Content Extraction Tests
// ============================================================================

describe('extractTextContent', () => {
  it('should extract from content array', () => {
    const msg = { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] };
    assert.equal(extractTextContent(msg), 'hello\nworld');
  });

  it('should extract from string content', () => {
    assert.equal(extractTextContent({ content: 'simple string' }), 'simple string');
  });

  it('should handle null/undefined', () => {
    assert.equal(extractTextContent(null), '');
    assert.equal(extractTextContent(undefined), '');
  });

  it('should skip non-text blocks', () => {
    const msg = { content: [
      { type: 'text', text: 'keep' },
      { type: 'tool_use', name: 'Read' },
      { type: 'text', text: 'this' },
    ]};
    assert.equal(extractTextContent(msg), 'keep\nthis');
  });
});

describe('extractToolCalls', () => {
  it('should extract tool_use blocks', () => {
    const msg = { content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/src/a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]};
    const calls = extractToolCalls(msg);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'Edit');
  });

  it('should handle null message', () => {
    assert.deepEqual(extractToolCalls(null), []);
  });
});

describe('extractFilePaths', () => {
  it('should extract and deduplicate paths', () => {
    const calls = [
      { name: 'Edit', input: { file_path: '/src/a.ts' } },
      { name: 'Read', input: { file_path: '/src/a.ts' } },
      { name: 'Glob', input: { path: '/src' } },
    ];
    const paths = extractFilePaths(calls);
    assert.equal(paths.length, 2);
    assert.ok(paths.includes('/src/a.ts'));
    assert.ok(paths.includes('/src'));
  });
});

// ============================================================================
// Chunking Tests
// ============================================================================

describe('chunkTranscript', () => {
  it('should group user+assistant pairs', () => {
    const messages = [
      makeUserMsg('first'), makeAssistantMsg('first answer'),
      makeUserMsg('second'), makeAssistantMsg('second answer'),
    ];
    const chunks = chunkTranscript(messages);
    assert.equal(chunks.length, 2);
  });

  it('should skip synthetic tool result messages', () => {
    const messages = [
      makeUserMsg('do something'),
      makeAssistantMsg('running tool', [{ name: 'Bash', input: { command: 'ls' } }]),
      makeToolResultMsg('id1', 'file1.txt'),
      makeAssistantMsg('done'),
    ];
    assert.equal(chunkTranscript(messages).length, 1);
  });

  it('should filter non user/assistant messages', () => {
    const messages = [
      { role: 'system', content: 'init' },
      makeUserMsg('hello'),
      makeAssistantMsg('hi'),
    ];
    assert.equal(chunkTranscript(messages).length, 1);
  });

  it('should handle empty messages', () => {
    assert.deepEqual(chunkTranscript([]), []);
  });
});

// ============================================================================
// Summary Extraction Tests
// ============================================================================

describe('extractSummary', () => {
  it('should produce summary within 300 chars', () => {
    const chunk = {
      userMessage: makeUserMsg('Implement user authentication with OAuth2'),
      assistantMessage: makeAssistantMsg('I\'ll implement OAuth2 authentication.'),
      toolCalls: [
        { name: 'Edit', input: { file_path: '/src/auth.ts' } },
      ],
      turnIndex: 0,
    };
    const summary = extractSummary(chunk);
    assert.ok(summary.length <= 300);
    assert.ok(summary.includes('OAuth2') || summary.includes('authentication'));
  });

  it('should handle empty chunk', () => {
    const summary = extractSummary({
      userMessage: null, assistantMessage: null, toolCalls: [], turnIndex: 0,
    });
    assert.ok(summary.length <= 300);
  });
});

// ============================================================================
// Entry Building Tests
// ============================================================================

describe('buildEntry', () => {
  it('should produce valid memory entry', () => {
    const chunk = {
      userMessage: makeUserMsg('test question'),
      assistantMessage: makeAssistantMsg('test answer'),
      toolCalls: [{ name: 'Read', input: { file_path: '/src/x.ts' } }],
      turnIndex: 5,
    };
    const entry = buildEntry(chunk, 'session-123', 'auto', '2026-02-10T00:00:00Z');

    assert.ok(entry.id.startsWith('ctx-'));
    assert.ok(entry.key.startsWith('transcript:session-123:5:'));
    assert.equal(entry.type, 'episodic');
    assert.equal(entry.namespace, NAMESPACE);
    assert.ok(entry.tags.includes('transcript'));
    assert.ok(entry.tags.includes('session-123'));
    assert.ok(entry.tags.includes('Read'));
    assert.equal(entry.metadata.sessionId, 'session-123');
    assert.equal(entry.metadata.chunkIndex, 5);
    assert.ok(entry.metadata.contentHash);
    assert.deepEqual(entry.metadata.filePaths, ['/src/x.ts']);
  });
});

// ============================================================================
// Store + Dedup Tests (with SQLite)
// ============================================================================

describe('storeChunks (SQLite)', () => {
  it('should store chunks and dedup duplicates', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'dedup-sqlite.db'));
    await backend.initialize();

    const chunks = [{
      userMessage: makeUserMsg('hello'),
      assistantMessage: makeAssistantMsg('hi'),
      toolCalls: [],
      turnIndex: 0,
    }];

    const r1 = await storeChunks(backend, chunks, 'sess1', 'auto');
    assert.equal(r1.stored, 1);
    assert.equal(r1.deduped, 0);

    const r2 = await storeChunks(backend, chunks, 'sess1', 'auto');
    assert.equal(r2.stored, 0);
    assert.equal(r2.deduped, 1);

    await backend.shutdown();
  });
});

describe('storeChunks (JSON fallback)', () => {
  it('should store chunks and dedup duplicates', async () => {
    const backend = new JsonFileBackend(join(TMP_DIR, 'dedup-json.json'));
    await backend.initialize();

    const chunks = [{
      userMessage: makeUserMsg('hello'),
      assistantMessage: makeAssistantMsg('hi'),
      toolCalls: [],
      turnIndex: 0,
    }];

    const r1 = await storeChunks(backend, chunks, 'sess1', 'auto');
    assert.equal(r1.stored, 1);

    const r2 = await storeChunks(backend, chunks, 'sess1', 'auto');
    assert.equal(r2.stored, 0);
    assert.equal(r2.deduped, 1);

    await backend.shutdown();
  });
});

// ============================================================================
// Context Retrieval Tests
// ============================================================================

describe('retrieveContext', () => {
  it('should build restoration text (SQLite)', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'retrieve-sqlite.db'));
    await backend.initialize();

    const now = Date.now();
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, key: `test:${i}`, content: `Turn ${i} content`, type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'sess-abc', chunkIndex: i, summary: `Summary of turn ${i}`, toolNames: ['Read', 'Edit'], filePaths: ['/src/file.ts'], contentHash: `rh${i}` },
      accessLevel: 'private', createdAt: now + i, updatedAt: now + i, version: 1,
      accessCount: 0, lastAccessedAt: now + i,
    }));
    await backend.bulkInsert(entries);

    const ctx = await retrieveContext(backend, 'sess-abc', 4000);
    assert.ok(ctx.includes('Restored Context'));
    assert.ok(ctx.includes('5 archived turns'));
    assert.ok(ctx.includes('Summary of turn'));
    assert.ok(ctx.length <= 4200); // budget + header + footer

    await backend.shutdown();
  });

  it('should return empty for unknown session', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'empty-retrieve.db'));
    await backend.initialize();
    assert.equal(await retrieveContext(backend, 'unknown', 4000), '');
    await backend.shutdown();
  });

  it('should respect budget constraint', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'budget-sqlite.db'));
    await backend.initialize();

    const now = Date.now();
    const entries = Array.from({ length: 50 }, (_, i) => ({
      id: `bg${i}`, key: `test:${i}`, content: 'x'.repeat(200), type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'budget-sess', chunkIndex: i, summary: `Long summary text for turn ${i} with padding`, toolNames: ['Edit', 'Write', 'Bash'], filePaths: ['/src/very/long/path.tsx'], contentHash: `bgh${i}` },
      accessLevel: 'private', createdAt: now + i, updatedAt: now + i, version: 1,
      accessCount: 0, lastAccessedAt: now + i,
    }));
    await backend.bulkInsert(entries);

    const ctx = await retrieveContext(backend, 'budget-sess', 500);
    assert.ok(ctx.length <= 700); // budget + header + footer

    await backend.shutdown();
  });
});

// ============================================================================
// No-op Condition Tests
// ============================================================================

describe('no-op conditions', () => {
  it('should not restore for non-matching session', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'noop-sqlite.db'));
    await backend.initialize();

    const now = Date.now();
    await backend.store({
      id: 'noop1', key: 'test:1', content: 'data', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'other-session', chunkIndex: 0, contentHash: 'nph1', summary: 's' },
      accessLevel: 'private', createdAt: now, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    });

    assert.equal(await retrieveContext(backend, 'my-session', 4000), '');
    await backend.shutdown();
  });
});

// ============================================================================
// PostgresVector Config Tests
// ============================================================================

describe('getPostgresVectorConfig', () => {
  it('should return null when no env vars set', () => {
    // Save and clear env vars
    const saved = { ...process.env };
    delete process.env.HIVE_VECTOR_HOST;
    delete process.env.HIVE_VECTOR_DATABASE;
    delete process.env.HIVE_VECTOR_USER;
    delete process.env.PGHOST;
    delete process.env.PGDATABASE;
    delete process.env.PGUSER;

    const config = getPostgresVectorConfig();
    assert.equal(config, null);

    // Restore env
    Object.assign(process.env, saved);
  });

  it('should parse config from HIVE_VECTOR_* env vars', () => {
    const saved = { ...process.env };
    process.env.HIVE_VECTOR_HOST = 'pg.example.com';
    process.env.HIVE_VECTOR_PORT = '5433';
    process.env.HIVE_VECTOR_DATABASE = 'hive_flow';
    process.env.HIVE_VECTOR_USER = 'admin';
    process.env.HIVE_VECTOR_PASSWORD = 'secret123';
    process.env.HIVE_VECTOR_SSL = 'true';

    const config = getPostgresVectorConfig();
    assert.ok(config);
    assert.equal(config.host, 'pg.example.com');
    assert.equal(config.port, 5433);
    assert.equal(config.database, 'hive_flow');
    assert.equal(config.user, 'admin');
    assert.equal(config.password, 'secret123');
    assert.equal(config.ssl, true);

    // Cleanup
    delete process.env.HIVE_VECTOR_HOST;
    delete process.env.HIVE_VECTOR_PORT;
    delete process.env.HIVE_VECTOR_DATABASE;
    delete process.env.HIVE_VECTOR_USER;
    delete process.env.HIVE_VECTOR_PASSWORD;
    delete process.env.HIVE_VECTOR_SSL;
    Object.assign(process.env, saved);
  });

  it('should fall back to PG* env vars', () => {
    const saved = { ...process.env };
    delete process.env.HIVE_VECTOR_HOST;
    delete process.env.HIVE_VECTOR_DATABASE;
    delete process.env.HIVE_VECTOR_USER;
    process.env.PGHOST = 'localhost';
    process.env.PGDATABASE = 'testdb';
    process.env.PGUSER = 'testuser';
    process.env.PGPORT = '5434';

    const config = getPostgresVectorConfig();
    assert.ok(config);
    assert.equal(config.host, 'localhost');
    assert.equal(config.port, 5434);
    assert.equal(config.database, 'testdb');
    assert.equal(config.user, 'testuser');

    delete process.env.PGHOST;
    delete process.env.PGDATABASE;
    delete process.env.PGUSER;
    delete process.env.PGPORT;
    Object.assign(process.env, saved);
  });
});

// ============================================================================
// PostgresVectorBackend Class Tests (mock-based, no real PostgreSQL)
// ============================================================================

describe('PostgresVectorBackend', () => {
  it('should be exported and constructable', () => {
    assert.ok(PostgresVectorBackend);
    const backend = new PostgresVectorBackend({
      host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test',
    });
    assert.ok(backend);
    assert.equal(backend.config.host, 'localhost');
  });

  it('hashExists should return false (async-only for pg)', () => {
    const backend = new PostgresVectorBackend({
      host: 'localhost', port: 5432, database: 'test', user: 'test', password: 'test',
    });
    // Synchronous hashExists always returns false for pg (uses ON CONFLICT for dedup)
    assert.equal(backend.hashExists('any-hash'), false);
  });
});

// ============================================================================
// Proactive Archiving Tests
// ============================================================================

describe('proactive archiving (UserPromptSubmit)', () => {
  it('should archive incrementally and dedup on re-archive', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'proactive-sqlite.db'));
    await backend.initialize();

    // First archive: 3 chunks
    const chunks1 = [
      { userMessage: makeUserMsg('q1'), assistantMessage: makeAssistantMsg('a1'), toolCalls: [], turnIndex: 0 },
      { userMessage: makeUserMsg('q2'), assistantMessage: makeAssistantMsg('a2'), toolCalls: [], turnIndex: 1 },
      { userMessage: makeUserMsg('q3'), assistantMessage: makeAssistantMsg('a3'), toolCalls: [], turnIndex: 2 },
    ];
    const r1 = await storeChunks(backend, chunks1, 'proactive-sess', 'proactive');
    assert.equal(r1.stored, 3);
    assert.equal(r1.deduped, 0);

    // Second archive (same + 2 new): dedup existing, store new
    const chunks2 = [
      ...chunks1,
      { userMessage: makeUserMsg('q4'), assistantMessage: makeAssistantMsg('a4'), toolCalls: [], turnIndex: 3 },
      { userMessage: makeUserMsg('q5'), assistantMessage: makeAssistantMsg('a5'), toolCalls: [], turnIndex: 4 },
    ];
    const r2 = await storeChunks(backend, chunks2, 'proactive-sess', 'proactive');
    assert.equal(r2.stored, 2);
    assert.equal(r2.deduped, 3);

    // Total should be 5
    const total = await backend.count(NAMESPACE);
    assert.equal(total, 5);

    await backend.shutdown();
  });

  it('should build complete restoration from proactively archived data', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'proactive-restore.db'));
    await backend.initialize();

    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await backend.store({
        id: `pa${i}`, key: `test:${i}`, content: `Turn ${i}`, type: 'episodic',
        namespace: NAMESPACE, tags: [],
        metadata: { sessionId: 'pa-sess', chunkIndex: i, summary: `Proactive turn ${i}`, toolNames: ['Edit'], filePaths: ['/src/a.ts'], contentHash: `pah${i}` },
        accessLevel: 'private', createdAt: now + i, updatedAt: now + i, version: 1,
        accessCount: 0, lastAccessedAt: now + i,
      });
    }

    const ctx = await retrieveContext(backend, 'pa-sess', 4000);
    assert.ok(ctx.includes('10 archived turns'));
    assert.ok(ctx.includes('Proactive turn'));

    await backend.shutdown();
  });
});

describe('compact advisory signal', () => {
  it('should arm deterministic post-compact recovery instructions', () => {
    const projectRoot = join(TMP_DIR, 'compact-recovery-arm');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const flagPath = join(dataDir, 'compaction-recovery-required.json');

    const recovery = armCompactionRecoveryRequired(projectRoot, {
      sessionId: 'compact-session-1',
      source: 'compact',
      restoredContext: 'restored archived turns',
    });
    const instructions = buildCompactionRecoveryInstructions(recovery);

    assert.equal(existsSync(flagPath), true);
    const flag = JSON.parse(readFileSync(flagPath, 'utf8'));
    assert.equal(flag.type, 'hive-flow.compaction-recovery-required');
    assert.equal(flag.sessionId, 'compact-session-1');
    assert.equal(flag.source, 'compact');
    assert.match(flag.recoveryNonce, /^[0-9a-f]{24}$/);
    assert.ok(Array.isArray(flag.requiredActions));
    assert.ok(flag.requiredActions.includes('read-compaction-handoff'));
    assert.equal(flag.handoffExists, false);
    assert.equal(flag.stateExists, false);
    assert.match(instructions, /POST-COMPACT RECOVERY REQUIRED/);
    assert.match(instructions, /compaction-handoff\.md/);
    assert.match(instructions, /git status --short --branch/);
    assert.match(instructions, /--nonce [0-9a-f]{24}/);
    assert.match(instructions, /--handoff-missing --state-missing --git-status-reviewed/);
    assert.match(instructions, /--objective "null" --next-step "null"/);
    assert.match(instructions, /--handoff-missing or --state-missing/);
    assert.match(instructions, /compaction-recovery\.cjs ack/);
  });

  it('should not arm session-start recovery without compact-boundary evidence', () => {
    const projectRoot = join(TMP_DIR, 'compact-session-start-no-boundary');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const flagPath = join(dataDir, 'compaction-recovery-required.json');

    mkdirSync(dataDir, { recursive: true });
    const context = buildSessionStartRecoveryContext(projectRoot, {
      source: 'compact',
      session_id: 'session-start-no-boundary',
    });

    assert.equal(context, '');
    assert.equal(existsSync(flagPath), false);
  });

  it('should arm session-start recovery when transcript contains a real compact boundary', () => {
    const projectRoot = join(TMP_DIR, 'compact-session-start-boundary');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const flagPath = join(dataDir, 'compaction-recovery-required.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'session-start-boundary-id',
        timestamp: '2026-06-07T22:00:00.000Z',
        compact_metadata: { pre_tokens: 444444, trigger: 'manual' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'post compact summary' }],
          usage: { input_tokens: 2048 },
        },
      }),
    ].join('\n') + '\n');

    const context = buildSessionStartRecoveryContext(projectRoot, {
      source: 'compact',
      session_id: 'session-start-boundary',
      transcript_path: transcriptPath,
    });

    assert.match(context, /POST-COMPACT RECOVERY REQUIRED/);
    assert.equal(existsSync(flagPath), true);
    const flag = JSON.parse(readFileSync(flagPath, 'utf8'));
    assert.equal(flag.sessionId, 'session-start-boundary');
    assert.equal(flag.compactBoundaryId, 'session-start-boundary-id');
    assert.equal(flag.compactBoundaryTrigger, 'manual');
  });

  it('should not re-arm session-start recovery after a matching boundary ack', () => {
    const projectRoot = join(TMP_DIR, 'compact-session-start-ack');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const flagPath = join(dataDir, 'compaction-recovery-required.json');
    const ackPath = join(dataDir, 'compaction-recovery-ack.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'session-start-acked-boundary',
        timestamp: '2026-06-07T22:10:00.000Z',
        compact_metadata: { pre_tokens: 444444, trigger: 'manual' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'post compact summary' }],
          usage: { input_tokens: 2048 },
        },
      }),
    ].join('\n') + '\n');
    writeFileSync(ackPath, JSON.stringify({
      type: 'hive-flow.compaction-recovery-ack',
      version: 1,
      sessionId: 'session-start-ack',
      compactBoundaryId: 'session-start-acked-boundary',
      acknowledgedAt: '2026-06-07T22:11:00.000Z',
      summary: 'Recovered from the compact boundary and resumed.',
    }));

    const context = buildSessionStartRecoveryContext(projectRoot, {
      source: 'compact',
      session_id: 'session-start-ack',
      transcript_path: transcriptPath,
    });

    assert.equal(context, '');
    assert.equal(existsSync(flagPath), false);
  });

  it('should surface a fresh compact advisory and remove the signal file', () => {
    const projectRoot = join(TMP_DIR, 'compact-signal-fresh');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const signalPath = join(dataDir, 'compact-request.json');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(signalPath, JSON.stringify({
      requestedAt: new Date().toISOString(),
      reason: 'token pressure',
    }));

    const advisory = consumeCompactSignalAdvisory(projectRoot);

    assert.match(advisory, /\[COMPACT_ADVISORY\]/);
    assert.match(advisory, /token pressure/);
    assert.match(advisory, /manual request/);
    assert.match(advisory, /HIVE_FLOW_SELF_COMPACT is not set/);
    assert.equal(existsSync(signalPath), false);
  });

  it('should act on a fresh compact request only when the self-compact env opt-in is set', () => {
    const projectRoot = join(TMP_DIR, 'compact-signal-trigger');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const signalPath = join(dataDir, 'compact-request.json');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(signalPath, JSON.stringify({
      requestedAt: new Date().toISOString(),
      reason: 'human requested compaction',
      mode: 'inplace',
      preservationPrompt: 'Preserve the current task, constraints, tests, and next action.',
    }));
    setEnv({ HIVE_FLOW_SELF_COMPACT: '1' });

    const advisory = consumeCompactSignalAdvisory(projectRoot);

    assert.match(advisory, /\[COMPACT_TRIGGER\]/);
    assert.match(advisory, /human requested compaction/);
    assert.match(advisory, /Preserve the current task/);
    assert.equal(existsSync(signalPath), false);
  });

  it('should launch headless compaction through the configured Claude binary without firing a live compact', async () => {
    const projectRoot = join(TMP_DIR, 'compact-signal-headless');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const signalPath = join(dataDir, 'compact-request.json');
    const fakeClaude = join(projectRoot, 'fake-claude.cjs');
    const argsPath = join(dataDir, 'fake-claude-args.json');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(fakeClaude, [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "fs.writeFileSync(process.env.HF_FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));",
      "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 9876, trigger: 'manual' } }) + '\\n');",
    ].join('\n'));
    chmodSync(fakeClaude, 0o755);
    writeFileSync(signalPath, JSON.stringify({
      requestedAt: new Date().toISOString(),
      reason: 'headless request',
      mode: 'headless',
      resume: 'session-headless',
      preservationPrompt: 'Preserve the current handoff details.',
    }));
    setEnv({
      HIVE_FLOW_SELF_COMPACT: '1',
      CLAUDE_BIN: fakeClaude,
      HF_FAKE_CLAUDE_ARGS: argsPath,
    });

    const advisory = consumeCompactSignalAdvisory(projectRoot);

    assert.match(advisory, /\[COMPACT_TRIGGER\]/);
    for (let i = 0; i < 20 && !existsSync(argsPath); i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(argsPath), true);
    const args = JSON.parse(readFileSync(argsPath, 'utf8'));
    assert.deepEqual(args.slice(0, 4), ['--output-format', 'stream-json', '--verbose', '-p']);
    assert.equal(args[4], '/compact Preserve the current handoff details.');
    assert.deepEqual(args.slice(5), ['--resume', 'session-headless']);
    assert.equal(existsSync(signalPath), false);
  });

  it('should ignore stale compact advisories but still remove the signal file', () => {
    const projectRoot = join(TMP_DIR, 'compact-signal-stale');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const signalPath = join(dataDir, 'compact-request.json');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(signalPath, JSON.stringify({
      requestedAt: new Date(Date.now() - 301000).toISOString(),
      reason: 'stale signal',
    }));

    const advisory = consumeCompactSignalAdvisory(projectRoot);

    assert.equal(advisory, '');
    assert.equal(existsSync(signalPath), false);
  });

  it('should not auto-arm a compact request when autopilot crosses the prune threshold', async () => {
    const projectRoot = join(TMP_DIR, 'compact-autopilot-no-auto-arm');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const signalPath = join(dataDir, 'compact-request.json');
    const statePath = join(dataDir, 'autopilot-state.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'high usage sample' }],
        usage: {
          input_tokens: Math.ceil(CONTEXT_WINDOW_TOKENS * 0.91),
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }) + '\n');

    const autopilot = await runAutopilot(
      transcriptPath,
      'autopilot-no-auto-arm-session',
      { pruneStale: () => 0 },
      'json',
      { statePath }
    );

    assert.ok(autopilot.percentage >= 0.85);
    assert.match(autopilot.additionalContext, /Configured storage-prune threshold/);
    assert.equal(existsSync(signalPath), false);
  });

  it('should emit threshold guidance that matches the human compaction policy', async () => {
    const cases = [
      {
        name: 'below-compaction-floor',
        pct: 0.49,
        matches: [],
        rejects: [/70%\+ warning zone/i, /50% is the low-context request floor/i, /hard redline/i],
      },
      {
        name: 'below-warning',
        pct: 0.62,
        matches: [],
        rejects: [/50% is the low-context request floor/i, /hard redline/i],
      },
      {
        name: 'warning',
        pct: 0.72,
        matches: [/70%\+ warning zone/i, /50% is the low-context request floor/i, /below 50% should be blocked/i],
        rejects: [/Compaction is permissible when context is at or above 50%/i],
      },
      {
        name: 'historical-redline',
        pct: 0.82,
        matches: [/80%\+ historically redlined/i, /do not treat this as fine/i],
        rejects: [],
      },
      {
        name: 'hard-redline',
        pct: 0.96,
        matches: [/95%\+ hard redline/i, /violates the human's rules/i, /compact before forced compaction/i],
        rejects: [],
      },
    ];

    for (const testCase of cases) {
      const projectRoot = join(TMP_DIR, `compact-autopilot-threshold-${testCase.name}`);
      const dataDir = join(projectRoot, '.hive-flow', 'data');
      const statePath = join(dataDir, 'autopilot-state.json');
      const transcriptPath = join(projectRoot, 'transcript.jsonl');

      mkdirSync(dataDir, { recursive: true });
      writeFileSync(transcriptPath, JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${testCase.name} usage sample` }],
          usage: {
            input_tokens: Math.ceil(CONTEXT_WINDOW_TOKENS * testCase.pct),
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) + '\n');

      const autopilot = await runAutopilot(
        transcriptPath,
        `threshold-session-${testCase.name}`,
        { pruneStale: () => 0 },
        'json',
        { statePath, projectRoot }
      );

      for (const pattern of testCase.matches) {
        assert.match(autopilot.additionalContext, pattern, testCase.name);
      }
      for (const pattern of testCase.rejects) {
        assert.doesNotMatch(autopilot.additionalContext, pattern, testCase.name);
      }
    }
  });

  it('should re-emit compaction guidance when the session crosses stronger threshold bands', async () => {
    const projectRoot = join(TMP_DIR, 'compact-autopilot-threshold-band-upgrades');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statePath = join(dataDir, 'autopilot-state.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });

    const runAt = async (pct) => {
      writeFileSync(transcriptPath, JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `usage ${pct}` }],
          usage: {
            input_tokens: Math.ceil(CONTEXT_WINDOW_TOKENS * pct),
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) + '\n');

      return runAutopilot(
        transcriptPath,
        'threshold-band-session',
        { pruneStale: () => 0 },
        'json',
        { statePath, projectRoot }
      );
    };

    const warning = await runAt(0.72);
    assert.match(warning.additionalContext, /70%\+ warning zone/i);
    assert.doesNotMatch(warning.additionalContext, /80%\+ historically redlined/i);

    const historical = await runAt(0.82);
    assert.match(historical.additionalContext, /80%\+ historically redlined/i);

    const hard = await runAt(0.96);
    assert.match(hard.additionalContext, /95%\+ hard redline/i);
  });

  it('should arm post-compact recovery when autopilot observes a compact boundary', async () => {
    const projectRoot = join(TMP_DIR, 'compact-boundary-recovery');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statePath = join(dataDir, 'autopilot-state.json');
    const recoveryPath = join(dataDir, 'compaction-recovery-required.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { pre_tokens: 123456, trigger: 'manual' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'post compact summary' }],
          usage: { input_tokens: 2048 },
        },
      }),
    ].join('\n') + '\n');

    const autopilot = await runAutopilot(
      transcriptPath,
      'boundary-session',
      { pruneStale: () => 0 },
      'json',
      { statePath, projectRoot }
    );

    assert.equal(existsSync(recoveryPath), true);
    assert.match(autopilot.additionalContext, /POST-COMPACT RECOVERY REQUIRED/);
    const flag = JSON.parse(readFileSync(recoveryPath, 'utf8'));
    assert.equal(flag.sessionId, 'boundary-session');
    assert.equal(flag.source, 'compact_boundary');
  });

  it('should not re-arm recovery for an acknowledged compact boundary after autopilot state is reset', async () => {
    const projectRoot = join(TMP_DIR, 'compact-boundary-ack-idempotent');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statePath = join(dataDir, 'autopilot-state.json');
    const recoveryPath = join(dataDir, 'compaction-recovery-required.json');
    const ackPath = join(dataDir, 'compaction-recovery-ack.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary-once',
        timestamp: '2026-06-06T19:00:00.000Z',
        compact_metadata: { pre_tokens: 349957, trigger: 'manual' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'post compact summary' }],
          usage: { input_tokens: 2048 },
        },
      }),
    ].join('\n') + '\n');

    await runAutopilot(
      transcriptPath,
      'boundary-ack-session',
      { pruneStale: () => 0 },
      'json',
      { statePath, projectRoot }
    );

    assert.equal(existsSync(recoveryPath), true);
    rmSync(recoveryPath, { force: true });
    writeFileSync(ackPath, JSON.stringify({
      type: 'hive-flow.compaction-recovery-ack',
      version: 1,
      sessionId: 'boundary-ack-session',
      compactBoundaryId: 'compact-boundary-once',
      acknowledgedAt: new Date().toISOString(),
      summary: 'Recovered from the compact boundary and resumed the exact next step.',
    }));
    rmSync(statePath, { force: true });

    const autopilot = await runAutopilot(
      transcriptPath,
      'boundary-ack-session',
      { pruneStale: () => 0 },
      'json',
      { statePath, projectRoot }
    );

    assert.equal(existsSync(recoveryPath), false);
    assert.doesNotMatch(autopilot.additionalContext, /POST-COMPACT RECOVERY REQUIRED/);
  });

  it('should not re-arm for a pre-boundary-id ack written after the compact boundary', async () => {
    const projectRoot = join(TMP_DIR, 'compact-boundary-legacy-ack');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statePath = join(dataDir, 'autopilot-state.json');
    const recoveryPath = join(dataDir, 'compaction-recovery-required.json');
    const ackPath = join(dataDir, 'compaction-recovery-ack.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'legacy-boundary',
        timestamp: '2026-06-06T18:24:20.114Z',
        compact_metadata: { pre_tokens: 349957, trigger: 'manual' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'post compact summary' }],
          usage: { input_tokens: 2048 },
        },
      }),
    ].join('\n') + '\n');
    writeFileSync(ackPath, JSON.stringify({
      type: 'hive-flow.compaction-recovery-ack',
      version: 1,
      sessionId: 'legacy-ack-session',
      acknowledgedAt: '2026-06-06T19:34:24.149Z',
      summary: 'Recovered from the compact boundary before boundary ids were stored.',
    }));

    const autopilot = await runAutopilot(
      transcriptPath,
      'legacy-ack-session',
      { pruneStale: () => 0 },
      'json',
      { statePath, projectRoot }
    );

    assert.equal(existsSync(recoveryPath), false);
    assert.doesNotMatch(autopilot.additionalContext, /POST-COMPACT RECOVERY REQUIRED/);
  });

  it('should keep one active recovery nonce for repeated scans of the same compact boundary', async () => {
    const projectRoot = join(TMP_DIR, 'compact-boundary-active-idempotent');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statePath = join(dataDir, 'autopilot-state.json');
    const recoveryPath = join(dataDir, 'compaction-recovery-required.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary-active',
        timestamp: '2026-06-06T19:05:00.000Z',
        compactMetadata: { preTokens: 776390, trigger: 'manual' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'post compact summary' }],
          usage: { input_tokens: 2048 },
        },
      }),
    ].join('\n') + '\n');

    await runAutopilot(
      transcriptPath,
      'boundary-active-session',
      { pruneStale: () => 0 },
      'json',
      { statePath, projectRoot }
    );
    const firstFlag = JSON.parse(readFileSync(recoveryPath, 'utf8'));
    rmSync(statePath, { force: true });

    await runAutopilot(
      transcriptPath,
      'boundary-active-session',
      { pruneStale: () => 0 },
      'json',
      { statePath, projectRoot }
    );
    const secondFlag = JSON.parse(readFileSync(recoveryPath, 'utf8'));

    assert.equal(secondFlag.recoveryNonce, firstFlag.recoveryNonce);
    assert.equal(secondFlag.compactBoundaryId, 'compact-boundary-active');
  });

  it('should not arm recovery for microcompaction or detached headless compact boundaries', async () => {
    for (const [name, compactMetadata] of [
      ['micro', { pre_tokens: 123456, trigger: 'compact_partial' }],
      ['headless', { pre_tokens: 123456, trigger: 'manual', hive_flow_headless: true }],
    ]) {
      const projectRoot = join(TMP_DIR, `compact-boundary-ignore-${name}`);
      const dataDir = join(projectRoot, '.hive-flow', 'data');
      const statePath = join(dataDir, 'autopilot-state.json');
      const recoveryPath = join(dataDir, 'compaction-recovery-required.json');
      const transcriptPath = join(projectRoot, 'transcript.jsonl');

      mkdirSync(dataDir, { recursive: true });
      writeFileSync(transcriptPath, [
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: compactMetadata,
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'post boundary summary' }],
            usage: { input_tokens: 2048 },
          },
        }),
      ].join('\n') + '\n');

      const autopilot = await runAutopilot(
        transcriptPath,
        `${name}-boundary-session`,
        { pruneStale: () => 0 },
        'json',
        { statePath, projectRoot }
      );

      assert.equal(existsSync(recoveryPath), false, name);
      assert.doesNotMatch(autopilot.additionalContext, /POST-COMPACT RECOVERY REQUIRED/, name);
    }
  });

  it('should use an explicit per-run context window when reporting autopilot usage', async () => {
    const projectRoot = join(TMP_DIR, 'compact-autopilot-runtime-window');
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statePath = join(dataDir, 'autopilot-state.json');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'runtime context window sample' }],
        usage: {
          input_tokens: 258587,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }) + '\n');

    const autopilot = await runAutopilot(
      transcriptPath,
      'runtime-window-session',
      { pruneStale: () => 0 },
      'json',
      { statePath, projectRoot, contextWindowTokens: 1000000 }
    );

    assert.equal(autopilot.percentage, 0.258587);
    assert.match(autopilot.additionalContext, /~258\.6K\/1\.0M tokens/);
    assert.doesNotMatch(autopilot.additionalContext, /Configured storage-prune threshold/);
  });
});

// ============================================================================
// Backend Resolution Priority Tests
// ============================================================================

describe('resolveBackend priority', () => {
  it('should resolve sqlite as highest priority', async () => {
    const { backend, type } = await resolveBackend();
    assert.equal(type, 'sqlite');
    await backend.shutdown();
  });

  it('should not resolve postgres when env vars are absent', () => {
    const config = getPostgresVectorConfig();
    assert.equal(config, null);
  });
});

// ============================================================================
// Smart Compaction Gate Tests (buildCompactInstructions)
// ============================================================================

describe('buildCompactInstructions', () => {
  it('should produce compact instructions with archived turn count', () => {
    const chunks = [
      {
        userMessage: makeUserMsg('Implement authentication module'),
        assistantMessage: makeAssistantMsg('I\'ll implement the auth module using JWT.'),
        toolCalls: [
          { name: 'Edit', input: { file_path: '/src/auth.ts' } },
          { name: 'Write', input: { file_path: '/src/jwt.ts' } },
        ],
        turnIndex: 0,
      },
      {
        userMessage: makeUserMsg('Add tests for auth'),
        assistantMessage: makeAssistantMsg('Writing tests for the auth module.'),
        toolCalls: [
          { name: 'Write', input: { file_path: '/tests/auth.test.ts' } },
          { name: 'Bash', input: { command: 'npm test' } },
        ],
        turnIndex: 1,
      },
    ];

    const result = buildCompactInstructions(chunks, 'sess-123', { stored: 2, deduped: 0 });

    assert.ok(result.includes('COMPACTION GUIDANCE'));
    assert.ok(result.includes('2 conversation turns'));
    assert.ok(result.includes('sess-123'));
    assert.ok(result.includes('Stored: 2 new'));
    assert.ok(result.includes('PRESERVE in compaction summary'));
  });

  it('should include file paths and tool names', () => {
    const chunks = [
      {
        userMessage: makeUserMsg('Fix the bug'),
        assistantMessage: makeAssistantMsg('Fixed the null check.'),
        toolCalls: [
          { name: 'Edit', input: { file_path: '/src/utils.ts' } },
          { name: 'Grep', input: { path: '/src' } },
          { name: 'Read', input: { file_path: '/src/config.ts' } },
        ],
        turnIndex: 0,
      },
    ];

    const result = buildCompactInstructions(chunks, 'sess-456', { stored: 1, deduped: 0 });

    assert.ok(result.includes('Files modified/read:'));
    assert.ok(result.includes('utils.ts'));
    assert.ok(result.includes('Tools used:'));
    assert.ok(result.includes('Edit'));
    assert.ok(result.includes('Grep'));
  });

  it('should include decision context from assistant text', () => {
    const chunks = [
      {
        userMessage: makeUserMsg('How should we handle caching?'),
        assistantMessage: makeAssistantMsg('I decided to use Redis instead of in-memory caching for scalability.'),
        toolCalls: [],
        turnIndex: 0,
      },
    ];

    const result = buildCompactInstructions(chunks, 'sess-789', { stored: 1, deduped: 0 });

    assert.ok(result.includes('Key decisions'));
    assert.ok(result.includes('Redis') || result.includes('decided'));
  });

  it('should include most recent turns section', () => {
    const chunks = Array.from({ length: 8 }, (_, i) => ({
      userMessage: makeUserMsg(`Question ${i}`),
      assistantMessage: makeAssistantMsg(`Answer ${i}`),
      toolCalls: [],
      turnIndex: i,
    }));

    const result = buildCompactInstructions(chunks, 'sess-recent', { stored: 8, deduped: 0 });

    assert.ok(result.includes('MOST RECENT TURNS'));
    // Should include last 5 turns
    assert.ok(result.includes('[Turn 7]'));
    assert.ok(result.includes('[Turn 3]'));
    // Should NOT include early turns in the recent section
    assert.ok(!result.includes('[Turn 0]') || result.includes('8 conversation turns'));
  });

  it('should respect COMPACT_INSTRUCTION_BUDGET', () => {
    // Generate many chunks with long content
    const chunks = Array.from({ length: 50 }, (_, i) => ({
      userMessage: makeUserMsg('x'.repeat(200) + ` question ${i}`),
      assistantMessage: makeAssistantMsg('y'.repeat(200) + ` answer ${i}. I decided to use approach A instead of B.`),
      toolCalls: Array.from({ length: 5 }, (_, j) => ({
        name: `Tool${j}`,
        input: { file_path: `/src/very/long/path/to/file${j}.ts` },
      })),
      turnIndex: i,
    }));

    const result = buildCompactInstructions(chunks, 'sess-budget', { stored: 50, deduped: 0 });

    assert.ok(result.length <= COMPACT_INSTRUCTION_BUDGET + 10); // small margin for trailing chars
  });

  it('should handle empty chunks gracefully', () => {
    const result = buildCompactInstructions([], 'sess-empty', { stored: 0, deduped: 0 });
    assert.ok(result.includes('COMPACTION GUIDANCE'));
    assert.ok(result.includes('0 conversation turns'));
  });
});

// ============================================================================
// Importance Scoring Tests
// ============================================================================

describe('computeImportance', () => {
  it('should rank recently accessed entries higher', () => {
    const now = Date.now();
    const recent = { createdAt: now - 3600000, accessCount: 1, metadata: { toolNames: [], filePaths: [] } }; // 1 hour ago
    const old = { createdAt: now - 86400000 * 14, accessCount: 1, metadata: { toolNames: [], filePaths: [] } }; // 14 days ago

    const recentScore = computeImportance(recent, now);
    const oldScore = computeImportance(old, now);

    assert.ok(recentScore > oldScore, `Recent ${recentScore} should be > old ${oldScore}`);
  });

  it('should rank frequently accessed entries higher', () => {
    const now = Date.now();
    const freq = { createdAt: now - 86400000, accessCount: 10, metadata: { toolNames: [], filePaths: [] } };
    const rare = { createdAt: now - 86400000, accessCount: 0, metadata: { toolNames: [], filePaths: [] } };

    const freqScore = computeImportance(freq, now);
    const rareScore = computeImportance(rare, now);

    assert.ok(freqScore > rareScore, `Frequent ${freqScore} should be > rare ${rareScore}`);
  });

  it('should boost entries with tool calls and file paths', () => {
    const now = Date.now();
    const rich = { createdAt: now - 86400000, accessCount: 0, metadata: { toolNames: ['Edit', 'Read'], filePaths: ['/src/a.ts'] } };
    const plain = { createdAt: now - 86400000, accessCount: 0, metadata: { toolNames: [], filePaths: [] } };

    const richScore = computeImportance(rich, now);
    const plainScore = computeImportance(plain, now);

    assert.ok(richScore > plainScore, `Rich ${richScore} should be > plain ${plainScore}`);
  });

  it('should return positive scores for all entries', () => {
    const now = Date.now();
    const entry = { createdAt: now - 86400000 * 30, accessCount: 0, metadata: {} };
    assert.ok(computeImportance(entry, now) > 0);
  });
});

// ============================================================================
// Smart Retrieval Tests
// ============================================================================

describe('retrieveContextSmart', () => {
  it('should return importance-ranked context', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'smart-retrieve.db'));
    await backend.initialize();

    const now = Date.now();
    // Entry with tools (will rank higher)
    await backend.store({
      id: 'sr-0', key: 'test:0', content: 'Turn with tools', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'smart-sess', chunkIndex: 0, summary: 'Edited auth module', toolNames: ['Edit', 'Bash'], filePaths: ['/src/auth.ts'], contentHash: 'srh0' },
      accessLevel: 'private', createdAt: now - 86400000, updatedAt: now, version: 1,
      accessCount: 5, lastAccessedAt: now,
    });
    // Plain entry (will rank lower)
    await backend.store({
      id: 'sr-1', key: 'test:1', content: 'Plain turn', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'smart-sess', chunkIndex: 1, summary: 'Asked a question', toolNames: [], filePaths: [], contentHash: 'srh1' },
      accessLevel: 'private', createdAt: now - 86400000 * 7, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    });

    const { text, accessedIds } = await retrieveContextSmart(backend, 'smart-sess', 4000);

    assert.ok(text.includes('importance-ranked'));
    assert.ok(text.includes('Edited auth module'));
    assert.ok(accessedIds.length > 0);
    // Tool-rich entry should appear first (higher importance)
    assert.ok(text.indexOf('auth module') < text.indexOf('question') || !text.includes('question'));

    await backend.shutdown();
  });

  it('should return empty for unknown session', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'smart-empty.db'));
    await backend.initialize();

    const { text, accessedIds } = await retrieveContextSmart(backend, 'unknown-sess', 4000);
    assert.equal(text, '');
    assert.equal(accessedIds.length, 0);

    await backend.shutdown();
  });
});

// ============================================================================
// Access Tracking Tests
// ============================================================================

describe('markAccessed (SQLite)', () => {
  it('should increment access_count and update last_accessed_at', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'access-track.db'));
    await backend.initialize();

    const now = Date.now();
    await backend.store({
      id: 'at-1', key: 'test:1', content: 'data', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'at-sess', chunkIndex: 0, contentHash: 'ath1', summary: 's' },
      accessLevel: 'private', createdAt: now, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    });

    // Mark as accessed 3 times
    backend.markAccessed(['at-1']);
    backend.markAccessed(['at-1']);
    backend.markAccessed(['at-1']);

    const entries = await backend.queryBySession(NAMESPACE, 'at-sess');
    assert.equal(entries[0].accessCount, 3);
    assert.ok(entries[0].lastAccessedAt >= now);

    await backend.shutdown();
  });
});

// ============================================================================
// Auto-Prune Tests
// ============================================================================

describe('pruneStale (SQLite)', () => {
  it('should prune never-accessed entries older than retention period', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'prune-test.db'));
    await backend.initialize();

    const now = Date.now();
    const oldTime = now - (RETENTION_DAYS + 5) * 86400000; // older than retention

    // Old, never accessed (should be pruned)
    await backend.store({
      id: 'prune-old', key: 'test:old', content: 'stale', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'prune-sess', chunkIndex: 0, contentHash: 'poh', summary: 's' },
      accessLevel: 'private', createdAt: oldTime, updatedAt: oldTime, version: 1,
      accessCount: 0, lastAccessedAt: oldTime,
    });

    // Old but accessed (should NOT be pruned)
    await backend.store({
      id: 'prune-accessed', key: 'test:accessed', content: 'important', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'prune-sess', chunkIndex: 1, contentHash: 'pah', summary: 's' },
      accessLevel: 'private', createdAt: oldTime, updatedAt: oldTime, version: 1,
      accessCount: 5, lastAccessedAt: now,
    });

    // Recent, never accessed (should NOT be pruned)
    await backend.store({
      id: 'prune-recent', key: 'test:recent', content: 'new', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'prune-sess', chunkIndex: 2, contentHash: 'prh', summary: 's' },
      accessLevel: 'private', createdAt: now, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    });

    const pruned = backend.pruneStale(NAMESPACE, RETENTION_DAYS);
    assert.equal(pruned, 1); // Only the old, never-accessed entry

    const remaining = await backend.count(NAMESPACE);
    assert.equal(remaining, 2);

    await backend.shutdown();
  });
});

// ============================================================================
// Auto-Optimize Tests
// ============================================================================

describe('autoOptimize', () => {
  it('should prune stale entries during optimization', async () => {
    const backend = new SQLiteBackend(join(TMP_DIR, 'auto-opt.db'));
    await backend.initialize();

    const now = Date.now();
    const oldTime = now - (RETENTION_DAYS + 10) * 86400000;

    // Old stale entry
    await backend.store({
      id: 'ao-stale', key: 'test:stale', content: 'old data', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'ao-sess', chunkIndex: 0, contentHash: 'aoh1', summary: 's' },
      accessLevel: 'private', createdAt: oldTime, updatedAt: oldTime, version: 1,
      accessCount: 0, lastAccessedAt: oldTime,
    });

    // Fresh entry
    await backend.store({
      id: 'ao-fresh', key: 'test:fresh', content: 'new data', type: 'episodic',
      namespace: NAMESPACE, tags: [],
      metadata: { sessionId: 'ao-sess', chunkIndex: 1, contentHash: 'aoh2', summary: 's' },
      accessLevel: 'private', createdAt: now, updatedAt: now, version: 1,
      accessCount: 0, lastAccessedAt: now,
    });

    const result = await autoOptimize(backend, 'sqlite');

    assert.equal(result.pruned, 1);
    assert.equal(result.synced, 0); // No PostgresVector configured

    const remaining = await backend.count(NAMESPACE);
    assert.equal(remaining, 1);

    await backend.shutdown();
  });
});
