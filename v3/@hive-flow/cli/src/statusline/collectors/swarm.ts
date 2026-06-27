// v3/@hive-flow/cli/src/statusline/collectors/swarm.ts
//
// Wave 5 / C1 BLOCKER FIX — canonical swarm collector for the statusline.
//
// This file REPLACES the semantic role of the legacy
// `src/statusline/swarm-collector.ts` (which is left in place until Wave 13's
// legacy cleanup). The legacy collector filtered `AgentRecord.status` against
// phantom literals that no MCP code path ever wrote; the canonical MCP enum
// is `spawning | idle | busy | terminated`. As a result the swarm count was
// perpetually 0/0/false. This collector consumes the reader-side normalizer
// instead, so legacy aliases and the canonical enum both classify correctly.
//
// Binding constraints from the canonical runbook (Phase 11 / collectors /
// Phase 3 + Phase 12 normalizer section):
//   - Reader-side normalization ONLY. Do NOT mutate the MCP enum.
//   - Consume `normalizeAgentStatus` from `../types.js`. Terminal statuses
//     (`terminated`, `failed`, `complete`, `cancelled`) map to `undefined`
//     and are dropped from live counts.
//   - No reference to recent-task timestamps that are not present on the
//     canonical `AgentRecord` shape (Phase 2 constraint C2).
//   - No unchecked casts (no escape hatches into untyped territory), no
//     synchronous hot I/O.
//   - Tolerate both the canonical dict shape (`{ agents: { id: row } }`) and
//     the legacy array shape (Phase 1 finding "Bug 1").
//   - Tolerate a missing or corrupt `store.json` without crashing the
//     renderer (statusline must never throw on collection failure).
//   - `readJsonFile` (storage.js) is already symlink-safe and byte-bounded;
//     we re-use it here so we inherit the Phase 5 guard.
//
// The legacy `swarm-collector.ts` is deliberately untouched — Wave 13 owns
// the deletion. Importers of the new collector use this module's exports.

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_MAX_AGENTS } from '../../shared/core/config/defaults.js';

import {
  collectActiveHiveRuntimeState,
  type ActiveHiveRuntimeAgent,
  type ActiveHiveRuntimeState,
} from '../hive-ownership.js';
import { sanitizeSessionId } from '../../mcp-tools/session-id.js';
import { readJsonFile } from '../storage.js';
import {
  type ActiveHiveOwnershipSummary,
  normalizeAgentStatus,
  type NormalizedAgentRow,
  type NormalizedAgentStatus,
} from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Freshness classifications for the swarm collector's view of `store.json`.
 *
 * - `fresh`     — mtime within {@link FRESH_MS}
 * - `degraded`  — mtime within {@link DEGRADED_MS} but not fresh
 * - `stale`     — mtime older than {@link DEGRADED_MS}
 * - `absent`    — `store.json` does not exist (no swarm activity yet)
 * - `error`     — `store.json` exists but could not be read or parsed
 */
export type SwarmFreshnessState = 'fresh' | 'degraded' | 'stale' | 'absent' | 'error';

export interface SwarmFreshness {
  readonly state: SwarmFreshnessState;
  readonly observedAt: string;
  readonly ageMs?: number;
  readonly reason?: string;
}

/**
 * Canonical reader-side swarm summary produced by {@link collectSwarm}.
 *
 * Fields mirror the brief from the Phase 11 collector spec. The legacy
 * `SwarmSummary` interface in `../types.ts` describes a different (snapshot-
 * level) shape and is intentionally distinct from this collector's return
 * value; downstream waves adapt one into the other.
 */
export interface SwarmCollectorSummary {
  /** Live (non-terminal) worker agents. */
  workersAlive: number;
  /** Live worker agents currently in the `'busy'` normalized status. */
  workersExecuting: number;
  /** Live (non-terminal) queen agents. */
  queensAlive: number;
  /** Live queen agents currently in the `'busy'` normalized status. */
  queensExecuting: number;
  /** Configured swarm cap (defaults to {@link DEFAULT_CAP}). */
  cap: number;
  /** Live advocate state read from `.hive-flow/data/advocate-state.json`. */
  advocateState: string;
  /** Per-row normalized agent rows surviving the terminal-status filter. */
  agents: ReadonlyArray<NormalizedAgentRow>;
  /** Active hives partitioned by owner session id. */
  activeHives?: ActiveHiveOwnershipSummary;
  /** Source freshness derived from `store.json` mtime (or absence). */
  freshness: SwarmFreshness;
}

