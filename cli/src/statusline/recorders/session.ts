// v3/@hive-flow/cli/src/statusline/recorders/session.ts
//
// Wave 4 of the statusline rewrite. Session recorder for host CLI lifecycle
// (session-start / session-heartbeat / session-end). Appends V1 events to the
// canonical `sessions/events.jsonl` ledger, deduplicates retries by `eventId`
// via `appendUniqueJsonlLocked`, and (when the lock is acquired) materializes
// the `sessions/current.json` summary used by the renderer.
//
// Binding constraints (canonical runbook 2026-05-20 §4.1, Phase 3 wave 4,
// Phase 4 design verification, prompt-level guardrails):
//   - Use Wave 2 storage primitives only (`appendUniqueJsonlLocked`,
//     `writeJsonFile`, `readJsonl`, `readJsonFile`, `touchRefreshRequest`).
//     Do NOT duplicate file I/O here.
//   - Heartbeats from the same `sessionId` MUST be idempotent on retry: a
//     redelivered event with the same `eventId` is silently rejected by the
//     unique-append primitive.
//   - Freshness thresholds: <=15s active, <=120s degraded, otherwise stale.
//     `session-end` events terminate the session — older heartbeats arriving
//     out-of-order MUST NOT resurrect an ended session.
//   - Bounded reads (delegated to `readJsonl`'s file/line caps).
//   - No `as any`, no unsafe casts, no sync I/O on hot paths, no shell strings.
//   - Symlinked ledger paths are rejected by the storage primitives — this
//     module never silences a `StatuslineStoragePathError`.

import {
  appendUniqueJsonlLocked,
  readJsonl,
  readJsonFile,
  touchRefreshRequest,
  writeJsonFile,
} from '../storage.js';
import { statuslinePaths } from '../paths.js';
import type {
  HostCli,
  SessionEventV1,
  SessionHostRow,
  SessionState,
  SessionSummary,
  SessionsCurrentRow,
} from '../types.js';

// ---------------------------------------------------------------------------
// Freshness thresholds (canonical runbook line 1174)
// ---------------------------------------------------------------------------

/** Sessions seen within this window count as active. */
export const SESSION_ACTIVE_MS = 15_000;

/** Sessions older than active but within this window count as degraded. */
export const SESSION_DEGRADED_MS = 120_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of a `recordSessionEvent` call.
 *
 * - `spooled: true` means the ledger lock was contended; the event was queued
 *   to the spool directory and the drainer will apply it later.
 * - `duplicate: true` means an event with the same `eventId` already exists
 *   in the canonical ledger (idempotent retry; nothing was appended).
 * - When neither flag is set, the event was appended and the current-session
 *   summary was re-materialized atomically.
 */
export interface RecordSessionEventResult {
  ok: true;
  spooled: boolean;
  duplicate: boolean;
}

/**
 * Append a {@link SessionEventV1} to the sessions ledger and (when the lock
 * is acquired and the event is not a duplicate) re-materialize
 * `sessions/current.json`. Idempotent on retry: a re-delivered event with the
 * same `eventId` is rejected by `appendUniqueJsonlLocked` rather than
 * appended a second time.
 *
 * On lock contention the event is spooled and the refresh marker is touched
 * so the next renderer pass picks up the drained ledger.
 */
export async function recordSessionEvent(
  event: SessionEventV1,
): Promise<RecordSessionEventResult> {
  const paths = statuslinePaths(event.repoRoot);
  const append = await appendUniqueJsonlLocked<SessionEventV1>({
    ledgerPath: paths.sessionsLedger,
    spoolRoot: paths.spoolRoot,
    ledgerName: 'sessions',
    event,
    uniqueField: 'eventId',
  });

  if (append.spooled) {
    // Lock contended — drainer will apply. Wake the renderer so it picks up
    // the spool drainage on the next refresh.
    await touchRefreshRequest(event.repoRoot);
    return { ok: true, spooled: true, duplicate: false };
  }

  if (append.duplicate) {
    // Idempotent retry: nothing changed. Skip the re-materialization (the
    // existing summary already reflects this event) but do not touch the
    // refresh marker either.
    return { ok: true, spooled: false, duplicate: true };
  }

  // Acquired lock + appended. Re-materialize the summary and wake the
  // renderer. We compute the summary AFTER the append so the new event is
  // reflected.
  const summary = await computeSessionSummary(event.repoRoot);
  await writeJsonFile(paths.sessionsCurrent, summary);
  await touchRefreshRequest(event.repoRoot);
  return { ok: true, spooled: false, duplicate: false };
}

/**
 * Resolve the freshness rank used to break ties between events with the same
 * timestamp. `session-end` outranks `session-heartbeat` outranks
 * `session-start`. This ensures a terminal event at the same ts as a
 * heartbeat wins, so an ended session cannot be resurrected by a coincident
 * heartbeat.
 */
