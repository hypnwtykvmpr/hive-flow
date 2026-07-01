// v3/@hive-flow/cli/src/statusline/spool-drainer.ts
//
// Phase 5.7 of the canonical statusline runbook (Codex merged, 2026-05-21 patched).
//
// Drains per-ledger spool entries written when an `appendJsonlLocked` /
// `appendUniqueJsonlLocked` call could not acquire the ledger lock. The
// refresher is required to call `drainSpool` before rebuilding any snapshot
// derived from a ledger, so a spooled event never sits behind a snapshot.
//
// Binding constraints:
//   - Iterate only the closed `SPOOL_LEDGER_NAMES` set (no caller-supplied
//     ledger identifier reaches a path operation).
//   - Recover stale `*.json.processing-*` files first via
//     `recoverStaleProcessingSpool` so a crashed prior drainer cannot
//     deadlock a queue.
//   - Use the storage primitives' compound dedupe (`['eventId', 'event']`)
//     for `scoreboard-calls` so a `call-start` and `call-complete` pair with
//     the same eventId are NOT collapsed into a single row. Single-key
//     `'eventId'` dedupe is used for every other ledger. This is the Codex
//     round-5 binding (see `Claude-vs-Codex-runbook-round5-review-2026-05-20.md`
//     §1 row "Spool replay" and the C1 patch which the storage primitives
//     have already adopted via the `ReadonlyArray<keyof T>` overload).
//   - On successful append (`written: true` OR `duplicate: true`) the spool
//     entry is deleted. On lock contention (`spooled: true`) the entry is
//     restored to its original name so the next drain pass retries it.
//   - Re-drains are idempotent because compound/single dedupe in the storage
//     primitive silently drops events already in the ledger.
//   - Symlink safety and ledger-name validation are enforced by the Wave 2.5A
//     storage primitives (`assertSafeStatuslineStoragePath`,
//     `assertValidSpoolLedgerName`); this module provides defense in depth by
//     never composing a ledger name from caller input — the set comes from
//     the frozen `SPOOL_LEDGER_NAMES` constant in `paths.ts`.

import {
  appendUniqueJsonlLocked,
  deleteSpoolEntry,
  readSpoolEntries,
  recoverStaleProcessingSpool,
  restoreSpoolEntry,
} from './storage.js';
import { SPOOL_LEDGER_NAMES, statuslinePaths } from './paths.js';
import type { SpoolLedgerName } from './paths.js';

// ---------------------------------------------------------------------------
// Per-ledger drain counters + aggregate report
// ---------------------------------------------------------------------------

/**
 * Per-ledger outcome of a single drain pass. `drained` counts entries that
 * were written to the canonical ledger; `deduped` counts entries dropped as
 * duplicates of a row already present in the ledger; `failed` counts entries
 * left for retry (lock contention or unexpected error). `recovered` reports
 * stale `*.processing-*` files that were reclaimed before draining began.
 */
export interface SpoolLedgerDrainCounts {
  readonly drained: number;
  readonly deduped: number;
  readonly failed: number;
  readonly recovered: number;
}

/**
 * Aggregate result of one `drainSpool` invocation. The per-ledger map is
 * keyed on the canonical `SpoolLedgerName` so a consumer (refresher,
 * `statusline doctor`) can branch on each row.
 */
export interface DrainReport {
  readonly ledgers: Readonly<Record<SpoolLedgerName, SpoolLedgerDrainCounts>>;
  readonly totals: SpoolLedgerDrainCounts;
}

