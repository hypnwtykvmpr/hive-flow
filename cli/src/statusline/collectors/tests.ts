// cli/src/statusline/collectors/tests.ts
//
// Tests subsystem collector. Reads the canonical tests JSONL ledger
// (`.hive-flow/tests/last-run.jsonl`) and folds suite / partial events into
// a `TestsSummary` the renderer can consume directly.
//
// Contract (Tests Subsystem):
//   - Pure, async, side-effect free aside from the bounded JSONL read.
//   - `kind: 'suite'` events are the canonical whole-suite baseline. The
//     latest suite event wins (replaces the prior suite) AND drops any
//     accumulated `latestPartial` -- partials are scoped between two
//     adjacent suites, so a fresh suite resets the partial slot.
//   - `kind: 'partial'` events are scope-limited supplementary runs. The
//     collector keeps the most recent partial that is observed at or after
//     the latest suite event in the ledger. If no suite has been observed
//     yet, every partial is eligible (the renderer will then surface the
//     partial on its own).
//   - Staleness: when the caller passes a pre-computed `SourceFingerprintV1`
//     (Wave 4 output) and that fingerprint's `sha256` does NOT equal the
//     selected suite event's stored `sourceFingerprint`, the suite is marked
//     `stale: true` with a `staleReason`. Per the round-5 fix on
//     `renderTests()` (`Codex-2026-05-20`/`Claude-vs-Codex-runbook-round5`):
//     stale is rendered as a SUFFIX on the numeric counts, never as a
//     REPLACEMENT. We therefore preserve the full event (passed/failed/etc.)
//     and only attach the `stale` / `staleReason` flags.
//   - When the caller does NOT provide a fingerprint, the freshness gate is
//     not evaluated; counts are surfaced as-is (no `stale` flag set).
//   - The collector is INDEPENDENT of the Wave 2 recorder. It only reads the
//     append-only ledger via `readJsonl` and never imports any recorder code
//     or any Wave 4 fingerprint-computation code. The fingerprint is passed
//     in by the refresher / orchestrator.
//
// Note on partial-supplement rendering (visual design 3.1 row 4a): the
// renderer is the one that gates `renderPartialSupplement` on
// `partial.ts > suite.ts`. This collector's job is only to surface the
// `latestPartial` slot so the renderer has the data it needs. We do NOT
// duplicate the "newer than suite" ts gate inside the renderer here.

import { statuslinePaths } from '../paths.js';
import { readJsonl } from '../storage.js';
import type {
  SourceFingerprintV1,
  TestRunEventV1,
  TestsSummary,
} from '../types.js';

export interface CollectTestsOptions {
  readonly projectRoot: string;
  /**
   * Optional pre-computed source fingerprint. When provided, the collector
   * compares `fingerprint.sha256` against the selected suite event's
   * `sourceFingerprint` and marks the suite stale on mismatch. When omitted
   * the freshness gate is skipped entirely (counts pass through verbatim).
   *
   * The collector MUST NOT compute a fingerprint itself; Wave 4 owns the
   * `computeSourceFingerprint` implementation. Decoupling here keeps the
   * collector pure and avoids accidental cross-wave imports.
   */
  readonly fingerprint?: SourceFingerprintV1;
}

/**
 * Staleness reason surfaced on `TestsSummary.suite.staleReason`. Mirrors the
 * runbook's wording so renderers (and downstream `markSuiteFreshness` audit
 * tooling) can rely on a stable, grep-able string.
 */
const STALE_REASON = 'source fingerprint changed since whole-suite test run';

/**
 * Narrowing guard: returns true when `value` looks like the canonical
 * `TestRunEventV1` shape. The recorder validates payloads at write time, but
 * this guard protects against hand-edited / legacy ledger rows so the
 * collector cannot crash on a malformed event. Optional fields
 * (`scope`, `durationMs`, `command`, `sourceFingerprint`) are validated only
 * when present.
 */
function isTestRunEvent(value: unknown): value is TestRunEventV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.eventId !== 'string' || v.eventId === '') return false;
  if (typeof v.ts !== 'string' || v.ts === '') return false;
  if (typeof v.repoRoot !== 'string') return false;
  if (typeof v.projectKey !== 'string') return false;
  if (typeof v.runner !== 'string') return false;
  if (v.kind !== 'suite' && v.kind !== 'partial') return false;
  if (!isNonNegativeInt(v.passed)) return false;
  if (!isNonNegativeInt(v.failed)) return false;
  if (!isNonNegativeInt(v.skipped)) return false;
  if (!isNonNegativeInt(v.total)) return false;
  if (v.scope !== undefined && typeof v.scope !== 'string') return false;
  if (v.durationMs !== undefined && !isNonNegativeInt(v.durationMs)) return false;
  if (v.command !== undefined && typeof v.command !== 'string') return false;
  if (typeof v.producerKind !== 'string') return false;
  if (typeof v.producerId !== 'string') return false;
  if (v.sourceFingerprint !== undefined && typeof v.sourceFingerprint !== 'string') return false;
  return true;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Parse an ISO timestamp to milliseconds. Returns `Number.NaN` when the input
 * cannot be parsed so callers can branch on validity without throwing.
 */
