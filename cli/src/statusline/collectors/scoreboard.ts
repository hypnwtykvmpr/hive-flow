// v3/@hive-flow/cli/src/statusline/collectors/scoreboard.ts
//
// Wave-3 scoreboard collector for the statusline rewrite. Pure async; never
// mutates ledgers. Reads the canonical presence + calls JSONL ledgers (Wave 2
// `readJsonl`) plus the legacy `.hive-flow/metrics/provider-usage.json` file
// and folds them into a `ScoreboardSummary` typed contract from Wave 1.
//
// Binding constraints (canonical runbook Phase 6 + Codex round-3 finding):
//   - Render BOTH `agentsByProvider` AND `callsByProvider`. Wrapper-only CLIs
//     (e.g. `wrapper` ProducerKind) emit presence events but are explicitly
//     excluded from call telemetry by `ProviderCallEventV1.producerKind`, so
//     presence and call counts MUST be folded into separate maps.
//   - Presence freshness uses the canonical constants exported from `types.ts`
//     (`SCOREBOARD_PRESENCE_DEGRADED_MS` = 15s, `_STALE_MS` = 2m). Do NOT
//     inline these values; the runbook requires identical semantics across
//     every consumer.
//   - Deduplicate by the compound `eventId + event` key (Codex round-5 binding,
//     matches `appendUniqueJsonlLocked` semantics in storage.ts).
//   - Migration: also read legacy `.hive-flow/metrics/provider-usage.json`.
//     Merge into result. File absent → no error. Parse failure / malformed
//     shape → return `migrationSkippedReason` on the summary and continue with
//     the ledger-derived values. NEVER throw.
//   - No `as any`. No unsafe casts. All narrowing is by `typeof` / `in` /
//     `Array.isArray` guards.

import { join } from 'node:path';

import { readJsonl } from '../storage.js';
import { statuslinePaths } from '../paths.js';
import {
  SCOREBOARD_PRESENCE_DEGRADED_MS,
  SCOREBOARD_PRESENCE_STALE_MS,
  type ProviderAgentPresence,
  type ProviderCallEventV1,
  type ProviderCallUsage,
  type ScoreProvider,
  type ScoreboardPresenceEventV1,
  type ScoreboardSummary,
} from '../types.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface CollectScoreboardOptions {
  readonly projectRoot: string;
  /**
   * Reference timestamp for freshness classification. Defaults to `Date.now()`.
   * Tests inject a fixed value so age windows are deterministic.
   */
  readonly now?: number;
}

/**
 * The collector's return shape is structurally a `ScoreboardSummary` (so the
 * snapshot type stays unchanged) with an optional diagnostic `migrationSkippedReason`
 * sidecar. The sidecar is the runbook's required signal when the legacy
 * `provider-usage.json` is present but unreadable.
 */
export type CollectScoreboardResult = ScoreboardSummary & {
  /**
   * Populated when the legacy migration source exists but cannot be parsed.
   * Undefined when the source is absent or successfully merged. NEVER causes
   * `collectScoreboard` to throw.
   */
  migrationSkippedReason?: string;
};

/**
 * Fold scoreboard ledgers (presence + calls) plus the legacy
 * `provider-usage.json` migration into a `ScoreboardSummary`. Pure async; no
 * mutation. Safe to invoke from the renderer's hot path.
 */
