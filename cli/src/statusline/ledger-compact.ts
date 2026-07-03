// cli/src/statusline/ledger-compact.ts
//
// Phase 13.3 of the statusline rewrite. Truncate a JSONL ledger to the most
// recent N valid events under an exclusive lock, preserving the newest state
// while bounding disk usage.
//
// Design constraints (from the canonical runbook + Phase 5 patches):
//   - Reads are bounded and symlink-safe via `readJsonl` (Wave 2.5A primitive
//     in `storage.ts`). Corrupt or oversized lines are dropped silently and
//     counted in `skipped`.
//   - Lock acquisition uses the same `withFileLock` primitive recorders use
//     for appends, so concurrent compaction and append cannot interleave.
//   - The rewrite goes through `atomicWrite` (tmp -> fsync -> rename) so a
//     mid-rewrite crash can never leave the ledger in a partial state.
//   - No-op fast path: when no truncation is required AND no corrupt lines
//     are present, the ledger is left untouched (preserves mtime, avoids
//     unnecessary disk churn). The runbook contract calls this state
//     `wroteCurrent: false`.
//   - Compaction does NOT rebuild the `*.current.json` materialized views;
//     that is the repair module's job. Callers needing both call
//     `compactLedger` THEN `repairLedger`.
//   - `compactAllLedgers` isolates per-ledger failures: a bad ledger returns
//     an error result for that target and the remaining ledgers still run.
//
// Public API:
//   - `compactLedger({ projectRoot, target, keep })` -- canonical statusline
//     interface; validates `target` against the frozen `SPOOL_LEDGER_NAMES`
//     set and resolves the canonical ledger path internally.
//   - `compactAllLedgers(projectRoot, keep)` -- sequentially compacts every
//     ledger in `SPOOL_LEDGER_NAMES`. Sequential because filesystem ops do
//     not benefit from parallelism here and a single failure should not
//     abort the others.
//   - `compactJsonl(filePath, keep)` -- lower-level variant used by command
//     wiring that already holds a resolved path. Internal callers should
//     prefer `compactLedger`.

import { chmod, stat } from 'node:fs/promises';
import { atomicWrite } from '../integrations/atomic-merge.js';
import {
  StatuslineSpoolLedgerNameError,
  readJsonl,
  withFileLock,
} from './storage.js';
import {
  SPOOL_LEDGER_NAMES,
  statuslinePaths,
  type SpoolLedgerName,
} from './paths.js';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown synchronously when `keep` is not a positive integer. Carries the
 * rejected value so diagnostic logs can surface it.
 */
export class StatuslineCompactKeepError extends Error {
  readonly code = 'STATUSLINE_COMPACT_KEEP';
  readonly rejected: number;
  constructor(rejected: number) {
    super(`compactLedger: --keep must be a positive integer (received ${rejected})`);
    this.name = 'StatuslineCompactKeepError';
    this.rejected = rejected;
  }
}

/**
 * Thrown when the ledger lock is held by a live owner. The compact path
 * refuses to fall back to spooling (compaction is a maintenance operation,
 * not an append) so a contended lock surfaces as an actionable error.
 */
