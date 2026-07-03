// cli/src/statusline/collectors/attention.ts
//
// Attention subsystem collector. Reads the canonical attention JSONL ledger
// and folds emit / resolve events into a compact summary the renderer can
// consume directly.
//
// Contract (Phase 8 / Attention Subsystem):
//   - Pure, async, side-effect free aside from the bounded JSONL read.
//   - `emit` events populate the unresolved map keyed by `item.id`.
//   - `resolve` events remove their counterpart by `id`. A resolve event
//     without a matching prior emit is a no-op (never throws).
//   - The returned summary is capped to `maxAttentionItems` (default 10).
//     Selection prefers higher severity first, then more recent items, so
//     the "lowest-priority" items are dropped when the ledger has more than
//     N unresolved entries.
//   - Display ordering matches selection: severity descending
//     (critical -> warn -> info), with recency descending as the tiebreaker.
//   - Reads via `readJsonl`, which is already redaction-safe because the
//     recorder applied `sanitizeAttentionItem` at write time. The collector
//     never re-redacts; it only folds the ledger and projects an age field.
//
// Notes for downstream waves:
//   - `maxAttentionItems` is not yet part of `StatuslineConfig`. The
//     collector accepts an explicit override on `opts` so the refresher can
//     plumb a config value when it is added, and otherwise defaults to 10.
//   - Items whose `ts` cannot be parsed sort last within their severity
//     tier and contribute `ageSeconds: 0`. They are never dropped on parse
//     error alone; the recorder owns input validation.

import { statuslinePaths } from '../paths.js';
import { readJsonl } from '../storage.js';
import type {
  AttentionItem,
  AttentionLedgerEntry,
  AttentionSeverity,
  AttentionSummary,
  AttentionSummaryRow,
} from '../types.js';

/**
 * Default cap on the number of unresolved attention items the collector
 * returns. Mirrors the runbook's "maxAttentionItems ~ 10" guideline. Kept as
 * a named constant so tests can pin the boundary explicitly without poking
 * at literal numbers.
 */
export const DEFAULT_MAX_ATTENTION_ITEMS = 10;

/**
 * Numeric rank used both for selection and for the final display order.
 * Lower number == higher priority. `critical` first, `info` last.
 */
const SEVERITY_RANK: Readonly<Record<AttentionSeverity, number>> = Object.freeze({
  critical: 0,
  warn: 1,
  info: 2,
});

export interface CollectAttentionOptions {
  readonly projectRoot: string;
  /**
   * Override the default cap. Non-integer / non-positive values fall back to
   * {@link DEFAULT_MAX_ATTENTION_ITEMS} so a tampered config cannot reduce
   * the cap to zero or below.
   */
  readonly maxAttentionItems?: number;
}

/**
 * Parse `ts` as a Unix millisecond timestamp. Returns `Number.NaN` when the
 * input is missing or unparseable so callers can detect the corrupt-ts case
 * without throwing. Kept as a tiny helper so the comparator below is easier
 * to reason about.
 */
function timestampMs(value: string | undefined): number {
  if (typeof value !== 'string' || value === '') return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Comparator: severity ascending (rank 0 first => `critical` first), then
 * recency descending (newer first), then `id` ascending for a deterministic
 * tiebreak when two items collide on both severity and timestamp.
 *
 * Items whose timestamps cannot be parsed sort last within their severity
 * tier; their `ageSeconds` will materialize as `0` downstream.
 */
function compareItems(a: AttentionItem, b: AttentionItem): number {
  const sa = SEVERITY_RANK[a.severity];
  const sb = SEVERITY_RANK[b.severity];
  if (sa !== sb) return sa - sb;
  const ta = timestampMs(a.ts);
  const tb = timestampMs(b.ts);
  const aValid = Number.isFinite(ta);
  const bValid = Number.isFinite(tb);
  if (aValid && bValid) {
    if (ta !== tb) return tb - ta; // newer first
  } else if (aValid !== bValid) {
    // Valid timestamps sort before unparseable ones inside the same severity.
    return aValid ? -1 : 1;
  }
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Clamp the cap to a positive integer. Falls back to the default when the
 * caller passes anything else.
 */
function resolveCap(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_ATTENTION_ITEMS;
  const floored = Math.floor(raw);
  if (floored <= 0) return DEFAULT_MAX_ATTENTION_ITEMS;
  return floored;
}

/**
 * Narrowing guard: returns true when `value` looks like the canonical
 * `AttentionItem` shape. The recorder has already sanitized payloads it
 * appends, but this guard protects against hand-edited / legacy ledger
 * rows so the collector cannot crash on a malformed `emit`.
 */
function isAttentionItem(value: unknown): value is AttentionItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id === '') return false;
  if (typeof v.ts !== 'string') return false;
  if (typeof v.message !== 'string') return false;
  if (typeof v.source !== 'string') return false;
  if (v.severity !== 'info' && v.severity !== 'warn' && v.severity !== 'critical') return false;
  if (v.action !== undefined && typeof v.action !== 'string') return false;
  if (typeof v.redacted !== 'boolean') return false;
  return true;
}

