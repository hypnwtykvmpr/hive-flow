// v3/@hive-flow/cli/src/statusline/recorders/scoreboard.ts
//
// Phase 6 of the statusline rewrite. The scoreboard subsystem persists two
// append-only JSONL ledgers — `scoreboard/presence.jsonl` and
// `scoreboard/calls.jsonl` — and exposes a pure reader that aggregates them
// into the canonical `ScoreboardSummary` consumed by the renderer.
//
// Binding constraints (canonical runbook 2026-05-21 patched + Codex round-5):
//   - The writer is event-sourced and idempotent. Replays of the same event
//     (same `eventId + event` for calls; same `eventId` for presence) are
//     dropped at the ledger via the Wave 2 `appendUniqueJsonlLocked` helper
//     so spool-replay-after-crash never double-counts.
//   - Provider names are validated at runtime against the canonical
//     `SCOREBOARD_PROVIDERS` set. Arbitrary strings (e.g. callers casting
//     `unknown as ScoreProvider`) are rejected with a typed error before any
//     I/O is performed.
//   - Wrapper producers may emit presence but MUST NOT emit call telemetry;
//     the type forbids `producerKind: 'wrapper'` on `ProviderCallEventV1`, and
//     the recorder enforces the same rule at runtime for defensive depth.
//   - Counting semantics live on the reader (`computeScoreboardSummary`). The
//     writer's job is solely to durably append the event and signal the
//     refresher. The reader collapses presence to one row per `presenceKey`
//     (latest event wins) and correlates call-start / call-complete /
//     call-failed by `eventId`, then exposes `calls` (completed),
//     `inFlightCalls` (start observed, no terminal), and `failedCalls`.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { statuslinePaths } from '../paths.js';
import {
  appendUniqueJsonlLocked,
  readJsonFile,
  readJsonl,
  touchRefreshRequest,
  writeJsonFile,
} from '../storage.js';
import type {
  ProducerKind,
  ProviderCallAggregate,
  ProviderCallEventV1,
  ProviderCallUsage,
  ProviderAgentPresence,
  ScoreboardEventV1,
  ScoreboardPresenceEventV1,
  ScoreboardSummary,
  ScoreProvider,
} from '../types.js';
import {
  SCOREBOARD_PRESENCE_DEGRADED_MS,
  SCOREBOARD_PRESENCE_STALE_MS,
} from '../types.js';

// ---------------------------------------------------------------------------
// Canonical provider / producer sets (runtime validation)
// ---------------------------------------------------------------------------

/**
 * Canonical scoreboard providers. Mirrors the `ScoreProvider` discriminated
 * type in `types.ts` so a callsite that casts an arbitrary string through the
 * compile-time barrier is still rejected at runtime. Frozen so downstream
 * code cannot mutate it via aliasing.
 *
 * Typed as `ReadonlySet<string>` so `.has(value)` accepts arbitrary string
 * inputs without an unsafe cast; the runtime `isScoreProvider` type predicate
 * does the structural narrow on a successful match.
 */
const SCOREBOARD_PROVIDERS: ReadonlySet<string> = Object.freeze(
  new Set<ScoreProvider>([
    'claude',
    'codex',
    'gemini',
    'forge',
    'cursor',
    'deepseek',
    'openrouter',
    'qwen',
    'opencode',
    'unknown',
  ]),
);

/**
 * Type predicate that narrows `string` to `ScoreProvider` when the value is in
 * the canonical {@link SCOREBOARD_PROVIDERS} set. Used by `assertValidProvider`
 * so the narrow happens without an unsafe cast through the compile-time
 * barrier.
 */
function isScoreProvider(value: string): value is ScoreProvider {
  return SCOREBOARD_PROVIDERS.has(value);
}

/**
 * Producer kinds that are forbidden from emitting provider-call telemetry.
 * Wrapper producers see the host CLI but not the underlying provider call
 * lifecycle, so any wrapper-emitted call event is a programming error.
 */
const CALL_FORBIDDEN_PRODUCERS: ReadonlySet<ProducerKind> = Object.freeze(
  new Set<ProducerKind>(['wrapper']),
);