export class StatuslineCompactLockError extends Error {
  readonly code = 'STATUSLINE_COMPACT_LOCK';
  constructor(filePath: string) {
    super(`compactLedger: ledger is locked: ${filePath}`);
    this.name = 'StatuslineCompactLockError';
  }
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface CompactResult {
  /** The ledger that was compacted. For `compactJsonl`, this is the leaf
   *  basename of the file path; for `compactLedger`, the canonical spool
   *  ledger name. */
  readonly target: SpoolLedgerName | string;
  /** Number of valid (parseable, within size limits) lines present before
   *  compaction. */
  readonly before: number;
  /** Number of valid lines remaining after compaction. */
  readonly after: number;
  /** Number of corrupt (unparseable or oversized) lines dropped. */
  readonly skipped: number;
  /** True when the ledger file was actually rewritten. False on the no-op
   *  fast path (already at or under `keep` and no corrupt lines). */
  readonly wroteCurrent: boolean;
  /** Present on `compactAllLedgers` per-target failures. */
  readonly error?: true;
  /** Error message for a per-target `compactAllLedgers` failure. */
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `target` is one of the canonical spool ledger identifiers.
 * Re-uses the typed error from `storage.ts` so a malformed name surfaces the
 * same diagnostic regardless of which entrypoint detects it. The check
 * happens BEFORE any filesystem operation; the frozen-set comparison
 * rejects `..`, separators, null bytes, casing variants, and any unknown
 * identifier in a single step.
 */
function assertTargetIsCanonical(target: string): asserts target is SpoolLedgerName {
  if (typeof target !== 'string') {
    throw new StatuslineSpoolLedgerNameError(String(target));
  }
  if (!(SPOOL_LEDGER_NAMES as ReadonlyArray<string>).includes(target)) {
    throw new StatuslineSpoolLedgerNameError(target);
  }
}

/**
 * Validate that `keep` is a positive integer. We reject zero, negative
 * numbers, fractional values, and non-finite values (NaN/Infinity) because
 * each would either lose every event or write an unbounded file.
 */
function assertKeepIsPositiveInteger(keep: number): void {
  if (typeof keep !== 'number' || !Number.isFinite(keep) || !Number.isInteger(keep) || keep < 1) {
    throw new StatuslineCompactKeepError(keep);
  }
}

/**
 * Map a canonical spool ledger name to its on-disk ledger path. Pure; no
 * I/O. Mirrors the drainer's `ledgerPathFor` so a future refactor can
 * unify both behind a single lookup if needed. We re-implement here to
 * avoid importing from `spool-drainer.ts`, which would create a cycle.
 */
function ledgerPathForTarget(projectRoot: string, target: SpoolLedgerName): string {
  const paths = statuslinePaths(projectRoot);
  switch (target) {
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
 * Inner compaction routine, shared by `compactLedger` and `compactJsonl`.
 * Acquires the ledger lock, parses every line, drops corrupt lines, retains
 * the last `keep` valid lines, and (when truncation is actually required)
 * rewrites the ledger atomically. The `targetLabel` is opaque to this
 * function -- it flows through to the result for diagnostic purposes.
 */
async function compactLedgerFile(
  ledgerPath: string,
  keep: number,
  targetLabel: string,
): Promise<CompactResult> {
  // Fast path for a missing ledger: do not even attempt the lock. `readJsonl`
  // would also return `{ events: [], corrupt: 0 }` here but skipping the lock
  // avoids creating a `.lock` file beside a nonexistent ledger -- compaction
  // of a missing file should leave the filesystem untouched.
  try {
    await stat(ledgerPath);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') {
      return Object.freeze({
        target: targetLabel,
        before: 0,
        after: 0,
        skipped: 0,
        wroteCurrent: false,
      });
    }
    // Any other stat error (EACCES/EIO/etc.) propagates -- the lock attempt
    // would observe the same condition and silently spool. Compaction is a
    // maintenance op; visible failure is preferable to a silent skip.
    throw error;
  }

  const locked = await withFileLock<CompactResult>(`${ledgerPath}.lock`, async () => {
    // readJsonl enforces the bounded byte cap and the symlink rejection
    // through assertSafeStatuslineStoragePath. We deliberately do NOT
    // pass a custom `maxBytes` so the same caps that govern the recorder
    // appends also govern the compactor view of the ledger.
    const parsed = await readJsonl<unknown>(ledgerPath);
    const valid: unknown[] = parsed.events;
    const skipped = parsed.corrupt;
    const before = valid.length;

    // No-op fast path: nothing to drop and already at or below the cap.
    // Preserving mtime is intentional -- a no-op compaction should not
    // disturb watchers keyed on the ledger mtime.
    //
    // Privacy hardening: tighten the ledger to 0o600 even on the no-op
    // path so a pre-existing loose-mode ledger (e.g. created by a
    // recorder that did not chmod, or by an external migration) is
    // brought back to the same private mode the rewrite path enforces
    // just below via the post-atomicWrite chmod. This keeps compaction's
    // permission-tightening behaviour uniform regardless of whether a
    // truncation was needed.
    // `chmod` is awaited so the result accurately reflects the final
    // on-disk mode; `.catch(() => undefined)` defends against a
    // late-disappearing file (the missing-ledger ENOENT fast path above
    // should already short-circuit, but defence-in-depth is cheap).
    // chmod updates inode metadata only, not mtime, so the mtime
    // invariant the surrounding test contract depends on is preserved.
    if (skipped === 0 && before <= keep) {
      await chmod(ledgerPath, 0o600).catch(() => undefined);
      return Object.freeze({
        target: targetLabel,
        before,
        after: before,
        skipped: 0,
        wroteCurrent: false,
      });
    }

    // Truncation path: keep the last `keep` valid events. JSON.stringify
    // is deterministic per-value (and re-serializes from the parsed
    // structure, dropping any trailing whitespace the recorder may have
    // emitted). Joining with '\n' and appending a terminating newline
    // matches the recorder's own append shape so a follow-up readJsonl
    // sees no behavioural difference.
    const kept = valid.slice(-keep);
    const body = kept.length === 0 ? '' : kept.map((event) => JSON.stringify(event)).join('\n') + '\n';

    // atomicWrite goes tmp -> fsync -> rename. A crash between any two
    // steps leaves either the pre-existing ledger (if rename has not
    // committed) or the new ledger (after rename) -- never a partial
    // file. The 0o600 mode is only applied by atomicWrite to NEW files;
    // an existing ledger keeps its prior mode. We tighten explicitly
    // afterward so a loose-mode ledger (e.g. one pre-existing from a
    // recorder that did not chmod) is brought back to 0o600 -- this
    // matches the recorder's own `chmod(..., 0o600)` after every append
    // and keeps the statusline storage surface uniformly private.
    await atomicWrite(ledgerPath, body, { mode: 0o600, fsync: true });
    await chmod(ledgerPath, 0o600).catch(() => undefined);

    return Object.freeze({
      target: targetLabel,
      before,
      after: kept.length,
      skipped,
      wroteCurrent: true,
    });
  });

  if (!locked.acquired) {
    throw new StatuslineCompactLockError(ledgerPath);
  }
  return locked.result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompactLedgerOptions {
  /** Absolute path to the project root (the directory containing
   *  `.hive-flow/`). */
  projectRoot: string;
  /** Canonical ledger identifier from `SPOOL_LEDGER_NAMES`. */
  target: SpoolLedgerName;
  /** Maximum number of most-recent valid lines to keep. Must be >= 1. */
  keep: number;
}

/**
 * Compact a canonical statusline ledger to its most recent `keep` valid
 * events. Validates `target` and `keep` BEFORE touching the filesystem so
 * malformed callers fail loud and early. Locks the ledger for the duration
 * of the rewrite and uses an atomic write so a crash mid-rewrite cannot
 * corrupt the ledger.
 *
 * Returns the before/after counts plus a `skipped` count for any corrupt
 * (unparseable or oversized) lines that were dropped. When the ledger
 * already satisfies the `keep` bound and has no corruption, returns the
 * no-op result `{ before, after: before, skipped: 0, wroteCurrent: false }`
 * without rewriting the file (mtime preserved).
 *
 * Errors:
 *   - `StatuslineCompactKeepError` -- `keep < 1` or non-integer.
 *   - `StatuslineSpoolLedgerNameError` -- `target` not in `SPOOL_LEDGER_NAMES`.
 *   - `StatuslineStoragePathError` -- ledger or any `.hive-flow/` parent is
 *     a symbolic link (propagated from `readJsonl` / `atomicWrite`).
 *   - `StatuslineCompactLockError` -- another live owner holds the ledger
 *     lock and cannot be evicted within the stale-lock window.
 */
export async function compactLedger(opts: CompactLedgerOptions): Promise<CompactResult> {
  assertKeepIsPositiveInteger(opts.keep);
  assertTargetIsCanonical(opts.target);
  const ledgerPath = ledgerPathForTarget(opts.projectRoot, opts.target);
  return compactLedgerFile(ledgerPath, opts.keep, opts.target);
}

/**
 * Compact every canonical statusline ledger in `SPOOL_LEDGER_NAMES`, in
 * declaration order. Sequential (not parallel) because filesystem ops do
 * not benefit from concurrency at this scale. Each ledger's result is
 * independent: one symlinked/locked/unreadable ledger returns an error result
 * for that target, and the remaining ledgers still compact.
 *
 * The optional helper is provided per the runbook so a `--all` command
 * flag can be wired without each call site reproducing the loop.
 */
export async function compactAllLedgers(
  projectRoot: string,
  keep: number,
): Promise<ReadonlyArray<CompactResult>> {
  assertKeepIsPositiveInteger(keep);
  const results: CompactResult[] = [];
  for (const target of SPOOL_LEDGER_NAMES) {
    // Each call validates `target` (redundantly here since the source is the
    // canonical set, but the cost is negligible and the consistency is
    // valuable for refactors).
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential
    try {
      const result = await compactLedger({ projectRoot, target, keep });
      results.push(result);
    } catch (error: unknown) {
      results.push(Object.freeze({
        target,
        before: 0,
        after: 0,
        skipped: 0,
        wroteCurrent: false,
        error: true,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }));
    }
  }
  return Object.freeze(results);
}

/**
 * Lower-level compaction variant accepting a fully-resolved file path.
 * Used by command wiring that already owns a path (e.g. when compacting a
 * non-canonical ledger or a path obtained through configuration). Internal
 * callers should prefer `compactLedger` so the canonical name check is in
 * effect.
 *
 * `filePath` must not point through a symbolic link under `.hive-flow/`;
 * the underlying `readJsonl` / `atomicWrite` primitives propagate
 * `StatuslineStoragePathError` for that case.
 */
export async function compactJsonl(filePath: string, keep: number): Promise<CompactResult> {
  assertKeepIsPositiveInteger(keep);
  if (typeof filePath !== 'string' || filePath.length === 0) {
    // Surface the misuse as a typed error rather than a downstream `ENOENT`
    // or `lstat` failure so the caller sees the API misuse directly.
    throw new TypeError('compactJsonl: filePath must be a non-empty string');
  }
  // Derive a stable label for the result -- the last path segment is a
  // reasonable diagnostic stand-in when no canonical name is available.
  const label = filePath.replace(/.*[\\/]/, '');
  return compactLedgerFile(filePath, keep, label || filePath);
}

// ---------------------------------------------------------------------------
// Re-exports for ergonomics
// ---------------------------------------------------------------------------

export { SPOOL_LEDGER_NAMES } from './paths.js';
export type { SpoolLedgerName } from './paths.js';
export { StatuslineSpoolLedgerNameError } from './storage.js';
