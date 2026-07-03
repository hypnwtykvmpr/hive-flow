// cli/src/statusline/repair.ts
//
// Wave 6/7 of the canonical statusline rewrite (Codex merged runbook 2026-05-20,
// post 2026-05-21 patches). Rebuilds materialized `*.current.json` snapshots
// from their canonical `*.jsonl` ledger sources. Invoked via
// `statusline refresh --repair` and `statusline repair` (CLI surfaces land in
// a later wave).
//
// Binding constraints:
//   - Repair MUST rebuild from ledgers only. The runbook's Phase 5 binding
//     (line 5878) prohibits applying the legacy `provider-usage.json` migration
//     here — otherwise direct-only migration state would be erased on each
//     rebuild. `collectScoreboard` applies the migration; `foldScoreboard`
//     (used here) does NOT.
//   - DO NOT duplicate collector fold logic. Each target imports its
//     corresponding `foldXxx` helper from `collectors/*.ts` so the renderer
//     and repair always produce structurally identical `*.current.json`.
//   - Corrupt lines are tolerated: `readJsonl` already counts them; repair
//     surfaces the count on `RepairResult.corrupt`.
//   - Missing ledger is tolerated: produce an empty collector summary and
//     mark `RepairResult.freshness.state = 'absent'`.
//   - Read + rebuild + write happen under the canonical ledger's
//     `<ledgerPath>.lock` so a concurrent recorder cannot interleave a
//     half-written append. Scoreboard repair holds BOTH presence + calls
//     locks (acquired in a fixed order — presence first, then calls — so two
//     concurrent scoreboard repairs cannot deadlock).
//   - All writes go through `writeJsonFile` / `atomicWriteJson` (write to
//     temp + fsync + rename); the repair path never touches the canonical
//     file in place.
//   - Phase 3 binding: the spool MUST be drained BEFORE any ledger read so a
//     spooled event (written when a recorder lost the ledger lock) is folded
//     into the rebuilt `*.current.json`. `repairLedger` drains all spool
//     ledgers up-front; `repairAllLedgers` drains exactly once at the very
//     start so per-target subcalls do not re-drain. The drainer releases its
//     locks before returning, so the subsequent `withFileLock` on the
//     canonical ledger acquires freely.

