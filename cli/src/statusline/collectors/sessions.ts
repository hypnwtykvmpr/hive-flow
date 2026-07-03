// cli/src/statusline/collectors/sessions.ts
//
// Sessions collector. Consumes the canonical session JSONL ledger written by
// the Wave 4 session recorder and folds it into a per-host
// {@link SessionSummary} the refresher (and downstream renderer) can consume
// directly. This collector is independent of the recorder: it never imports
// the recorder module so the read path stays decoupled from the writer.
//
// Contract (Wave 5 collectors, anchored to the merged 2026-05-20 runbook):
//   - Pure, async, side-effect free aside from the bounded JSONL read via
//     `readJsonl` (already symlink-safe and size/line-bounded post-Wave-2.5A).
//   - Folds events keyed by `${hostCli}:${sessionId}`. The latest event wins
//     on `ts`; ties prefer terminal events (session-end > heartbeat > start)
//     so an out-of-order replay of a terminal event never resurrects a
//     `session-end` that arrived first in append order.
//   - Classifies each surviving (non-ended) session by age relative to
//     `now()`: <=15s active, <=2m degraded, otherwise stale. Thresholds match
//     the recorder/runbook semantics so the renderer's downstream freshness
//     ladder agrees with the recorder-materialized summary.
//   - Tolerates corrupt JSONL rows: `readJsonl` already returns them via a
//     `corrupt` counter; the collector surfaces that count through the
//     freshness `reason` field and downgrades freshness to `degraded` so the
//     renderer can flag the issue without crashing.
//   - Returns a freshness tag covering `unavailable` (ledger absent), `fresh`,
//     `degraded`, and `stale`. Corrupt lines or out-of-window sessions
//     downgrade fresh -> degraded -> stale via the ladder.
//   - NO writes. No spool. No refresh-marker touches. The refresher (Wave 7)
//     is responsible for materializing the result.
//
// The shape returned is the canonical `SessionSummary` plus an attached
// `freshness` tag. The intersection is declared locally so callers consuming
// the bare `SessionSummary` are not forced to take the freshness as a
// dependency; downstream waves that need it can narrow the result type.

import { lstat } from 'node:fs/promises';

import { statuslinePaths } from '../paths.js';
import { readJsonl } from '../storage.js';
import type {
  HostCli,
  SessionEventKind,
  SessionEventV1,
  SessionHostRow,
  SessionState,
  SessionSummary,
  SessionsCurrentRow,
  SourceFreshness,
} from '../types.js';

// ---------------------------------------------------------------------------
// Thresholds (mirrors the runbook 4.1 spec)
// ---------------------------------------------------------------------------

/** Sessions whose newest event is <=15s old are `active`. */
export const SESSION_ACTIVE_THRESHOLD_MS = 15_000;
/** Sessions whose newest event is <=2m old are `degraded`. */
export const SESSION_DEGRADED_THRESHOLD_MS = 120_000;

// ---------------------------------------------------------------------------
// Options + result shape
// ---------------------------------------------------------------------------

export interface CollectSessionsOptions {
  readonly projectRoot: string;
  /**
   * Override the "now" reference timestamp in milliseconds. Tests and
   * deterministic callers pass an explicit value; the default uses
   * `Date.now()` so callers do not need to thread a clock.
   */
  readonly nowMs?: number;
}

export interface SessionsCollectorResult extends SessionSummary {
  readonly freshness: SourceFreshness;
}

// ---------------------------------------------------------------------------
// Type guards (defensive; the ledger is recorder-controlled but may have
// hand-edited or legacy rows we should skip rather than crash on).
// ---------------------------------------------------------------------------

const HOST_CLI_VALUES: ReadonlySet<string> = new Set<HostCli>([
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

const EVENT_KINDS: ReadonlySet<SessionEventKind> = new Set<SessionEventKind>([
  'session-start',
  'session-heartbeat',
  'session-end',
]);

/**
 * Narrow an arbitrary value to a {@link SessionEventV1}. Only the fields the
 * collector actually consumes are checked strictly; optional/wire-only fields
 * (`pid`, `ppid`, `exitCode`, etc.) are not required because the collector
 * does not depend on them.
 */
function isSessionEventV1(value: unknown): value is SessionEventV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.ts !== 'string' || v.ts === '') return false;
  if (typeof v.sessionId !== 'string' || v.sessionId === '') return false;
  if (typeof v.hostCli !== 'string') return false;
  if (!HOST_CLI_VALUES.has(v.hostCli)) return false;
  if (typeof v.event !== 'string') return false;
  if (!EVENT_KINDS.has(v.event as SessionEventV1['event'])) return false;
  if (typeof v.producerKind !== 'string') return false;
  if (typeof v.confidence !== 'string') return false;
  if (v.confidence !== 'direct' && v.confidence !== 'derived') return false;
  return true;
}