export interface CollectSwarmOptions {
  /** Absolute path to the project root. The collector reads
   *  `<projectRoot>/.hive-flow/agents/store.json` and the advocate-state file. */
  readonly projectRoot: string;
  /** Session whose owned agents should be counted. Unowned/other-session agents are excluded. */
  readonly sessionId?: string;
  /** Optional override for the swarm cap (testing / config injection). */
  readonly cap?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default swarm cap when no config-supplied value is provided. */
export const DEFAULT_CAP = DEFAULT_MAX_AGENTS;

/** mtime threshold below which `store.json` is considered `fresh`. */
export const FRESH_MS = 60_000;

/** mtime threshold below which `store.json` is considered `degraded`. */
export const DEGRADED_MS = 5 * 60_000;

const STORE_RELATIVE = ['.hive-flow', 'agents', 'store.json'] as const;
const ADVOCATE_STATE_RELATIVE = ['.hive-flow', 'data', 'advocate-state.json'] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawAgentRecord {
  agentId?: unknown;
  agentType?: unknown;
  type?: unknown;
  role?: unknown;
  status?: unknown;
  provider?: unknown;
  model?: unknown;
  resolvedModel?: unknown;
  ownerSessionId?: unknown;
  currentTaskPid?: unknown;
  config?: unknown;
  lastResult?: unknown;
}

interface RawStoreShape {
  agents?: unknown;
  entries?: unknown;
}

interface AdvocateStateShape {
  state?: unknown;
}

/**
 * Defensively normalize the `store.agents` field into an array of raw
 * records. Tolerates the canonical dict shape (`Record<string, AgentRecord>`),
 * the legacy array shape (Phase 1 finding "Bug 1"), and the `entries` legacy
 * key. Drops null/non-object members so a corrupt slot can never propagate.
 */
function extractRecords(raw: unknown): RawAgentRecord[] {
  if (raw === null || raw === undefined) return [];
  const out: RawAgentRecord[] = [];
  const pushIf = (value: unknown): void => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(value as RawAgentRecord);
    }
  };
  if (typeof raw !== 'object') return out;
  const store = raw as RawStoreShape;
  if (store.agents !== undefined && store.agents !== null) {
    if (Array.isArray(store.agents)) {
      for (const item of store.agents) pushIf(item);
      return out;
    }
    if (typeof store.agents === 'object') {
      for (const item of Object.values(store.agents as Record<string, unknown>)) pushIf(item);
      return out;
    }
  }
  if (store.entries !== undefined) {
    if (Array.isArray(store.entries)) {
      for (const item of store.entries) pushIf(item);
      return out;
    }
    if (typeof store.entries === 'object' && store.entries !== null) {
      for (const item of Object.values(store.entries as Record<string, unknown>)) pushIf(item);
      return out;
    }
  }
  // Last-resort: a bare array of records, or a record-of-records dict whose
  // top level is the agents collection itself (some pre-Wave shapes).
  if (Array.isArray(raw)) {
    for (const item of raw) pushIf(item);
    return out;
  }
  for (const item of Object.values(raw as Record<string, unknown>)) pushIf(item);
  return out;
}

/**
 * Decide whether a raw record represents a queen. Queens are identified by
 * `agentType === 'queen'` (the canonical field on `AgentRecord`); legacy
 * fields `type` and `role` are honored defensively so renderer paths reading
 * an older store layout still classify correctly.
 */
function isQueenRecord(rec: RawAgentRecord): boolean {
  // Type fields take precedence over the agentId prefix (F3 fix).
  //  - any of agentType/type/role === 'queen'  -> queen.
  //  - any of them === 'worker'                 -> NOT a queen, even when the
  //    agentId is `queen-*` (the reported F3 case: a worker deliberately named
  //    `queen-*`). An explicit worker role overrides the prefix.
  //  - otherwise (coordinator-typed queens, or no type field) the `queen-`
  //    agentId prefix is honored as the queen signal.
  const typeFields: ReadonlyArray<unknown> = [rec.agentType, rec.type, rec.role];
  for (const field of typeFields) {
    if (typeof field === 'string' && field.toLowerCase() === 'queen') return true;
  }
  for (const field of typeFields) {
    if (typeof field === 'string' && field.toLowerCase() === 'worker') return false;
  }
  return typeof rec.agentId === 'string' && rec.agentId.startsWith('queen-');
}