import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { collectAttention, foldAttention } from './collectors/attention.js';
import { collectScoreboard, foldScoreboard } from './collectors/scoreboard.js';
import { collectSessions, foldSessions } from './collectors/sessions.js';
import { collectTests, foldTests } from './collectors/tests.js';
import { statuslinePaths } from './paths.js';
import { drainSpool, type DrainReport } from './spool-drainer.js';
import { atomicWriteJson, readJsonl, withFileLock } from './storage.js';
import type {
  AttentionSummary,
  ScoreboardSummary,
  SourceFreshness,
  TestsSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type RepairTarget = 'sessions' | 'scoreboard' | 'tests' | 'attention';

/**
 * Canonical declaration order for `repairAllLedgers`. Exported so callers and
 * tests can assert deterministic per-target sequencing.
 */
export const REPAIR_TARGETS: ReadonlyArray<RepairTarget> = Object.freeze([
  'sessions',
  'scoreboard',
  'tests',
  'attention',
]);

/**
 * Repair-specific freshness shape. Mirrors {@link SourceFreshness} for the
 * common case (ledger present, parsed cleanly) and adds an `absent` state
 * which represents "ledger file did not exist when repair ran". `absent` is
 * not part of the canonical {@link import('./types.js').FreshnessState} union
 * because no upstream consumer needs to disambiguate it from `unavailable`;
 * repair surfaces it as a programmatic signal for tooling.
 */
export type RepairFreshnessState = SourceFreshness['state'] | 'absent';

export interface RepairFreshness {
  readonly state: RepairFreshnessState;
  readonly observedAt: string;
  readonly reason?: string;
}

export interface RepairResult {
  readonly target: RepairTarget;
  /** Total parsed events read from the ledger(s). */
  readonly read: number;
  /** Lines / rows that failed JSON.parse or schema validation. */
  readonly corrupt: number;
  /** True when the canonical `*.current.json` was rewritten by this call. */
  readonly wroteCurrent: boolean;
  /** Whether the source ledger(s) were present on disk. */
  readonly ledgerPresent: boolean;
  /** Repair-specific freshness tag (see {@link RepairFreshness}). */
  readonly freshness: RepairFreshness;
  /**
   * Aggregate spool drain report produced before any ledger read. Present
   * whenever the caller went through `repairLedger` directly (a single
   * up-front drain across all 5 spool ledgers) or through `repairAllLedgers`
   * (one shared report attached to every per-target result so each row tells
   * the same story). Undefined is reserved for future internal callers that
   * may want to skip the drain explicitly; the public entry points always
   * populate it.
   */
  readonly spoolReport?: DrainReport;
}

export interface RepairLedgerOptions {
  readonly projectRoot: string;
  readonly target: RepairTarget;
  /**
   * Reference timestamp in milliseconds. Defaults to `Date.now()`. Tests and
   * deterministic callers can pin this so age-based folds (sessions,
   * scoreboard) produce stable output.
   */
  readonly nowMs?: number;
  /**
   * Override for the `withFileLock` stale-after-MS threshold. Forwarded
   * verbatim to the storage primitive. Defaults to the storage primitive's
   * own default (10 minutes).
   */
  readonly staleAfterMs?: number;
}

/**
 * Internal options bag the public entry points forward to the per-target
 * implementations. `spoolReport`, when set, is the drain report the caller
 * has already produced (so this call does NOT drain again). When unset, the
 * dispatcher drains up-front and attaches the report to the result.
 *
 * Not exported: callers should always go through `repairLedger` or
 * `repairAllLedgers` so the drain-before-rebuild invariant cannot be bypassed
 * by accident.
 */
interface RepairLedgerInternalOptions extends RepairLedgerOptions {
  readonly spoolReport?: DrainReport;
}

/**
 * Rebuild a single `*.current.json` from its canonical `*.jsonl` ledger.
 *
 * Steps:
 *   1. Drain every canonical spool ledger via `drainSpool` so any event
 *      previously written to spool (recorder lost the ledger lock) is folded
 *      into the rebuild. The drainer releases its own locks before returning.
 *   2. Acquire the ledger's exclusive lock (`<ledgerPath>.lock`). Scoreboard
 *      acquires presence-then-calls in a fixed order.
 *   3. Read the ledger via `readJsonl` (bounded, symlink-safe).
 *   4. Fold the raw rows via the corresponding collector's `foldXxx` helper
 *      so the produced shape matches the collector exactly.
 *   5. Write the materialized summary via `writeJsonFile` (atomic + symlink-
 *      safe + 0600 mode).
 *
 * Tolerates missing ledgers (writes an empty collector summary; marks
 * freshness as `absent`). Tolerates corrupt rows (counted on
 * `RepairResult.corrupt`). Throws only when the lock is contended past its
 * stale threshold OR when the storage primitives reject a symlinked path.
 */
export async function repairLedger(opts: RepairLedgerOptions): Promise<RepairResult> {
  if (!opts || typeof opts.projectRoot !== 'string' || opts.projectRoot.length === 0) {
    throw new TypeError('repairLedger: projectRoot must be a non-empty string');
  }
  if (!REPAIR_TARGETS.includes(opts.target)) {
    // Defensive: the type system guards this, but tests can pass unknown
    // strings through a `RepairTarget` cast and we want a typed error.
    throw new TypeError(`repairLedger: unknown target "${String(opts.target)}"`);
  }
  // Phase 3 binding: drain the spool BEFORE any ledger read. The drainer
  // surfaces a thrown `StatuslineStoragePathError` if `.hive-flow/spool` is a
  // symlink — we propagate it (mirrors how the rest of the repair path
  // propagates symlink rejections from storage primitives). The drainer
  // returns even when individual ledger drains fail (per-entry restore), so
  // a contended spool lock for one ledger never blocks the rebuild of a
  // different one.
  const spoolReport = await drainSpool({ projectRoot: opts.projectRoot });
  const dispatchOpts: RepairLedgerInternalOptions = { ...opts, spoolReport };
  switch (opts.target) {
    case 'sessions':
      return repairSessions(dispatchOpts);
    case 'scoreboard':
      return repairScoreboard(dispatchOpts);
    case 'tests':
      return repairTests(dispatchOpts);
    case 'attention':
      return repairAttention(dispatchOpts);
  }
}

/**
 * Repair every canonical target in {@link REPAIR_TARGETS} declaration order.
 * Failures in one target never block the others: each repair runs sequentially
 * so a contended lock or a symlinked ledger on (e.g.) `tests` does not stop
 * `sessions` from rebuilding. The returned array preserves declaration order
 * and contains one row per target.
 *
 * The spool is drained EXACTLY ONCE at the start of the call. The shared
 * `DrainReport` is attached to every per-target result so callers can see the
 * full drain outcome regardless of which target they inspect. Per-target
 * subcalls receive the shared report and skip their own drain — running the
 * drainer four times in a row would still be idempotent (compound/single
 * dedupe collapses replays) but it would waste FS work and produce four
 * stale `recovered`/`drained` counts that obscure the actual drain history.
 */
export async function repairAllLedgers(
  projectRoot: string,
  opts: { readonly nowMs?: number; readonly staleAfterMs?: number } = {},
): Promise<ReadonlyArray<RepairResult>> {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('repairAllLedgers: projectRoot must be a non-empty string');
  }
  // Single up-front drain shared across every per-target rebuild.
  const spoolReport = await drainSpool({ projectRoot });
  const out: RepairResult[] = [];
  for (const target of REPAIR_TARGETS) {
    const single: RepairLedgerInternalOptions = {
      projectRoot,
      target,
      spoolReport,
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
      ...(opts.staleAfterMs !== undefined ? { staleAfterMs: opts.staleAfterMs } : {}),
    };
    out.push(await repairLedgerInternal(single));
  }
  return Object.freeze(out);
}

