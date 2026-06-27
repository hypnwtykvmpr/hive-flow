/**
 * HF-13 Slice D1 — reaper lifecycle resilience for cleanupStaleBusyAgents().
 *
 * Exercises the EXTENDED stuck-busy reaper in
 *   /.claude/helpers/hive-cleanup.cjs
 * after the operator applies the reaper patch from the D1 report.
 *
 * The reaper must reap/idle a busy agent when EITHER:
 *   (1) currentTaskPid is a positive PID that is definitely DEAD (ESRCH), OR
 *   (2) currentTaskId resolves to tracking PAST deadlineAt with NO result file
 *       (even when the recorded PID is still alive).
 *   (3) status is busy, but there is no task/PID evidence and the record is
 *       older than the idle timeout.
 * Result-file-present is terminal: clear fields, do not keep busy.
 * It must NOT over-reap: live-in-deadline tasks, missing/malformed tracking,
 * and fresh no-task dispatch-window records are preserved.
 *
 * The patch makes the module require()-able by:
 *   - honoring HIVE_FLOW_CLEANUP_PROJECT_DIR for PROJECT_DIR, and
 *   - exporting cleanupStaleBusyAgents (IIFE only runs as `node hive-cleanup.cjs`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Canonical reaper lives at repo-root /.claude/helpers/hive-cleanup.cjs.
// This test file is at v3/@hive-flow/cli/src/__tests__/ → up 5 to repo root.
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const CLEANUP_CJS = join(REPO_ROOT, '.claude', 'helpers', 'hive-cleanup.cjs');

let tmpRoot;
let agentsDir;
let tasksDir;
let storePath;

function writeStore(agents) {
  writeFileSync(storePath, JSON.stringify({ agents, version: '3.0.0' }, null, 2), 'utf-8');
}

function readStore() {
  return JSON.parse(readFileSync(storePath, 'utf-8'));
}

function writeTracking(taskId, tracking) {
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify(tracking, null, 2), 'utf-8');
}

function writeResult(taskId, result = { success: true }) {
  writeFileSync(join(tasksDir, `${taskId}.result.json`), JSON.stringify(result, null, 2), 'utf-8');
}

/** A PID that is essentially guaranteed dead (max pid + 1 region). */
const DEAD_PID = 2147480000;
/** Our own pid is guaranteed alive. */
const LIVE_PID = process.pid;

function loadReaper() {
  // Fresh module each test so PROJECT_DIR re-resolves from the env override.
  delete require.cache[require.resolve(CLEANUP_CJS)];
  return require(CLEANUP_CJS);
}

