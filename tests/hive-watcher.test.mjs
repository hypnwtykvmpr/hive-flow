import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'hive-watcher.cjs');

function loadWatcherModule() {
  const source = readFileSync(SCRIPT, 'utf8').replace(/\nmain\(\)\.catch\([\s\S]*$/, '\n');
  const module = { exports: {} };
  const context = {
    require: createRequire(pathToFileURL(SCRIPT)),
    module,
    exports: module.exports,
    __filename: SCRIPT,
    __dirname: dirname(SCRIPT),
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(
    `${source}
module.exports = {
  parseArgs,
  getPaths,
  sanitizeHiveId,
  pollWorkers,
  writeProgressFile,
  cleanupProgressFile,
  appendAuditLog,
  writeDoneMarker: typeof writeDoneMarker === 'function' ? writeDoneMarker : undefined,
  appendPendingCompletion: typeof appendPendingCompletion === 'function' ? appendPendingCompletion : undefined,
  appendPendingTerminal: typeof appendPendingTerminal === 'function' ? appendPendingTerminal : undefined,
  handleStopRequest: typeof handleStopRequest === 'function' ? handleStopRequest : undefined,
  shouldNotifyStaleTransition: typeof shouldNotifyStaleTransition === 'function' ? shouldNotifyStaleTransition : undefined,
  noteWorkerProgressTransition: typeof noteWorkerProgressTransition === 'function' ? noteWorkerProgressTransition : undefined,
};
`,
    context,
    { filename: SCRIPT }
  );

  return module.exports;
}

function makeProjectDir() {
  return mkdtempSync(join(tmpdir(), 'hive-watcher-test-'));
}

function isoMsAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeHive(projectDir, hiveId, workers, audit = []) {
  const mod = loadWatcherModule();
  const sanitized = mod.sanitizeHiveId(hiveId);
  const hiveDir = join(projectDir, '.hive-flow', 'hives', sanitized);
  mkdirSync(hiveDir, { recursive: true });
  writeFileSync(join(hiveDir, 'hive.json'), JSON.stringify({
    id: hiveId,
    queenId: 'queen-1',
    status: 'active',
    workers,
    audit,
  }, null, 2));
}

function writeTracking(projectDir, fileName, tracking) {
  const tasksDir = join(projectDir, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, fileName), JSON.stringify(tracking, null, 2));
  if (tracking.result) {
    writeFileSync(join(tasksDir, `${tracking.taskId}.result.json`), JSON.stringify(tracking.result, null, 2));
  }
}

let tempDirs = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('hive-watcher regressions', () => {
  it('treats a hive as complete once nothing is running even if some workers are idle', () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const spawnedAt = isoMsAgo(10 * 60_000);

    makeHive(projectDir, 'demo/hive', [
      { workerId: 'w1', agentId: 'worker-1', role: 'coder', status: 'idle', spawnedAt },
      { workerId: 'w2', agentId: 'worker-2', role: 'tester', status: 'idle', spawnedAt },
    ], [
      {
        timestamp: spawnedAt,
        event: 'worker-tasked',
        hiveId: 'demo/hive',
        workerId: 'w1',
        agentId: 'worker-1',
        detail: 'worker-1 was tasked',
      },
    ]);

    writeTracking(projectDir, 'task-one.json', {
      agentId: 'worker-1',
      taskId: 'task-one',
      startedAt: '2026-03-23T00:00:00.000Z',
      pid: process.pid,
      status: 'completed',
      result: { ok: true },
    });

    const mod = loadWatcherModule();
    const status = mod.pollWorkers(
      join(projectDir, '.hive-flow', 'hives'),
      join(projectDir, '.hive-flow', 'tasks'),
      'demo/hive'
    );

    assert.equal(status.completedCount, 1);
    assert.equal(status.idleCount, 1);
    assert.equal(status.runningCount, 0);
    assert.equal(status.allComplete, true);
  });

  it('settles a never-tasked hive once the startup grace window has elapsed', () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);

    makeHive(projectDir, 'demo/never-tasked', [
      {
        workerId: 'w1',
        agentId: 'worker-1',
        role: 'coder',
        status: 'idle',
        spawnedAt: isoMsAgo(10 * 60_000),
      },
    ]);

    const mod = loadWatcherModule();
    const status = mod.pollWorkers(
      join(projectDir, '.hive-flow', 'hives'),
      join(projectDir, '.hive-flow', 'tasks'),
      'demo/never-tasked'
    );

    assert.equal(status.completedCount, 0);
    assert.equal(status.idleCount, 1);
    assert.equal(status.runningCount, 0);
    assert.equal(status.allComplete, true);
  });

  it('does not settle a freshly-spawned hive inside the startup grace window', () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);

    makeHive(projectDir, 'demo/fresh', [
      {
        workerId: 'w1',
        agentId: 'worker-1',
        role: 'coder',
        status: 'idle',
        spawnedAt: isoMsAgo(2_000),
      },
    ]);

    const mod = loadWatcherModule();
    const status = mod.pollWorkers(
      join(projectDir, '.hive-flow', 'hives'),
      join(projectDir, '.hive-flow', 'tasks'),
      'demo/fresh'
    );

    assert.equal(status.runningCount, 0);
    assert.equal(status.idleCount, 1);
    assert.equal(status.allComplete, false);
  });

  it('does not write watcher progress files for null-like hive ids', () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);

    const mod = loadWatcherModule();
    const paths = mod.getPaths(projectDir);
    const invalidProgressPath = join(paths.dataDir, 'watcher-null.json');

    mod.writeProgressFile(paths, null, { status: 'active' });
    assert.equal(existsSync(invalidProgressPath), false);

    mod.cleanupProgressFile(paths, null);
    assert.equal(existsSync(invalidProgressPath), false);
  });

  it('adds a stop-file path and removes both progress and stop files during cleanup', () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);

    const mod = loadWatcherModule();
    const paths = mod.getPaths(projectDir);

    assert.equal(typeof paths.stopFile, 'function');

    mkdirSync(paths.dataDir, { recursive: true });
    const progressPath = join(paths.dataDir, 'watcher-demo_hive.json');
    const stopPath = paths.stopFile('demo/hive');
    writeFileSync(progressPath, '{}');
    writeFileSync(stopPath, '');

    mod.cleanupProgressFile(paths, 'demo/hive');

    assert.equal(existsSync(progressPath), false);
    assert.equal(existsSync(stopPath), false);
  });

  it('writes a done marker with completion metadata', () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);

    const mod = loadWatcherModule();
    const paths = mod.getPaths(projectDir);

    assert.equal(typeof mod.writeDoneMarker, 'function');

    mod.writeDoneMarker(paths, 'demo/hive', {
      completedCount: 2,
      failedCount: 1,
      terminatedCount: 0,
      idleCount: 0,
    });

    const donePath = join(paths.dataDir, 'hive-demo_hive.done');
    const done = JSON.parse(readFileSync(donePath, 'utf8'));

    assert.equal(done.hiveId, 'demo/hive');
    assert.equal(done.completedCount, 2);
    assert.equal(done.failedCount, 1);
    assert.match(done.summary, /completed=2 failed=1/);
    assert.ok(done.completedAt);
    assert.equal(readdirSync(paths.dataDir).some(name => name.includes('.tmp.')), false);
  });

  it('mirrors completion wakeups into one global wake directory per owner session', () => {
    const projectDir = makeProjectDir();
    const home = makeProjectDir();
    tempDirs.push(projectDir, home);
    const origHome = process.env.HIVE_FLOW_HOME;
    process.env.HIVE_FLOW_HOME = home;

    try {
      const mod = loadWatcherModule();
      const pathsA = mod.getPaths(projectDir, 'claude-session-a');
      const pathsB = mod.getPaths(projectDir, 'claude-session-b');

      assert.equal(typeof mod.writeDoneMarker, 'function');
      assert.equal(typeof mod.appendPendingCompletion, 'function');
      assert.equal(typeof pathsA.wakeHiveDoneFile, 'function');
      assert.notEqual(pathsA.wakeSessionDir, pathsB.wakeSessionDir);

      const status = {
        completedCount: 2,
        failedCount: 0,
        terminatedCount: 0,
        idleCount: 0,
      };

      mod.writeDoneMarker(pathsA, 'demo/hive', status, 'claude-session-a');
      mod.appendPendingCompletion(pathsA, 'demo/hive', status, 'completed=2 failed=0', 'claude-session-a');

      assert.equal(existsSync(join(pathsA.dataDir, 'hive-demo_hive.done')), true);
      assert.equal(existsSync(pathsA.wakeHiveDoneFile('demo/hive')), true);
      assert.equal(existsSync(pathsA.wakePendingFile), true);
      assert.match(readFileSync(pathsA.wakePendingFile, 'utf8'), /"ownerSessionId":"claude-session-a"/);

      assert.equal(existsSync(pathsB.wakeSessionDir), false);
      assert.equal(existsSync(pathsB.wakePendingFile), false);
    } finally {
      if (origHome !== undefined) process.env.HIVE_FLOW_HOME = origHome;
      else delete process.env.HIVE_FLOW_HOME;
    }
  });

  it('honors stop control files by writing stopped progress and logging the stop', () => {
    const projectDir = makeProjectDir();
    const home = makeProjectDir();
    tempDirs.push(projectDir, home);
    const origHome = process.env.HIVE_FLOW_HOME;
    process.env.HIVE_FLOW_HOME = home;

    try {
      const mod = loadWatcherModule();
      const paths = mod.getPaths(projectDir);

      assert.equal(typeof mod.handleStopRequest, 'function');

      mkdirSync(paths.dataDir, { recursive: true });
      writeFileSync(paths.stopFile('demo/hive'), '');

      const stopped = mod.handleStopRequest(paths, 'demo/hive', {
        completedCount: 1,
        failedCount: 0,
        runningCount: 0,
        idleCount: 0,
        terminatedCount: 0,
      });

      assert.equal(stopped, true);

      const progress = JSON.parse(readFileSync(join(paths.dataDir, 'watcher-demo_hive.json'), 'utf8'));
      assert.equal(progress.status, 'stopped');

      // Slice 3: hive-audit.jsonl is control-plane, written to the global Hive home, not project-local.
      const auditPath = join(home, 'enforcement', 'hive-audit.jsonl');
      const audit = readFileSync(auditPath, 'utf8');
      assert.match(audit, /watcher-stop-requested/);
      assert.equal(
        existsSync(join(paths.hiveFlowDir, 'enforcement', 'hive-audit.jsonl')),
        false,
        'stop audit must not be written to project-local enforcement',
      );
    } finally {
      if (origHome !== undefined) process.env.HIVE_FLOW_HOME = origHome;
      else delete process.env.HIVE_FLOW_HOME;
    }
  });

  it('notifies stale hives once per state transition and suppresses ambient idle-settled states', () => {
    const mod = loadWatcherModule();
    assert.equal(typeof mod.shouldNotifyStaleTransition, 'function');
    assert.equal(typeof mod.noteWorkerProgressTransition, 'function');

    const transitionState = {};
    const staleRunningState = {
      runningCount: 1,
      completedCount: 0,
      failedCount: 4,
      idleCount: 0,
      terminatedCount: 0,
      workerCount: 5,
    };

    const notifications = [];
    for (let i = 0; i < 6; i++) {
      if (mod.shouldNotifyStaleTransition(transitionState, staleRunningState, 3 + i)) {
        notifications.push(i);
      }
    }
    assert.deepEqual(notifications, [0]);

    mod.noteWorkerProgressTransition(transitionState);
    assert.equal(
      mod.shouldNotifyStaleTransition(transitionState, {
        ...staleRunningState,
        runningCount: 0,
        completedCount: 1,
      }, 3),
      false,
      'settled/failed hives with no running workers are ambient statusline state, not wake-worthy stale work',
    );

    assert.equal(
      mod.shouldNotifyStaleTransition(transitionState, {
        ...staleRunningState,
        completedCount: 1,
        failedCount: 3,
      }, 3),
      true,
      'a changed running stale state should wake once',
    );
    assert.equal(
      mod.shouldNotifyStaleTransition(transitionState, {
        ...staleRunningState,
        completedCount: 1,
        failedCount: 3,
      }, 4),
      false,
      'unchanged stale state should not wake again on the next cycle',
    );
  });

  it('accepts legacy tmux pane arguments without any watcher tmux execution path', () => {
    const mod = loadWatcherModule();
    const parsed = mod.parseArgs(['demo/hive', '--tmux-pane', '%9'], {});

    assert.equal(parsed.hiveId, 'demo/hive');
    assert.equal(parsed.tmuxPane, '%9');

    const source = readFileSync(SCRIPT, 'utf8');
    assert.doesNotMatch(source, /function tmuxSendKeys/);
    assert.doesNotMatch(source, /function findTmux/);
    assert.doesNotMatch(source, /function resolveTmuxPane/);
    assert.doesNotMatch(source, /execFileSync/);
    assert.doesNotMatch(source, /send-keys/);
  });

  it('uses the requested non-mutating and stale-transition source changes', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    assert.match(source, /const sorted = tasks\.slice\(\)\.sort\(/);
    assert.doesNotMatch(source, /tasks\.sort\(/);
    assert.match(source, /const allComplete = runningCount === 0 && !startupWindowOpen;/);
    assert.doesNotMatch(source, /const allComplete = taskedCount > 0 && runningCount === 0 && idleCount === 0;/);
    assert.doesNotMatch(source, /if \(latest\.tracking\.pid\) \{/);
    assert.match(source, /function shouldNotifyStaleTransition/);
    assert.match(source, /staleTransitionSignature\(status\)/);
    assert.match(source, /lastStaleSignature/);
    assert.doesNotMatch(source, /Reset stale counter/);
  });

  it('d7rA-010 regression: poll loop calls pollWorkers exactly once per iteration (single snapshot)', () => {
    // Structural assertion: the main poll loop must not contain inline pollWorkers() call-sites.
    // All three former usages (handleStopRequest, appendPendingTerminal, status) must be collapsed
    // into a single `const snapshot = pollWorkers(...)` at the top of the loop body.
    const source = readFileSync(SCRIPT, 'utf8');

    // The single cached read must be present
    assert.match(
      source,
      /const snapshot = pollWorkers\(paths\.hivesDir, paths\.tasksDir, hiveId\)/,
      'expected single snapshot assignment at top of poll loop',
    );

    // handleStopRequest must be called with the snapshot, not with an inline poll
    assert.match(
      source,
      /handleStopRequest\(paths, hiveId, snapshot\)/,
      'expected handleStopRequest to receive snapshot, not inline pollWorkers call',
    );

    // appendPendingTerminal must receive snapshot, not an inline poll
    assert.match(
      source,
      /appendPendingTerminal\(\s*paths,\s*hiveId,\s*snapshot,/,
      'expected appendPendingTerminal to receive snapshot, not inline pollWorkers call',
    );

    // status must be assigned from snapshot, not from a new pollWorkers call
    assert.match(
      source,
      /const status = snapshot/,
      'expected status to be aliased from snapshot, not from a fresh pollWorkers call',
    );

    // Guard: no inline pollWorkers calls should remain inside the while(true) loop body.
    // Extract the loop body from "while (true) {" to the closing line to scope the check.
    const loopStart = source.indexOf('// Main poll loop');
    assert.ok(loopStart !== -1, 'could not locate main poll loop comment');
    const loopBody = source.slice(loopStart);

    // Count all pollWorkers( occurrences in the loop region — exactly one is allowed (the snapshot assignment)
    const allMatches = [...loopBody.matchAll(/pollWorkers\(/g)];
    assert.equal(
      allMatches.length,
      1,
      `expected exactly 1 pollWorkers() call in the poll loop region, found ${allMatches.length}`,
    );
  });
});
