// v3/@hive-flow/cli/src/statusline/recorders/attention.ts
//
// Phase 8 / Attention Subsystem — emit + resolve recorder with the four
// mandatory redactions from Phase 5 constraint C3:
//
//   1. Homedir replacement   ($HOME prefix -> `~`)
//   2. Secret-key redaction  (token | api_key | apikey | password | secret |
//                              credential, case-insensitive -> [REDACTED])
//   3. Quoted-string truncation (double-quoted strings > 80 chars -> 80 + ...)
//   4. Multi-line rejection  (input containing \n or \r is rejected with a
//                              typed error rather than redacted)
//
// All four are exposed via a pure `redactAttentionSummary(input)` function so
// they are testable in isolation, and the recorder calls the redactor BEFORE
// writing to the ledger. Raw input is never persisted.
//
// Regex linearity (round-3 / Wave 2.5C bug-hunter findings):
//   - The secret-key match uses a SINGLE non-greedy hop and then a bounded
//     value class; no nested quantifiers.
//   - The quoted-string class is `[^"\x0A\x0D]` — quotes and newlines never
//     match inside, so the inner `*` cannot interact with the trailing `"`
//     in a way that creates ambiguity. There is no `(...)*` over another
//     `*` and no overlapping alternations.
//   - Long-quoted-string detection uses `[^"\x0A\x0D]{81,}` (a single
//     bounded repetition) so the engine cannot enter the catastrophic-
//     backtracking regime on inputs that fail late.
//   - All control bytes are written via `\xNN` escapes rather than literal
//     bytes in source per the Wave 2.5C lesson.

import { homedir } from 'node:os';

import {
  appendJsonlLocked,
  type AppendJsonlLockedOptions,
  type AppendJsonlLockedResult,
} from '../storage.js';
import type { AttentionEventV1, AttentionItem, AttentionResolvedV1 } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Thrown by `redactAttentionSummary` when the input contains a CR or LF
 * byte. The attention ledger stores one event per JSONL line, so a multi-line
 * summary would either corrupt the ledger (raw write) or silently drop content
 * (naive strip). We reject instead.
 */
export class AttentionMultiLineError extends Error {
  /** Tag for instanceof-free checks across module-instance boundaries. */
  public readonly code: 'ATTENTION_MULTI_LINE' = 'ATTENTION_MULTI_LINE';
  constructor(message: string = 'attention summary contains \\n or \\r') {
    super(message);
    this.name = 'AttentionMultiLineError';
  }
}

/**
 * Append-function shape accepted by the recorder. Compatible with
 * `appendJsonlLocked` (whose `event` field is `unknown`) — recorder callers
 * may pass the storage primitive directly. Tests inject a spy/mock with the
 * same shape to assert the recorder calls the redactor BEFORE writing.
 */
export type AttentionAppend = (
  opts: AppendJsonlLockedOptions & {
    readonly ledgerName: 'attention';
    readonly event: AttentionEventV1 | AttentionResolvedV1;
  },
) => Promise<AppendJsonlLockedResult>;

export interface AttentionRecorderDeps {
  /** Override for the ledger writer. Default uses `appendJsonlLocked`. */
  readonly append?: AttentionAppend;
  /** Override `os.homedir()`; defaults to the real one. Used by tests. */
  readonly homedir?: () => string;
  /** Override `Date.now()`-derived ISO timestamp. */
  readonly now?: () => string;
  /** Override the eventId generator. Default: timestamp + random suffix. */
  readonly newEventId?: () => string;
}

export interface RecordEmitInput {
  /** Required: ledger path resolved via `statuslinePaths(...).attentionLedger`. */
  readonly ledgerPath: string;
  /** Required: spool root resolved via `statuslinePaths(...).spoolRoot`. */
  readonly spoolRoot: string;
  /** Stable item identifier (re-emit collapses to the same id). */
  readonly id: string;
  readonly severity: AttentionItem['severity'];
  readonly source: string;
  /**
   * Free-form attention summary. Will be passed through
   * `redactAttentionSummary` before persistence.
   */
  readonly message: string;
  /** Optional action prompt; also redacted. */
  readonly action?: string;
}

export interface RecordResolveInput {
  readonly ledgerPath: string;
  readonly spoolRoot: string;
  readonly id: string;
  /** Free-form reason; also redacted. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Redactor — pure function (no I/O)
// ---------------------------------------------------------------------------

/**
 * Secret-key trigger regex. ONE alternation, anchored on a word boundary so
 * `mytoken` does not match. The trailing `(?=...)` look-ahead is a single
 * character class — no nested quantifiers. Case-insensitive flag.
 *
 * The match itself only spans the key + separator; the value is consumed by
 * `consumeSecretValue` so the regex never backtracks across a value boundary.
 */
const SECRET_KEY_REGEX = /\b(token|api_key|apikey|password|secret|credential)(\s*[:=]\s*)/gi;

/**
 * Detect a double-quoted JSON-style string longer than 80 chars (inclusive of
 * the contents). `[^"\x0A\x0D]` excludes both quote terminators and the
 * newline bytes the multi-line check would have caught — so the engine cannot
 * walk past the closing quote or wander into another line.
 *
 * Phase 5 spec: ">80 chars truncated to 80 chars + ...". We match the WHOLE
 * quoted token (including outer quotes) and rewrite it; the inner length is
 * checked in JS to avoid relying on regex back-references.
 */
const QUOTED_STRING_REGEX = /"[^"\x0A\x0D]*"/g;