/**
 * Rank session events so terminal states win when timestamps collide.
 * `session-end` (2) > `session-heartbeat` (1) > `session-start` (0).
 */
function sessionEventRank(event: SessionEventV1): number {
  if (event.event === 'session-end') return 2;
  if (event.event === 'session-heartbeat') return 1;
  return 0;
}

/**
 * Returns true when `candidate` should replace `prior` for a given
 * (hostCli, sessionId) pair. Newer `ts` wins; on a tie, terminal events win
 * so a replayed `session-end` never gets shadowed by an older heartbeat that
 * happens to arrive later in append order.
 */
function shouldReplace(candidate: SessionEventV1, prior: SessionEventV1): boolean {
  if (candidate.ts > prior.ts) return true;
  if (candidate.ts < prior.ts) return false;
  return sessionEventRank(candidate) >= sessionEventRank(prior);
}

// ---------------------------------------------------------------------------
// Freshness ladder
// ---------------------------------------------------------------------------

/**
 * Worst-state escalator. Higher rank means worse freshness. Used to combine
 * the corrupt-line signal with the session-state signal so neither shadows
 * the other.
 */
const FRESHNESS_RANK: Readonly<Record<SourceFreshness['state'], number>> = Object.freeze({
  fresh: 0,
  degraded: 1,
  stale: 2,
  error: 3,
  unavailable: 4,
});

function worse(a: SourceFreshness['state'], b: SourceFreshness['state']): SourceFreshness['state'] {
  return FRESHNESS_RANK[a] >= FRESHNESS_RANK[b] ? a : b;
}

/**
 * Best-effort filesystem probe. Used solely to distinguish "ledger absent"
 * (no recorder has ever written) from "ledger empty / all sessions ended"
 * (writer ran but emitted nothing live). The probe never throws to the
 * caller — any unexpected error is treated as "absent" so the collector
 * surfaces an unavailable freshness rather than masking the issue.
 *
 * Note: this is a non-fatal hint only. The bounded read in `readJsonl`
 * already classifies the file safely; we just need a coarse signal for the
 * freshness tag here.
 */
async function ledgerExists(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public collector
// ---------------------------------------------------------------------------

/**
 * Build the canonical "no live sessions, no rows" summary skeleton. A fresh
 * object is returned every call so callers can mutate the `byHost` /
 * `current` fields without leaking back into shared state.
 */
function emptySummary(): SessionSummary {
  return {
    active: 0,
    degraded: 0,
    stale: 0,
    byHost: {},
    current: [],
  };
}

/**
 * Read the session ledger for `projectRoot` and fold it into a per-host
 * {@link SessionSummary}. The result also carries a {@link SourceFreshness}
 * tag describing the read outcome:
 *
 *   - `unavailable` — ledger file does not exist at all.
 *   - `fresh`       — at least one active session and no degraded/stale ones.
 *   - `degraded`    — at least one degraded session, OR corrupt rows were
 *                     skipped, OR the ledger has only ended sessions.
 *   - `stale`       — at least one session exceeds the 2-minute threshold.
 *
 * `now` defaults to `Date.now()`; tests should pass an explicit `nowMs` to
 * keep age classification deterministic.
 */
export async function collectSessions(
  opts: CollectSessionsOptions,
): Promise<SessionsCollectorResult> {
  const nowMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)
    ? opts.nowMs
    : Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const paths = statuslinePaths(opts.projectRoot);

  const present = await ledgerExists(paths.sessionsLedger);
  if (!present) {
    return {
      ...emptySummary(),
      freshness: {
        source: 'sessions',
        state: 'unavailable',
        observedAt,
        reason: 'session ledger not found',
      },
    };
  }

  let rawEvents: ReadonlyArray<unknown>;
  let parsedCorrupt: number;
  try {
    const parsed = await readJsonl<unknown>(paths.sessionsLedger);
    rawEvents = parsed.events;
    parsedCorrupt = parsed.corrupt;
  } catch (error: unknown) {
    // `readJsonl` only throws for hard symlink rejections under `.hive-flow`.
    // Surface the failure as `error` so the renderer can flag the source
    // without the collector itself blowing up.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...emptySummary(),
      freshness: {
        source: 'sessions',
        state: 'error',
        observedAt,
        reason: message,
      },
    };
  }

  return foldSessions(rawEvents, { nowMs, observedAt, priorCorrupt: parsedCorrupt });
}