export interface DrainSpoolOptions {
  /** Absolute project root containing `.hive-flow/`. Required. */
  readonly projectRoot: string;
  /**
   * Override for the stale-processing-file reclamation threshold. The default
   * (5 minutes) matches the storage primitive default. Tests stub a smaller
   * value to exercise crash recovery without sleeping.
   */
  readonly staleProcessingAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Ledger -> canonical ledger path mapping
// ---------------------------------------------------------------------------

/**
 * Compute the canonical ledger path for a given spool ledger name. Pure;
 * no I/O. Centralised so the drainer never hand-rolls a path expression.
 */
function ledgerPathFor(projectRoot: string, ledgerName: SpoolLedgerName): string {
  const paths = statuslinePaths(projectRoot);
  switch (ledgerName) {
    case 'tests':
      return paths.testsLedger;
    case 'sessions':
      return paths.sessionsLedger;
    case 'scoreboard-calls':
      return paths.scoreboardCallsLedger;
    case 'scoreboard-presence':
      return paths.scoreboardPresenceLedger;
    case 'attention':
      return paths.attentionLedger;
  }
}

/**
 * Compound dedupe key per Codex round-5 binding: scoreboard-calls dedupes on
 * `[eventId, event]` so `call-start` and `call-complete` with the same eventId
 * are preserved as separate rows. Every other ledger dedupes on a single
 * `eventId` field.
 */
const SCOREBOARD_CALLS_KEY = Object.freeze(['eventId', 'event'] as const);
const SINGLE_EVENT_ID_KEY = 'eventId' as const;

// ---------------------------------------------------------------------------
// Internal entry shape constraints
// ---------------------------------------------------------------------------

/**
 * Minimal type the drainer enforces on a spool entry before handing it to the
 * locked-append primitive. Recorders are responsible for richer validation
 * (suite vs partial test row, presence event shape, attention emit/resolve);
 * the drainer's contract is only that the entry is a JSON object so the
 * dedupe key fields can be projected without unsafe casts.
 *
 * `eventId` is the universal dedupe key required by the storage primitives.
 * `event` is required only for `scoreboard-calls` (the second key in the
 * compound dedupe). Other fields are tolerated and pass through untouched.
 */
interface SpoolEntryObject {
  readonly eventId?: unknown;
  readonly event?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Type guard for `SpoolEntryObject`. Refuses primitives, arrays, and `null`.
 * Refusal is a normal outcome — the drainer treats it as a `failed` row and
 * leaves the spool entry in place so a human operator can investigate (the
 * storage primitives quarantine corrupt JSON via a `.corrupt-<ts>` rename).
 */
function isSpoolEntryObject(value: unknown): value is SpoolEntryObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The drainer requires `eventId` to be a non-empty string so the dedupe key
 * is stable and meaningful. Without a usable eventId the storage primitive
 * would still write the event but a re-drain could never detect the
 * duplicate, so we treat the row as `failed` instead.
 */
function hasUsableEventId(entry: SpoolEntryObject): boolean {
  const id = entry.eventId;
  return typeof id === 'string' && id.length > 0;
}

/**
 * Scoreboard-calls requires both `eventId` and `event` to be non-empty
 * strings for the compound dedupe to be sound.
 */
function hasUsableCallKey(entry: SpoolEntryObject): boolean {
  if (!hasUsableEventId(entry)) return false;
  const event = entry.event;
  return typeof event === 'string' && event.length > 0;
}

// ---------------------------------------------------------------------------
// Single-ledger drain
// ---------------------------------------------------------------------------

/**
 * Drain a single ledger directory. Performs three steps:
 *   1. Recover any stale `*.processing-*` files from a prior crashed drainer.
 *   2. Claim every drainable entry via `readSpoolEntries` (which renames each
 *      to a unique `.processing-<pid>-<uuid>` so concurrent drainers cannot
 *      double-process).
 *   3. For each claimed entry, append to the canonical ledger via
 *      `appendUniqueJsonlLocked` with `spoolOnLockFailure: false` so a
 *      contended lock surfaces as `spooled: true` instead of writing back
 *      into the spool we are currently draining. On success/duplicate the
 *      claimed file is deleted; on contention the file is restored to its
 *      original name for the next drain pass.
 */
async function drainOneLedger(
  projectRoot: string,
  ledgerName: SpoolLedgerName,
  staleProcessingAfterMs: number,
): Promise<SpoolLedgerDrainCounts> {
  const paths = statuslinePaths(projectRoot);
  const ledgerPath = ledgerPathFor(projectRoot, ledgerName);

  // Step 1: reclaim stale processing files. The storage primitive already
  // validates `ledgerName` against the canonical set and walks
  // `assertSafeStatuslineStoragePath`; we propagate any symlink rejection or
  // canonical-set rejection up to the caller for the same reason every other
  // storage call does — symlinked spool trees are a hard structural failure,
  // not a transient drain outcome.
  const recovered = await recoverStaleProcessingSpool(
    paths.spoolRoot,
    ledgerName,
    staleProcessingAfterMs,
  );

  // Step 2: claim drainable entries. `readSpoolEntries` returns each claimed
  // file as `{ path, originalPath, event }`. Order is monotonic with mtime
  // because filenames are `<Date.now()>-<pid>-<uuid>.json`.
  const entries = await readSpoolEntries<unknown>(paths.spoolRoot, ledgerName);

  let drained = 0;
  let deduped = 0;
  let failed = 0;

  // Step 3: append each entry. We bail per-entry rather than per-batch so a
  // single bad row never blocks the rest of the queue.
  for (const entry of entries) {
    if (!isSpoolEntryObject(entry.event)) {
      // Cannot project a dedupe key from a non-object payload. Leave the
      // claim in place so a quarantine pass (or operator) can inspect it.
      await restoreSpoolEntry(entry.path, entry.originalPath);
      failed++;
      continue;
    }

    const dedupeable =
      ledgerName === 'scoreboard-calls'
        ? hasUsableCallKey(entry.event)
        : hasUsableEventId(entry.event);
    if (!dedupeable) {
      await restoreSpoolEntry(entry.path, entry.originalPath);
      failed++;
      continue;
    }

    try {
      // `uniqueField` accepts either a single key or a compound key. Storage's
      // `appendUniqueJsonlLocked` already supports both shapes per Wave 2.5C
      // and is the only correct dedupe source — re-implementing it here would
      // race a concurrent recorder. We pass `spoolOnLockFailure: false` so
      // a contended lock returns `spooled: true` instead of writing back into
      // the spool we are currently draining.
      const result =
        ledgerName === 'scoreboard-calls'
          ? await appendUniqueJsonlLocked<SpoolEntryObject>({
              ledgerPath,
              spoolRoot: paths.spoolRoot,
              ledgerName,
              event: entry.event,
              uniqueField: SCOREBOARD_CALLS_KEY,
              spoolOnLockFailure: false,
            })
          : await appendUniqueJsonlLocked<SpoolEntryObject>({
              ledgerPath,
              spoolRoot: paths.spoolRoot,
              ledgerName,
              event: entry.event,
              uniqueField: SINGLE_EVENT_ID_KEY,
              spoolOnLockFailure: false,
            });

      if (result.written) {
        await deleteSpoolEntry(entry.path);
        drained++;
        continue;
      }
      if (result.duplicate) {
        // Already in the ledger from a prior drain or a successful direct
        // recorder write. Idempotent replay outcome — drop the spool copy.
        await deleteSpoolEntry(entry.path);
        deduped++;
        continue;
      }
      // result.spooled is false (we set spoolOnLockFailure: false) and
      // result.written is false => lock was contended. Restore the claim so
      // the next pass retries.
      await restoreSpoolEntry(entry.path, entry.originalPath);
      failed++;
    } catch {
      // Any unexpected error from the append (symlinked ledger surface,
      // oversize event, FS error) must restore the claim so the entry is
      // never silently lost. The storage primitives quarantine truly corrupt
      // entries with a `.corrupt-<ts>` rename; here we just preserve the
      // original spool file for the next pass.
      await restoreSpoolEntry(entry.path, entry.originalPath);
      failed++;
    }
  }

  return Object.freeze({ drained, deduped, failed, recovered });
}

// ---------------------------------------------------------------------------
// Aggregate drain
// ---------------------------------------------------------------------------

const ZERO_COUNTS: SpoolLedgerDrainCounts = Object.freeze({
  drained: 0,
  deduped: 0,
  failed: 0,
  recovered: 0,
});

function emptyLedgerMap(): Record<SpoolLedgerName, SpoolLedgerDrainCounts> {
  // Construct directly via the canonical-set tuple so TypeScript narrows the
  // resulting type to `Record<SpoolLedgerName, SpoolLedgerDrainCounts>`
  // without a runtime cast. Object spreads over `SPOOL_LEDGER_NAMES` would
  // need a cast; an explicit object literal does not. Each entry is the
  // shared frozen `ZERO_COUNTS` so the caller observes immutable initial
  // rows that will be replaced wholesale by `drainOneLedger` per ledger.
  return {
    tests: ZERO_COUNTS,
    sessions: ZERO_COUNTS,
    'scoreboard-calls': ZERO_COUNTS,
    'scoreboard-presence': ZERO_COUNTS,
    attention: ZERO_COUNTS,
  };
}

/**
 * Drain every canonical spool ledger in declaration order. Failures in one
 * ledger never block the others — each ledger drain is awaited sequentially
 * so a contended lock or symlink rejection on (e.g.) `tests` does not stop
 * `sessions` from making progress. Sequential (not parallel) iteration is
 * deliberate: parallel drains across ledgers do not race (different lock
 * paths), but ordering matters for diagnostics and for the refresher's
 * snapshot rebuild which expects a deterministic per-ledger report.
 *
 * Returns a `DrainReport` with per-ledger counts and an aggregate total.
 * Re-drains are idempotent because the storage primitive's dedupe silently
 * drops events already in the ledger.
 */
export async function drainSpool(opts: DrainSpoolOptions): Promise<DrainReport> {
  if (!opts || typeof opts.projectRoot !== 'string' || opts.projectRoot.length === 0) {
    throw new TypeError('drainSpool: projectRoot must be a non-empty string');
  }
  const staleProcessingAfterMs = opts.staleProcessingAfterMs ?? 5 * 60 * 1000;

  const ledgers = emptyLedgerMap();
  let drained = 0;
  let deduped = 0;
  let failed = 0;
  let recovered = 0;

  for (const name of SPOOL_LEDGER_NAMES) {
    const counts = await drainOneLedger(opts.projectRoot, name, staleProcessingAfterMs);
    ledgers[name] = counts;
    drained += counts.drained;
    deduped += counts.deduped;
    failed += counts.failed;
    recovered += counts.recovered;
  }

  return Object.freeze({
    ledgers: Object.freeze(ledgers),
    totals: Object.freeze({ drained, deduped, failed, recovered }),
  });
}
