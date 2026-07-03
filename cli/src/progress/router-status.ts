/**
 * Closed router-note Status grammar -- P5 of the inter-agent communication
 * design (Knot hive-flow-2ee8 / hive-flow-29a5; design of record: 2ee8 knot
 * note section 6 + router 20260703T192135Z; Codex PLAN_REVIEW_PASS
 * 20260703T192607Z, split to its own knot per Q3).
 *
 * Today the router-note `Status:` header is free text (~29 distinct values in
 * the wild) and the classifier text-mines note bodies instead. This module is
 * the closed vocabulary and the validating parser that makes the header
 * authoritative:
 *
 *   ACTIVE_HANDOFF          work handed to a named next owner; action follows
 *   REVIEW_REQUEST          a review/verification gate requested from the peer
 *   VERIFY_CLEAN            verification passed; nothing to fix
 *   VERIFY_BOUNCE           verification bounced; the fix owner is named
 *   COMPLETE_NO_ACTION      all assignments complete; no next owner remains
 *   BLOCKED_TRUE_HUMAN_GATE only a human can unblock; the exact action is stated
 *
 * Unknown values are FLAGGED (raw preserved, `recognized: false`), never
 * silently coerced -- a consumer can fall back to legacy body mining for
 * headerless/unknown notes while the closed set hardens over time.
 */

export const ROUTER_STATUSES = [
  'ACTIVE_HANDOFF',
  'REVIEW_REQUEST',
  'VERIFY_CLEAN',
  'VERIFY_BOUNCE',
  'COMPLETE_NO_ACTION',
  'BLOCKED_TRUE_HUMAN_GATE',
] as const;

export type RouterStatus = (typeof ROUTER_STATUSES)[number];

export interface ParsedRouterStatus {
  /** Canonical closed-set value, or null when missing/unknown. */
  status: RouterStatus | null;
  /** Header value exactly as written (preserved for unknown values). */
  raw: string | null;
  /** True only when a header exists AND its value is in the closed set. */
  recognized: boolean;
  reason?: 'missing-header' | 'unknown-status';
}

/** The header must appear in the first few lines -- a `Status:` string deep in
 *  a note body is prose, not a header. */
const HEADER_SCAN_LINES = 5;

export function isRouterStatus(value: unknown): value is RouterStatus {
  return typeof value === 'string' && (ROUTER_STATUSES as readonly string[]).includes(value);
}

/**
 * Parse the `Status:` header of a router note against the closed set.
 * Case-insensitive on input, canonical uppercase on output. Never throws.
 */
export function parseRouterStatus(noteText: string): ParsedRouterStatus {
  const lines = String(noteText ?? '').split('\n').slice(0, HEADER_SCAN_LINES);
  for (const line of lines) {
    const match = line.match(/^\s*Status:\s*(.+?)\s*$/i);
    if (!match) continue;
    const raw = match[1];
    const candidate = raw.toUpperCase();
    if (isRouterStatus(candidate)) {
      return { status: candidate, raw, recognized: true };
    }
    return { status: null, raw, recognized: false, reason: 'unknown-status' };
  }
  return { status: null, raw: null, recognized: false, reason: 'missing-header' };
}