const PRESENCE_EVENT_KINDS: ReadonlySet<ScoreboardPresenceEventV1['event']> = Object.freeze(
  new Set<ScoreboardPresenceEventV1['event']>([
    'agent-spawn',
    'agent-resume',
    'agent-idle',
    'agent-end',
    'session-seen',
  ]),
);

const CALL_EVENT_KINDS: ReadonlySet<ProviderCallEventV1['event']> = Object.freeze(
  new Set<ProviderCallEventV1['event']>(['call-start', 'call-complete', 'call-failed']),
);

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a scoreboard recorder receives an event with a provider name
 * outside the canonical {@link SCOREBOARD_PROVIDERS} set. Carries the
 * rejected value (truncated) for diagnostic logging.
 */
export class ScoreboardProviderError extends Error {
  readonly code = 'SCOREBOARD_PROVIDER';
  readonly rejected: string;
  constructor(rejected: string) {
    const safe = rejected
      .slice(0, 64)
      .replace(/[\x00-\x1f\x7f]/g, '?');
    super(`scoreboard: provider must be one of canonical set; got ${safe}`);
    this.name = 'ScoreboardProviderError';
    this.rejected = rejected;
  }
}

/**
 * Thrown when a scoreboard recorder receives a malformed event (missing
 * fields, non-ISO timestamp, wrong version, invalid producerKind, invalid
 * event kind, invalid countWeight, etc.). Distinct from
 * {@link ScoreboardProviderError} so callers can branch on `instanceof`.
 */
export class ScoreboardEventError extends Error {
  readonly code = 'SCOREBOARD_EVENT';
  constructor(message: string) {
    super(`scoreboard: ${message}`);
    this.name = 'ScoreboardEventError';
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (runtime guards; no `as any`)
// ---------------------------------------------------------------------------

function assertValidProvider(value: string): asserts value is ScoreProvider {
  if (!isScoreProvider(value)) {
    throw new ScoreboardProviderError(value);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ScoreboardEventError(`${field} must be a non-empty string`);
  }
}

function assertValidIsoTs(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ScoreboardEventError(`${field} must be a valid ISO timestamp`);
  }
}

function assertVersion1(event: { version: unknown }): void {
  if (event.version !== 1) {
    throw new ScoreboardEventError('event version must be 1');
  }
}

function assertCallProducerKind(producerKind: ProducerKind): void {
  if (CALL_FORBIDDEN_PRODUCERS.has(producerKind)) {
    throw new ScoreboardEventError(
      `producerKind '${producerKind}' may not record provider calls`,
    );
  }
}

function assertOptionalPositiveInteger(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ScoreboardEventError(`${field} must be a positive integer when provided`);
  }
}

function assertOptionalNonNegativeNumber(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ScoreboardEventError(`${field} must be a finite non-negative number when provided`);
  }
}

function validatePresenceEvent(event: ScoreboardPresenceEventV1): void {
  assertVersion1(event);
  assertNonEmptyString(event.eventId, 'eventId');
  assertValidIsoTs(event.ts, 'ts');
  assertNonEmptyString(event.repoRoot, 'repoRoot');
  assertNonEmptyString(event.projectKey, 'projectKey');
  assertNonEmptyString(event.hostCli, 'hostCli');
  assertNonEmptyString(event.producerKind, 'producerKind');
  assertNonEmptyString(event.producerId, 'producerId');
  assertNonEmptyString(event.presenceKey, 'presenceKey');
  if (typeof event.provider !== 'string') {
    throw new ScoreboardEventError('provider must be a string');
  }
  assertValidProvider(event.provider);
  if (!PRESENCE_EVENT_KINDS.has(event.event)) {
    throw new ScoreboardEventError(`unknown presence event kind '${String(event.event)}'`);
  }
}