/**
 * Internal dispatcher used by `repairAllLedgers`. Identical to the public
 * `repairLedger` except it does NOT drain — the caller has already drained
 * once for the whole batch and is passing the shared report through. Keeping
 * this private prevents external callers from bypassing the drain by
 * constructing their own report.
 */
async function repairLedgerInternal(
  opts: RepairLedgerInternalOptions,
): Promise<RepairResult> {
  switch (opts.target) {
    case 'sessions':
      return repairSessions(opts);
    case 'scoreboard':
      return repairScoreboard(opts);
    case 'tests':
      return repairTests(opts);
    case 'attention':
      return repairAttention(opts);
  }
}

// ---------------------------------------------------------------------------
// Per-target implementations
// ---------------------------------------------------------------------------

/**
 * Wrap a per-target rebuild in the canonical ledger lock. Throws when the
 * lock cannot be acquired (contended past stale threshold). The runbook's
 * `compactJsonl` (Phase 13.3) uses the same fail-loud semantics so operators
 * see lock contention as a clear error rather than silent partial repair.
 */
async function withTargetLock<T>(
  lockPath: string,
  staleAfterMs: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const lockOptions = staleAfterMs !== undefined ? { staleAfterMs } : {};
  const result = await withFileLock(lockPath, fn, lockOptions);
  if (!result.acquired) {
    throw new Error(`repairLedger: ledger is locked: ${lockPath}`);
  }
  return result.result;
}

/** Ensure the parent directory exists before `atomicWriteJson` lands there. */
async function ensureParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function repairSessions(opts: RepairLedgerInternalOptions): Promise<RepairResult> {
  const paths = statuslinePaths(opts.projectRoot);
  const nowMs = resolveNowMs(opts.nowMs);
  const observedAt = new Date(nowMs).toISOString();

  return withTargetLock(`${paths.sessionsLedger}.lock`, opts.staleAfterMs, async () => {
    const ledgerPresent = await ledgerExists(paths.sessionsLedger);
    if (!ledgerPresent) {
      // Empty collector summary keeps the renderer happy on a cold project.
      // `foldSessions` with no events returns the canonical "no live sessions"
      // skeleton, which is the same shape the collector emits when the ledger
      // is absent.
      const summary = foldSessions([], { nowMs, observedAt, priorCorrupt: 0 });
      await ensureParent(paths.sessionsCurrent);
      await atomicWriteJson(paths.sessionsCurrent, summary);
      return {
        target: 'sessions',
        read: 0,
        corrupt: 0,
        wroteCurrent: true,
        ledgerPresent: false,
        freshness: {
          state: 'absent',
          observedAt,
          reason: 'sessions ledger not found',
        },
        ...(opts.spoolReport !== undefined ? { spoolReport: opts.spoolReport } : {}),
      };
    }

    const { events, corrupt } = await readJsonl<unknown>(paths.sessionsLedger);
    const summary = foldSessions(events, { nowMs, observedAt, priorCorrupt: corrupt });
    await ensureParent(paths.sessionsCurrent);
    await atomicWriteJson(paths.sessionsCurrent, summary);
    // `RepairResult.corrupt` reflects the JSON-parse corrupt count. Schema-
    // rejection counts are surfaced through `summary.freshness.reason` so the
    // renderer can flag them downstream; we do not re-narrow events here to
    // keep the type-guard logic centralized in `foldSessions`.
    return {
      target: 'sessions',
      read: events.length,
      corrupt,
      wroteCurrent: true,
      ledgerPresent: true,
      freshness: summary.freshness,
      ...(opts.spoolReport !== undefined ? { spoolReport: opts.spoolReport } : {}),
    };
  });
}