function sessionEventRank(event: SessionEventV1): number {
  if (event.event === 'session-end') return 2;
  if (event.event === 'session-heartbeat') return 1;
  return 0;
}

/**
 * Pure summarizer: compute the per-session/per-host snapshot from the
 * sessions ledger. Used by `recordSessionEvent` on the write path and by the
 * spool drainer / refresher on read paths.
 *
 * Algorithm (runbook §4.1):
 *   1. Group ledger rows by `${hostCli}:${sessionId}` and keep the latest by
 *      `(ts, rank)`. The rank tie-breaker prevents session-end resurrection.
 *   2. Drop ended sessions from the live counts.
 *   3. Classify each remaining session by age relative to `nowMs` using the
 *      15s / 120s thresholds.
 *   4. Aggregate per-host counts and `lastSeenAt` (max of kept ts only).
 */
export async function computeSessionSummary(
  projectRoot: string,
  nowMs: number = Date.now(),
): Promise<SessionSummary> {
  const paths = statuslinePaths(projectRoot);
  const { events } = await readJsonl<SessionEventV1>(paths.sessionsLedger);
  const bySession = new Map<string, SessionEventV1>();
  for (const event of events) {
    if (!isWellFormedSessionEvent(event)) continue;
    const key = `${event.hostCli}:${event.sessionId}`;
    const prior = bySession.get(key);
    if (
      !prior ||
      event.ts > prior.ts ||
      (event.ts === prior.ts && sessionEventRank(event) >= sessionEventRank(prior))
    ) {
      bySession.set(key, event);
    }
  }

  const byHost: SessionSummary['byHost'] = {};
  const current: SessionsCurrentRow[] = [];
  let active = 0;
  let degraded = 0;
  let stale = 0;

  for (const event of bySession.values()) {
    if (event.event === 'session-end') continue;
    const ts = Date.parse(event.ts);
    // Defence-in-depth: a corrupted ts that parses to NaN would otherwise
    // produce a NaN age and miscount the session. Treat as stale.
    const ageMs = Number.isFinite(ts) ? nowMs - ts : Number.POSITIVE_INFINITY;
    const state: SessionState =
      ageMs <= SESSION_ACTIVE_MS
        ? 'active'
        : ageMs <= SESSION_DEGRADED_MS
          ? 'degraded'
          : 'stale';

    if (state === 'active') active++;
    else if (state === 'degraded') degraded++;
    else stale++;

    const existingHost: SessionHostRow | undefined = byHost[event.hostCli];
    const host: SessionHostRow =
      existingHost ?? { active: 0, degraded: 0, stale: 0, lastSeenAt: event.ts };
    if (state === 'active') host.active++;
    else if (state === 'degraded') host.degraded++;
    else host.stale++;
    if (event.ts > host.lastSeenAt) host.lastSeenAt = event.ts;
    byHost[event.hostCli] = host;

    current.push({
      hostCli: event.hostCli,
      sessionId: event.sessionId,
      state,
      lastSeenAt: event.ts,
      producerKind: event.producerKind,
      confidence: event.confidence,
    });
  }

  return { active, degraded, stale, byHost, current };
}

/**
 * Read the materialized `sessions/current.json` snapshot, or `undefined` when
 * the file is absent / oversize / symlinked / corrupt. Bounded by the storage
 * primitive's defaults.
 */
export async function readSessionSummary(
  projectRoot: string,
): Promise<SessionSummary | undefined> {
  return readJsonFile<SessionSummary>(statuslinePaths(projectRoot).sessionsCurrent);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SESSION_EVENT_KINDS: ReadonlySet<string> = new Set([
  'session-start',
  'session-heartbeat',
  'session-end',
]);

const HOST_CLI_KINDS: ReadonlySet<string> = new Set<HostCli>([
  'claude-code',
  'codex',
  'gemini',
  'forgecode',
  'cursor-cli',
  'qwen',
  'opencode',
  'hive-flow-daemon',
  'wrapper',
]);

/**
 * Reject ledger rows whose required fields are missing or have the wrong
 * shape. The ledger may have been written by an older recorder or hand-edited
 * by `statusline repair`, so the summarizer is defensive about its input.
 *
 * The type predicate narrows to `SessionEventV1` for downstream consumers.
 */
function isWellFormedSessionEvent(value: unknown): value is SessionEventV1 {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) return false;
  if (typeof v.ts !== 'string' || v.ts.length === 0) return false;
  if (typeof v.hostCli !== 'string' || !HOST_CLI_KINDS.has(v.hostCli)) return false;
  if (typeof v.event !== 'string' || !SESSION_EVENT_KINDS.has(v.event)) return false;
  if (typeof v.producerKind !== 'string') return false;
  if (typeof v.confidence !== 'string') return false;
  return true;
}
