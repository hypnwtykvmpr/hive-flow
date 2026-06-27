import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HiveRecord, HiveWorkerRecord } from '../hive-store.js';

const originalCwd = process.cwd();
const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
let tempDir: string;
let taskCalls: Array<Record<string, unknown>>;

const DEAD_PID = 2147480000;

function isoMsAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function tasksDir(): string {
  return join(tempDir, '.hive-flow', 'tasks');
}

function agentsDir(): string {
  return join(tempDir, '.hive-flow', 'agents');
}

function writeTracking(taskId: string, tracking: Record<string, unknown>): void {
  mkdirSync(tasksDir(), { recursive: true });
  writeJson(join(tasksDir(), `${taskId}.json`), {
    status: 'running',
    taskId,
    agentId: 'agent-dead',
    startedAt: isoMsAgo(10 * 60_000),
    pid: DEAD_PID,
    timeoutMs: 120_000,
    ...tracking,
  });
}

function writeTask(taskId: string, prompt = 'recover this exact task'): void {
  mkdirSync(tasksDir(), { recursive: true });
  writeFileSync(join(tasksDir(), `${taskId}.task`), prompt, 'utf-8');
}

async function importQueenModules() {
  vi.resetModules();
  taskCalls = [];
  vi.doMock('../agent-tools.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../agent-tools.js')>();
    const mockedAgentTask = {
      name: 'agent_task',
      handler: async (input: Record<string, unknown>) => {
        const retryContext = (input as Record<symbol, unknown>)[actual.AGENT_TASK_RETRY_CONTEXT];
        taskCalls.push({ ...input, __retryContext: retryContext });
        const replacementTaskId = `task-retry-${taskCalls.length}`;
        const store = actual.loadAgentStore();
        const agent = store.agents[input.agentId as string];
        if (agent) {
          actual.transitionAgent(agent, 'busy');
          agent.currentTaskId = replacementTaskId;
          agent.currentTaskPid = process.pid;
          actual.saveAgentStore(store);
        }
        writeTask(replacementTaskId, input.task as string);
        writeTracking(replacementTaskId, {
          agentId: input.agentId,
          pid: process.pid,
          timeoutMs: input.timeout,
          ...(retryContext && typeof retryContext === 'object' ? retryContext as Record<string, unknown> : {}),
        });
        return {
          success: true,
          taskId: replacementTaskId,
          status: 'running',
          agentId: input.agentId,
          pid: process.pid,
        };
      },
    };
    return {
      ...actual,
      agentTools: [
        ...actual.agentTools.filter(tool => tool.name !== 'agent_task'),
        mockedAgentTask,
      ],
    };
  });

  const queen = await import('../queen-tools.js');
  const hiveStore = await import('../hive-store.js');
  return { queenTools: queen.queenTools, ...hiveStore };
}

function getQueenTool(queenTools: Array<{ name: string; handler: (input: Record<string, unknown>) => unknown }>, name: string) {
  const tool = queenTools.find(entry => entry.name === name);
  if (!tool) throw new Error(`Missing queen tool ${name}`);
  return tool;
}

function writeAgentStore(): void {
  mkdirSync(agentsDir(), { recursive: true });
  writeJson(join(agentsDir(), 'store.json'), {
    version: '3.0.0',
    agents: {
      'agent-dead': {
        agentId: 'agent-dead',
        agentType: 'coder',
        status: 'busy',
        health: 1,
        taskCount: 0,
        config: {},
        createdAt: new Date().toISOString(),
        provider: 'deepseek',
        ownerSessionId: 'owner-session',
        ownerClientKind: 'claude',
        currentTaskId: 'task-dead',
        currentTaskPid: DEAD_PID,
      },
    },
  });
}

async function seedHive(
  createHive: typeof import('../hive-store.js').createHive,
  loadHive: typeof import('../hive-store.js').loadHive,
  saveHive: typeof import('../hive-store.js').saveHive,
  withHiveLock: typeof import('../hive-store.js').withHiveLock,
): Promise<HiveRecord> {
  const hive = createHive('queen-reassign', {
    maxWorkers: 1,
    ownerSessionId: 'owner-session',
    ownerClientKind: 'claude',
  });
  const worker: HiveWorkerRecord = {
    workerId: 'worker-dead',
    agentId: 'agent-dead',
    ownerSessionId: 'owner-session',
    ownerClientKind: 'claude',
    role: 'coder',
    provider: 'deepseek',
    status: 'busy',
    spawnedAt: isoMsAgo(10 * 60_000),
    taskId: 'task-dead',
  };
  await withHiveLock(hive.hiveId, () => {
    const fresh = loadHive(hive.hiveId);
    if (!fresh) throw new Error(`Missing hive ${hive.hiveId}`);
    fresh.status = 'active';
    fresh.workers = [worker];
    fresh.budget.workersAllocated = 1;
    fresh.audit = [{
      timestamp: isoMsAgo(9 * 60_000),
      event: 'worker-tasked',
      hiveId: hive.hiveId,
      workerId: worker.workerId,
      agentId: worker.agentId,
      detail: 'original task dispatched',
    }];
    saveHive(hive.hiveId, fresh);
  });
  const saved = loadHive(hive.hiveId);
  if (!saved) throw new Error(`Missing saved hive ${hive.hiveId}`);
  return saved;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'queen-dead-worker-reassign-'));
  process.chdir(tempDir);
  process.env.CLAUDE_PROJECT_DIR = tempDir;
});