describe('cleanupStaleBusyAgents — HF-13 D1 reaper', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hf-reaper-'));
    agentsDir = join(tmpRoot, '.hive-flow', 'agents');
    tasksDir = join(tmpRoot, '.hive-flow', 'tasks');
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(tasksDir, { recursive: true });
    storePath = join(agentsDir, 'store.json');
    process.env.HIVE_FLOW_CLEANUP_PROJECT_DIR = tmpRoot;
  });

  afterEach(() => {
    delete process.env.HIVE_FLOW_CLEANUP_PROJECT_DIR;
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('reaps a busy agent whose currentTaskPid is definitely dead (clears both fields)', async () => {
    writeStore({
      a1: { agentId: 'a1', status: 'busy', currentTaskPid: DEAD_PID, currentTaskId: 'task-dead-pid' },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    const summary = await cleanupStaleBusyAgents();

    expect(summary.staleBusyReaped).toBeGreaterThanOrEqual(1);
    const agent = readStore().agents.a1;
    expect(agent.status).toBe('idle');
    expect(agent.currentTaskPid).toBeUndefined();
    expect(agent.currentTaskId).toBeUndefined();
  });

  it('reaps a busy agent whose currentTaskId is past deadlineAt with no result (pid absent)', async () => {
    const taskId = 'task-past-deadline';
    writeTracking(taskId, {
      status: 'running',
      taskId,
      agentId: 'a2',
      startedAt: new Date(Date.now() - 600000).toISOString(),
      deadlineAt: new Date(Date.now() - 60000).toISOString(), // 1 min ago
      // no pid — liveness unknown
    });
    writeStore({
      a2: { agentId: 'a2', status: 'busy', currentTaskId: taskId },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    const summary = await cleanupStaleBusyAgents();

    expect(summary.staleBusyReaped).toBeGreaterThanOrEqual(1);
    const agent = readStore().agents.a2;
    expect(agent.status).toBe('idle');
    expect(agent.currentTaskId).toBeUndefined();
    expect(agent.currentTaskPid).toBeUndefined();
  });

  it('treats result-file-present as terminal — clears fields, does not keep busy', async () => {
    const taskId = 'task-with-result';
    writeTracking(taskId, {
      status: 'running',
      taskId,
      agentId: 'a3',
      startedAt: new Date(Date.now() - 600000).toISOString(),
      deadlineAt: new Date(Date.now() - 60000).toISOString(),
    });
    writeResult(taskId, { success: true, response: 'done' });
    writeStore({
      a3: { agentId: 'a3', status: 'busy', currentTaskId: taskId },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    await cleanupStaleBusyAgents();

    const agent = readStore().agents.a3;
    expect(agent.status).toBe('idle');
    expect(agent.currentTaskId).toBeUndefined();
    expect(agent.currentTaskPid).toBeUndefined();
  });

  it('does NOT reap a busy agent whose task is within deadline (live in time)', async () => {
    const taskId = 'task-in-time';
    writeTracking(taskId, {
      status: 'running',
      taskId,
      agentId: 'a4',
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 300000).toISOString(), // 5 min in future
      pid: LIVE_PID,
    });
    writeStore({
      a4: { agentId: 'a4', status: 'busy', currentTaskId: taskId, currentTaskPid: LIVE_PID },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    const summary = await cleanupStaleBusyAgents();

    expect(summary.staleBusyReaped).toBe(0);
    const agent = readStore().agents.a4;
    expect(agent.status).toBe('busy');
    expect(agent.currentTaskId).toBe(taskId);
  });

  it('reaps a task past deadlineAt even when the recorded PID is still alive', async () => {
    const taskId = 'task-live-past-deadline';
    writeTracking(taskId, {
      status: 'running',
      taskId,
      agentId: 'a5',
      startedAt: new Date(Date.now() - 600000).toISOString(),
      deadlineAt: new Date(Date.now() - 60000).toISOString(),
      pid: LIVE_PID,
    });
    writeStore({
      a5: { agentId: 'a5', status: 'busy', currentTaskId: taskId, currentTaskPid: LIVE_PID },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    const summary = await cleanupStaleBusyAgents();

    expect(summary.staleBusyReaped).toBeGreaterThanOrEqual(1);
    const agent = readStore().agents.a5;
    expect(agent.status).toBe('idle');
    expect(agent.currentTaskId).toBeUndefined();
    expect(agent.currentTaskPid).toBeUndefined();
  });

  it('reaps ghost-busy records after the idle timeout age floor', async () => {
    writeStore({
      a9: {
        agentId: 'a9',
        status: 'busy',
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    const summary = await cleanupStaleBusyAgents();

    expect(summary.staleBusyReaped).toBeGreaterThanOrEqual(1);
    const agent = readStore().agents.a9;
    expect(agent.status).toBe('idle');
    expect(agent.idleSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves fresh ghost-busy records from the dispatch window', async () => {
    writeStore({
      a10: {
        agentId: 'a10',
        status: 'busy',
        createdAt: new Date().toISOString(),
      },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    const summary = await cleanupStaleBusyAgents();

    expect(summary.staleBusyReaped).toBe(0);
    const agent = readStore().agents.a10;
    expect(agent.status).toBe('busy');
  });

  it('is fail-safe on fresh missing/malformed tracking — no over-reap', async () => {
    // Missing/malformed tracking becomes reapable only after the idle age floor.
    // Fresh dispatch-window records are still preserved.
    const malformedId = 'task-malformed';
    writeFileSync(join(tasksDir, `${malformedId}.json`), '{ not valid json', 'utf-8');
    const now = new Date().toISOString();
    writeStore({
      a6: { agentId: 'a6', status: 'busy', currentTaskId: 'task-does-not-exist', createdAt: now },
      a7: { agentId: 'a7', status: 'busy', currentTaskId: malformedId, createdAt: now },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    const summary = await cleanupStaleBusyAgents();

    expect(summary.staleBusyReaped).toBe(0);
    const store = readStore();
    expect(store.agents.a6.status).toBe('busy');
    expect(store.agents.a7.status).toBe('busy');
  });

  it('does not touch idle agents', async () => {
    writeStore({
      a8: { agentId: 'a8', status: 'idle', currentTaskPid: DEAD_PID },
    });
    const { cleanupStaleBusyAgents } = loadReaper();
    const summary = await cleanupStaleBusyAgents();

    expect(summary.staleBusyReaped).toBe(0);
    expect(readStore().agents.a8.status).toBe('idle');
  });
});