function validateCallEvent(event: ProviderCallEventV1): void {
  assertVersion1(event);
  assertNonEmptyString(event.eventId, 'eventId');
  assertValidIsoTs(event.ts, 'ts');
  assertNonEmptyString(event.repoRoot, 'repoRoot');
  assertNonEmptyString(event.projectKey, 'projectKey');
  assertNonEmptyString(event.hostCli, 'hostCli');
  assertNonEmptyString(event.producerKind, 'producerKind');
  assertNonEmptyString(event.producerId, 'producerId');
  if (typeof event.provider !== 'string') {
    throw new ScoreboardEventError('provider must be a string');
  }
  assertValidProvider(event.provider);
  if (!CALL_EVENT_KINDS.has(event.event)) {
    throw new ScoreboardEventError(`unknown call event kind '${String(event.event)}'`);
  }
  // The static type bans 'wrapper' on ProviderCallEventV1, but cast-through
  // callers can still slip a wrapper in at runtime; reject it here so the
  // contract holds whether the call came from typed code or a JSON payload.
  assertCallProducerKind(event.producerKind);
  assertOptionalPositiveInteger(event.countWeight, 'countWeight');
  assertOptionalNonNegativeNumber(event.tokensTotal, 'tokensTotal');
  assertOptionalNonNegativeNumber(event.costUsd, 'costUsd');
  assertOptionalNonNegativeNumber(event.ttfbMs, 'ttfbMs');
}

// ---------------------------------------------------------------------------
// Writer surface (event-sourced, idempotent)
// ---------------------------------------------------------------------------

/**
 * Result of a scoreboard recorder call.
 *
 *  - `written`: the event was appended to the canonical ledger.
 *  - `spooled`: the canonical ledger was locked; the event was spooled to be
 *    drained later by the renderer's drainer.
 *  - `duplicate`: the same event was already on the ledger (idempotent replay).
 */
export interface ScoreboardRecordResult {
  readonly ok: true;
  readonly written: boolean;
  readonly spooled: boolean;
  readonly duplicate: boolean;
}

function ledgerResult(written: boolean, spooled: boolean, duplicate: boolean): ScoreboardRecordResult {
  return { ok: true, written, spooled, duplicate };
}

/**
 * Append a scoreboard presence event to the presence ledger, dedupe on
 * `eventId`, then re-materialize `scoreboard/current.json` so a subsequent
 * renderer pass observes the new presence row.
 *
 * The presence ledger is updated only when the lock is acquired AND the event
 * is new; otherwise the event is spooled (lock contention) or dropped
 * (duplicate replay) and the materialized snapshot is left untouched on the
 * duplicate branch (the canonical row is already correct).
 */
export async function recordPresenceEvent(
  event: ScoreboardPresenceEventV1,
): Promise<ScoreboardRecordResult> {
  validatePresenceEvent(event);
  const paths = statuslinePaths(event.repoRoot);
  await mkdir(dirname(paths.scoreboardPresenceLedger), { recursive: true });
  const append = await appendUniqueJsonlLocked<ScoreboardPresenceEventV1>({
    ledgerPath: paths.scoreboardPresenceLedger,
    spoolRoot: paths.spoolRoot,
    ledgerName: 'scoreboard-presence',
    event,
    uniqueField: 'eventId',
  });
  if (append.duplicate) {
    // Idempotent replay — the ledger already records this presence row.
    return ledgerResult(false, false, true);
  }
  if (append.spooled) {
    await touchRefreshRequest(event.repoRoot);
    return ledgerResult(false, true, false);
  }
  if (!append.written) {
    // The lock was contended and the caller asked us NOT to spool. Forward
    // the no-op verbatim; nothing else to do.
    return ledgerResult(false, false, false);
  }
  const summary = await computeScoreboardSummary(event.repoRoot);
  await writeJsonFile(paths.scoreboardCurrent, summary);
  await touchRefreshRequest(event.repoRoot);
  return ledgerResult(true, false, false);
}

/**
 * Append a provider-call event to the call ledger. Dedupe is **compound** on
 * `[eventId, event]` so the call-start / call-complete pair for a single
 * eventId is preserved while exact replays (same event kind on same eventId)
 * are dropped. Codex round-5 binding.
 *
 * Re-materializes `scoreboard/current.json` on a successful append so a
 * subsequent renderer pass observes the new call row. Spooled events do not
 * update the snapshot — the drainer will do that after the lock is released.
 */
