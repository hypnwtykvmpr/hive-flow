import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queenTools } from '../queen-tools.js';
import { createHive, loadHive, saveHive, withHiveLock } from '../hive-store.js';
import { setWorkflowHookDispatcher } from '../workflow-executor.js';
import type { HiveAuditEntry, HiveRecord, HiveWorkerRecord } from '../hive-store.js';

const originalCwd = process.cwd();
const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
let tempDir: string;

function getQueenTool(name: string) {
  const tool = queenTools.find(t => t.name === name);
  if (!tool) throw new Error(`Missing queen tool ${name}`);
  return tool;
}

function isoMsAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function makeWorker(overrides: Partial<HiveWorkerRecord> = {}): HiveWorkerRecord {
  return {
    workerId: 'worker-1',
    agentId: 'agent-1',
    role: 'coder',
    provider: 'codex-cli',
    status: 'idle',
    spawnedAt: isoMsAgo(10 * 60_000),
    ...overrides,
  };
}

function taskedAudit(hiveId: string, worker: HiveWorkerRecord): HiveAuditEntry {
  return {
    timestamp: isoMsAgo(9 * 60_000),
    event: 'worker-tasked',
    hiveId,
    workerId: worker.workerId,
    agentId: worker.agentId,
    detail: `${worker.workerId} was tasked`,
  };
}

async function seedHive(workers: HiveWorkerRecord[], audit: HiveAuditEntry[] = []): Promise<HiveRecord> {
  const hive = createHive('queen-settlement', { maxWorkers: workers.length || 1 });
  await withHiveLock(hive.hiveId, () => {
    const fresh = loadHive(hive.hiveId);
    if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
    fresh.status = 'active';
    fresh.workers = workers;
    fresh.audit = audit;
    fresh.budget.workersAllocated = workers.length;
    saveHive(hive.hiveId, fresh);
  });
  const saved = loadHive(hive.hiveId);
  if (!saved) throw new Error(`Missing saved hive ${hive.hiveId}`);
  return saved;
}

function writeTracking(taskId: string, tracking: Record<string, unknown>, result?: unknown): void {
  const tasksDir = join(tempDir, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({
    taskId,
    status: 'running',
    startedAt: isoMsAgo(5 * 60_000),
    ...tracking,
  }, null, 2));
  if (result !== undefined) {
    writeFileSync(join(tasksDir, `${taskId}.result.json`), JSON.stringify(result, null, 2));
  }
}

async function pollHive(hiveId: string): Promise<Record<string, unknown>> {
  const tool = getQueenTool('hive_poll_workers');
  return await tool.handler({ hiveId }) as Record<string, unknown>;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'queen-tools-settlement-'));
  process.chdir(tempDir);
  process.env.CLAUDE_PROJECT_DIR = tempDir;
  delete process.env.HIVE_FLOW_SETTLE_GRACE_MS;
  setWorkflowHookDispatcher(null);
});

afterEach(() => {
  delete process.env.HIVE_FLOW_SETTLE_GRACE_MS;
  setWorkflowHookDispatcher(null);
  process.chdir(originalCwd);
  if (originalProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('queen hive settlement predicate', () => {
  it('settles a never-tasked hive after the startup grace window as failed', async () => {
    const worker = makeWorker();
    const hive = await seedHive([worker]);

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.runningCount).toBe(0);
    expect(result.completedCount).toBe(0);
    expect(result.allComplete).toBe(true);
    expect(result.allWorkersSettled).toBe(true);
    expect(settled?.status).toBe('failed');
    expect(settled?.completedAt).toBeTruthy();
    expect(settled?.error).toMatch(/Hive settled with no completed workers/);
  });

  it('keeps a freshly-spawned never-tasked hive active inside the startup grace window', async () => {
    const worker = makeWorker({ spawnedAt: isoMsAgo(2_000) });
    const hive = await seedHive([worker]);

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.runningCount).toBe(0);
    expect(result.allComplete).toBe(false);
    expect(result.readyForReport).toBe(false);
    expect(settled?.status).toBe('active');
    expect(settled?.completedAt).toBeUndefined();
  });

  it('settles completed tasked workers as completed', async () => {
    const worker = makeWorker();
    const hive = await seedHive([worker]);
    writeTracking('task-complete', {
      agentId: worker.agentId,
      pid: process.pid,
    }, { ok: true });
    await withHiveLock(hive.hiveId, () => {
      const fresh = loadHive(hive.hiveId);
      if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
      fresh.audit.push(taskedAudit(hive.hiveId, worker));
      saveHive(hive.hiveId, fresh);
    });

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.completedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.allComplete).toBe(true);
    expect(settled?.status).toBe('completed');
    expect(settled?.error).toBeUndefined();
    expect(settled?.completedAt).toBeTruthy();
  });

  it('does not settle while any worker is still running', async () => {
    const running = makeWorker({ workerId: 'worker-running', agentId: 'agent-running' });
    const completed = makeWorker({ workerId: 'worker-completed', agentId: 'agent-completed' });
    const hive = await seedHive([running, completed]);
    await withHiveLock(hive.hiveId, () => {
      const fresh = loadHive(hive.hiveId);
      if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
      fresh.audit = [taskedAudit(hive.hiveId, running), taskedAudit(hive.hiveId, completed)];
      saveHive(hive.hiveId, fresh);
    });
    writeTracking('task-running', {
      agentId: running.agentId,
      pid: process.pid,
      status: 'running',
    });
    writeTracking('task-done', {
      agentId: completed.agentId,
      pid: process.pid,
    }, { ok: true });

    const result = await pollHive(hive.hiveId);
    const settled = loadHive(hive.hiveId);

    expect(result.success).toBe(true);
    expect(result.runningCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.allComplete).toBe(false);
    expect(settled?.status).toBe('active');
  });
});