function rawAgentHiveId(rec: RawAgentRecord): string {
  if (!rec.config || typeof rec.config !== 'object' || Array.isArray(rec.config)) return '';
  const hiveId = (rec.config as { hiveId?: unknown }).hiveId;
  return typeof hiveId === 'string' && hiveId.trim() ? hiveId.trim() : '';
}

function shouldKeepRuntimeAgent(
  rec: RawAgentRecord,
  agentId: string,
  runtimeState: ActiveHiveRuntimeState | undefined,
): boolean {
  const hiveId = rawAgentHiveId(rec);
  if (runtimeState === undefined || runtimeState.inspected <= 0) return true;
  if (hiveId === '') {
    return !runtimeState.hiveAgentIds.has(agentId) || runtimeState.activeAgentIds.has(agentId);
  }
  return runtimeState.activeHiveIds.has(hiveId) && runtimeState.activeAgentIds.has(agentId);
}

function hasCompletedLastResult(rec: RawAgentRecord): boolean {
  if (!rec.lastResult || typeof rec.lastResult !== 'object' || Array.isArray(rec.lastResult)) {
    return false;
  }
  const result = rec.lastResult as { completedAt?: unknown; status?: unknown };
  if (typeof result.completedAt === 'string' && result.completedAt.trim()) return true;
  if (typeof result.status !== 'string') return false;
  return ['cancelled', 'canceled', 'complete', 'completed', 'done', 'failed', 'terminated'].includes(
    result.status.trim().toLowerCase(),
  );
}

/**
 * A record whose `lastResult` is terminal is "completed" and must not count
 * as a live agent — UNLESS it is genuinely busy on a live task pid (a worker
 * that finished one task and immediately picked up another). F2 fix: this
 * applies to hive agents too; the prior early-return for `rawAgentHiveId!==''`
 * let a completed idle hive worker with a lingering live pid be counted.
 */