async function repairScoreboard(opts: RepairLedgerInternalOptions): Promise<RepairResult> {
  const paths = statuslinePaths(opts.projectRoot);
  const nowMs = resolveNowMs(opts.nowMs);
  const observedAt = new Date(nowMs).toISOString();

  // Scoreboard acquires BOTH ledger locks (presence first, then calls) in a
  // fixed order. Without a global ordering, two concurrent scoreboard repairs
  // could deadlock: one holding presence and waiting on calls, the other
  // holding calls and waiting on presence.
  return withTargetLock(`${paths.scoreboardPresenceLedger}.lock`, opts.staleAfterMs, () =>
    withTargetLock(`${paths.scoreboardCallsLedger}.lock`, opts.staleAfterMs, async () => {
      const [presencePresent, callsPresent] = await Promise.all([
        ledgerExists(paths.scoreboardPresenceLedger),
        ledgerExists(paths.scoreboardCallsLedger),
      ]);
      const ledgerPresent = presencePresent || callsPresent;

      if (!ledgerPresent) {
        const summary: ScoreboardSummary = foldScoreboard([], [], {
          now: nowMs,
          presenceCorrupt: 0,
          callsCorrupt: 0,
        });
        await ensureParent(paths.scoreboardCurrent);
        await atomicWriteJson(paths.scoreboardCurrent, summary);
        return {
          target: 'scoreboard',
          read: 0,
          corrupt: 0,
          wroteCurrent: true,
          ledgerPresent: false,
          freshness: {
            state: 'absent',
            observedAt,
            reason: 'scoreboard ledgers not found',
          },
          ...(opts.spoolReport !== undefined ? { spoolReport: opts.spoolReport } : {}),
        };
      }

      const [presence, calls] = await Promise.all([
        readJsonl<unknown>(paths.scoreboardPresenceLedger),
        readJsonl<unknown>(paths.scoreboardCallsLedger),
      ]);
      // Repair MUST rebuild from ledgers only — the legacy migration is
      // intentionally NOT applied here (runbook line 5878).
      const summary = foldScoreboard(presence.events, calls.events, {
        now: nowMs,
        presenceCorrupt: presence.corrupt,
        callsCorrupt: calls.corrupt,
      });
      await ensureParent(paths.scoreboardCurrent);
      await atomicWriteJson(paths.scoreboardCurrent, summary);

      const totalCorrupt = presence.corrupt + calls.corrupt;
      const totalRead = presence.events.length + calls.events.length;
      const state: RepairFreshnessState = summary.stale ? 'stale' : 'fresh';
      const reasonParts: string[] = [];
      if (totalCorrupt > 0) {
        reasonParts.push(
          `skipped ${totalCorrupt} corrupt scoreboard row${totalCorrupt === 1 ? '' : 's'}`,
        );
      }
      if (summary.stale && totalCorrupt === 0) {
        reasonParts.push('no recent scoreboard events');
      }
      return {
        target: 'scoreboard',
        read: totalRead,
        corrupt: totalCorrupt,
        wroteCurrent: true,
        ledgerPresent: true,
        freshness: {
          state,
          observedAt,
          ...(reasonParts.length > 0 ? { reason: reasonParts.join('; ') } : {}),
        },
        ...(opts.spoolReport !== undefined ? { spoolReport: opts.spoolReport } : {}),
      };
    }),
  );
}

