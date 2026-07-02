/**
 * Hive Store — Persistence layer for Hive Protocol records.
 *
 * Manages `.hive-flow/hives/{hiveId}/hive.json` with concurrency-safe
 * file locking (Condition 3). Provides typed interfaces for hive records,
 * workers, missions, and audit entries.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, renameSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizePathId } from '../shared/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_DIR = '.hive-flow';
const HIVES_DIR = 'hives';
const HIVE_FILE = 'hive.json';
const LOCK_FILE = '.lock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HiveStatus = 'pending' | 'active' | 'completed' | 'failed' | 'terminated';

/**
 * Budget constraints for a hive. `maxWorkers` is enforced as a hard limit
 * in `queen_spawn_worker` — spawn requests beyond this limit are rejected.
 */
export interface HiveBudget {
  /** Hard limit on the number of workers a queen can spawn (enforced in queen_spawn_worker) */
  maxWorkers: number;
  /** Maximum total cost allowance (informational — not enforced at persistence layer) */
  maxCost?: number;
  /** Number of workers currently allocated */
  workersAllocated: number;
}

export interface HiveWorkerRecord {
  workerId: string;
  agentId: string;
  ownerSessionId?: string;
  ownerClientKind?: string;
  role: string;
  provider: string;
  // P2-SH2 (hive-flow-4a28): permission-waiting / waiting-for-queen are first-class
  // BLOCKED states — a worker in them is NOT settled/idle and must NOT let a hive be
  // declared allComplete. Derived from pending permission requests at poll/settlement
  // time (source of truth) and surfaced in worker status reports.
  status: 'spawning' | 'idle' | 'busy' | 'error' | 'terminated' | 'permission-waiting' | 'waiting-for-queen';
  spawnedAt: string;
  /** ISO timestamp of when this worker was terminated (set by hive_terminate, hive-cleanup, queen-tools) */
  terminatedAt?: string;
  /** ISO timestamp of when this worker last transitioned to idle (for accurate idle timeout) */
  idleSince?: string;
  budgetAllocation?: number;
  /** Task ID of the most recently dispatched task for this worker (set by queen_mission_assign spawnAndTask) */
  taskId?: string;
}

export interface HiveMission {
  hiveId: string;
  scope: string;
  description: string;
  format?: string;
  assignedAt: string;
  assignedBy: string;
  providers?: string[];
}

export interface HiveAuditEntry {
  timestamp: string;
  event: 'mission-assigned' | 'worker-spawned' | 'worker-tasked' | 'worker-terminated' | 'results-collected' | 'report-submitted' | 'hive-terminated' | 'watcher-spawned' | 'permission-requested' | 'permission-reviewed' | 'error';
  hiveId: string;
  detail: string;
  agentId?: string;
  workerId?: string;
}

export type HivePermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'redirected' | 'redirect-failed' | 'halted';
export type HivePermissionDecision = 'approve' | 'deny' | 'redirect' | 'halt';

export interface HivePermissionRequest {
  requestId: string;
  taskId: string;
  agentId: string;
  workerId?: string;
  hiveId: string;
  queenId?: string;
  tool: string;
  denyReason: string;
  denyCode?: string;
  status: HivePermissionRequestStatus;
  requestedAt: string;
  updatedAt?: string;
  decision?: {
    decision: HivePermissionDecision;
    decidedAt: string;
    decidedBy: string;
    reason?: string;
    guidance?: string;
    redirectTask?: string;
    redirectError?: string;
    /** P2-SH7 (hive-flow-8119): a denied worker got a resume/continue instruction. */
    resumeDispatched?: boolean;
    resumeError?: string;
  };
}

/**
 * ModuleHiveConfig — optional config block for modular hive compositions.
 *
 * NOTE (Condition 6): `workerDependencies` keys are **role names**, not
 * worker IDs. Worker IDs are generated at runtime by `queen_spawn_worker`.
 * For example: `{ "coder": ["architect"], "tester": ["coder"] }` means
 * the "coder" role depends on "architect" completing first.
 */