const REDACTED = '[REDACTED]';
const TRUNCATE_AT = 80;
const TRUNCATION_SUFFIX = '...';

/**
 * Apply the four mandatory redactions in a deterministic chain:
 *
 *   0. Reject if input contains `\n` or `\r` (typed error).
 *   1. Replace the resolved `$HOME` prefix with `~`.
 *   2. Replace secret-key values with `[REDACTED]`.
 *   3. Truncate any double-quoted string whose inner length exceeds 80 to
 *      80 chars + `...`.
 *
 * Ordering rationale:
 *   - Multi-line check first so we fail fast before any rewriting work
 *     could mask a CR/LF inside an otherwise-redactable value.
 *   - Homedir before secrets so a path that *happens* to contain "token"
 *     in its directory name does not accidentally cause a secret rewrite
 *     of a now-shortened `~` segment.
 *   - Secrets before quote truncation so a long secret value inside a
 *     quoted string is replaced with `[REDACTED]` (short) rather than
 *     truncated to 80 chars of secret material.
 */
export function redactAttentionSummary(
  input: string,
  options: { readonly homedir?: () => string } = {},
): string {
  if (typeof input !== 'string') {
    throw new AttentionMultiLineError('attention summary must be a string');
  }
  // Reject control bytes that would split the ledger row. We use
  // explicit escapes so the source itself contains no literal control bytes.
  if (input.indexOf('\x0A') !== -1 || input.indexOf('\x0D') !== -1) {
    throw new AttentionMultiLineError();
  }

  let out = input;

  // 1. Homedir -> ~
  const home = (options.homedir ?? homedir)();
  if (typeof home === 'string' && home.length > 0) {
    // Plain string replace — no regex, so no backtracking risk regardless of
    // home contents. We replace every occurrence by walking with indexOf so
    // the implementation does not depend on regex metacharacter escaping of
    // an arbitrary user home string.
    out = replaceAll(out, home, '~');
  }

  // 2. Secret keys -> [REDACTED]
  //
  // Two-phase, both linear. Phase A: rewrite each `<key><sep>` match to
  // `<key><sep>[REDACTED]`, but only when the value is not ALREADY
  // `[REDACTED]` — that way re-running the redactor over its own output is
  // idempotent. Phase B: a single forward scan strips the original value
  // text that now sits immediately after each newly inserted `[REDACTED]`
  // marker (because `.replace` only substitutes the match itself).
  out = out.replace(
    SECRET_KEY_REGEX,
    (match: string, key: string, sep: string, offset: number, full: string) => {
      // Idempotency guard: if the value is already redacted, leave it.
      const valueStart = offset + match.length;
      if (full.startsWith(REDACTED, valueStart)) return match;
      return `${key}${sep}${REDACTED}`;
    },
  );
  out = stripPostMarkerSecretValues(out);

  // 3. Quoted-string truncation (inner length > 80)
  out = out.replace(QUOTED_STRING_REGEX, (quoted) => {
    // `quoted` includes the surrounding double quotes, so inner length is
    // length - 2. The regex bounds the engine to a single character class with
    // no nested quantifier, so this match is linear in the input length.
    const inner = quoted.slice(1, -1);
    if (inner.length <= TRUNCATE_AT) return quoted;
    return `"${inner.slice(0, TRUNCATE_AT)}${TRUNCATION_SUFFIX}"`;
  });

  return out;
}

/**
 * Walk forward from `start` consuming a value token. Stops at the first
 * value-terminator: whitespace, comma, `}`, `]`, `)`, `;`, or end-of-string.
 * If the value is double-quoted, consumes the whole quoted span. Linear in
 * the input length.
 */
function consumeSecretValue(input: string, start: number): number {
  if (start >= input.length) return 0;
  const first = input.charCodeAt(start);
  // Quoted value: walk to the matching closing quote, stopping at newlines.
  if (first === 0x22 /* " */) {
    for (let i = start + 1; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c === 0x22) return i - start + 1;
      if (c === 0x0a || c === 0x0d) return i - start;
    }
    return input.length - start;
  }
  // Bare value: walk to the first terminator.
  for (let i = start; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (
      c === 0x20 || // space
      c === 0x09 || // tab
      c === 0x2c || // ,
      c === 0x3b || // ;
      c === 0x29 || // )
      c === 0x7d || // }
      c === 0x5d || // ]
      c === 0x0a || // LF (defensive; rejected at entry)
      c === 0x0d    // CR (defensive; rejected at entry)
    ) {
      return i - start;
    }
  }
  return input.length - start;
}

