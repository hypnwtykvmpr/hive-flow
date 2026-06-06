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
  getPaths,
  sanitizeHiveId,
  pollWorkers,
  writeProgressFile,
  cleanupProgressFile,
  appendAuditLog,
  writeDoneMarker: typeof writeDoneMarker === 'function' ? writeDoneMarker : undefined,
  handleStopRequest: typeof handleStopRequest === 'function' ? handleStopRequest : undefined,
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

  it('honors stop control files by writing stopped progress and logging the stop', () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);

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

    const auditPath = join(paths.hiveFlowDir, 'enforcement', 'hive-audit.jsonl');
    const audit = readFileSync(auditPath, 'utf8');
    assert.match(audit, /watcher-stop-requested/);
  });

  it('uses the requested non-mutating and stale-reset source changes', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    assert.match(source, /const sorted = tasks\.slice\(\)\.sort\(/);
    assert.doesNotMatch(source, /tasks\.sort\(/);
    assert.match(source, /const allComplete = runningCount === 0 && !startupWindowOpen;/);
    assert.doesNotMatch(source, /const allComplete = taskedCount > 0 && runningCount === 0 && idleCount === 0;/);
    assert.doesNotMatch(source, /if \(latest\.tracking\.pid\) \{/);
    assert.match(
      source,
      /Reset stale counter[\s\S]*prevCompletedCount = status\.completedCount;[\s\S]*prevFailedCount = status\.failedCount;/
    );
  });
});