// ---------------------------------------------------------------------------
// Reusable fold helper
// ---------------------------------------------------------------------------

/**
 * Pure fold of raw ledger rows into a {@link SessionsCollectorResult}. Used
 * by both {@link collectSessions} (on the read path) and `repair.ts` (on the
 * rebuild path) so the renderer and the repair command produce structurally
 * identical `sessions/current.json` files.
 *
 * Narrows each row with the same `isSessionEventV1` guard `collectSessions`
 * uses internally; non-conforming rows are counted as corrupt and skipped.
 * The caller forwards the JSONL-parse corrupt counter via `priorCorrupt` so
 * the freshness ladder reflects every skipped row regardless of failure mode.
 * Pure; no I/O.
 */
export function foldSessions(
  rawEvents: ReadonlyArray<unknown>,
  opts: {
    readonly nowMs: number;
    readonly observedAt: string;
    readonly priorCorrupt: number;
  },
): SessionsCollectorResult {
  const { nowMs, observedAt } = opts;

  const events: SessionEventV1[] = [];
  let corrupt = opts.priorCorrupt;
  for (const candidate of rawEvents) {
    if (isSessionEventV1(candidate)) {
      events.push(candidate);
    } else {
      // A non-conforming row is functionally indistinguishable from a JSON
      // parse failure from the consumer's perspective: skip + count it.
      corrupt++;
    }
  }

  // Fold events into the latest-per-session map. Append order is preserved
  // for readers who need it but never decides the winning event.
  const bySession = new Map<string, SessionEventV1>();
  for (const event of events) {
    const key = `${event.hostCli}:${event.sessionId}`;
    const prior = bySession.get(key);
    if (!prior || shouldReplace(event, prior)) {
      bySession.set(key, event);
    }
  }

  // Project the surviving (non-ended) sessions onto the summary.
  const byHost: Partial<Record<HostCli, SessionHostRow>> = {};
  const current: SessionsCurrentRow[] = [];
  let active = 0;
  let degraded = 0;
  let stale = 0;
  for (const event of bySession.values()) {
    if (event.event === 'session-end') continue;
    const ageMs = nowMs - Date.parse(event.ts);
    const state: SessionState = !Number.isFinite(ageMs) || ageMs > SESSION_DEGRADED_THRESHOLD_MS
      ? 'stale'
      : ageMs > SESSION_ACTIVE_THRESHOLD_MS
        ? 'degraded'
        : 'active';
    if (state === 'active') active++;
    else if (state === 'degraded') degraded++;
    else stale++;
    const host = byHost[event.hostCli] ?? {
      active: 0,
      degraded: 0,
      stale: 0,
      lastSeenAt: event.ts,
    };
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

  // Freshness ladder:
  //  - any stale session => stale
  //  - else any degraded session => degraded
  //  - else if there's at least one active session => fresh
  //  - else (ledger had only ended sessions or no live entries) => degraded
  //    (the ledger exists but produced no live signal — the renderer should
  //    treat this as "writer is silent")
  // Corrupt-line presence escalates fresh -> degraded so the renderer
  // surfaces the issue even when the live sessions look healthy.
  let baseState: SourceFreshness['state'];
  if (stale > 0) {
    baseState = 'stale';
  } else if (degraded > 0) {
    baseState = 'degraded';
  } else if (active > 0) {
    baseState = 'fresh';
  } else {
    baseState = 'degraded';
  }
  const corruptState: SourceFreshness['state'] = corrupt > 0 ? 'degraded' : 'fresh';
  const state = worse(baseState, corruptState);

  let reason: string | undefined;
  if (corrupt > 0 && active + degraded + stale === 0) {
    reason = `skipped ${corrupt} corrupt session row${corrupt === 1 ? '' : 's'}; no live sessions`;
  } else if (corrupt > 0) {
    reason = `skipped ${corrupt} corrupt session row${corrupt === 1 ? '' : 's'}`;
  } else if (active + degraded + stale === 0) {
    reason = 'ledger present but no live sessions';
  } else if (state === 'stale') {
    reason = `${stale} stale session${stale === 1 ? '' : 's'}`;
  } else if (state === 'degraded') {
    reason = `${degraded} degraded session${degraded === 1 ? '' : 's'}`;
  }

  return {
    active,
    degraded,
    stale,
    byHost,
    current,
    freshness: {
      source: 'sessions',
      state,
      observedAt,
      ...(reason !== undefined ? { reason } : {}),
    },
  };
}