export async function recordProviderCall(
  event: ProviderCallEventV1,
): Promise<ScoreboardRecordResult> {
  validateCallEvent(event);
  const paths = statuslinePaths(event.repoRoot);
  await mkdir(dirname(paths.scoreboardCallsLedger), { recursive: true });
  const append = await appendUniqueJsonlLocked<ProviderCallEventV1>({
    ledgerPath: paths.scoreboardCallsLedger,
    spoolRoot: paths.spoolRoot,
    ledgerName: 'scoreboard-calls',
    event,
    uniqueField: ['eventId', 'event'],
  });
  if (append.duplicate) {
    return ledgerResult(false, false, true);
  }
  if (append.spooled) {
    await touchRefreshRequest(event.repoRoot);
    return ledgerResult(false, true, false);
  }
  if (!append.written) {
    return ledgerResult(false, false, false);
  }
  const summary = await computeScoreboardSummary(event.repoRoot);
  await writeJsonFile(paths.scoreboardCurrent, summary);
  await touchRefreshRequest(event.repoRoot);
  return ledgerResult(true, false, false);
}

/**
 * Unified recorder for callers that hold a discriminated `ScoreboardEventV1`
 * value (e.g. CLI subcommands). Dispatches on the `event` field via the
 * presence/call event-kind sets so the static narrowing matches the runtime
 * dispatch. The two writer-side branches are otherwise distinct.
 */
export async function recordScoreboardEvent(
  event: ScoreboardEventV1,
): Promise<ScoreboardRecordResult> {
  if (CALL_EVENT_KINDS.has(event.event as ProviderCallEventV1['event'])) {
    return recordProviderCall(event as ProviderCallEventV1);
  }
  if (PRESENCE_EVENT_KINDS.has(event.event as ScoreboardPresenceEventV1['event'])) {
    return recordPresenceEvent(event as ScoreboardPresenceEventV1);
  }
  throw new ScoreboardEventError(`unknown scoreboard event kind '${String(event.event)}'`);
}

// ---------------------------------------------------------------------------
// Reader surface (pure aggregation)
// ---------------------------------------------------------------------------

function ensureAgent(
  summary: ScoreboardSummary,
  provider: ScoreProvider,
): ProviderAgentPresence {
  const existing = summary.agentsByProvider[provider];
  if (existing) return existing;
  const fresh: ProviderAgentPresence = { activeAgents: 0, idleAgents: 0, staleAgents: 0, models: {} };
  summary.agentsByProvider[provider] = fresh;
  return fresh;
}

function ensureCalls(
  summary: ScoreboardSummary,
  provider: ScoreProvider,
): ProviderCallUsage {
  const existing = summary.callsByProvider[provider];
  if (existing) return existing;
  const fresh: ProviderCallUsage = { calls: 0, models: {} };
  summary.callsByProvider[provider] = fresh;
  return fresh;
}

function mergeCallEvent(
  callsByEventId: Map<string, ProviderCallAggregate>,
  event: ProviderCallEventV1,
): void {
  const existing = callsByEventId.get(event.eventId);
  const base: ProviderCallAggregate = existing ?? {
    provider: event.provider,
    firstTs: event.ts,
    model: event.model,
    complete: false,
    failed: false,
  };
  if (event.model !== undefined) base.model = event.model;
  if (event.countWeight !== undefined) base.countWeight = event.countWeight;
  if (event.tokensTotal !== undefined) base.tokensTotal = event.tokensTotal;
  if (event.costUsd !== undefined) base.costUsd = event.costUsd;
  if (event.ttfbMs !== undefined) base.ttfbMs = event.ttfbMs;
  base.complete = base.complete || event.event === 'call-complete';
  base.failed = base.failed || event.event === 'call-failed';
  if (event.ts < base.firstTs) base.firstTs = event.ts;
  callsByEventId.set(event.eventId, base);
}

/**
 * Compute the canonical `ScoreboardSummary` from the on-disk ledgers. Pure;
 * never mutates the ledgers. Presence rows collapse to one row per
 * `presenceKey` (latest event wins) so a long-lived agent that emits many
 * heartbeat events still counts as exactly one row. Call rows correlate
 * start / complete / failed pairs by `eventId` and aggregate per provider.
 *
 * `nowMs` is injected so tests can pin the staleness window. Defaults to
 * `Date.now()` so production callers do not need to thread a clock.
 */
