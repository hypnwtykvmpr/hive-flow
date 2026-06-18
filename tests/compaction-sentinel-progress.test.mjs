/**
 * Regression: d7rA-013 — extractHiveSentinelState must derive workersDone /
 * workersReported / lastHeartbeat from the fields the watcher actually writes.
 *
 * The watcher (scripts/hive-watcher.cjs writeProgressFile) emits:
 *   completedCount, runningCount, failedCount, idleCount, terminatedCount,
 *   workerCount, allComplete, ownerSessionId, updatedAt, watcherPid, hiveId
 *
 * It does NOT emit workersReported or workersDone. Before the fix,
 * extractHiveSentinelState returned 0/0 for those fields on every real
 * watcher file, making compaction-restored sentinel state useless.
 *
 * After the fix the reader derives:
 *   workersDone      <- completedCount
 *   workersReported  <- workerCount, or all watcher buckets when workerCount is absent
 *   lastHeartbeat    <- updatedAt (the watcher updates this on every write)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync,
  existsSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, '.claude/helpers/compaction-state-hook.mjs');

// ---------------------------------------------------------------------------
// Shim to load extractHiveSentinelState with a controlled PROJECT_DIR
// ---------------------------------------------------------------------------

/**
 * Extract the extractHiveSentinelState function body from the source and
 * run it in a vm context where PROJECT_DIR is our temp dir.
 */
function loadExtractFn(projectDir) {
  const src = readFileSync(SCRIPT, 'utf8');

  // Find the function — it must exist after our fix.
  const fnMatch = src.match(/function extractHiveSentinelState\(\)\s*\{[\s\S]*?\n\}/);
  if (!fnMatch) throw new Error('extractHiveSentinelState not found in ' + SCRIPT);

  const shim = `
    'use strict';
    const { join } = require('path');
    const { existsSync, readdirSync, readFileSync } = require('fs');
    const PROJECT_DIR = ${JSON.stringify(projectDir)};
    ${fnMatch[0]}
    module.exports = { extractHiveSentinelState };
  `;

  const mod = { exports: {} };
  const _req = createRequire(fileURLToPath(import.meta.url));
  const ctx = {
    require: _req, module: mod, exports: mod.exports,
    __filename: SCRIPT, __dirname: dirname(SCRIPT),
    process, console, Buffer,
  };
  vm.runInNewContext(shim, ctx, { filename: SCRIPT + '.shim' });
  return ctx.module.exports.extractHiveSentinelState;
}

// ---------------------------------------------------------------------------
// Helper: write a realistic watcher-style progress file
// (uses only the fields hive-watcher.cjs writeProgressFile emits)
// ---------------------------------------------------------------------------