export async function collectScoreboard(
  opts: CollectScoreboardOptions,
): Promise<CollectScoreboardResult> {
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const paths = statuslinePaths(opts.projectRoot);

  const [presenceRead, callsRead] = await Promise.all([
    readJsonl<unknown>(paths.scoreboardPresenceLedger),
    readJsonl<unknown>(paths.scoreboardCallsLedger),
  ]);

  const folded = foldScoreboard(presenceRead.events, callsRead.events, {
    now,
    presenceCorrupt: presenceRead.corrupt,
    callsCorrupt: callsRead.corrupt,
  });

  // Migration: read the legacy `provider-usage.json`. Always best-effort.
  // Repair callers (which use `foldScoreboard` directly) do NOT apply the
  // migration because the runbook's Phase 5 binding (line 5878) requires
  // repair to rebuild from ledgers only — otherwise direct-only migration
  // state would be erased on each rebuild.
  const migration = await readLegacyProviderUsage(opts.projectRoot);
  if (migration.kind === 'ok') {
    mergeLegacyUsage(folded.callsByProvider, migration.value);
  }

  const result: CollectScoreboardResult = {
    agentsByProvider: folded.agentsByProvider,
    callsByProvider: folded.callsByProvider,
    stale: folded.stale,
  };
  if (typeof folded.lastUpdatedAt === 'string') {
    result.lastUpdatedAt = folded.lastUpdatedAt;
  }
  if (migration.kind === 'skipped') {
    result.migrationSkippedReason = migration.reason;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reusable fold helper (extracted for `repair.ts`)
// ---------------------------------------------------------------------------

/**
 * Pure fold of raw presence + call ledger rows into a {@link ScoreboardSummary}.
 * Used by both {@link collectScoreboard} (on the read path) and `repair.ts`
 * (on the rebuild path) so the renderer and the repair command produce
 * structurally identical `scoreboard/current.json` files.
 *
 * Narrows each row with the same `isPresenceEvent` / `isCallEvent` guards and
 * applies the same `eventId + event` compound dedupe `collectScoreboard` uses
 * internally. The legacy `provider-usage.json` migration is intentionally
 * EXCLUDED from this helper because repair must rebuild from ledgers only
 * (runbook line 5878). Pure; no I/O.
 */
export function foldScoreboard(
  presenceEvents: ReadonlyArray<unknown>,
  callEvents: ReadonlyArray<unknown>,
  opts: {
    readonly now: number;
    readonly presenceCorrupt: number;
    readonly callsCorrupt: number;
  },
): ScoreboardSummary {
  const presence = dedupeEvents(presenceEvents, isPresenceEvent);
  const calls = dedupeEvents(callEvents, isCallEvent);

  const agentsByProvider = foldPresence(presence, opts.now);
  const callsByProvider = foldCalls(calls);

  const lastUpdatedAt = computeLastUpdatedAt(presence, calls);
  const stale = computeStale(opts.now, lastUpdatedAt, opts.presenceCorrupt, opts.callsCorrupt);

  const summary: ScoreboardSummary = {
    agentsByProvider,
    callsByProvider,
    stale,
  };
  if (typeof lastUpdatedAt === 'string') {
    summary.lastUpdatedAt = lastUpdatedAt;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Event guards (structural; no `as any`)
// ---------------------------------------------------------------------------

const PRESENCE_EVENT_KINDS: ReadonlySet<string> = new Set([
  'agent-spawn',
  'agent-resume',
  'agent-idle',
  'agent-end',
  'session-seen',
]);

const CALL_EVENT_KINDS: ReadonlySet<string> = new Set([
  'call-start',
  'call-complete',
  'call-failed',
]);

const SCORE_PROVIDERS: ReadonlySet<string> = new Set<ScoreProvider>([
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
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Type predicate narrowing a `string` to a canonical `ScoreProvider`. Uses the
 * `SCORE_PROVIDERS` set (typed `ReadonlySet<string>` to keep `.has` accepting
 * arbitrary input) so the narrow happens without an unsafe cast.
 */
function isScoreProvider(value: string): value is ScoreProvider {
  return SCORE_PROVIDERS.has(value);
}

function toScoreProvider(value: unknown): ScoreProvider {
  if (isString(value) && isScoreProvider(value)) {
    return value;
  }
  return 'unknown';
}

function isPresenceEvent(value: unknown): value is ScoreboardPresenceEventV1 {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isString(value.eventId)) return false;
  if (!isString(value.ts)) return false;
  if (!isString(value.event) || !PRESENCE_EVENT_KINDS.has(value.event)) return false;
  if (!isString(value.provider)) return false;
  if (!isString(value.presenceKey)) return false;
  // hostCli, producerKind, producerId, repoRoot, projectKey are required by the
  // type but we tolerate weakly-typed ledger rows; the fold only needs the
  // event kind, provider, presenceKey, ts, and (optional) model.
  return true;
}

function isCallEvent(value: unknown): value is ProviderCallEventV1 {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!isString(value.eventId)) return false;
  if (!isString(value.ts)) return false;
  if (!isString(value.event) || !CALL_EVENT_KINDS.has(value.event)) return false;
  if (!isString(value.provider)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Dedupe by `eventId + event` (compound key — Codex round-5 binding)
// ---------------------------------------------------------------------------

function dedupeEvents<T extends { eventId: string; event: string }>(
  events: ReadonlyArray<unknown>,
  guard: (value: unknown) => value is T,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const raw of events) {
    if (!guard(raw)) continue;
    const key = `${raw.eventId}\x01${raw.event}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presence fold
// ---------------------------------------------------------------------------

interface PresenceFoldRow {
  ts: string;
  age: number;
  event: ScoreboardPresenceEventV1['event'];
  model?: string;
}

function foldPresence(
  events: ReadonlyArray<ScoreboardPresenceEventV1>,
  now: number,
): Partial<Record<ScoreProvider, ProviderAgentPresence>> {
  // For each (provider, presenceKey) pair, keep only the LATEST event by `ts`.
  // The latest event determines the agent's current bucket: spawn/resume/idle
  // contribute to live counts; agent-end / session-seen interact with the
  // freshness window per the runbook Phase 6 spec.
  const latestByKey = new Map<string, { provider: ScoreProvider; row: PresenceFoldRow }>();
  for (const evt of events) {
    const provider = toScoreProvider(evt.provider);
    const ts = evt.ts;
    const parsed = Date.parse(ts);
    if (!Number.isFinite(parsed)) continue;
    const age = now - parsed;
    const mapKey = `${provider}\x01${evt.presenceKey}`;
    const existing = latestByKey.get(mapKey);
    if (!existing || Date.parse(existing.row.ts) <= parsed) {
      const row: PresenceFoldRow = { ts, age, event: evt.event };
      if (isString(evt.model)) row.model = evt.model;
      latestByKey.set(mapKey, { provider, row });
    }
  }

  const out: Partial<Record<ScoreProvider, ProviderAgentPresence>> = {};
  for (const { provider, row } of latestByKey.values()) {
    // Terminal `agent-end` excludes the row from all live counts.
    if (row.event === 'agent-end') continue;

    let bucket = out[provider];
    if (!bucket) {
      bucket = { activeAgents: 0, idleAgents: 0, staleAgents: 0 };
      out[provider] = bucket;
    }

    // Freshness windows (canonical constants from types.ts).
    if (row.age >= SCOREBOARD_PRESENCE_STALE_MS) {
      bucket.staleAgents++;
    } else if (row.age >= SCOREBOARD_PRESENCE_DEGRADED_MS) {
      // Degraded freshness collapses to the `idle` bucket regardless of the
      // last event kind: the agent stopped emitting heartbeats within the
      // fresh window.
      bucket.idleAgents++;
    } else if (row.event === 'agent-idle' || row.event === 'session-seen') {
      bucket.idleAgents++;
    } else {
      bucket.activeAgents++;
    }

    if (isString(row.model)) {
      const models = bucket.models ?? {};
      models[row.model] = (models[row.model] ?? 0) + 1;
      bucket.models = models;
    }

    if (!bucket.lastSeenAt || row.ts > bucket.lastSeenAt) {
      bucket.lastSeenAt = row.ts;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calls fold
// ---------------------------------------------------------------------------

interface CallFoldEntry {
  provider: ScoreProvider;
  firstTs: string;
  lastTs: string;
  model?: string;
  countWeight: number;
  tokensTotal: number;
  costUsd: number;
  ttfbSumMs: number;
  ttfbSamples: number;
  hasStart: boolean;
  hasComplete: boolean;
  hasFailed: boolean;
}

function foldCalls(
  events: ReadonlyArray<ProviderCallEventV1>,
): Partial<Record<ScoreProvider, ProviderCallUsage>> {
  // Aggregate by `eventId`: call-start and call-complete share an eventId so
  // they collapse into a single call record. We track per-event flags
  // (hasStart/hasComplete/hasFailed) to derive in-flight + failed totals.
  const byEventId = new Map<string, CallFoldEntry>();
  for (const evt of events) {
    const provider = toScoreProvider(evt.provider);
    const existing = byEventId.get(evt.eventId);
    if (!existing) {
      const entry: CallFoldEntry = {
        provider,
        firstTs: evt.ts,
        lastTs: evt.ts,
        countWeight: isFiniteNumber(evt.countWeight) ? evt.countWeight : 1,
        tokensTotal: isFiniteNumber(evt.tokensTotal) ? evt.tokensTotal : 0,
        costUsd: isFiniteNumber(evt.costUsd) ? evt.costUsd : 0,
        ttfbSumMs: 0,
        ttfbSamples: 0,
        hasStart: evt.event === 'call-start',
        hasComplete: evt.event === 'call-complete',
        hasFailed: evt.event === 'call-failed',
      };
      if (isString(evt.model)) entry.model = evt.model;
      if (isFiniteNumber(evt.ttfbMs)) {
        entry.ttfbSumMs += evt.ttfbMs;
        entry.ttfbSamples += 1;
      }
      byEventId.set(evt.eventId, entry);
      continue;
    }
    // Merge a subsequent event into the same eventId bucket.
    if (evt.ts < existing.firstTs) existing.firstTs = evt.ts;
    if (evt.ts > existing.lastTs) existing.lastTs = evt.ts;
    if (evt.event === 'call-start') existing.hasStart = true;
    if (evt.event === 'call-complete') existing.hasComplete = true;
    if (evt.event === 'call-failed') existing.hasFailed = true;
    if (isFiniteNumber(evt.countWeight) && evt.countWeight > existing.countWeight) {
      existing.countWeight = evt.countWeight;
    }
    if (isFiniteNumber(evt.tokensTotal) && evt.tokensTotal > existing.tokensTotal) {
      existing.tokensTotal = evt.tokensTotal;
    }
    if (isFiniteNumber(evt.costUsd) && evt.costUsd > existing.costUsd) {
      existing.costUsd = evt.costUsd;
    }
    if (isString(evt.model) && !existing.model) existing.model = evt.model;
    if (isFiniteNumber(evt.ttfbMs)) {
      existing.ttfbSumMs += evt.ttfbMs;
      existing.ttfbSamples += 1;
    }
  }

  const out: Partial<Record<ScoreProvider, ProviderCallUsage>> = {};
  for (const entry of byEventId.values()) {
    let bucket = out[entry.provider];
    if (!bucket) {
      bucket = { calls: 0 };
      out[entry.provider] = bucket;
    }
    // `calls`, `failedCalls`, and `inFlightCalls` are mutually exclusive. Only
    // observably completed calls increment `calls`; failed and in-flight events
    // populate their respective counters without double-counting. Recorder-side
    // semantics (see `recorders/__tests__/scoreboard.test.ts:93`) treat `calls`
    // as completed-only. Usage metrics below (tokens, cost, ttfb, models,
    // lastCallAt) accumulate regardless of completion state because they are
    // observed-usage signals, not call-counts.
    if (entry.hasFailed) {
      bucket.failedCalls = (bucket.failedCalls ?? 0) + entry.countWeight;
    } else if (entry.hasStart && !entry.hasComplete) {
      bucket.inFlightCalls = (bucket.inFlightCalls ?? 0) + entry.countWeight;
    } else {
      bucket.calls += entry.countWeight;
    }
    if (entry.tokensTotal > 0) {
      bucket.tokensTotal = (bucket.tokensTotal ?? 0) + entry.tokensTotal;
    }
    if (entry.costUsd > 0) {
      bucket.costUsd = (bucket.costUsd ?? 0) + entry.costUsd;
    }
    if (entry.ttfbSamples > 0) {
      const priorSamples = bucket.ttfbSamples ?? 0;
      const priorAvg = bucket.ttfbAvgMs ?? 0;
      const totalSamples = priorSamples + entry.ttfbSamples;
      const totalSum = priorAvg * priorSamples + entry.ttfbSumMs;
      bucket.ttfbSamples = totalSamples;
      bucket.ttfbAvgMs = totalSamples > 0 ? totalSum / totalSamples : 0;
    }
    if (isString(entry.model)) {
      const models = bucket.models ?? {};
      models[entry.model] = (models[entry.model] ?? 0) + entry.countWeight;
      bucket.models = models;
    }
    if (!bucket.lastCallAt || entry.lastTs > bucket.lastCallAt) {
      bucket.lastCallAt = entry.lastTs;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Last-updated derivation
// ---------------------------------------------------------------------------

function computeLastUpdatedAt(
  presence: ReadonlyArray<ScoreboardPresenceEventV1>,
  calls: ReadonlyArray<ProviderCallEventV1>,
): string | undefined {
  let max: string | undefined;
  for (const evt of presence) {
    if (!max || evt.ts > max) max = evt.ts;
  }
  for (const evt of calls) {
    if (!max || evt.ts > max) max = evt.ts;
  }
  return max;
}

function computeStale(
  now: number,
  lastUpdatedAt: string | undefined,
  presenceCorrupt: number,
  callsCorrupt: number,
): boolean {
  if (presenceCorrupt > 0 || callsCorrupt > 0) return true;
  if (typeof lastUpdatedAt !== 'string') return false;
  const parsed = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed >= SCOREBOARD_PRESENCE_STALE_MS;
}

// ---------------------------------------------------------------------------
// Legacy `provider-usage.json` migration
// ---------------------------------------------------------------------------

type LegacyMigrationOutcome =
  | { kind: 'ok'; value: LegacyProviderUsage }
  | { kind: 'absent' }
  | { kind: 'skipped'; reason: string };

interface LegacyProviderUsage {
  readonly providers: Record<string, LegacyProviderRecord>;
  readonly sessionId?: string;
  readonly startedAt?: string;
}

interface LegacyProviderRecord {
  readonly calls: number;
  readonly tokens?: number;
  readonly ttfbAvgMs?: number;
  readonly lastUsed?: string;
}

async function readLegacyProviderUsage(projectRoot: string): Promise<LegacyMigrationOutcome> {
  const legacyPath = join(projectRoot, '.hive-flow', 'metrics', 'provider-usage.json');
  // We deliberately do NOT funnel this through the symlink-guarded
  // `readJsonFile` helper. The legacy file predates the statusline storage
  // primitives and lives outside the runbook's hardened ledger tree. We still
  // bound the read aggressively (2 MiB cap) and tolerate every error mode.
  const { readFile, lstat } = await import('node:fs/promises');
  let stats;
  try {
    stats = await lstat(legacyPath);
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) return { kind: 'absent' };
    return { kind: 'skipped', reason: 'lstat-error' };
  }
  if (stats.isSymbolicLink()) {
    return { kind: 'skipped', reason: 'symlinked' };
  }
  if (!stats.isFile()) {
    return { kind: 'skipped', reason: 'not-a-regular-file' };
  }
  if (stats.size > 2 * 1024 * 1024) {
    return { kind: 'skipped', reason: 'oversize' };
  }
  let raw: string;
  try {
    raw = await readFile(legacyPath, 'utf8');
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) return { kind: 'absent' };
    return { kind: 'skipped', reason: 'read-error' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'skipped', reason: 'parse-error' };
  }
  if (!isRecord(parsed)) {
    return { kind: 'skipped', reason: 'invalid-shape' };
  }
  const providersRaw = parsed.providers;
  if (!isRecord(providersRaw)) {
    return { kind: 'skipped', reason: 'invalid-shape' };
  }
  const providers: Record<string, LegacyProviderRecord> = {};
  for (const [name, recordRaw] of Object.entries(providersRaw)) {
    if (!isRecord(recordRaw)) continue;
    const callsRaw = recordRaw.calls;
    if (!isFiniteNumber(callsRaw) || callsRaw < 0) continue;
    const entry: LegacyProviderRecord = mergeOptionalRecord({
      calls: callsRaw,
      tokens: isFiniteNumber(recordRaw.tokens) ? recordRaw.tokens : undefined,
      ttfbAvgMs: isFiniteNumber(recordRaw.ttfb_avg_ms)
        ? recordRaw.ttfb_avg_ms
        : isFiniteNumber(recordRaw.ttfbAvgMs)
          ? recordRaw.ttfbAvgMs
          : undefined,
      lastUsed: isString(recordRaw.last_used)
        ? recordRaw.last_used
        : isString(recordRaw.lastUsed)
          ? recordRaw.lastUsed
          : undefined,
    });
    providers[name] = entry;
  }
  const out: LegacyProviderUsage = {
    providers,
    ...(isString(parsed.sessionId) ? { sessionId: parsed.sessionId } : {}),
    ...(isString(parsed.startedAt) ? { startedAt: parsed.startedAt } : {}),
  };
  return { kind: 'ok', value: out };
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (!isRecord(error)) return false;
  return error['code'] === code;
}

function mergeOptionalRecord(record: {
  calls: number;
  tokens?: number;
  ttfbAvgMs?: number;
  lastUsed?: string;
}): LegacyProviderRecord {
  const out: LegacyProviderRecord = { calls: record.calls };
  if (record.tokens !== undefined) Object.assign(out, { tokens: record.tokens });
  if (record.ttfbAvgMs !== undefined) Object.assign(out, { ttfbAvgMs: record.ttfbAvgMs });
  if (record.lastUsed !== undefined) Object.assign(out, { lastUsed: record.lastUsed });
  return out;
}

// ---------------------------------------------------------------------------
// Legacy provider name mapping
// ---------------------------------------------------------------------------

/**
 * Legacy `provider-usage.json` keyed by model name (`opus`, `sonnet`, `haiku`)
 * or provider name. Map model-flavoured names onto their canonical
 * `ScoreProvider` so the renderer can keep one row per provider.
 */
function mapLegacyProviderName(name: string): ScoreProvider {
  const normalized = name.trim().toLowerCase();
  if (normalized === '') return 'unknown';
  // Direct ScoreProvider matches.
  if (isScoreProvider(normalized)) {
    return normalized;
  }
  // Anthropic model families.
  if (
    normalized === 'opus' ||
    normalized === 'sonnet' ||
    normalized === 'haiku' ||
    normalized.startsWith('claude-') ||
    normalized.startsWith('opus-') ||
    normalized.startsWith('sonnet-') ||
    normalized.startsWith('haiku-')
  ) {
    return 'claude';
  }
  // OpenAI / Codex model families.
  if (normalized.startsWith('gpt-') || normalized.startsWith('codex')) {
    return 'codex';
  }
  // Gemini model families.
  if (normalized.startsWith('gemini')) {
    return 'gemini';
  }
  return 'unknown';
}

function mergeLegacyUsage(
  callsByProvider: Partial<Record<ScoreProvider, ProviderCallUsage>>,
  legacy: LegacyProviderUsage,
): void {
  for (const [legacyName, record] of Object.entries(legacy.providers)) {
    const provider = mapLegacyProviderName(legacyName);
    let bucket = callsByProvider[provider];
    if (!bucket) {
      bucket = { calls: 0 };
      callsByProvider[provider] = bucket;
    }
    bucket.calls += record.calls;
    if (typeof record.tokens === 'number' && Number.isFinite(record.tokens) && record.tokens > 0) {
      bucket.tokensTotal = (bucket.tokensTotal ?? 0) + record.tokens;
    }
    if (
      typeof record.ttfbAvgMs === 'number' &&
      Number.isFinite(record.ttfbAvgMs) &&
      record.ttfbAvgMs > 0
    ) {
      // Legacy file stored only a running average without sample counts. Treat
      // the legacy value as a single representative sample so the canonical
      // running average remains numerically defensible. Ledger samples carry
      // their own counts and dominate over time.
      const priorSamples = bucket.ttfbSamples ?? 0;
      const priorAvg = bucket.ttfbAvgMs ?? 0;
      const totalSamples = priorSamples + 1;
      const totalSum = priorAvg * priorSamples + record.ttfbAvgMs;
      bucket.ttfbSamples = totalSamples;
      bucket.ttfbAvgMs = totalSamples > 0 ? totalSum / totalSamples : 0;
    }
    if (isString(record.lastUsed)) {
      if (!bucket.lastCallAt || record.lastUsed > bucket.lastCallAt) {
        bucket.lastCallAt = record.lastUsed;
      }
    }
  }
}
