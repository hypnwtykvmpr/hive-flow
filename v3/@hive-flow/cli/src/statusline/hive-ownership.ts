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
  provider?: unknown;
  model?: unknown;
  resolvedModel?: unknown;
}

interface TaskMetadataShape {
  status?: unknown;
  pid?: unknown;
  provider?: unknown;
  model?: unknown;
  resolvedModel?: unknown;
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
  activeAgents: ReadonlyArray<ActiveHiveRuntimeAgent>;
  inspected: number;
}

export interface ActiveHiveRuntimeAgent {
  agentId: string;
  ownerSessionId: string;
  role: 'queen' | 'worker';
  status: 'busy' | 'idle';
  hiveId: string;
  currentTaskPid?: number;
  taskId?: string;
  provider?: string;
  model?: string;
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

function isLivePid(value: unknown): value is number {
  return isPositiveInteger(value) && !isPidDefinitelyDead(value);
}

function recordQueenPid(record: HiveRecordShape): unknown {
  if (isLivePid(record.queenPid)) return record.queenPid;
  if (record.queen && typeof record.queen === 'object' && !Array.isArray(record.queen)) {
    const legacyPid = (record.queen as { pid?: unknown }).pid;
    return isLivePid(legacyPid) ? legacyPid : undefined;
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

async function taskMetadata(tasksRoot: string, taskId: string): Promise<TaskMetadataShape | undefined> {
  return readJsonFile<TaskMetadataShape>(join(tasksRoot, `${taskId}.json`)).catch(() => undefined);
}

async function taskMetadataLivePid(tasksRoot: string, taskId: string): Promise<number | undefined> {
  const meta = await readJsonFile<TaskMetadataShape>(join(tasksRoot, `${taskId}.json`)).catch(
    () => undefined,
  );
  const pid = meta?.pid;
  return isLivePid(pid) ? pid : undefined;
}

async function workerLivePid(tasksRoot: string, worker: HiveWorkerShape): Promise<number | undefined> {
  if (isTerminalStatus(worker.status)) return undefined;
  if (isLivePid(worker.currentTaskPid)) return worker.currentTaskPid;
  if (isLivePid(worker.pid)) return worker.pid;
  const taskId = typeof worker.taskId === 'string' && worker.taskId.trim()
    ? worker.taskId.trim()
    : '';
  if (!taskId) return undefined;
  if (await taskResultExists(tasksRoot, taskId)) return undefined;
  if (await taskMetadataTerminal(tasksRoot, taskId)) return undefined;
  return taskMetadataLivePid(tasksRoot, taskId);
}

async function isWorkerLive(tasksRoot: string, worker: HiveWorkerShape): Promise<boolean> {
  return (await workerLivePid(tasksRoot, worker)) !== undefined;
}

function workerAgentId(worker: HiveWorkerShape): string | null {
  if (typeof worker.agentId === 'string' && worker.agentId.trim()) return worker.agentId.trim();
  if (typeof worker.workerId === 'string' && worker.workerId.trim()) return worker.workerId.trim();
  return null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Record the worker + queen agent ids of ANY hive record (active OR
 * terminated/failed) into `hiveAgentIds`. This set marks an agent as
 * "belongs to some hive" so the empty-`config.hiveId` branch in
 * `shouldKeepRuntimeAgent` can exclude an orphaned worker once its hive is no
 * longer active. Accepts `unknown` because terminated records do not pass
 * `isActiveHiveRecord`; parses defensively and is a no-op on garbage input.
 */
function registerHiveAgentIds(record: unknown, hiveAgentIds: Set<string>): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  const shape = record as HiveRecordShape;
  for (const worker of extractWorkers(shape)) {
    const agentId = workerAgentId(worker);
    if (agentId !== null) hiveAgentIds.add(agentId);
  }
  if (typeof shape.queenId === 'string' && shape.queenId.trim()) {
    hiveAgentIds.add(shape.queenId.trim());
  }
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
  const activeAgents: ActiveHiveRuntimeAgent[] = [];

  for (const entry of entries) {
    if (inspected >= MAX_HIVE_RECORDS) break;
    if (!entry.isDirectory()) continue;
    inspected++;

    const record = await readJsonFile<unknown>(join(hivesRoot, entry.name, 'hive.json')).catch(
      () => undefined,
    );

    // F1/F4 fix: a worker belonging to a TERMINATED/failed hive must still be
    // recognized as hive-associated so the empty-hiveId branch in
    // `shouldKeepRuntimeAgent` (collectors/swarm.ts) excludes it once its hive
    // is no longer active. Populate `hiveAgentIds` from EVERY hive record
    // (active + terminated) before the active-only guard; the active-only sets
    // (`activeAgentIds` / `activeHiveIds` / `active` count) stay gated below.
    registerHiveAgentIds(record, hiveAgentIds);

    if (!isActiveHiveRecord(record)) continue;

    const ownerSessionId = sanitizeSessionId(record.ownerSessionId);
    if (ownerSessionId === null) continue;

    // `hiveAgentIds` for this record's workers/queen was already populated by
    // `registerHiveAgentIds` above; here we only gate the active-only sets.
    const workers = extractWorkers(record);
    let hasLiveWorker = false;
    for (const worker of workers) {
      const agentId = workerAgentId(worker);
      const currentTaskPid = await workerLivePid(tasksRoot, worker);
      if (currentTaskPid === undefined) continue;
      hasLiveWorker = true;
      if (agentId !== null) activeAgentIds.add(agentId);
      if (agentId !== null) {
        const taskId = optionalString(worker.taskId);
        const meta = taskId !== undefined ? await taskMetadata(tasksRoot, taskId) : undefined;
        const provider = optionalString(worker.provider) ?? optionalString(meta?.provider);
        const model =
          optionalString(worker.resolvedModel) ??
          optionalString(worker.model) ??
          optionalString(meta?.resolvedModel) ??
          optionalString(meta?.model);
        activeAgents.push({
          agentId,
          ownerSessionId,
          role: 'worker',
          status: 'busy',
          hiveId: typeof record.hiveId === 'string' && record.hiveId.trim()
            ? record.hiveId.trim()
            : entry.name,
          currentTaskPid,
          ...(taskId !== undefined ? { taskId } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
        });
      }
    }
    const hasLiveQueen = isLivePid(recordQueenPid(record));
    if (typeof record.queenId === 'string' && record.queenId.trim()) {
      const queenId = record.queenId.trim();
      if (hasLiveWorker || hasLiveQueen) {
        activeAgentIds.add(queenId);
        activeAgents.push({
          agentId: queenId,
          ownerSessionId,
          role: 'queen',
          status: 'idle',
          hiveId: typeof record.hiveId === 'string' && record.hiveId.trim()
            ? record.hiveId.trim()
            : entry.name,
        });
      }
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
    return { activeAgentIds, hiveAgentIds, activeHiveIds, activeAgents, inspected };
  }
  return {
    activeHives: { active, unknownOwner, byOwnerSessionId },
    activeAgentIds,
    hiveAgentIds,
    activeHiveIds,
    activeAgents,
    inspected,
  };
}

export async function collectActiveHiveOwnership(
  projectRoot: string,
): Promise<ActiveHiveOwnershipSummary | undefined> {
  const state = await collectActiveHiveRuntimeState(projectRoot);
  return state?.activeHives;
}