async function repairTests(opts: RepairLedgerInternalOptions): Promise<RepairResult> {
  const paths = statuslinePaths(opts.projectRoot);
  const nowMs = resolveNowMs(opts.nowMs);
  const observedAt = new Date(nowMs).toISOString();

  return withTargetLock(`${paths.testsLedger}.lock`, opts.staleAfterMs, async () => {
    const ledgerPresent = await ledgerExists(paths.testsLedger);
    if (!ledgerPresent) {
      const summary: TestsSummary = foldTests([]);
      await ensureParent(paths.testsCurrent);
      await atomicWriteJson(paths.testsCurrent, summary);
      return {
        target: 'tests',
        read: 0,
        corrupt: 0,
        wroteCurrent: true,
        ledgerPresent: false,
        freshness: {
          state: 'absent',
          observedAt,
          reason: 'tests ledger not found',
        },
        ...(opts.spoolReport !== undefined ? { spoolReport: opts.spoolReport } : {}),
      };
    }

    const { events, corrupt } = await readJsonl<unknown>(paths.testsLedger);
    const summary = foldTests(events);
    await ensureParent(paths.testsCurrent);
    await atomicWriteJson(paths.testsCurrent, summary);

    // Sidecar materializations (current-suite + latest-partial) — per the
    // runbook's Phase 13 example. These are best-effort: failure to write
    // them does not bubble up because the canonical `tests/current.json`
    // is the renderer's source of truth.
    if (summary.suite !== undefined) {
      await ensureParent(paths.testsCurrentSuite);
      await atomicWriteJson(paths.testsCurrentSuite, summary.suite);
    }
    if (summary.latestPartial !== undefined) {
      await ensureParent(paths.testsLatestPartial);
      await atomicWriteJson(paths.testsLatestPartial, summary.latestPartial);
    }

    const reason =
      corrupt > 0
        ? `skipped ${corrupt} corrupt test row${corrupt === 1 ? '' : 's'}`
        : undefined;
    return {
      target: 'tests',
      read: events.length,
      corrupt,
      wroteCurrent: true,
      ledgerPresent: true,
      freshness: {
        state: corrupt > 0 ? 'degraded' : 'fresh',
        observedAt,
        ...(reason !== undefined ? { reason } : {}),
      },
      ...(opts.spoolReport !== undefined ? { spoolReport: opts.spoolReport } : {}),
    };
  });
}

async function repairAttention(opts: RepairLedgerInternalOptions): Promise<RepairResult> {
  const paths = statuslinePaths(opts.projectRoot);
  const nowMs = resolveNowMs(opts.nowMs);
  const observedAt = new Date(nowMs).toISOString();

  return withTargetLock(`${paths.attentionLedger}.lock`, opts.staleAfterMs, async () => {
    const ledgerPresent = await ledgerExists(paths.attentionLedger);
    if (!ledgerPresent) {
      const summary: AttentionSummary = foldAttention([], { nowMs });
      await ensureParent(paths.attentionCurrent);
      await atomicWriteJson(paths.attentionCurrent, summary);
      return {
        target: 'attention',
        read: 0,
        corrupt: 0,
        wroteCurrent: true,
        ledgerPresent: false,
        freshness: {
          state: 'absent',
          observedAt,
          reason: 'attention ledger not found',
        },
        ...(opts.spoolReport !== undefined ? { spoolReport: opts.spoolReport } : {}),
      };
    }

    const { events, corrupt } = await readJsonl<unknown>(paths.attentionLedger);
    const summary = foldAttention(events, { nowMs });
    await ensureParent(paths.attentionCurrent);
    await atomicWriteJson(paths.attentionCurrent, summary);

    const reason =
      corrupt > 0
        ? `skipped ${corrupt} corrupt attention row${corrupt === 1 ? '' : 's'}`
        : undefined;
    return {
      target: 'attention',
      read: events.length,
      corrupt,
      wroteCurrent: true,
      ledgerPresent: true,
      freshness: {
        state: corrupt > 0 ? 'degraded' : 'fresh',
        observedAt,
        ...(reason !== undefined ? { reason } : {}),
      },
      ...(opts.spoolReport !== undefined ? { spoolReport: opts.spoolReport } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveNowMs(raw: number | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return Date.now();
}

/**
 * Cheap existence probe. Tolerates every error mode (ENOENT, EACCES, symlink)
 * by returning `false` so the caller treats the ledger as absent and writes a
 * fresh empty summary. The storage primitives still apply their own
 * symlink-safety walks on every read/write — this helper is only used to
 * decide which RepairResult branch to take.
 */
async function ledgerExists(filePath: string): Promise<boolean> {
  try {
    const st = await lstat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Re-exports for ergonomic CLI wiring (Phase 13.1)
// ---------------------------------------------------------------------------
//
// The CLI surfaces (`statusline refresh --repair`, `statusline repair`) land in
// a later wave. They import the fold helpers and the collectors via these
// re-exports so call sites do not need to know whether they want the live read
// path (`collectXxx`) or the rebuild path (`foldXxx`).

export { collectAttention, collectScoreboard, collectSessions, collectTests };
export { foldAttention, foldScoreboard, foldSessions, foldTests };
