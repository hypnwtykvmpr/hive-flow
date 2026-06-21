import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { sanitizeSessionId } from '../mcp-tools/session-id.js';
import { readJsonFile } from './storage.js';
import type { ActiveHiveOwnershipSummary } from './types.js';

const MAX_HIVE_RECORDS = 500;

interface HiveRecordShape {
  hiveId?: unknown;
  status?: unknown;
  ownerSessionId?: unknown;
  queenId?: unknown;
  queenPid?: unknown;
  queen?: unknown;
  workers?: unknown;
}

interface HiveWorkerShape {
  workerId?: unknown;
  agentId?: unknown;
  status?: unknown;
  taskId?: unknown;
  currentTaskPid?: unknown;
  pid?: unknown;
}

interface TaskMetadataShape {
  status?: unknown;
  pid?: unknown;
}

function isActiveHiveRecord(record: unknown): record is HiveRecordShape {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const status = (record as HiveRecordShape).status;
  return typeof status === 'string' && status.toLowerCase() === 'active';
}

export interface ActiveHiveRuntimeState {
  activeHives?: ActiveHiveOwnershipSummary;
  activeAgentIds: ReadonlySet<string>;
  hiveAgentIds: ReadonlySet<string>;
  activeHiveIds: ReadonlySet<string>;
  inspected: number;
}

const TERMINAL_STATUSES = new Set([
  'cancelled',
  'canceled',
  'complete',
  'completed',
  'done',
  'failed',
  'terminal',
  'terminated',
]);

function normalizeStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isTerminalStatus(value: unknown): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 1;
}

function isPidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'ESRCH';
  }
}

function isLivePid(value: unknown): boolean {
  return isPositiveInteger(value) && !isPidDefinitelyDead(value);
}

function recordQueenPid(record: HiveRecordShape): unknown {
  if (isLivePid(record.queenPid)) return record.queenPid;
  if (record.queen && typeof record.queen === 'object' && !Array.isArray(record.queen)) {
    return (record.queen as { pid?: unknown }).pid;
  }
  return undefined;
}

function extractWorkers(record: HiveRecordShape): HiveWorkerShape[] {
  if (!Array.isArray(record.workers)) return [];
  return record.workers.filter(
    (worker): worker is HiveWorkerShape =>
      worker !== null && typeof worker === 'object' && !Array.isArray(worker),
  );
}

async function taskResultExists(tasksRoot: string, taskId: string): Promise<boolean> {
  try {
    const stat = await lstat(join(tasksRoot, `${taskId}.result.json`));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function taskMetadataTerminal(tasksRoot: string, taskId: string): Promise<boolean> {
  const meta = await readJsonFile<TaskMetadataShape>(join(tasksRoot, `${taskId}.json`)).catch(
    () => undefined,
  );
  return isTerminalStatus(meta?.status);
}

async function taskMetadataLivePid(tasksRoot: string, taskId: string): Promise<boolean> {
  const meta = await readJsonFile<TaskMetadataShape>(join(tasksRoot, `${taskId}.json`)).catch(
    () => undefined,
  );
  return isLivePid(meta?.pid);
}

async function isWorkerLive(tasksRoot: string, worker: HiveWorkerShape): Promise<boolean> {
  if (isTerminalStatus(worker.status)) return false;
  if (isLivePid(worker.currentTaskPid) || isLivePid(worker.pid)) return true;
  const taskId = typeof worker.taskId === 'string' && worker.taskId.trim()
    ? worker.taskId.trim()
    : '';
  if (!taskId) return false;
  if (await taskResultExists(tasksRoot, taskId)) return false;
  if (await taskMetadataTerminal(tasksRoot, taskId)) return false;
  return taskMetadataLivePid(tasksRoot, taskId);
}

function workerAgentId(worker: HiveWorkerShape): string | null {
  if (typeof worker.agentId === 'string' && worker.agentId.trim()) return worker.agentId.trim();
  if (typeof worker.workerId === 'string' && worker.workerId.trim()) return worker.workerId.trim();
  return null;
}

export async function collectActiveHiveRuntimeState(
  projectRoot: string,
): Promise<ActiveHiveRuntimeState | undefined> {
  const hivesRoot = join(projectRoot, '.hive-flow', 'hives');
  const tasksRoot = join(projectRoot, '.hive-flow', 'tasks');
  try {
    const stat = await lstat(hivesRoot);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  let entries;
  try {
    entries = await readdir(hivesRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let active = 0;
  let unknownOwner = 0;
  let inspected = 0;
  const byOwnerSessionId: Record<string, number> = {};
  const activeAgentIds = new Set<string>();
  const hiveAgentIds = new Set<string>();
  const activeHiveIds = new Set<string>();

  for (const entry of entries) {
    if (inspected >= MAX_HIVE_RECORDS) break;
    if (!entry.isDirectory()) continue;
    inspected++;

    const record = await readJsonFile<unknown>(join(hivesRoot, entry.name, 'hive.json')).catch(
      () => undefined,
    );
    if (!isActiveHiveRecord(record)) continue;

    const ownerSessionId = sanitizeSessionId(record.ownerSessionId);
    if (ownerSessionId === null) continue;

    const workers = extractWorkers(record);
    let hasLiveWorker = false;
    for (const worker of workers) {
      const agentId = workerAgentId(worker);
      if (agentId !== null) hiveAgentIds.add(agentId);
      if (!(await isWorkerLive(tasksRoot, worker))) continue;
      hasLiveWorker = true;
      if (agentId !== null) activeAgentIds.add(agentId);
    }
    const hasLiveQueen = isLivePid(recordQueenPid(record));
    if (typeof record.queenId === 'string' && record.queenId.trim()) {
      const queenId = record.queenId.trim();
      hiveAgentIds.add(queenId);
      if (hasLiveWorker || hasLiveQueen) activeAgentIds.add(queenId);
    }
    if (!hasLiveWorker && !hasLiveQueen) continue;
    activeHiveIds.add(entry.name);
    if (typeof record.hiveId === 'string' && record.hiveId.trim()) {
      activeHiveIds.add(record.hiveId.trim());
    }

    active++;
    byOwnerSessionId[ownerSessionId] = (byOwnerSessionId[ownerSessionId] ?? 0) + 1;
  }

  if (active <= 0) {
    return { activeAgentIds, hiveAgentIds, activeHiveIds, inspected };
  }
  return {
    activeHives: { active, unknownOwner, byOwnerSessionId },
    activeAgentIds,
    hiveAgentIds,
    activeHiveIds,
    inspected,
  };
}

export async function collectActiveHiveOwnership(
  projectRoot: string,
): Promise<ActiveHiveOwnershipSummary | undefined> {
  const state = await collectActiveHiveRuntimeState(projectRoot);
  return state?.activeHives;
}
