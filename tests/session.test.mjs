/**
 * Tests for .claude/helpers/session.cjs
 * COV-007 — node:test suite
 *
 * Uses a temp CWD so session files don't pollute real project state.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Provide a temp CWD for each test run so session.cjs finds a .hive-flow dir
const testDir = join(tmpdir(), 'hive-flow-session-test-' + process.pid);
mkdirSync(join(testDir, '.hive-flow'), { recursive: true });
const origCwd = process.cwd();
process.chdir(testDir);

const require = createRequire(import.meta.url);

// Re-require fresh each time by busting require cache
function freshSession() {
  const mod = '../.claude/helpers/session.cjs';
  // Clear cache entry
  const resolvedPath = require.resolve(mod);
  delete require.cache[resolvedPath];
  return require(mod);
}

describe('session.cjs', () => {
  let session;

  beforeEach(() => {
    // Clean up any leftover session file
    const sessionDir = join(testDir, '.hive-flow', 'sessions');
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
    mkdirSync(join(testDir, '.hive-flow'), { recursive: true });
    session = freshSession();
  });

  afterEach(() => {
    const sessionDir = join(testDir, '.hive-flow', 'sessions');
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('exports start, restore, end, status, metric commands', () => {
    assert.strictEqual(typeof session.start, 'function');
    assert.strictEqual(typeof session.restore, 'function');
    assert.strictEqual(typeof session.end, 'function');
    assert.strictEqual(typeof session.status, 'function');
    assert.strictEqual(typeof session.metric, 'function');
  });

  test('start returns a session object with an id', () => {
    const result = session.start();
    assert.ok(result, 'start should return a session');
    assert.ok(typeof result.id === 'string', 'session should have string id');
    assert.ok(result.id.startsWith('session-'), 'id should start with "session-"');
  });

  test('start returns session with metrics initialized to zero', () => {
    const result = session.start();
    assert.deepStrictEqual(result.metrics, { edits: 0, commands: 0, tasks: 0, errors: 0 });
  });

  test('start returns session with startedAt timestamp', () => {
    const result = session.start();
    assert.ok(typeof result.startedAt === 'string', 'startedAt should be a string');
    const parsed = Date.parse(result.startedAt);
    assert.ok(!isNaN(parsed), 'startedAt should be a valid date');
  });

  test('restore returns null when no session exists', () => {
    const result = session.restore();
    assert.strictEqual(result, null);
  });

  test('restore returns session after start', () => {
    const started = session.start();
    const restored = session.restore();
    assert.ok(restored, 'restore should return session');
    assert.strictEqual(restored.id, started.id);
    assert.ok(typeof restored.restoredAt === 'string', 'restoredAt should be set');
  });

  test('status returns null when no session exists', () => {
    const result = session.status();
    assert.strictEqual(result, null);
  });

  test('status returns session when one is active', () => {
    const started = session.start();
    const statusResult = session.status();
    assert.ok(statusResult, 'status should return session');
    assert.strictEqual(statusResult.id, started.id);
  });

  test('end returns null when no session exists', () => {
    const result = session.end();
    assert.strictEqual(result, null);
  });

  test('end returns session with endedAt and duration', () => {
    session.start();
    const ended = session.end();
    assert.ok(ended, 'end should return the session');
    assert.ok(typeof ended.endedAt === 'string', 'endedAt should be set');
    assert.ok(typeof ended.duration === 'number', 'duration should be a number');
    assert.ok(ended.duration >= 0, 'duration should be non-negative');
  });

  test('metric returns null when no session exists', () => {
    const result = session.metric('edits');
    assert.strictEqual(result, null);
  });

  test('metric increments the named counter', () => {
    session.start();
    const result = session.metric('edits');
    assert.ok(result, 'metric should return session');
    assert.strictEqual(result.metrics.edits, 1);
  });

  test('metric does not throw for unknown metric name', () => {
    session.start();
    assert.doesNotThrow(() => {
      session.metric('unknownMetric');
    });
  });
});

// Cleanup on exit
process.on('exit', () => {
  try {
    process.chdir(origCwd);
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});
