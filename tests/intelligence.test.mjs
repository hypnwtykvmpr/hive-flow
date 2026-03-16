/**
 * Tests for .claude/helpers/intelligence.cjs
 * COV-005 — node:test suite
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Run tests in an isolated temp directory so no real .hive-flow data is touched
const testDir = join(tmpdir(), 'hive-flow-intel-test-' + process.pid);
mkdirSync(testDir, { recursive: true });
const origCwd = process.cwd();
process.chdir(testDir);

const require = createRequire(import.meta.url);
const intelligence = require('../.claude/helpers/intelligence.cjs');

describe('intelligence.cjs', () => {
  test('exports required functions', () => {
    assert.strictEqual(typeof intelligence.init, 'function');
    assert.strictEqual(typeof intelligence.getContext, 'function');
    assert.strictEqual(typeof intelligence.recordEdit, 'function');
    assert.strictEqual(typeof intelligence.feedback, 'function');
    assert.strictEqual(typeof intelligence.consolidate, 'function');
    assert.strictEqual(typeof intelligence.stats, 'function');
  });

  test('init returns nodes/edges counts', () => {
    const result = intelligence.init();
    assert.ok(typeof result === 'object', 'init should return an object');
    assert.ok('nodes' in result, 'result should have nodes');
    assert.ok('edges' in result, 'result should have edges');
    assert.strictEqual(typeof result.nodes, 'number');
    assert.strictEqual(typeof result.edges, 'number');
  });

  test('getContext returns null for empty prompt', () => {
    const result = intelligence.getContext('');
    assert.strictEqual(result, null);
  });

  test('getContext returns null for null prompt', () => {
    const result = intelligence.getContext(null);
    assert.strictEqual(result, null);
  });

  test('getContext returns null or string for real query', () => {
    intelligence.init();
    const result = intelligence.getContext('authentication patterns JWT');
    assert.ok(result === null || typeof result === 'string', 'should return null or string');
  });

  test('recordEdit does not throw for valid file path', () => {
    assert.doesNotThrow(() => {
      intelligence.recordEdit('/src/mcp-tools/auth.ts');
    });
  });

  test('recordEdit does not throw for undefined', () => {
    assert.doesNotThrow(() => {
      intelligence.recordEdit(undefined);
    });
  });

  test('feedback does not throw for success=true', () => {
    assert.doesNotThrow(() => {
      intelligence.feedback(true);
    });
  });

  test('feedback does not throw for success=false', () => {
    assert.doesNotThrow(() => {
      intelligence.feedback(false);
    });
  });

  test('consolidate returns object with entries/edges/newEntries when no pending file', () => {
    const result = intelligence.consolidate();
    assert.ok(typeof result === 'object', 'consolidate should return an object');
    assert.ok('entries' in result);
    assert.ok('edges' in result);
    assert.ok('newEntries' in result);
  });

  test('consolidate processes recorded edits', () => {
    // Record multiple edits in the same directory to form a pattern cluster
    intelligence.recordEdit(join(testDir, 'src/mcp-tools/hooks.ts'));
    intelligence.recordEdit(join(testDir, 'src/mcp-tools/claims.ts'));
    intelligence.recordEdit(join(testDir, 'src/mcp-tools/terminal.ts'));
    intelligence.feedback(true);
    const result = intelligence.consolidate();
    assert.ok(typeof result.entries === 'number');
    assert.ok(result.entries >= 0);
  });

  test('stats does not throw', () => {
    assert.doesNotThrow(() => {
      intelligence.stats(false);
    });
  });
});

// Cleanup
process.on('exit', () => {
  try {
    process.chdir(origCwd);
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});