afterEach(() => {
  vi.doUnmock('../agent-tools.js');
  vi.restoreAllMocks();
  vi.resetModules();
  process.chdir(originalCwd);
  if (originalProjectDir === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('hive_poll_workers dead-worker reassignment', () => {
  it('reassigns a definitely-dead worker task once using the original .task payload', async () => {
    const { queenTools, createHive, loadHive, saveHive, withHiveLock } = await importQueenModules();
    writeAgentStore();
    const hive = await seedHive(createHive, loadHive, saveHive, withHiveLock);
    writeTask('task-dead', 'original prompt');
    writeTracking('task-dead', {});

    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === DEAD_PID) {
        const err = new Error('dead process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;

    try {
      const poll = getQueenTool(queenTools, 'hive_poll_workers');
      const result = await poll.handler({ hiveId: hive.hiveId }) as Record<string, unknown>;

      expect(result.runningCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(taskCalls).toHaveLength(1);
      expect(taskCalls[0]).toMatchObject({
        agentId: 'agent-dead',
        task: 'original prompt',
        timeout: 120_000,
        __retryContext: {
          retryCount: 1,
          reassignedFromTaskId: 'task-dead',
          originalTaskId: 'task-dead',
        },
      });

      const oldTracking = readJson(join(tasksDir(), 'task-dead.json'));
      expect(oldTracking.status).toBe('failed');
      expect(oldTracking.failureReason).toBe('worker-process-dead');
      expect(oldTracking.reassignedToTaskId).toBe('task-retry-1');
      expect(oldTracking.retryCount).toBe(1);

      const replacementTracking = readJson(join(tasksDir(), 'task-retry-1.json'));
      expect(replacementTracking.reassignedFromTaskId).toBe('task-dead');
      expect(replacementTracking.retryCount).toBe(1);

      const updatedHive = loadHive(hive.hiveId);
      expect(updatedHive?.workers[0].status).toBe('busy');
      expect(updatedHive?.workers[0].taskId).toBe('task-retry-1');
      expect(updatedHive?.audit.some(entry => entry.detail.includes("Reassigned dead-worker task 'task-dead'"))).toBe(true);

      const store = readJson<{ agents: Record<string, Record<string, unknown>> }>(join(agentsDir(), 'store.json'));
      expect(store.agents['agent-dead'].status).toBe('busy');
      expect(store.agents['agent-dead'].currentTaskId).toBe('task-retry-1');
    } finally {
      process.kill = originalKill;
    }
  });

  it('does not retry a dead worker task more than once', async () => {
    const { queenTools, createHive, loadHive, saveHive, withHiveLock } = await importQueenModules();
    writeAgentStore();
    const hive = await seedHive(createHive, loadHive, saveHive, withHiveLock);
    writeTask('task-dead', 'original prompt');
    writeTracking('task-dead', { retryCount: 1 });

    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === DEAD_PID) {
        const err = new Error('dead process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;

    try {
      const poll = getQueenTool(queenTools, 'hive_poll_workers');
      const result = await poll.handler({ hiveId: hive.hiveId }) as Record<string, unknown>;

      expect(result.runningCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(taskCalls).toHaveLength(0);
      expect(readJson(join(tasksDir(), 'task-dead.json')).status).toBe('failed');
      expect(loadHive(hive.hiveId)?.workers[0].taskId).toBe('task-dead');
    } finally {
      process.kill = originalKill;
    }
  });

  it('treats EPERM liveness as still running without corrupting tracking', async () => {
    const { queenTools, createHive, loadHive, saveHive, withHiveLock } = await importQueenModules();
    writeAgentStore();
    const hive = await seedHive(createHive, loadHive, saveHive, withHiveLock);
    writeTask('task-dead', 'original prompt');
    writeTracking('task-dead', {});

    const originalTracking = readJson(join(tasksDir(), 'task-dead.json'));
    const originalKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === DEAD_PID) {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;

    try {
      const poll = getQueenTool(queenTools, 'hive_poll_workers');
      const result = await poll.handler({ hiveId: hive.hiveId }) as Record<string, unknown>;

      expect(result.runningCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(taskCalls).toHaveLength(0);
      expect(readJson(join(tasksDir(), 'task-dead.json'))).toEqual(originalTracking);

      const updatedHive = loadHive(hive.hiveId);
      expect(updatedHive?.workers[0].status).toBe('busy');
      expect(updatedHive?.workers[0].taskId).toBe('task-dead');
    } finally {
      process.kill = originalKill;
    }
  });
});
