import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, '.claude', 'helpers', 'hive-cleanup.cjs');

function isoMsAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeProjectDir() {
  return mkdtempSync(join(tmpdir(), 'hive-cleanup-reaper-'));
}

function loadCleanupModule(projectDir) {
  const helperDir = join(projectDir, '.claude', 'helpers');
  mkdirSync(helperDir, { recursive: true });
  const source = readFileSync(SCRIPT, 'utf8')
    .replace(/\n\/\/ ---------------------------------------------------------------------------\n\/\/ Main[\s\S]*$/, '\n');
  const module = { exports: {} };
  const context = {
    require: createRequire(pathToFileURL(SCRIPT)),
    module,
    exports: module.exports,
    __filename: join(helperDir, 'hive-cleanup.cjs'),
    __dirname: helperDir,
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    SharedArrayBuffer,
    Atomics,
  };

  vm.runInNewContext(
    `${source}
module.exports = {
  cleanupIdleAgents,
  cleanupStaleBusyAgents: typeof cleanupStaleBusyAgents === 'function' ? cleanupStaleBusyAgents : undefined,
  cleanupAgedAgentStoreRecords: typeof cleanupAgedAgentStoreRecords === 'function' ? cleanupAgedAgentStoreRecords : undefined,
  autoFailStuckActiveHives: typeof autoFailStuckActiveHives === 'function' ? autoFailStuckActiveHives : undefined,
  cleanupOrphanedTasks,
  cleanupLegacyWatchersDir: typeof cleanupLegacyWatchersDir === 'function' ? cleanupLegacyWatchersDir : undefined,
  resolveWorkerPid: typeof resolveWorkerPid === 'function' ? resolveWorkerPid : undefined,
  reapWorkerProcess: typeof reapWorkerProcess === 'function' ? reapWorkerProcess : undefined,
};
`,
    context,
    { filename: SCRIPT }
  );

  return module.exports;
}

function makeIdleWorker(index, overrides = {}) {
  return {
    workerId: `w${index}`,
    agentId: `agent-${index}`,
    role: 'coder',
    provider: 'codex-cli',
    status: 'idle',
    spawnedAt: isoMsAgo((40 - index) * 60_000),
    idleSince: isoMsAgo(30 * 60_000),
    ...overrides,
  };
}

