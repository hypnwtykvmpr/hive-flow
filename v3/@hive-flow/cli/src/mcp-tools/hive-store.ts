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
import { sanitizePathId } from '@hive-flow/shared';

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
  role: string;
  provider: string;
  status: 'spawning' | 'idle' | 'busy' | 'error' | 'terminated';
  spawnedAt: string;
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
  event: 'mission-assigned' | 'worker-spawned' | 'worker-tasked' | 'results-collected' | 'report-submitted' | 'hive-terminated' | 'error';
  hiveId: string;
  detail: string;
  agentId?: string;
  workerId?: string;
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
  /** HMAC signature over the hive record for tamper detection */
  signature?: string;
  /** Queen delegation counters (directWorkCount synced from role.json on queen_report) */
  delegationMetrics?: DelegationMetrics;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getHivesDir(): string {
  return join(process.cwd(), STORAGE_DIR, HIVES_DIR);
}

function getHiveDir(hiveId: string): string {
  // A10: Use shared sanitizePathId utility to prevent path traversal
  const sanitized = sanitizePathId(hiveId, 128);
  if (!sanitized) throw new Error('Invalid hiveId');
  return join(getHivesDir(), sanitized);
}

function getHivePath(hiveId: string): string {
  return join(getHiveDir(hiveId), HIVE_FILE);
}

function getLockPath(hiveId: string): string {
  return join(getHiveDir(hiveId), LOCK_FILE);
}

function ensureHiveDir(hiveId: string): void {
  const dir = getHiveDir(hiveId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
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
export async function withHiveLock<T>(hiveId: string, fn: () => T | Promise<T>): Promise<T> {
  ensureHiveDir(hiveId);
  const lockPath = getLockPath(hiveId);
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
export function createHive(queenId: string, budget: Partial<HiveBudget> = {}, config?: ModuleHiveConfig): HiveRecord {
  const hiveId = `hive-${randomUUID()}`;
  const now = new Date().toISOString();

  const record: HiveRecord = {
    hiveId,
    queenId,
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

  ensureHiveDir(hiveId);
  saveHiveUnsafe(record);
  return record;
}

/**
 * Load a hive record from disk. Returns null if not found.
 */
export function loadHive(hiveId: string): HiveRecord | null {
  try {
    const path = getHivePath(hiveId);
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
export function saveHive(hiveId: string, record: HiveRecord): void {
  record.updatedAt = new Date().toISOString();
  saveHiveUnsafe(record);
}

/** Internal save without updatedAt bump — used by createHive */
function saveHiveUnsafe(record: HiveRecord): void {
  ensureHiveDir(record.hiveId);
  const targetPath = getHivePath(record.hiveId);
  const tmpPath = targetPath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmpPath, targetPath);
}

/**
 * List all hive records. Optionally filter by status.
 */
export function listHives(statusFilter?: HiveStatus): HiveRecord[] {
  const hivesDir = getHivesDir();
  if (!existsSync(hivesDir)) return [];

  const results: HiveRecord[] = [];
  try {
    const entries = readdirSync(hivesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const record = loadHive(entry.name);
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
export function findStaleHives(): HiveRecord[] {
  const activeHives = listHives('active');
  return activeHives.filter(isHiveStale);
}