export async function computeScoreboardSummary(
  projectRoot: string,
  nowMs: number = Date.now(),
): Promise<ScoreboardSummary> {
  const paths = statuslinePaths(projectRoot);
  const presence = await readJsonl<ScoreboardPresenceEventV1>(paths.scoreboardPresenceLedger);
  const calls = await readJsonl<ProviderCallEventV1>(paths.scoreboardCallsLedger);

  const summary: ScoreboardSummary = {
    agentsByProvider: {},
    callsByProvider: {},
    stale: false,
  };

  // -------------------------------------------------------------------------
  // Presence aggregation: collapse to latest event per presenceKey.
  // -------------------------------------------------------------------------
  const latestPresence = new Map<string, ScoreboardPresenceEventV1>();
  for (const event of presence.events) {
    if (typeof event.presenceKey !== 'string' || event.presenceKey.length === 0) continue;
    if (typeof event.provider !== 'string' || !SCOREBOARD_PROVIDERS.has(event.provider)) continue;
    if (!summary.lastUpdatedAt || event.ts > summary.lastUpdatedAt) {
      summary.lastUpdatedAt = event.ts;
    }
    const prior = latestPresence.get(event.presenceKey);
    if (!prior || event.ts >= prior.ts) latestPresence.set(event.presenceKey, event);
  }

  for (const event of latestPresence.values()) {
    if (event.event === 'agent-end') continue;
    const provider = ensureAgent(summary, event.provider);
    const ageMs = nowMs - new Date(event.ts).getTime();
    const isStale = Number.isFinite(ageMs) && ageMs > SCOREBOARD_PRESENCE_STALE_MS;
    const isDegraded = Number.isFinite(ageMs) && ageMs > SCOREBOARD_PRESENCE_DEGRADED_MS;
    if (isStale) {
      provider.staleAgents += 1;
      summary.stale = true;
    } else if (isDegraded) {
      provider.idleAgents += 1;
    } else if (event.event === 'agent-idle') {
      provider.idleAgents += 1;
    } else {
      provider.activeAgents += 1;
    }
    if (event.model !== undefined && provider.models) {
      provider.models[event.model] = (provider.models[event.model] ?? 0) + 1;
    }
    provider.lastSeenAt = event.ts;
  }

  // -------------------------------------------------------------------------
  // Call aggregation: correlate start / complete / failed pairs by eventId.
  // -------------------------------------------------------------------------
  const callsByEventId = new Map<string, ProviderCallAggregate>();
  for (const event of calls.events) {
    if (typeof event.provider !== 'string' || !SCOREBOARD_PROVIDERS.has(event.provider)) continue;
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) continue;
    if (!summary.lastUpdatedAt || event.ts > summary.lastUpdatedAt) {
      summary.lastUpdatedAt = event.ts;
    }
    mergeCallEvent(callsByEventId, event);
  }

  for (const call of callsByEventId.values()) {
    const usage = ensureCalls(summary, call.provider);
    if (!call.complete) {
      if (call.failed) {
        usage.failedCalls = (usage.failedCalls ?? 0) + 1;
      } else {
        usage.inFlightCalls = (usage.inFlightCalls ?? 0) + 1;
      }
      continue;
    }
    usage.calls += call.countWeight ?? 1;
    usage.tokensTotal = (usage.tokensTotal ?? 0) + (call.tokensTotal ?? 0);
    usage.costUsd = (usage.costUsd ?? 0) + (call.costUsd ?? 0);
    if (call.model !== undefined && usage.models) {
      usage.models[call.model] = (usage.models[call.model] ?? 0) + 1;
    }
    if (call.ttfbMs !== undefined) {
      const samples = usage.ttfbSamples ?? 0;
      const prior = usage.ttfbAvgMs ?? 0;
      usage.ttfbAvgMs = Math.round((prior * samples + call.ttfbMs) / (samples + 1));
      usage.ttfbSamples = samples + 1;
    }
    usage.lastCallAt =
      !usage.lastCallAt || call.firstTs > usage.lastCallAt ? call.firstTs : usage.lastCallAt;
  }

  return summary;
}

/**
 * Read the materialized `scoreboard/current.json`. Returns `undefined` when
 * the snapshot has never been written (cold start). Bounded + symlink-safe
 * via the underlying `readJsonFile` primitive.
 */
export async function readScoreboardSummary(
  projectRoot: string,
): Promise<ScoreboardSummary | undefined> {
  const paths = statuslinePaths(projectRoot);
  return readJsonFile<ScoreboardSummary>(paths.scoreboardCurrent);
}