function writeHive(projectDir, hiveId, workers) {
  const hiveDir = join(projectDir, '.hive-flow', 'hives', hiveId);
  mkdirSync(hiveDir, { recursive: true });
  writeFileSync(join(hiveDir, 'hive.json'), JSON.stringify({
    hiveId,
    queenId: 'queen-1',
    status: 'active',
    workers,
    budget: { maxWorkers: 8, workersAllocated: workers.length },
    audit: [],
    createdAt: isoMsAgo(60 * 60_000),
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function readHive(projectDir, hiveId) {
  return JSON.parse(readFileSync(join(projectDir, '.hive-flow', 'hives', hiveId, 'hive.json'), 'utf8'));
}

function writeAgentStore(projectDir, agents) {
  const agentsDir = join(projectDir, '.hive-flow', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents,
  }, null, 2));
}

function readAgentStore(projectDir) {
  return JSON.parse(readFileSync(join(projectDir, '.hive-flow', 'agents', 'store.json'), 'utf8'));
}

function writeTracking(projectDir, fileName, tracking) {
  const tasksDir = join(projectDir, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, fileName), JSON.stringify(tracking, null, 2));
}

function writeResult(projectDir, taskId, result = { ok: true }) {
  const tasksDir = join(projectDir, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${taskId}.result.json`), JSON.stringify(result, null, 2));
}

function touchOld(filePath, ageMs) {
  const old = new Date(Date.now() - ageMs);
  utimesSync(filePath, old, old);
}

function spawnSleepingChild() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* best-effort */ }
  await new Promise(resolve => {
    child.once('exit', resolve);
    setTimeout(resolve, 1000);
  });
}

let tempDirs = [];
let originalEnv = {};

beforeEach(() => {
  tempDirs = [];
  originalEnv = {
    HIVE_FLOW_IDLE_TIMEOUT_MS: process.env.HIVE_FLOW_IDLE_TIMEOUT_MS,
    HIVE_FLOW_REAP_WAIT_MS: process.env.HIVE_FLOW_REAP_WAIT_MS,
    HIVE_FLOW_CLEANUP_MAX_RUNTIME_MS: process.env.HIVE_FLOW_CLEANUP_MAX_RUNTIME_MS,
    HIVE_FLOW_STUCK_ACTIVE_THRESHOLD_MS: process.env.HIVE_FLOW_STUCK_ACTIVE_THRESHOLD_MS,
    HIVE_FLOW_AGENT_RECORD_TTL_MS: process.env.HIVE_FLOW_AGENT_RECORD_TTL_MS,
    HIVE_FLOW_RESULT_TTL_MS: process.env.HIVE_FLOW_RESULT_TTL_MS,
    HIVE_FLOW_LEGACY_WATCHER_TTL_MS: process.env.HIVE_FLOW_LEGACY_WATCHER_TTL_MS,
  };
  process.env.HIVE_FLOW_IDLE_TIMEOUT_MS = '1';
  process.env.HIVE_FLOW_REAP_WAIT_MS = '10';
  process.env.HIVE_FLOW_CLEANUP_MAX_RUNTIME_MS = '2000';
  process.env.HIVE_FLOW_STUCK_ACTIVE_THRESHOLD_MS = '1';
  process.env.HIVE_FLOW_AGENT_RECORD_TTL_MS = String(7 * 24 * 60 * 60 * 1000);
  process.env.HIVE_FLOW_RESULT_TTL_MS = '1';
  process.env.HIVE_FLOW_LEGACY_WATCHER_TTL_MS = '1';
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('hive-cleanup OS reaper', () => {
  it('does not idle-reap workers with unfinished task tracking even when spawned long ago', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const workers = [];
    workers.push(makeIdleWorker(1, {
      agentId: 'agent-pending',
      workerId: 'worker-pending',
      taskId: 'task-pending',
      spawnedAt: isoMsAgo(60 * 60_000),
      idleSince: undefined,
    }));
    for (let i = 2; i <= 7; i++) workers.push(makeIdleWorker(i));
    writeHive(projectDir, 'h1', workers);
    writeTracking(projectDir, 'task-pending.json', {
      status: 'running',
      taskId: 'task-pending',
      agentId: 'agent-pending',
      startedAt: isoMsAgo(60 * 60_000),
      pid: 456789,
      deadlineAt: isoMsAgo(50 * 60_000),
    });

    const mod = loadCleanupModule(projectDir);
    const result = await mod.cleanupIdleAgents(Date.now() + 2000);
    const hive = readHive(projectDir, 'h1');

    assert.equal(result.terminated.some(entry => entry.agentId === 'agent-pending'), false);
    assert.equal(hive.workers.find(w => w.agentId === 'agent-pending').status, 'idle');
    assert.equal(hive.workers.find(w => w.agentId === 'agent-pending').taskId, 'task-pending');
  });

  it('does not idle-reap queued workers with only a .task file and no result yet', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const workers = [];
    workers.push(makeIdleWorker(1, {
      agentId: 'agent-queued',
      workerId: 'worker-queued',
      taskId: 'task-queued',
      spawnedAt: isoMsAgo(60 * 60_000),
      idleSince: undefined,
    }));
    for (let i = 2; i <= 7; i++) workers.push(makeIdleWorker(i));
    writeHive(projectDir, 'h1', workers);
    const tasksDir = join(projectDir, '.hive-flow', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'task-queued.task'), 'queued provider task', 'utf8');

    const mod = loadCleanupModule(projectDir);
    const result = await mod.cleanupIdleAgents(Date.now() + 2000);
    const hive = readHive(projectDir, 'h1');

    assert.equal(result.terminated.some(entry => entry.agentId === 'agent-queued'), false);
    assert.equal(hive.workers.find(w => w.agentId === 'agent-queued').status, 'idle');
    assert.equal(hive.workers.find(w => w.agentId === 'agent-queued').taskId, 'task-queued');
  });

  it('still idle-reaps workers whose assigned task already has a result file', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const workers = [];
    workers.push(makeIdleWorker(1, {
      agentId: 'agent-done',
      workerId: 'worker-done',
      taskId: 'task-done',
      spawnedAt: isoMsAgo(60 * 60_000),
      idleSince: undefined,
    }));
    for (let i = 2; i <= 7; i++) workers.push(makeIdleWorker(i));
    writeHive(projectDir, 'h1', workers);
    writeTracking(projectDir, 'task-done.json', {
      status: 'completed',
      taskId: 'task-done',
      agentId: 'agent-done',
      startedAt: isoMsAgo(60 * 60_000),
      pid: 567890,
    });
    writeResult(projectDir, 'task-done', { status: 'completed' });

    const mod = loadCleanupModule(projectDir);
    const result = await mod.cleanupIdleAgents(Date.now() + 2000);
    const hive = readHive(projectDir, 'h1');

    assert.equal(result.terminated.some(entry => entry.agentId === 'agent-done'), true);
    assert.equal(hive.workers.find(w => w.agentId === 'agent-done').status, 'terminated');
  });

  it('SIGTERMs the worker PID read from the task tracking file', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const workers = [makeIdleWorker(1)];
    for (let i = 2; i <= 6; i++) workers.push(makeIdleWorker(i));
    writeHive(projectDir, 'h1', workers);

    const child = spawnSleepingChild();
    writeTracking(projectDir, 'task-1.json', {
      status: 'running',
      taskId: 'task-1',
      agentId: 'agent-1',
      startedAt: new Date().toISOString(),
      pid: child.pid,
    });

    const originalKill = process.kill;
    let killed = [];
    try {
      const mod = loadCleanupModule(projectDir);
      assert.equal(typeof mod.resolveWorkerPid, 'function');
      assert.equal(typeof mod.reapWorkerProcess, 'function');
      assert.equal(mod.resolveWorkerPid('agent-1'), child.pid);

      killed = [];
      process.kill = (pid, signal) => {
        killed.push([pid, signal]);
        return originalKill.call(process, pid, signal);
      };
      await mod.cleanupIdleAgents(Date.now() + 2000);
    } finally {
      process.kill = originalKill;
      await stopChild(child);
    }

    assert.ok(
      killed.some(([pid, signal]) => pid === child.pid && signal === 'SIGTERM'),
      'expected SIGTERM to the tracking-file PID'
    );
  });

  it('does not signal an idle worker when no tracking-file PID exists', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const workers = [];
    for (let i = 1; i <= 6; i++) workers.push(makeIdleWorker(i));
    writeHive(projectDir, 'h1', workers);

    const mod = loadCleanupModule(projectDir);
    assert.equal(mod.resolveWorkerPid('agent-1'), null);

    const killed = [];
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      killed.push([pid, signal]);
      return true;
    };

    try {
      await mod.cleanupIdleAgents(Date.now() + 2000);
    } finally {
      process.kill = originalKill;
    }

    assert.deepEqual(killed, []);
  });

  it('never signals self or init PIDs from tracking files', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    writeTracking(projectDir, 'task-self.json', {
      status: 'running',
      taskId: 'task-self',
      agentId: 'agent-self',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    writeTracking(projectDir, 'task-init.json', {
      status: 'running',
      taskId: 'task-init',
      agentId: 'agent-init',
      startedAt: new Date().toISOString(),
      pid: 1,
    });

    const mod = loadCleanupModule(projectDir);
    assert.equal(mod.resolveWorkerPid('agent-self'), process.pid);
    assert.equal(mod.resolveWorkerPid('agent-init'), null);

    const killed = [];
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      killed.push([pid, signal]);
      return true;
    };

    try {
      await mod.reapWorkerProcess('agent-self');
      await mod.reapWorkerProcess('agent-init');
    } finally {
      process.kill = originalKill;
    }

    assert.equal(killed.some(([pid]) => pid === process.pid || pid === 1), false);
  });

  it('selects the most recent valid tracking PID for an agent', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    writeTracking(projectDir, 'task-old.json', {
      status: 'running',
      taskId: 'task-old',
      agentId: 'agent-1',
      startedAt: isoMsAgo(60_000),
      pid: 12345,
    });
    writeTracking(projectDir, 'task-new.json', {
      status: 'running',
      taskId: 'task-new',
      agentId: 'agent-1',
      startedAt: new Date().toISOString(),
      pid: 23456,
    });

    const mod = loadCleanupModule(projectDir);

    assert.equal(mod.resolveWorkerPid('agent-1'), 23456);
  });

  it('reaps stale busy agent records only when currentTaskPid is definitely dead', async () => {
    process.env.HIVE_FLOW_IDLE_TIMEOUT_MS = String(60_000);
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const deadPid = 626262;
    const epermPid = 626263;
    writeAgentStore(projectDir, {
      dead: {
        agentId: 'dead',
        agentType: 'coder',
        status: 'busy',
        currentTaskPid: deadPid,
        taskId: 'task-dead-stale',
        createdAt: new Date().toISOString(),
      },
      eperm: {
        agentId: 'eperm',
        agentType: 'coder',
        status: 'busy',
        currentTaskPid: epermPid,
        taskId: 'task-eperm-live',
        createdAt: new Date().toISOString(),
      },
      legacy: {
        agentId: 'legacy',
        agentType: 'coder',
        status: 'busy',
        createdAt: new Date().toISOString(),
      },
    });
    writeHive(projectDir, 'h1', [
      makeIdleWorker(1, { agentId: 'dead', workerId: 'w-dead', status: 'busy', taskId: 'task-dead-stale' }),
      makeIdleWorker(2, { agentId: 'eperm', workerId: 'w-eperm', status: 'busy', taskId: 'task-eperm-live' }),
      makeIdleWorker(3, { agentId: 'legacy', workerId: 'w-legacy', status: 'busy' }),
    ]);

    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (signal === 0 && pid === deadPid) {
        const err = new Error('dead process');
        err.code = 'ESRCH';
        throw err;
      }
      if (signal === 0 && pid === epermPid) {
        const err = new Error('permission denied');
        err.code = 'EPERM';
        throw err;
      }
      return true;
    };

    try {
      const mod = loadCleanupModule(projectDir);
      assert.equal(typeof mod.cleanupStaleBusyAgents, 'function');
      const result = await mod.cleanupStaleBusyAgents(Date.now() + 2000);

      assert.equal(result.staleBusyFound, 1);
      assert.equal(result.staleBusyReaped, 1);
      assert.equal(result.hiveWorkersReaped, 1);

      const store = readAgentStore(projectDir);
      assert.equal(store.agents.dead.status, 'idle');
      assert.equal(store.agents.dead.currentTaskPid, undefined);
      assert.equal(store.agents.dead.taskId, undefined);
      assert.match(store.agents.dead.idleSince, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(store.agents.eperm.status, 'busy');
      assert.equal(store.agents.eperm.currentTaskPid, epermPid);
      assert.equal(store.agents.eperm.taskId, 'task-eperm-live');
      assert.equal(store.agents.legacy.status, 'busy');
      assert.equal(store.agents.legacy.currentTaskPid, undefined);

      const hive = readHive(projectDir, 'h1');
      const deadWorker = hive.workers.find(w => w.agentId === 'dead');
      const epermWorker = hive.workers.find(w => w.agentId === 'eperm');
      assert.equal(deadWorker.status, 'idle');
      assert.equal(deadWorker.taskId, undefined);
      assert.equal(epermWorker.status, 'busy');
      assert.equal(epermWorker.taskId, 'task-eperm-live');
      assert.equal(hive.workers.find(w => w.agentId === 'legacy').status, 'busy');
      assert.equal(hive.audit.some(entry => entry.event === 'worker-idle' && entry.agentId === 'dead'), true);
    } finally {
      process.kill = originalKill;
    }
  });

  it('reaps ghost-busy records only after the idle timeout age floor', async () => {
    process.env.HIVE_FLOW_IDLE_TIMEOUT_MS = String(60_000);
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    writeAgentStore(projectDir, {
      staleGhost: {
        agentId: 'staleGhost',
        agentType: 'coder',
        status: 'busy',
        createdAt: isoMsAgo(60 * 60_000),
      },
      freshGhost: {
        agentId: 'freshGhost',
        agentType: 'coder',
        status: 'busy',
        createdAt: new Date().toISOString(),
      },
    });
    writeHive(projectDir, 'h-ghost', [
      makeIdleWorker(1, { agentId: 'staleGhost', workerId: 'w-stale', status: 'busy' }),
      makeIdleWorker(2, { agentId: 'freshGhost', workerId: 'w-fresh', status: 'busy' }),
    ]);

    const mod = loadCleanupModule(projectDir);
    const result = await mod.cleanupStaleBusyAgents(Date.now() + 2000);

    assert.equal(result.staleBusyFound, 1);
    assert.equal(result.staleBusyReaped, 1);
    assert.equal(result.hiveWorkersReaped, 1);
    assert.equal(result.staleBusyAgents[0].reason, 'ghost-busy-no-task');

    const store = readAgentStore(projectDir);
    assert.equal(store.agents.staleGhost.status, 'idle');
    assert.equal(store.agents.freshGhost.status, 'busy');
    const hive = readHive(projectDir, 'h-ghost');
    assert.equal(hive.workers.find(w => w.agentId === 'staleGhost').status, 'idle');
    assert.equal(hive.workers.find(w => w.agentId === 'freshGhost').status, 'busy');
  });

  it('reaps busy records with missing tracking after the idle timeout age floor', async () => {
    process.env.HIVE_FLOW_IDLE_TIMEOUT_MS = String(60_000);
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const taskId = 'task-missing-tracking';
    writeAgentStore(projectDir, {
      staleMissingTracking: {
        agentId: 'staleMissingTracking',
        agentType: 'coder',
        status: 'busy',
        currentTaskId: taskId,
        createdAt: isoMsAgo(60 * 60_000),
      },
      freshMissingTracking: {
        agentId: 'freshMissingTracking',
        agentType: 'coder',
        status: 'busy',
        currentTaskId: 'task-fresh-missing-tracking',
        createdAt: new Date().toISOString(),
      },
    });
    writeHive(projectDir, 'h-missing-tracking', [
      makeIdleWorker(1, {
        agentId: 'staleMissingTracking',
        workerId: 'w-stale-missing',
        status: 'busy',
        currentTaskId: taskId,
      }),
      makeIdleWorker(2, {
        agentId: 'freshMissingTracking',
        workerId: 'w-fresh-missing',
        status: 'busy',
        currentTaskId: 'task-fresh-missing-tracking',
      }),
    ]);

    const mod = loadCleanupModule(projectDir);
    const result = await mod.cleanupStaleBusyAgents(Date.now() + 2000);

    assert.equal(result.staleBusyFound, 1);
    assert.equal(result.staleBusyReaped, 1);
    assert.equal(result.hiveWorkersReaped, 1);
    assert.equal(result.staleBusyAgents[0].reason, 'missing-tracking');

    const store = readAgentStore(projectDir);
    assert.equal(store.agents.staleMissingTracking.status, 'idle');
    assert.equal(store.agents.staleMissingTracking.currentTaskId, undefined);
    assert.equal(store.agents.freshMissingTracking.status, 'busy');
    const hive = readHive(projectDir, 'h-missing-tracking');
    assert.equal(hive.workers.find(w => w.agentId === 'staleMissingTracking').status, 'idle');
    assert.equal(hive.workers.find(w => w.agentId === 'staleMissingTracking').currentTaskId, undefined);
    assert.equal(hive.workers.find(w => w.agentId === 'freshMissingTracking').status, 'busy');
  });

  it('reaps busy records with malformed tracking after the idle timeout age floor', async () => {
    process.env.HIVE_FLOW_IDLE_TIMEOUT_MS = String(60_000);
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const taskId = 'task-malformed-tracking';
    const tasksDir = join(projectDir, '.hive-flow', 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, `${taskId}.json`), '{"status":"running"', 'utf8');
    writeAgentStore(projectDir, {
      malformedTrackingAgent: {
        agentId: 'malformedTrackingAgent',
        agentType: 'coder',
        status: 'busy',
        currentTaskId: taskId,
        updatedAt: isoMsAgo(60 * 60_000),
      },
    });
    writeHive(projectDir, 'h-malformed-tracking', [
      makeIdleWorker(1, {
        agentId: 'malformedTrackingAgent',
        workerId: 'w-malformed',
        status: 'busy',
        currentTaskId: taskId,
      }),
    ]);

    const mod = loadCleanupModule(projectDir);
    const result = await mod.cleanupStaleBusyAgents(Date.now() + 2000);

    assert.equal(result.staleBusyFound, 1);
    assert.equal(result.staleBusyReaped, 1);
    assert.equal(result.hiveWorkersReaped, 1);
    assert.equal(result.staleBusyAgents[0].reason, 'malformed-tracking');

    const store = readAgentStore(projectDir);
    assert.equal(store.agents.malformedTrackingAgent.status, 'idle');
    assert.equal(store.agents.malformedTrackingAgent.currentTaskId, undefined);
    const hiveWorker = readHive(projectDir, 'h-malformed-tracking').workers[0];
    assert.equal(hiveWorker.status, 'idle');
    assert.equal(hiveWorker.currentTaskId, undefined);
  });

  it('reaps past-deadline busy records even when their recorded PID is still alive', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const taskId = 'task-live-past-deadline';
    writeTracking(projectDir, `${taskId}.json`, {
      status: 'running',
      taskId,
      agentId: 'deadlineAgent',
      startedAt: isoMsAgo(10 * 60_000),
      deadlineAt: isoMsAgo(60_000),
      pid: process.pid,
    });
    writeAgentStore(projectDir, {
      deadlineAgent: {
        agentId: 'deadlineAgent',
        agentType: 'coder',
        status: 'busy',
        currentTaskId: taskId,
        currentTaskPid: process.pid,
        createdAt: new Date().toISOString(),
      },
    });
    writeHive(projectDir, 'h-deadline', [
      makeIdleWorker(1, {
        agentId: 'deadlineAgent',
        workerId: 'w-deadline',
        status: 'busy',
        currentTaskId: taskId,
        currentTaskPid: process.pid,
      }),
    ]);

    const mod = loadCleanupModule(projectDir);
    const result = await mod.cleanupStaleBusyAgents(Date.now() + 2000);

    assert.equal(result.staleBusyFound, 1);
    assert.equal(result.staleBusyReaped, 1);
    assert.equal(result.hiveWorkersReaped, 1);
    assert.equal(result.staleBusyAgents[0].reason, 'past-deadline');

    const store = readAgentStore(projectDir);
    assert.equal(store.agents.deadlineAgent.status, 'idle');
    assert.equal(store.agents.deadlineAgent.currentTaskId, undefined);
    assert.equal(store.agents.deadlineAgent.currentTaskPid, undefined);
    const hiveWorker = readHive(projectDir, 'h-deadline').workers[0];
    assert.equal(hiveWorker.status, 'idle');
    assert.equal(hiveWorker.currentTaskId, undefined);
    assert.equal(hiveWorker.currentTaskPid, undefined);
  });

  it('does not auto-fail an old active hive while a worker tracking PID is alive', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const worker = makeIdleWorker(1, {
      agentId: 'agent-stuck',
      workerId: 'worker-stuck',
      status: 'busy',
    });
    writeHive(projectDir, 'stuck-hive', [worker]);
    const hivePath = join(projectDir, '.hive-flow', 'hives', 'stuck-hive', 'hive.json');
    const stuckHive = readHive(projectDir, 'stuck-hive');
    stuckHive.updatedAt = isoMsAgo(60_000);
    writeFileSync(hivePath, JSON.stringify(stuckHive, null, 2));

    const child = spawnSleepingChild();
    writeTracking(projectDir, 'task-stuck.json', {
      status: 'running',
      taskId: 'task-stuck',
      agentId: 'agent-stuck',
      startedAt: new Date().toISOString(),
      pid: child.pid,
    });

    const originalKill = process.kill;
    let killed = [];
    try {
      const mod = loadCleanupModule(projectDir);
      assert.equal(typeof mod.autoFailStuckActiveHives, 'function');
      killed = [];
      process.kill = (pid, signal) => {
        killed.push([pid, signal]);
        return originalKill.call(process, pid, signal);
      };
      const result = await mod.autoFailStuckActiveHives(Date.now() + 2000);

      assert.equal(result.autoFailed, 0);
      assert.equal(readHive(projectDir, 'stuck-hive').status, 'active');
      assert.equal(killed.some(([pid, signal]) => pid === child.pid && signal === 'SIGTERM'), false);
    } finally {
      process.kill = originalKill;
      await stopChild(child);
    }
  });

  it('auto-fails an old active hive only when its worker PIDs are gone', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const deadPid = 747474;
    const worker = makeIdleWorker(1, {
      agentId: 'agent-dead',
      workerId: 'worker-dead',
      status: 'busy',
    });
    writeHive(projectDir, 'dead-hive', [worker]);
    const hivePath = join(projectDir, '.hive-flow', 'hives', 'dead-hive', 'hive.json');
    const staleHive = readHive(projectDir, 'dead-hive');
    staleHive.updatedAt = isoMsAgo(60_000);
    writeFileSync(hivePath, JSON.stringify(staleHive, null, 2));

    writeTracking(projectDir, 'task-dead.json', {
      status: 'running',
      taskId: 'task-dead',
      agentId: 'agent-dead',
      startedAt: new Date().toISOString(),
      pid: deadPid,
    });

    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if ((signal === 0 || signal === 'SIGTERM') && pid === deadPid) {
        const err = new Error('dead process');
        err.code = 'ESRCH';
        throw err;
      }
      return originalKill.call(process, pid, signal);
    };

    try {
      const mod = loadCleanupModule(projectDir);
      const result = await mod.autoFailStuckActiveHives(Date.now() + 2000);

      assert.equal(result.autoFailed, 1);
      assert.equal(readHive(projectDir, 'dead-hive').status, 'failed');
    } finally {
      process.kill = originalKill;
    }
  });

  it('prunes aged non-live agent store records while preserving live and recent records', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const livePid = process.pid;
    const deadPid = 858585;
    const eightDaysAgo = isoMsAgo(8 * 24 * 60 * 60 * 1000);
    const oneDayAgo = isoMsAgo(24 * 60 * 60 * 1000);
    writeAgentStore(projectDir, {
      oldIdle: {
        agentId: 'oldIdle',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-a',
        createdAt: eightDaysAgo,
      },
      oldTerminated: {
        agentId: 'oldTerminated',
        agentType: 'tester',
        status: 'terminated',
        ownerSessionId: 'session-a',
        createdAt: eightDaysAgo,
        terminatedAt: eightDaysAgo,
      },
      oldLive: {
        agentId: 'oldLive',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        createdAt: eightDaysAgo,
        currentTaskPid: livePid,
      },
      oldCreatedRecentActivity: {
        agentId: 'oldCreatedRecentActivity',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-a',
        createdAt: eightDaysAgo,
        lastTaskAt: oneDayAgo,
      },
      recentIdle: {
        agentId: 'recentIdle',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-a',
        createdAt: oneDayAgo,
      },
      recentZombie: {
        agentId: 'recentZombie',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        createdAt: oneDayAgo,
        currentTaskPid: deadPid,
      },
      recentCompleted: {
        agentId: 'recentCompleted',
        agentType: 'tester',
        status: 'idle',
        ownerSessionId: 'session-a',
        createdAt: oneDayAgo,
        lastResult: {
          status: 'completed',
          completedAt: new Date().toISOString(),
        },
      },
    });

    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (signal === 0 && pid === deadPid) {
        const err = new Error('dead process');
        err.code = 'ESRCH';
        throw err;
      }
      return originalKill.call(process, pid, signal);
    };

    let result;
    let store;
    try {
      const mod = loadCleanupModule(projectDir);
      assert.equal(typeof mod.cleanupAgedAgentStoreRecords, 'function');
      result = await mod.cleanupAgedAgentStoreRecords(Date.now() + 2000);
      store = readAgentStore(projectDir);
    } finally {
      process.kill = originalKill;
    }

    assert.equal(result.agedAgentsPruned, 4);
    assert.equal(JSON.stringify([...result.pruned].sort()), JSON.stringify(['oldIdle', 'oldTerminated', 'recentCompleted', 'recentZombie']));
    assert.equal(store.agents.oldIdle, undefined);
    assert.equal(store.agents.oldTerminated, undefined);
    assert.equal(store.agents.recentCompleted, undefined);
    assert.equal(store.agents.recentZombie, undefined);
    assert.equal(store.agents.oldLive.status, 'busy');
    assert.equal(store.agents.oldCreatedRecentActivity.status, 'idle');
    assert.equal(store.agents.recentIdle.status, 'idle');
  });

  it('prunes non-live worker records from terminal hives without waiting for age TTL', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    writeHive(projectDir, 'failed-hive', [
      makeIdleWorker(1, { agentId: 'failed-worker', workerId: 'failed-worker' }),
    ]);
    const failedHive = readHive(projectDir, 'failed-hive');
    failedHive.status = 'failed';
    writeFileSync(
      join(projectDir, '.hive-flow', 'hives', 'failed-hive', 'hive.json'),
      JSON.stringify(failedHive, null, 2),
    );
    writeHive(projectDir, 'active-hive', [
      makeIdleWorker(2, { agentId: 'active-worker', workerId: 'active-worker' }),
    ]);

    writeAgentStore(projectDir, {
      failedWorker: {
        agentId: 'failed-worker',
        agentType: 'tester',
        status: 'idle',
        ownerSessionId: 'session-a',
        createdAt: new Date().toISOString(),
      },
      activeWorker: {
        agentId: 'active-worker',
        agentType: 'tester',
        status: 'idle',
        ownerSessionId: 'session-a',
        createdAt: new Date().toISOString(),
      },
    });

    const mod = loadCleanupModule(projectDir);
    const result = await mod.cleanupAgedAgentStoreRecords(Date.now() + 2000);
    const store = readAgentStore(projectDir);

    assert.equal(result.agedAgentsPruned, 1);
    assert.equal(JSON.stringify(result.pruned), JSON.stringify(['failedWorker']));
    assert.equal(store.agents.failedWorker, undefined);
    assert.equal(store.agents.activeWorker.status, 'idle');
  });

  it('prunes completed task/result pairs after TTL only when the hive is terminal', async () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    writeHive(projectDir, 'terminal-hive', []);
    const terminalHive = readHive(projectDir, 'terminal-hive');
    terminalHive.status = 'completed';
    writeFileSync(
      join(projectDir, '.hive-flow', 'hives', 'terminal-hive', 'hive.json'),
      JSON.stringify(terminalHive, null, 2)
    );
    writeTracking(projectDir, 'task-a1.json', {
      status: 'completed',
      taskId: 'task-a1',
      agentId: 'agent-terminal',
      hiveId: 'terminal-hive',
      startedAt: isoMsAgo(60_000),
      pid: 23456,
    });
    writeResult(projectDir, 'task-a1');

    writeHive(projectDir, 'active-hive', []);
    writeTracking(projectDir, 'task-b2.json', {
      status: 'completed',
      taskId: 'task-b2',
      agentId: 'agent-active',
      hiveId: 'active-hive',
      startedAt: isoMsAgo(60_000),
      pid: 23457,
    });
    writeResult(projectDir, 'task-b2');

    writeTracking(projectDir, 'task-c3.json', {
      status: 'completed',
      taskId: 'task-c3',
      agentId: 'agent-missing',
      hiveId: 'missing-hive',
      startedAt: isoMsAgo(60_000),
      pid: 23458,
    });
    writeResult(projectDir, 'task-c3');

    const tasksDir = join(projectDir, '.hive-flow', 'tasks');
    for (const file of readdirSync(tasksDir)) {
      touchOld(join(tasksDir, file), 60_000);
    }

    const mod = loadCleanupModule(projectDir);
    const result = mod.cleanupOrphanedTasks(Date.now() + 2000);

    assert.equal(result.completedResultsCleaned, 1);
    assert.equal(existsSync(join(tasksDir, 'task-a1.json')), false);
    assert.equal(existsSync(join(tasksDir, 'task-a1.result.json')), false);
    assert.equal(existsSync(join(tasksDir, 'task-b2.json')), true);
    assert.equal(existsSync(join(tasksDir, 'task-b2.result.json')), true);
    assert.equal(existsSync(join(tasksDir, 'task-c3.json')), true);
    assert.equal(existsSync(join(tasksDir, 'task-c3.result.json')), true);
  });

  it('prunes only the legacy watchers directory and leaves live data watcher files untouched', () => {
    const projectDir = makeProjectDir();
    tempDirs.push(projectDir);
    const legacyDir = join(projectDir, '.hive-flow', 'watchers');
    const dataDir = join(projectDir, '.hive-flow', 'data');
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const legacyWatcher = join(legacyDir, 'old.json');
    const liveWatcher = join(dataDir, 'watcher-hive.json');
    writeFileSync(legacyWatcher, '{}');
    writeFileSync(liveWatcher, '{}');
    touchOld(legacyWatcher, 60_000);
    touchOld(liveWatcher, 60_000);

    const mod = loadCleanupModule(projectDir);
    assert.equal(typeof mod.cleanupLegacyWatchersDir, 'function');
    const result = mod.cleanupLegacyWatchersDir(Date.now() + 2000);

    assert.equal(result.watchersPruned, 1);
    assert.equal(existsSync(legacyWatcher), false);
    assert.equal(existsSync(liveWatcher), true);
  });
});