/**
 * After the SECRET_KEY_REGEX pass each match has been rewritten to
 * `<key><sep>[REDACTED]<originalValue>`. This helper walks the string once
 * and removes the lingering `<originalValue>` segment that immediately
 * follows every `[REDACTED]` marker. Linear in the input length. Uses a
 * fixed marker scan + `consumeSecretValue` for termination so there is no
 * possible backtracking.
 *
 * Two correctness rules:
 *   - If the post-marker text starts with another `[REDACTED]` (idempotent
 *     re-redaction case), skip stripping entirely so we do not chip the
 *     trailing `]` off the previous marker.
 *   - Likewise, do not strip when post-marker is non-content (whitespace,
 *     punctuation, end-of-string).
 */
function stripPostMarkerSecretValues(input: string): string {
  const marker = REDACTED;
  let cursor = 0;
  let out = '';
  while (cursor < input.length) {
    const idx = input.indexOf(marker, cursor);
    if (idx === -1) {
      out += input.slice(cursor);
      break;
    }
    out += input.slice(cursor, idx + marker.length);
    const afterMarker = idx + marker.length;
    // Idempotency guard: if the immediate post-marker text is itself
    // another `[REDACTED]` token, leave it alone — that's an already-
    // redacted ledger row being re-processed.
    if (input.startsWith(marker, afterMarker)) {
      cursor = afterMarker;
      continue;
    }
    const valueLen = consumeSecretValue(input, afterMarker);
    cursor = afterMarker + valueLen;
  }
  return out;
}

/**
 * Plain-string global replacement. We deliberately avoid `String.prototype
 * .replaceAll` to keep this file usable on the runbook's compatibility
 * targets (Node 18) and to make the per-iteration cost explicit. Linear in
 * the input length and the needle length is bounded by the homedir.
 */
function replaceAll(input: string, needle: string, replacement: string): string {
  if (needle.length === 0) return input;
  let result = '';
  let cursor = 0;
  while (cursor <= input.length - needle.length) {
    const idx = input.indexOf(needle, cursor);
    if (idx === -1) break;
    result += input.slice(cursor, idx) + replacement;
    cursor = idx + needle.length;
  }
  result += input.slice(cursor);
  return result;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

// `appendJsonlLocked` types `event` as `unknown`, so the recorder's stricter
// `AttentionEventV1 | AttentionResolvedV1` event narrows the argument — no
// cast required because the stricter type is structurally assignable.
const DEFAULT_APPEND: AttentionAppend = appendJsonlLocked;

/**
 * Append an `emit` event to the attention ledger. The message and action
 * are passed through `redactAttentionSummary` BEFORE the JSON is built and
 * BEFORE any I/O — raw input never leaves this function intact.
 */
export async function recordAttentionEmit(
  input: RecordEmitInput,
  deps: AttentionRecorderDeps = {},
): Promise<AppendJsonlLockedResult> {
  const home = deps.homedir;
  const message = redactAttentionSummary(input.message, home ? { homedir: home } : undefined);
  const action =
    typeof input.action === 'string'
      ? redactAttentionSummary(input.action, home ? { homedir: home } : undefined)
      : undefined;

  const now = (deps.now ?? defaultNow)();
  const item: AttentionItem = {
    id: input.id,
    ts: now,
    severity: input.severity,
    source: input.source,
    message,
    redacted: true,
    ...(action !== undefined ? { action } : {}),
  };

  const event: AttentionEventV1 = {
    eventId: (deps.newEventId ?? defaultEventId)(),
    ts: now,
    event: 'emit',
    item,
  };

  const append = deps.append ?? DEFAULT_APPEND;
  return append({
    ledgerPath: input.ledgerPath,
    spoolRoot: input.spoolRoot,
    ledgerName: 'attention',
    event,
  });
}

/**
 * Append a `resolve` event to the attention ledger. The resolution reason
 * is passed through `redactAttentionSummary` BEFORE I/O.
 */
export async function recordAttentionResolve(
  input: RecordResolveInput,
  deps: AttentionRecorderDeps = {},
): Promise<AppendJsonlLockedResult> {
  const home = deps.homedir;
  const reason = redactAttentionSummary(input.reason, home ? { homedir: home } : undefined);
  const now = (deps.now ?? defaultNow)();
  const event: AttentionResolvedV1 = {
    eventId: (deps.newEventId ?? defaultEventId)(),
    ts: now,
    event: 'resolve',
    id: input.id,
    reason,
    redacted: true,
  };
  const append = deps.append ?? DEFAULT_APPEND;
  return append({
    ledgerPath: input.ledgerPath,
    spoolRoot: input.spoolRoot,
    ledgerName: 'attention',
    event,
  });
}

function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * Default eventId generator: timestamp + 8 hex chars from a 32-bit random.
 * We avoid pulling `node:crypto` into the hot path of the recorder — the
 * eventId only needs to be unique enough to dedupe drains, not
 * cryptographically random.
 */
function defaultEventId(): string {
  const ms = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `attn-${ms}-${rand}`;
}