export interface ModuleHiveConfig {
  /** Role-based dependency graph. Keys are role names, values are arrays of role names. */
  workerDependencies?: Record<string, string[]>;
  /** Default provider for workers in this hive */
  defaultProvider?: string;
  /** Timeout in ms before hive is considered stale (default: 3600000 = 1h) */
  stalenessTimeout?: number;
}

/** Queen delegation telemetry: tasked via queen_task_worker vs direct work (role.json). */
export interface DelegationMetrics {
  taskedCount: number;
  directWorkCount: number;
  /** taskedCount / (taskedCount + directWorkCount), or 1 when denominator is 0 */
  delegationRate: number;
}

/**
 * Core hive record persisted at `.hive-flow/hives/{hiveId}/hive.json`.
 *
 * The `error` field is populated when status transitions to `failed`
 * (Condition 4 — verification requirement).
 */
export interface HiveRecord {
  hiveId: string;
  queenId: string;
  /** Live-process proof captured from the queen agent when the hive is assigned. */
  queenPid?: number;
  /** Session that launched this hive, used for multi-session completion routing. */
  ownerSessionId?: string | null;
  /** Parent client that launched this hive, used for owned worker top-ups. */
  ownerClientKind?: string | null;
  status: HiveStatus;
  /** Error message when status is 'failed' (Condition 4) */
  error?: string;
  mission?: HiveMission;
  workers: HiveWorkerRecord[];
  budget: HiveBudget;
  config?: ModuleHiveConfig;
  audit: HiveAuditEntry[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Queen's synthesized report content (populated by queen_report) */
  report?: string;
  /** Worker tool-denial requests awaiting queen review. */
  permissionRequests?: HivePermissionRequest[];
  /** HMAC signature over the hive record for tamper detection */
  signature?: string;
  /** Queen delegation counters (directWorkCount synced from role.json on queen_report) */
  delegationMetrics?: DelegationMetrics;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getHivesDir(projectRoot = process.cwd()): string {
  return join(projectRoot, STORAGE_DIR, HIVES_DIR);
}

function getHiveDir(hiveId: string, projectRoot = process.cwd()): string {
  // A10: Use shared sanitizePathId utility to prevent path traversal
  const sanitized = sanitizePathId(hiveId, 128);
  if (!sanitized) throw new Error('Invalid hiveId');
  return join(getHivesDir(projectRoot), sanitized);
}

function getHivePath(hiveId: string, projectRoot = process.cwd()): string {
  return join(getHiveDir(hiveId, projectRoot), HIVE_FILE);
}

function getLockPath(hiveId: string, projectRoot = process.cwd()): string {
  return join(getHiveDir(hiveId, projectRoot), LOCK_FILE);
}

function ensureHiveDir(hiveId: string, projectRoot = process.cwd()): void {
  const dir = getHiveDir(hiveId, projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * P2-SH2 (hive-flow-4a28): the SINGLE shared source of truth for worker IDs BLOCKED
 * on an UNDECIDED permission request. Used by hive_poll_workers settlement, hive_status,
 * and the statusboard/agent_list runtime rows (the sentinel watcher mirrors this in
 * .cjs). DERIVED — never a persisted mutable status — from BOTH the persisted
 * hive.permissionRequests AND, when projectRoot is known, the append-only
 * permission-requests.jsonl (fresh bridge requests not yet surfaced to the queen).
 * A request blocks its worker unless a terminal decision is recorded (status !== 'pending').
 */
export function pendingPermissionBlockedWorkerIds(
  hive: {
    hiveId?: string;
    workers?: Array<{ workerId?: string; agentId?: string }>;
    permissionRequests?: HivePermissionRequest[];
  },
  projectRoot?: string,
): Set<string> {
  const blocked = new Set<string>();
  const agentToWorker = new Map<string, string>();
  for (const w of hive.workers ?? []) {
    if (w?.agentId && w?.workerId) agentToWorker.set(w.agentId, w.workerId);
  }
  const decided = new Map<string, HivePermissionRequestStatus>();
  for (const r of hive.permissionRequests ?? []) {
    if (r?.requestId) decided.set(r.requestId, r.status);
    if (r?.status === 'pending') {
      const wid = r.workerId || (r.agentId ? agentToWorker.get(r.agentId) : undefined);
      if (wid) blocked.add(wid);
    }
  }
  if (projectRoot && hive.hiveId) {
    try {
      const logPath = join(getHiveDir(hive.hiveId, projectRoot), 'permission-requests.jsonl');
      if (existsSync(logPath)) {
        for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let req: { requestId?: string; workerId?: string; agentId?: string };
          try { req = JSON.parse(trimmed) as typeof req; } catch { continue; }
          if (!req?.requestId) continue;
          const status = decided.get(req.requestId);
          if (status === undefined || status === 'pending') {
            const wid = req.workerId || (req.agentId ? agentToWorker.get(req.agentId) : undefined);
            if (wid) blocked.add(wid);
          }
        }
      }
    } catch { /* log unreadable — persisted requests above still apply */ }
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Hive-scoped lock (Condition 3)
//
// Uses the same mkdirSync-based locking mechanism as agent-tools.ts
// `withStoreLock`, but scoped to each hive directory to allow concurrent
// operations on different hives without contention.
// ---------------------------------------------------------------------------

/**
 * Execute a function while holding an exclusive lock on a specific hive.
 * Prevents race conditions when multiple `queen_spawn_worker` calls
 * concurrently modify the same hive record (Condition 3).
 *
 * Lock path: `.hive-flow/hives/{hiveId}/.lock`
 */
export async function withHiveLock<T>(hiveId: string, fn: () => T | Promise<T>, projectRoot = process.cwd()): Promise<T> {
  ensureHiveDir(hiveId, projectRoot);
  const lockPath = getLockPath(hiveId, projectRoot);
  const maxWait = 10000; // 10s timeout
  const start = Date.now();
  let acquired = false;

  while (Date.now() - start < maxWait) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      break;
    } catch {
      // Check for stale lock (older than 30s)
      try {
        const lockStat = statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30000) {
          try { rmdirSync(lockPath); } catch { /* race with another cleaner */ }
          continue;
        }
      } catch {
        // Lock dir gone, retry
        continue;
      }
      await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    }
  }

  if (!acquired) {
    throw new Error(`Failed to acquire hive lock for ${hiveId} within 10s`);
  }

  try {
    return await fn();
  } finally {
    try { rmdirSync(lockPath); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Create a new hive record. Does NOT acquire lock — caller should use
 * `withHiveLock` if concurrent creation is possible.
 */
export function createHive(
  queenId: string,
  budget: Partial<HiveBudget> = {},
  config?: ModuleHiveConfig,
  owner?: { ownerSessionId?: string | null; ownerClientKind?: string | null; queenPid?: number },
  projectRoot = process.cwd(),
): HiveRecord {
  const hiveId = `hive-${randomUUID()}`;
  const now = new Date().toISOString();
  const queenPid = owner?.queenPid;

  const record: HiveRecord = {
    hiveId,
    queenId,
    ...(Number.isInteger(queenPid) && (queenPid ?? 0) > 1 ? { queenPid } : {}),
    ...(owner?.ownerSessionId ? { ownerSessionId: owner.ownerSessionId } : {}),
    ...(owner?.ownerClientKind ? { ownerClientKind: owner.ownerClientKind } : {}),
    status: 'pending',
    workers: [],
    budget: {
      maxWorkers: budget.maxWorkers ?? 20,
      maxCost: budget.maxCost,
      workersAllocated: 0,
    },
    config,
    audit: [],
    createdAt: now,
    updatedAt: now,
  };

  ensureHiveDir(hiveId, projectRoot);
  saveHiveUnsafe(record, projectRoot);
  return record;
}

/**
 * Load a hive record from disk. Returns null if not found.
 */
export function loadHive(hiveId: string, projectRoot = process.cwd()): HiveRecord | null {
  try {
    const path = getHivePath(hiveId, projectRoot);
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data) as HiveRecord;
    }
  } catch {
    // Return null on error
  }
  return null;
}

/**
 * Save a hive record to disk. Uses atomic rename for crash safety.
 * Caller MUST hold the hive lock via `withHiveLock` (Condition 3).
 */
export function saveHive(hiveId: string, record: HiveRecord, projectRoot = process.cwd()): void {
  record.updatedAt = new Date().toISOString();
  saveHiveUnsafe(record, projectRoot);
}

/** Internal save without updatedAt bump — used by createHive */
function saveHiveUnsafe(record: HiveRecord, projectRoot = process.cwd()): void {
  ensureHiveDir(record.hiveId, projectRoot);
  const targetPath = getHivePath(record.hiveId, projectRoot);
  const tmpPath = targetPath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmpPath, targetPath);
}

/**
 * List all hive records. Optionally filter by status.
 */
export function listHives(statusFilter?: HiveStatus, projectRoot = process.cwd()): HiveRecord[] {
  const hivesDir = getHivesDir(projectRoot);
  if (!existsSync(hivesDir)) return [];

  const results: HiveRecord[] = [];
  try {
    const entries = readdirSync(hivesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const record = loadHive(entry.name, projectRoot);
        if (record) {
          if (!statusFilter || record.status === statusFilter) {
            results.push(record);
          }
        }
      }
    }
  } catch {
    // Return whatever we have
  }
  return results;
}

/**
 * Append an audit entry to a hive record. Caller MUST hold the hive lock.
 */
export function appendHiveAudit(record: HiveRecord, entry: Omit<HiveAuditEntry, 'timestamp' | 'hiveId'>): void {
  record.audit.push({
    ...entry,
    timestamp: new Date().toISOString(),
    hiveId: record.hiveId,
  });
}

/** Recompute delegationRate from taskedCount + directWorkCount on the hive record. */
export function recomputeDelegationMetrics(record: HiveRecord): DelegationMetrics {
  const tasked = record.delegationMetrics?.taskedCount ?? 0;
  const direct = record.delegationMetrics?.directWorkCount ?? 0;
  const denom = tasked + direct;
  const delegationRate = denom === 0 ? 1 : tasked / denom;
  const m: DelegationMetrics = { taskedCount: tasked, directWorkCount: direct, delegationRate };
  record.delegationMetrics = m;
  return m;
}

// ---------------------------------------------------------------------------
// Staleness check (Condition 5)
// ---------------------------------------------------------------------------

/**
 * Check if a hive is stale (stuck in 'active' beyond configurable timeout).
 * Default timeout: 1 hour (3600000ms). Override via `config.stalenessTimeout`.
 */
export function isHiveStale(record: HiveRecord): boolean {
  if (record.status !== 'active') return false;
  const timeout = record.config?.stalenessTimeout ?? 3600000;
  const updatedAt = new Date(record.updatedAt).getTime();
  return Date.now() - updatedAt > timeout;
}

/**
 * Find all stale hives (active beyond their timeout).
 */
export function findStaleHives(projectRoot = process.cwd()): HiveRecord[] {
  const activeHives = listHives('active', projectRoot);
  return activeHives.filter(isHiveStale);
}

/**
 * W4: Transition stale active hives to 'failed' status with error 'queen-timeout'.
 * This function finds all active hives where updatedAt is older than stalenessTimeout,
 * changes their status to 'failed', sets error to 'queen-timeout', and saves them.
 */
export async function markStaleHivesAsFailed(projectRoot = process.cwd()): Promise<{ failedHives: string[]; errors: string[] }> {
  const staleHives = findStaleHives(projectRoot);
  const failedHives: string[] = [];
  const errors: string[] = [];

  for (const hive of staleHives) {
    try {
      await withHiveLock(hive.hiveId, () => {
        // Re-load under lock to ensure freshness
        const freshHive = loadHive(hive.hiveId, projectRoot);
        if (!freshHive || freshHive.status !== 'active') return;
        
        // Check if still stale under lock
        if (!isHiveStale(freshHive)) return;
        
        // Transition to failed
        freshHive.status = 'failed';
        freshHive.error = 'queen-timeout';
        freshHive.updatedAt = new Date().toISOString();
        
        // Add audit entry
        appendHiveAudit(freshHive, {
          event: 'error',
          detail: 'Hive marked as failed due to queen timeout (staleness)',
          agentId: freshHive.queenId,
        });
        
        // Save the updated hive
        saveHive(freshHive.hiveId, freshHive, projectRoot);
        failedHives.push(freshHive.hiveId);
      }, projectRoot);
    } catch (error) {
      errors.push(`Failed to transition hive ${hive.hiveId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { failedHives, errors };
}