function isCompletedAgent(rec: RawAgentRecord, row: NormalizedAgentRow): boolean {
  if (!hasCompletedLastResult(rec)) return false;
  return !(row.status === 'busy' && isPositiveInteger(rec.currentTaskPid));
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

function hasLiveProcessEvidence(rec: RawAgentRecord): boolean {
  return isPositiveInteger(rec.currentTaskPid) && !isPidDefinitelyDead(rec.currentTaskPid);
}

function ownerSessionIdOf(rec: RawAgentRecord): string | null {
  return sanitizeSessionId(rec.ownerSessionId);
}

/**
 * Build a {@link NormalizedAgentRow} for a single raw record, returning
 * `undefined` when the record's normalized status is terminal.
 */
function buildRow(
  rec: RawAgentRecord,
  fallbackId: string,
): { row: NormalizedAgentRow; isQueen: boolean } | undefined {
  const rawStatus = typeof rec.status === 'string' ? rec.status : undefined;
  const status: NormalizedAgentStatus | undefined = normalizeAgentStatus(rawStatus);
  if (status === undefined) return undefined;
  const id = typeof rec.agentId === 'string' && rec.agentId.length > 0 ? rec.agentId : fallbackId;
  const isQueen = isQueenRecord(rec);
  const roleSource = isQueen
    ? 'queen'
    : (typeof rec.agentType === 'string' && rec.agentType) ||
      (typeof rec.type === 'string' && rec.type) ||
      (typeof rec.role === 'string' && rec.role) ||
      'worker';
  const row: NormalizedAgentRow = {
    id,
    role: roleSource,
    status,
  };
  if (typeof rec.provider === 'string' && rec.provider.length > 0) {
    (row as { provider?: string }).provider = rec.provider;
  }
  if (typeof rec.resolvedModel === 'string' && rec.resolvedModel.length > 0) {
    (row as { model?: string }).model = rec.resolvedModel;
  } else if (typeof rec.model === 'string' && rec.model.length > 0) {
    (row as { model?: string }).model = rec.model;
  }
  return { row, isQueen };
}

/**
 * Classify `store.json` freshness based on the file's mtime relative to
 * `now`. Returns `undefined` when the file cannot be stat'd; callers map
 * that to the `'absent'` state.
 */
async function classifyFreshness(
  storePath: string,
  now: number,
): Promise<{ state: 'fresh' | 'degraded' | 'stale'; ageMs: number } | undefined> {
  try {
    const st = await lstat(storePath);
    if (!st.isFile()) return undefined;
    const ageMs = Math.max(0, now - st.mtimeMs);
    if (ageMs < FRESH_MS) return { state: 'fresh', ageMs };
    if (ageMs < DEGRADED_MS) return { state: 'degraded', ageMs };
    return { state: 'stale', ageMs };
  } catch {
    return undefined;
  }
}

function emptySummary(
  cap: number,
  freshness: SwarmFreshness,
  advocateState: string,
  activeHives?: ActiveHiveOwnershipSummary,
  agents: ReadonlyArray<NormalizedAgentRow> = [],
): SwarmCollectorSummary {
  const workersAlive = agents.filter((agent) => agent.role !== 'queen').length;
  const workersExecuting = agents.filter(
    (agent) => agent.role !== 'queen' && agent.status === 'busy',
  ).length;
  const queensAlive = agents.filter((agent) => agent.role === 'queen').length;
  const queensExecuting = agents.filter(
    (agent) => agent.role === 'queen' && agent.status === 'busy',
  ).length;
  return {
    workersAlive,
    workersExecuting,
    queensAlive,
    queensExecuting,
    cap,
    advocateState,
    agents,
    ...(activeHives !== undefined ? { activeHives } : {}),
    freshness,
  };
}

function buildRuntimeHiveRows(
  runtimeAgents: ReadonlyArray<ActiveHiveRuntimeAgent> | undefined,
  countedAgentIds: ReadonlySet<string>,
  suppressedAgentIds: ReadonlySet<string>,
  sessionId?: string,
): NormalizedAgentRow[] {
  if (runtimeAgents === undefined || runtimeAgents.length === 0) return [];
  const rows: NormalizedAgentRow[] = [];
  const seen = new Set(countedAgentIds);
  for (const runtimeAgent of runtimeAgents) {
    if (sessionId !== undefined && runtimeAgent.ownerSessionId !== sessionId) continue;
    if (seen.has(runtimeAgent.agentId)) continue;
    if (suppressedAgentIds.has(runtimeAgent.agentId)) continue;
    seen.add(runtimeAgent.agentId);
    const row: NormalizedAgentRow = {
      id: runtimeAgent.agentId,
      role: runtimeAgent.role,
      status: runtimeAgent.status,
    };
    if (runtimeAgent.provider !== undefined) {
      (row as { provider?: string }).provider = runtimeAgent.provider;
    }
    if (runtimeAgent.model !== undefined) {
      (row as { model?: string }).model = runtimeAgent.model;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Defensively extract a string state from the advocate-state JSON. Falls
 * back to `'unknown'` when the file is missing, malformed, or the `state`
 * field is not a string.
 */
async function readAdvocateState(projectRoot: string): Promise<string> {
  const advocatePath = join(projectRoot, ...ADVOCATE_STATE_RELATIVE);
  const data = await readJsonFile<AdvocateStateShape>(advocatePath).catch(
    () => undefined,
  );
  if (data && typeof data === 'object' && typeof data.state === 'string' && data.state.length > 0) {
    return data.state;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Public collector
// ---------------------------------------------------------------------------

/**
 * Read `.hive-flow/agents/store.json`, normalize statuses via
 * {@link normalizeAgentStatus}, drop terminal records, and aggregate the
 * worker / queen live + executing counts plus a freshness tag derived from
 * the file's mtime.
 *
 * Never throws. Missing files, parse errors, and unexpected shapes all
 * collapse into an empty summary with the appropriate {@link SwarmFreshness}.
 */
export async function collectSwarm(opts: CollectSwarmOptions): Promise<SwarmCollectorSummary> {
  const projectRoot = opts.projectRoot;
  const cap = typeof opts.cap === 'number' && Number.isFinite(opts.cap) && opts.cap > 0
    ? Math.floor(opts.cap)
    : DEFAULT_CAP;
  const storePath = join(projectRoot, ...STORE_RELATIVE);
  const now = Date.now();
  const observedAt = new Date(now).toISOString();

  // Stat first so we can classify even when `readJsonFile` succeeds. Reading
  // the advocate state in parallel keeps the collector cheap (two small JSON
  // files, both bounded by storage.ts caps).
  const [freshnessClass, advocateState, rawStore, runtimeState] = await Promise.all([
    classifyFreshness(storePath, now),
    readAdvocateState(projectRoot),
    readJsonFile<unknown>(storePath).catch(() => undefined),
    collectActiveHiveRuntimeState(projectRoot).catch(() => undefined),
  ]);
  const activeHives = runtimeState?.activeHives;
  const hiveRows = buildRuntimeHiveRows(
    runtimeState?.activeAgents,
    new Set(),
    new Set(),
    opts.sessionId,
  );

  if (freshnessClass === undefined && rawStore === undefined) {
    return emptySummary(
      cap,
      { state: 'absent', observedAt, reason: 'store.json missing' },
      advocateState,
      activeHives,
      hiveRows,
    );
  }

  if (rawStore === undefined) {
    // File exists (we got a freshness class) but parse failed or it was
    // symlinked / oversize / non-regular. Surface as an `'error'` freshness
    // and return an empty summary so the renderer can still draw a row.
    return emptySummary(
      cap,
      {
        state: 'error',
        observedAt,
        ageMs: freshnessClass?.ageMs,
        reason: 'store.json unreadable or corrupt',
      },
      advocateState,
      activeHives,
      hiveRows,
    );
  }

  const records = extractRecords(rawStore);
  let workersAlive = 0;
  let workersExecuting = 0;
  let queensAlive = 0;
  let queensExecuting = 0;
  const agents: NormalizedAgentRow[] = [];
  const countedAgentIds = new Set<string>();
  const suppressedRuntimeAgentIds = new Set<string>();
  let index = 0;
  for (const rec of records) {
    if (hasCompletedLastResult(rec) && typeof rec.agentId === 'string' && rec.agentId.trim()) {
      suppressedRuntimeAgentIds.add(rec.agentId.trim());
    }
    const ownerSessionId = ownerSessionIdOf(rec);
    if (ownerSessionId === null) continue;
    if (opts.sessionId !== undefined && ownerSessionId !== opts.sessionId) continue;
    const built = buildRow(rec, `agent-${index}`);
    index++;
    if (built === undefined) continue;
    if (!shouldKeepRuntimeAgent(rec, built.row.id, runtimeState)) continue;
    if (isCompletedAgent(rec, built.row)) continue;
    if (!hasLiveProcessEvidence(rec)) continue;
    const isExecuting =
      built.row.status === 'busy' && isPositiveInteger(rec.currentTaskPid);
    const row = built.row;
    agents.push(row);
    countedAgentIds.add(row.id);
    if (built.isQueen) {
      queensAlive++;
      if (isExecuting) queensExecuting++;
    } else {
      workersAlive++;
      if (isExecuting) workersExecuting++;
    }
  }
  const runtimeRows = buildRuntimeHiveRows(
    runtimeState?.activeAgents,
    countedAgentIds,
    suppressedRuntimeAgentIds,
    opts.sessionId,
  );
  for (const row of runtimeRows) {
    agents.push(row);
    if (row.role === 'queen') {
      queensAlive++;
      if (row.status === 'busy') queensExecuting++;
    } else {
      workersAlive++;
      if (row.status === 'busy') workersExecuting++;
    }
  }

  const freshness: SwarmFreshness = freshnessClass !== undefined
    ? { state: freshnessClass.state, observedAt, ageMs: freshnessClass.ageMs }
    : { state: 'absent', observedAt, reason: 'store.json missing after read' };

  return {
    workersAlive,
    workersExecuting,
    queensAlive,
    queensExecuting,
    cap,
    advocateState,
    agents,
    ...(activeHives !== undefined ? { activeHives } : {}),
    freshness,
  };
}