function timestampMs(value: string | undefined): number {
  if (typeof value !== 'string' || value === '') return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Read the tests ledger for `projectRoot` and fold it into a `TestsSummary`.
 *
 * The fold rules (canonical runbook + task brief):
 *   - For each event in append order:
 *       * `kind: 'suite'`  -> set `current.suite = event`, clear `latestPartial`.
 *       * `kind: 'partial'`-> if eligible (no suite yet, or partial.ts >= suite.ts),
 *                              set `current.latestPartial = event`.
 *   - After the fold, if a fingerprint is supplied AND `current.suite` exists,
 *     attach `stale` + `staleReason` based on a string-equality check against
 *     the suite's stored `sourceFingerprint`. A missing `sourceFingerprint` on
 *     the suite event is treated as "no fingerprint at record time" and is
 *     marked stale because the renderer cannot prove freshness without it.
 *   - When no fingerprint is supplied, counts pass through without the stale
 *     flag (the renderer simply omits the suffix).
 *
 * Returns an empty `{}` when the ledger is missing, empty, or contains only
 * unparseable rows. Never throws -- corrupt rows are skipped silently and the
 * underlying `readJsonl` enforces size caps.
 */
export async function collectTests(opts: CollectTestsOptions): Promise<TestsSummary> {
  const paths = statuslinePaths(opts.projectRoot);
  const ledger = await readJsonl<unknown>(paths.testsLedger);
  return foldTests(ledger.events, opts.fingerprint !== undefined ? { fingerprint: opts.fingerprint } : {});
}

// ---------------------------------------------------------------------------
// Reusable fold helper (extracted for `repair.ts`)
// ---------------------------------------------------------------------------

/**
 * Pure fold of raw ledger rows into a {@link TestsSummary}. Used by both
 * {@link collectTests} (on the read path) and `repair.ts` (on the rebuild
 * path) so the renderer and the repair command produce structurally identical
 * `tests/current.json` files.
 *
 * Narrows each row with the same `isTestRunEvent` guard `collectTests` uses
 * internally; non-conforming rows are skipped silently. Pure; no I/O.
 */
export function foldTests(
  rawEvents: ReadonlyArray<unknown>,
  opts: { readonly fingerprint?: SourceFingerprintV1 } = {},
): TestsSummary {
  let suite: TestRunEventV1 | undefined;
  let latestPartial: TestRunEventV1 | undefined;

  for (const raw of rawEvents) {
    if (!isTestRunEvent(raw)) continue;
    if (raw.kind === 'suite') {
      // Latest suite wins. A new suite invalidates any accumulated partial,
      // because partials live BETWEEN adjacent suites.
      suite = raw;
      latestPartial = undefined;
      continue;
    }
    // raw.kind === 'partial'
    // Partials are only valid when they fall in the window starting at the
    // most recent suite event. If no suite has been observed yet we keep the
    // partial so the renderer can still surface partial-only runs.
    if (suite === undefined) {
      latestPartial = raw;
      continue;
    }
    const suiteMs = timestampMs(suite.ts);
    const partialMs = timestampMs(raw.ts);
    // If either ts is unparseable, fall back to "keep" since the append-order
    // already orders them; this is consistent with the recorder's contract
    // that valid TestRunEvents always carry a parseable ts.
    if (!Number.isFinite(suiteMs) || !Number.isFinite(partialMs)) {
      latestPartial = raw;
      continue;
    }
    if (partialMs >= suiteMs) {
      latestPartial = raw;
    }
    // else: partial predates the current suite window -- drop it.
  }

  const summary: TestsSummary = {};

  if (suite !== undefined) {
    if (opts.fingerprint !== undefined) {
      const expected = opts.fingerprint.sha256;
      const recorded = suite.sourceFingerprint;
      const stale = recorded === undefined || recorded !== expected;
      if (stale) {
        summary.suite = { ...suite, stale: true, staleReason: STALE_REASON };
      } else {
        summary.suite = { ...suite, stale: false };
      }
    } else {
      summary.suite = suite;
    }
  }

  if (latestPartial !== undefined) {
    summary.latestPartial = latestPartial;
  }

  return summary;
}