function writeWatcherProgress(projectDir, hiveId, fields) {
  const dataDir = join(projectDir, '.hive-flow', 'data');
  mkdirSync(dataDir, { recursive: true });
  const sanitized = hiveId.replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '');
  const data = {
    hiveId,
    watcherPid: process.pid,
    status: 'active',
    updatedAt: new Date().toISOString(),
    ...fields,
  };
  writeFileSync(
    join(dataDir, `watcher-${sanitized}.json`),
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let tempDirs = [];
beforeEach(() => { tempDirs = []; });
afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeTempDir() {
  const d = mkdtempSync(join(tmpdir(), 'sentinel-progress-test-'));
  tempDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compaction sentinel progress field alignment (d7rA-013)', () => {
  it('derives non-zero workersDone from completedCount in a real watcher-format file', () => {
    const projectDir = makeTempDir();

    writeWatcherProgress(projectDir, 'test/hive-01', {
      completedCount: 3,
      runningCount: 1,
      failedCount: 1,
      idleCount: 0,
      terminatedCount: 0,
      workerCount: 5,
      allComplete: false,
    });

    const extract = loadExtractFn(projectDir);
    const watchers = extract();

    assert.ok(Array.isArray(watchers) && watchers.length === 1,
      'should return 1 watcher entry');
    const w = watchers[0];

    assert.equal(w.workersDone, 3,
      `workersDone should equal completedCount (3), got ${w.workersDone}`);
    assert.equal(w.workersReported, 5,
      `workersReported should use workerCount as total denominator (5), got ${w.workersReported}`);
    assert.ok(w.lastHeartbeat !== null && typeof w.lastHeartbeat === 'string',
      'lastHeartbeat must be non-null string derived from updatedAt');
  });

  it('returns workersDone=0 only when completedCount is genuinely 0', () => {
    const projectDir = makeTempDir();

    writeWatcherProgress(projectDir, 'test/hive-02', {
      completedCount: 0,
      runningCount: 3,
      failedCount: 0,
      idleCount: 0,
      terminatedCount: 0,
      workerCount: 3,
      allComplete: false,
    });

    const extract = loadExtractFn(projectDir);
    const watchers = extract();

    assert.ok(Array.isArray(watchers) && watchers.length === 1);
    const w = watchers[0];
    assert.equal(w.workersDone, 0, 'workersDone=0 correct when completedCount=0');
    assert.equal(w.workersReported, 3,
      'workersReported should include running workers via workerCount');
    assert.ok(w.lastHeartbeat !== null, 'lastHeartbeat must derive from updatedAt');
  });

  it('honours explicit workersReported/workersDone when present (backward compat)', () => {
    const projectDir = makeTempDir();

    // A hypothetical future watcher that also writes the old field names explicitly.
    writeWatcherProgress(projectDir, 'test/hive-03', {
      completedCount: 2,
      failedCount: 0,
      terminatedCount: 0,
      workerCount: 4,
      workersReported: 99,
      workersDone: 77,
    });

    const extract = loadExtractFn(projectDir);
    const watchers = extract();

    assert.ok(Array.isArray(watchers) && watchers.length === 1);
    const w = watchers[0];
    assert.equal(w.workersDone, 77,
      'explicit workersDone must be honoured over derived value');
    assert.equal(w.workersReported, 99,
      'explicit workersReported must be honoured over derived value');
  });

  it('falls back to workerCount for workersReported when all component fields are absent', () => {
    const projectDir = makeTempDir();

    // Very old watcher file: only has workerCount and updatedAt (no completedCount etc.)
    writeWatcherProgress(projectDir, 'test/hive-04', {
      workerCount: 6,
      allComplete: false,
    });

    const extract = loadExtractFn(projectDir);
    const watchers = extract();

    assert.ok(Array.isArray(watchers) && watchers.length === 1);
    const w = watchers[0];
    assert.equal(w.workersDone, 0,
      'workersDone=0 when completedCount absent');
    assert.equal(w.workersReported, 6,
      'workersReported falls back to workerCount when component fields absent');
  });

  it('derives workersReported from all status buckets when workerCount is absent', () => {
    const projectDir = makeTempDir();

    writeWatcherProgress(projectDir, 'test/hive-04b', {
      completedCount: 1,
      runningCount: 2,
      failedCount: 1,
      idleCount: 3,
      terminatedCount: 1,
      allComplete: false,
    });

    const extract = loadExtractFn(projectDir);
    const watchers = extract();

    assert.ok(Array.isArray(watchers) && watchers.length === 1);
    const w = watchers[0];
    assert.equal(w.workersDone, 1,
      'workersDone stays completedCount only');
    assert.equal(w.workersReported, 8,
      'workersReported derives completed+running+failed+idle+terminated when workerCount is absent');
  });

  it('includes a real lastHeartbeat timestamp derived from updatedAt', () => {
    const projectDir = makeTempDir();
    const before = new Date().toISOString();

    writeWatcherProgress(projectDir, 'test/hive-05', {
      completedCount: 1,
      workerCount: 2,
    });

    const extract = loadExtractFn(projectDir);
    const watchers = extract();

    assert.ok(Array.isArray(watchers) && watchers.length === 1);
    const hb = watchers[0].lastHeartbeat;
    assert.ok(hb !== null && hb >= before,
      `lastHeartbeat (${hb}) must be a recent ISO string >= test start (${before})`);
  });
});

// ---------------------------------------------------------------------------
// Source-level assertions
// ---------------------------------------------------------------------------

describe('compaction sentinel source assertions (d7rA-013)', () => {
  it('source derives workersDone from completedCount', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    assert.match(source, /workersDone[\s\S]{0,200}completedCount/,
      'source must derive workersDone from completedCount');
  });

  it('source derives workersReported from total worker count or all status buckets', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    assert.match(source, /workersReported[\s\S]{0,400}workerCount/,
      'source must prefer workerCount for workersReported');
    assert.match(source, /workersReported[\s\S]{0,500}runningCount/,
      'source fallback must include runningCount in workersReported derivation');
    assert.match(source, /workersReported[\s\S]{0,600}idleCount/,
      'source fallback must include idleCount in workersReported derivation');
  });

  it('source does not use the old bare literal fallback', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(
      source,
      /workersReported: raw\.workersReported \|\| 0/,
      'old literal `workersReported: raw.workersReported || 0` must be replaced'
    );
    assert.doesNotMatch(
      source,
      /workersDone: raw\.workersDone \|\| 0/,
      'old literal `workersDone: raw.workersDone || 0` must be replaced'
    );
  });
});
