/**
 * Regressions for hive-cleanup.cjs idle-worker reaping logic.
 *
 * d7rA-003 — Non-queen worker floor:
 *   MIN_WORKERS_PER_HIVE (5) is a NON-QUEEN floor. The queen must be excluded
 *   from the count used to compute keepFromIdle, otherwise a hive with queen +
 *   5 idle workers (= 5 non-queen workers) would terminate one of them, leaving
 *   only 4 non-queen workers — violating the documented guarantee.
 *
 * d7rA-001 — Idle sort key:
 *   Workers must be reaped oldest-idle-first (by idleSince), not
 *   oldest-spawned-first (by spawnedAt). A long-lived worker that just became
 *   idle must not be reaped ahead of a newer worker that has been idle longer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, '.claude/helpers/hive-cleanup.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoMsAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'hive-cleanup-test-'));
}

/**
 * Write a hive.json into a real temp directory and return the projectDir.
 * cleanupIdleAgents reads the filesystem directly, so we need real files.
 * We set IDLE_TIMEOUT_MS extremely low via env to treat all our workers as idle.
 */
function writeHive(hivesDir, hiveId, workers, budget) {
  const hiveDir = join(hivesDir, hiveId);
  mkdirSync(hiveDir, { recursive: true });
  const record = {
    hiveId,
    status: 'active',
    workers,
    budget: budget || { workersAllocated: workers.length },
    audit: [],
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(hiveDir, 'hive.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/**
 * Load cleanupIdleAgents from the script using vm.  The script has no
 * module.exports — it's a pure IIFE.  We strip the IIFE, run the functions in
 * a vm context with __dirname overridden to the temp project dir, then extract
 * cleanupIdleAgents directly from the context.
 *
 * We also override HIVE_FLOW_IDLE_TIMEOUT_MS to 1ms so every worker that has
 * idleSince set is treated as past the idle threshold.
 */
function loadCleanupFn(projectDir) {
  let source = readFileSync(SCRIPT, 'utf8');

  // Strip the trailing IIFE that runs all cleanup and writes to stdout.
  source = source.replace(/\(async \(\) => \{[\s\S]*?\}\)\(\);?\s*$/, '');

  // The module reads IDLE_TIMEOUT_MS from process.env at module load time.
  // We patch it before running the vm.
  const savedEnv = process.env.HIVE_FLOW_IDLE_TIMEOUT_MS;
  process.env.HIVE_FLOW_IDLE_TIMEOUT_MS = '1'; // 1 ms — all idle workers are eligible

  const _require = createRequire(fileURLToPath(import.meta.url));
  const mod = { exports: {} };

  // Override __dirname so that PROJECT_DIR resolves to our temp dir.
  // PROJECT_DIR = path.resolve(__dirname, '..', '..') — so we need
  // __dirname to be projectDir + '/.claude/helpers'
  const fakeHelperDir = join(projectDir, '.claude', 'helpers');
  mkdirSync(fakeHelperDir, { recursive: true });

  const ctx = {
    require: _require,
    module: mod,
    exports: mod.exports,
    __filename: SCRIPT,
    __dirname: fakeHelperDir,
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(source, ctx, { filename: SCRIPT });

  if (savedEnv === undefined) delete process.env.HIVE_FLOW_IDLE_TIMEOUT_MS;
  else process.env.HIVE_FLOW_IDLE_TIMEOUT_MS = savedEnv;

  // The functions are in the vm context, not in module.exports.
  // Access them via the ctx object.
  return ctx.cleanupIdleAgents;
}

// ---------------------------------------------------------------------------
// d7rA-003 tests — non-queen worker floor
// ---------------------------------------------------------------------------

describe('hive-cleanup floor regression (d7rA-003)', () => {
  it('queen + exactly 5 idle workers: terminates ZERO idle workers', async () => {
    const projectDir = makeTempDir();
    const hivesDir = join(projectDir, '.hive-flow', 'hives');
    try {
      // Idle past 1ms threshold
      const IDLE_PAST = isoMsAgo(1000);

      writeHive(hivesDir, 'hive-floor-5', [
        { workerId: 'queen', agentId: 'queen-1', role: 'queen',  status: 'idle', spawnedAt: IDLE_PAST, idleSince: IDLE_PAST },
        { workerId: 'w1',    agentId: 'a1',      role: 'coder',  status: 'idle', spawnedAt: IDLE_PAST, idleSince: IDLE_PAST },
        { workerId: 'w2',    agentId: 'a2',      role: 'coder',  status: 'idle', spawnedAt: IDLE_PAST, idleSince: IDLE_PAST },
        { workerId: 'w3',    agentId: 'a3',      role: 'coder',  status: 'idle', spawnedAt: IDLE_PAST, idleSince: IDLE_PAST },
        { workerId: 'w4',    agentId: 'a4',      role: 'coder',  status: 'idle', spawnedAt: IDLE_PAST, idleSince: IDLE_PAST },
        { workerId: 'w5',    agentId: 'a5',      role: 'coder',  status: 'idle', spawnedAt: IDLE_PAST, idleSince: IDLE_PAST },
      ]);

      const cleanupIdleAgents = loadCleanupFn(projectDir);
      assert.equal(typeof cleanupIdleAgents, 'function', 'cleanupIdleAgents must be in vm context');
      const summary = await cleanupIdleAgents();

      assert.equal(
        summary.workersTerminated,
        0,
        `Expected 0 terminations with queen + 5 idle workers, got ${summary.workersTerminated}`
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('queen + 6 idle workers: terminates exactly ONE non-queen worker', async () => {
    const projectDir = makeTempDir();
    const hivesDir = join(projectDir, '.hive-flow', 'hives');
    try {
      const OLDER = isoMsAgo(2000);
      const NEWER = isoMsAgo(1000);

      writeHive(hivesDir, 'hive-floor-6', [
        { workerId: 'queen', agentId: 'queen-1', role: 'queen', status: 'idle', spawnedAt: OLDER, idleSince: OLDER },
        { workerId: 'w1',    agentId: 'a1',      role: 'coder', status: 'idle', spawnedAt: OLDER, idleSince: OLDER },
        { workerId: 'w2',    agentId: 'a2',      role: 'coder', status: 'idle', spawnedAt: NEWER, idleSince: NEWER },
        { workerId: 'w3',    agentId: 'a3',      role: 'coder', status: 'idle', spawnedAt: NEWER, idleSince: NEWER },
        { workerId: 'w4',    agentId: 'a4',      role: 'coder', status: 'idle', spawnedAt: NEWER, idleSince: NEWER },
        { workerId: 'w5',    agentId: 'a5',      role: 'coder', status: 'idle', spawnedAt: NEWER, idleSince: NEWER },
        { workerId: 'w6',    agentId: 'a6',      role: 'coder', status: 'idle', spawnedAt: NEWER, idleSince: NEWER },
      ]);

      const cleanupIdleAgents = loadCleanupFn(projectDir);
      const summary = await cleanupIdleAgents();

      assert.equal(
        summary.workersTerminated,
        1,
        `Expected exactly 1 termination with queen + 6 idle workers, got ${summary.workersTerminated}`
      );
      // The queen must never appear in terminated list
      const terminatedQueens = (summary.terminated || []).filter(e => e.workerId === 'queen');
      assert.equal(terminatedQueens.length, 0, 'Queen must never be terminated');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// d7rA-001 tests — idle sort key
// ---------------------------------------------------------------------------

describe('hive-cleanup idle sort regression (d7rA-001)', () => {
  it('reaps worker with longest idle time first, not oldest spawn time', async () => {
    const projectDir = makeTempDir();
    const hivesDir = join(projectDir, '.hive-flow', 'hives');
    try {
      // Worker A: spawned earliest (oldest spawnedAt) but went idle most recently.
      // Worker B: spawned later but has been idle longer.
      // Correct behaviour (fix): B is reaped. Bug: A is reaped (sorted by spawnedAt).
      //
      // Queen + 6 idle non-queens = 7 workers total → exactly 1 can be terminated.
      // (keepFromIdle = max(0, 5 - 0) = 5; terminatableCount = max(0, 6 - 5) = 1)
      const QUEEN_T = isoMsAgo(5000);
      const A_SPAWNED = isoMsAgo(4000);  // spawned 4s ago
      const A_IDLE    = isoMsAgo(1100);  // idle only 1.1s ago
      const B_SPAWNED = isoMsAgo(2000);  // spawned 2s ago
      const B_IDLE    = isoMsAgo(3000);  // idle 3s ago — longest
      const OTHER_T   = isoMsAgo(1500);

      writeHive(hivesDir, 'hive-sort', [
        { workerId: 'queen', agentId: 'q1', role: 'queen', status: 'idle', spawnedAt: QUEEN_T,   idleSince: QUEEN_T   },
        { workerId: 'wA',    agentId: 'aA', role: 'coder', status: 'idle', spawnedAt: A_SPAWNED, idleSince: A_IDLE    },
        { workerId: 'wB',    agentId: 'aB', role: 'coder', status: 'idle', spawnedAt: B_SPAWNED, idleSince: B_IDLE    },
        { workerId: 'wC',    agentId: 'aC', role: 'coder', status: 'idle', spawnedAt: OTHER_T,   idleSince: OTHER_T   },
        { workerId: 'wD',    agentId: 'aD', role: 'coder', status: 'idle', spawnedAt: OTHER_T,   idleSince: OTHER_T   },
        { workerId: 'wE',    agentId: 'aE', role: 'coder', status: 'idle', spawnedAt: OTHER_T,   idleSince: OTHER_T   },
        { workerId: 'wF',    agentId: 'aF', role: 'coder', status: 'idle', spawnedAt: OTHER_T,   idleSince: OTHER_T   },
      ]);

      const cleanupIdleAgents = loadCleanupFn(projectDir);
      const summary = await cleanupIdleAgents();

      assert.equal(summary.workersTerminated, 1,
        `Expected exactly 1 termination, got ${summary.workersTerminated}`);

      const term = (summary.terminated || []).filter(e => e.workerId !== 'queen');
      assert.equal(term.length, 1, 'Exactly 1 non-queen should be in terminated list');
      assert.equal(
        term[0].workerId,
        'wB',
        `Expected wB (longest idle, idleSince=${B_IDLE}) to be reaped, ` +
        `but got ${term[0].workerId}. ` +
        `(Bug: old code sorted by spawnedAt and would incorrectly reap wA.)`
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Sanity: source-level assertions (belt-and-suspenders, no runtime needed)
// ---------------------------------------------------------------------------

describe('hive-cleanup source assertions', () => {
  it('source uses idleSince || spawnedAt as sort key (d7rA-001)', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    assert.match(source, /idleSince \|\| \w+\.spawnedAt/,
      'sort key must use idleSince fallback');
  });

  it('source computes nonQueenNonIdleCount for floor (d7rA-003)', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    assert.match(source, /nonQueenNonIdleCount/,
      'floor must exclude queen via nonQueenNonIdleCount');
  });

  it('source floor uses nonQueenNonIdleCount not nonIdleWorkers.length', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    assert.match(source, /MIN_WORKERS_PER_HIVE - nonQueenNonIdleCount/,
      'keepFromIdle must subtract nonQueenNonIdleCount');
    assert.doesNotMatch(source, /MIN_WORKERS_PER_HIVE - nonIdleWorkers\.length/,
      'old buggy floor pattern must be absent');
  });
});