/**
 * Read the attention ledger for `projectRoot` and return a compact summary
 * of the unresolved items, ordered for renderer consumption. Returns a
 * summary with an empty `unresolved` array when the ledger is empty,
 * missing, or contains only resolved events.
 */
export async function collectAttention(
  opts: CollectAttentionOptions,
): Promise<AttentionSummary> {
  const paths = statuslinePaths(opts.projectRoot);
  const ledger = await readJsonl<AttentionLedgerEntry>(paths.attentionLedger);
  return foldAttention(ledger.events, {
    ...(opts.maxAttentionItems !== undefined
      ? { maxAttentionItems: opts.maxAttentionItems }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Reusable fold helper (extracted for `repair.ts`)
// ---------------------------------------------------------------------------

/**
 * Pure fold of raw attention ledger rows into an {@link AttentionSummary}.
 * Used by both {@link collectAttention} (on the read path) and `repair.ts`
 * (on the rebuild path) so the renderer and the repair command produce
 * structurally identical `attention/current.json` files.
 *
 * `emit` events populate the unresolved map keyed by `item.id`; `resolve`
 * events remove their counterpart. Non-conforming rows are skipped silently.
 * The result is capped, sorted by severity (desc) then recency (desc), and
 * projected onto {@link AttentionSummaryRow} (with computed `ageSeconds`).
 * Pure; no I/O. Accepts an optional `nowMs` so tests can pin age computation.
 */
export function foldAttention(
  rawEvents: ReadonlyArray<unknown>,
  opts: {
    readonly maxAttentionItems?: number;
    readonly nowMs?: number;
  } = {},
): AttentionSummary {
  const cap = resolveCap(opts.maxAttentionItems);
  const now = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)
    ? opts.nowMs
    : Date.now();

  // Fold the ledger in append order. `emit` adds to the unresolved map; a
  // subsequent `resolve` for the same id removes it. A `resolve` arriving
  // without a prior matching `emit` is a no-op (never throws) so the
  // collector tolerates partial / out-of-order replay safely.
  const unresolved = new Map<string, AttentionItem>();
  for (const event of rawEvents) {
    if (!event || typeof event !== 'object') continue;
    const candidate = event as { event?: unknown; item?: unknown; id?: unknown };
    if (candidate.event === 'emit') {
      if (isAttentionItem(candidate.item)) {
        unresolved.set(candidate.item.id, candidate.item);
      }
      continue;
    }
    if (candidate.event === 'resolve') {
      if (typeof candidate.id === 'string' && candidate.id !== '') {
        unresolved.delete(candidate.id);
      }
      continue;
    }
  }

  if (unresolved.size === 0) {
    return { unresolved: [] };
  }

  // Sort all unresolved items, then cap to `maxAttentionItems`. The
  // comparator's ordering doubles as selection priority: with severity
  // ascending + recency descending, the top N items are the highest-
  // severity, most recent entries. The dropped tail is therefore the
  // lowest-priority / oldest set, matching the runbook's selection rule.
  const all = Array.from(unresolved.values()).sort(compareItems);
  const top = all.length > cap ? all.slice(0, cap) : all;

  const rows: AttentionSummaryRow[] = top.map((item) => {
    const ts = timestampMs(item.ts);
    const ageSeconds = Number.isFinite(ts)
      ? Math.max(0, Math.floor((now - ts) / 1000))
      : 0;
    return {
      id: item.id,
      ts: item.ts,
      severity: item.severity,
      source: item.source,
      message: item.message,
      action: item.action,
      redacted: item.redacted,
      ageSeconds,
    };
  });

  return { unresolved: rows };
}
