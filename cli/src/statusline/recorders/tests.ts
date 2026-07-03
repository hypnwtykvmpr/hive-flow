// cli/src/statusline/recorders/tests.ts
//
// Phase 4 of the statusline rewrite. Tests subsystem recorder.
//
// Responsibilities (from the canonical runbook + task brief):
//   - Accept a `TestRunRecorderInput` describing one test run (suite or
//     partial), validate it, stamp ISO timestamps, derive duration, and
//     append the canonical `TestRunEventV1` to the tests JSONL ledger.
//   - Enforce the arithmetic invariant `passed + failed + skipped === total`
//     BEFORE any write hits disk. A violation throws the typed
//     `TestRunArithmeticError` with the offending counts so the caller can
//     surface the failure in diagnostics.
//   - `kind: 'suite' | 'partial'` is mutually exclusive — a single event is
//     one or the other. The discriminated input shape makes the mutual
//     exclusion structural (not a runtime check), so misuse is a compile
//     error rather than a silent bug.
//   - `framework` accepts an arbitrary non-empty string (junit-xml, vitest,
//     jest, pytest, gotest, etc.); we never narrow it to a closed enum.
//   - Writes go through `appendUniqueJsonlLocked` (single-field dedupe on
//     `eventId`) so we get the spool fallback, symlink rejection, per-line
//     cap "for free", AND idempotent retry semantics: a re-delivered event
//     with the same caller-supplied `eventId` is silently rejected and the
//     outcome reports `duplicate: true`. Production callers that omit
//     `eventId` mint a fresh UUID per call so the dedupe is effectively a
//     no-op for them.
//   - No compound dedupe for tests — fingerprinting (in the materializer)
//     handles run-uniqueness across producers with different `eventId`s.
//     Two events with the same suite name + framework but different
//     `eventId`s are explicitly allowed to coexist; the single-field dedupe
//     only collapses verbatim retries.
//
// This module is intentionally thin: it does no aggregation, no
// materialization, and no freshness tagging. Those live in the materializer
// (`recorders/tests-materializer.ts` per the runbook) which is a separate
// wave/agent.

import { randomUUID } from 'node:crypto';

import {
  appendUniqueJsonlLocked,
  type AppendUniqueJsonlLockedResult,
} from '../storage.js';
import { statuslinePaths } from '../paths.js';
import type {
  ProducerKind,
  TestRunEventV1,
  TestRunKind,
} from '../types.js';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a `TestRunRecorderInput` fails the arithmetic invariant
 * `passed + failed + skipped === total`. Carries the offending counts so
 * upstream diagnostics can surface what the producer reported without
 * having to re-derive them.
 *
 * Runbook spec: "Validate `passed + failed + skipped === total` before
 * appending (throw with typed error if violated)". The typed shape (named
 * subclass with a `code` discriminator) follows the same convention as
 * `StatuslineStoragePathError` / `StatuslineSpoolLedgerNameError` in
 * `storage.ts`.
 */
export class TestRunArithmeticError extends Error {
  readonly code = 'STATUSLINE_TEST_RUN_ARITHMETIC';
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
  constructor(passed: number, failed: number, skipped: number, total: number) {
    super(
      `Refusing test run: passed + failed + skipped (${passed} + ${failed} + ${skipped} = ${
        passed + failed + skipped
      }) !== total (${total})`,
    );
    this.name = 'TestRunArithmeticError';
    this.passed = passed;
    this.failed = failed;
    this.skipped = skipped;
    this.total = total;
  }
}

/**
 * Thrown when an input field that should be a non-empty string is missing,
 * empty, or whitespace-only. Used for `framework`, `producerId`,
 * `projectKey`, and `repoRoot` so the canonical ledger never accumulates
 * rows that downstream consumers cannot key on.
 */
export class TestRunFieldError extends Error {
  readonly code = 'STATUSLINE_TEST_RUN_FIELD';
  readonly field: string;
  constructor(field: string) {
    super(`Refusing test run: required string field '${field}' is missing or empty`);
    this.name = 'TestRunFieldError';
    this.field = field;
  }
}

/**
 * Thrown when one of the count fields (`passed`, `failed`, `skipped`,
 * `total`) is not a finite, non-negative integer. JS will happily let
 * `NaN`, `Infinity`, or fractional counts slip through the arithmetic
 * check (`NaN + 0 + 0 === NaN`, which is never equal to `total`), but the
 * resulting error message is opaque; this typed error names the offender.
 */
export class TestRunCountError extends Error {
  readonly code = 'STATUSLINE_TEST_RUN_COUNT';
  readonly field: string;
  readonly value: number;
  constructor(field: string, value: number) {
    super(`Refusing test run: count field '${field}' must be a non-negative integer, received ${value}`);
    this.name = 'TestRunCountError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Thrown when the optional `startedAt` / `finishedAt` ISO timestamps are
 * present but unparseable or out-of-order (`finishedAt` before
 * `startedAt`). The error message names the offending pair so the
 * producer can correct its clock handling.
 */
export class TestRunTimestampError extends Error {
  readonly code = 'STATUSLINE_TEST_RUN_TIMESTAMP';
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Refusing test run: timestamp '${field}' invalid (${detail})`);
    this.name = 'TestRunTimestampError';
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Input shape (discriminated union enforces `kind` mutual exclusion)
// ---------------------------------------------------------------------------

/**
 * Common fields shared by both `suite` and `partial` test run inputs.
 * Split into a base interface so the discriminated union at the bottom of
 * this section reads cleanly.
 *
 * Note that the canonical `TestRunEventV1` (in `types.ts`) uses `runner`
 * for the framework identifier. The recorder accepts `framework` because
 * the runbook spec phrases it that way and producers (junit-xml, vitest,
 * jest, gotest, …) think in terms of "framework". We mirror it onto
 * `runner` when constructing the canonical event so downstream consumers
 * keep their existing key.
 */
interface TestRunRecorderInputBase {
  /** Framework identifier; mapped onto `TestRunEventV1.runner`. */
  readonly framework: string;
  readonly projectKey: string;
  readonly repoRoot: string;
  readonly producerKind: ProducerKind;
  readonly producerId: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
  /** ISO 8601 timestamp the test run started. Defaults to `Date.now()`. */
  readonly startedAt?: string;
  /** ISO 8601 timestamp the test run finished. Defaults to `startedAt`. */
  readonly finishedAt?: string;
  /** Optional scope identifier (suite name, file glob, etc.). */
  readonly scope?: string;
  /** Optional shell command that produced the run. */
  readonly command?: string;
  /** Optional pre-computed source fingerprint (SHA-256). */
  readonly sourceFingerprint?: string;
  /**
   * Optional pre-allocated event id. Tests use this to assert that the
   * recorder did not silently regenerate it. Production callers should
   * leave it undefined so a fresh UUID is minted per event.
   */
  readonly eventId?: string;
}

/** A full-suite run: every test in the suite was attempted. */
export interface SuiteTestRunRecorderInput extends TestRunRecorderInputBase {
  readonly kind: 'suite';
}

/** A partial run: filtered, sharded, or focus-mode test run. */
export interface PartialTestRunRecorderInput extends TestRunRecorderInputBase {
  readonly kind: 'partial';
}

/**
 * Discriminated union of test run inputs. `kind: 'suite' | 'partial'` is
 * mutually exclusive at the type level: TypeScript will reject a literal
 * `{ kind: 'suite' | 'partial' }` shape, so misuse is a compile error
 * rather than a runtime one.
 */
export type TestRunRecorderInput =
  | SuiteTestRunRecorderInput
  | PartialTestRunRecorderInput;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RecordTestRunOptions {
  /** Absolute path to the project root (the `.hive-flow/` parent). */
  readonly projectRoot: string;
  readonly input: TestRunRecorderInput;
  /**
   * Forwarded to `appendJsonlLocked`. Defaults to true (spool on lock
   * contention); set false to surface a hard write failure.
   */
  readonly spoolOnLockFailure?: boolean;
  /**
   * Forwarded to `appendJsonlLocked` for the underlying file-lock. Tests
   * use this to force stale-lock reclaim in <1s.
   */
  readonly staleAfterMs?: number;
}

/**
 * Outcome of `recordTestRun`. The discriminated `result` mirrors the
 * underlying `appendUniqueJsonlLocked` return so callers can distinguish:
 *   - a write that landed in the ledger (`written: true`),
 *   - a lock-fallback (`spooled: true`) that the drainer will apply later,
 *   - an idempotent retry of a previously-recorded `eventId`
 *     (`duplicate: true`, nothing was appended or spooled), or
 *   - a hard skip when `spoolOnLockFailure: false` and the lock was
 *     contended (`written: false, spooled: false, duplicate: false`).
 *
 * `event` is the canonical record the recorder produced (and possibly
 * persisted) so callers (e.g. the materializer's same-process fast-path)
 * can read it without re-parsing the ledger. For the `duplicate: true`
 * path the event payload still describes the inbound retry — it is NOT
 * re-fetched from the ledger row that won the race.
 *
 * `startedAt` / `finishedAt` are surfaced separately because the canonical
 * `TestRunEventV1.ts` field is the *finish* timestamp; callers that want
 * to reason about the start of the run (e.g. attributing flake to a
 * deploy window) read them here without re-deriving from `durationMs`.
 */
export interface RecordTestRunOutcome {
  readonly event: TestRunEventV1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: AppendUniqueJsonlLockedResult;
}

/**
 * Record a single test run. Validates the input, stamps timestamps + a
 * fresh `eventId` (when one is not caller-supplied), constructs a frozen
 * `TestRunEventV1`, and appends it to the tests JSONL ledger under an
 * exclusive lock.
 *
 * Idempotent on retry: when the caller supplies an `eventId` that already
 * appears in the ledger, the duplicate is silently rejected and the
 * outcome reports `result.duplicate: true` with no `written` row added.
 * Callers that omit `eventId` mint a fresh UUID per call, so the dedupe
 * never collapses logically-distinct runs.
 *
 * Throws (typed) on input validation failure; never returns a partially-
 * built event in that case so the caller cannot accidentally persist
 * garbage through a different code path.
 */
export async function recordTestRun(
  options: RecordTestRunOptions,
): Promise<RecordTestRunOutcome> {
  const { projectRoot, input } = options;

  // Validation runs in a fixed order so error messages point at the first
  // structural problem. Strings first (cheap), then counts, then
  // arithmetic, then timestamps.
  assertNonEmptyString(input.framework, 'framework');
  assertNonEmptyString(input.projectKey, 'projectKey');
  assertNonEmptyString(input.repoRoot, 'repoRoot');
  assertNonEmptyString(input.producerId, 'producerId');
  if (input.scope !== undefined) assertNonEmptyString(input.scope, 'scope');
  if (input.command !== undefined) assertNonEmptyString(input.command, 'command');
  if (input.sourceFingerprint !== undefined) {
    assertNonEmptyString(input.sourceFingerprint, 'sourceFingerprint');
  }

  assertNonNegativeInteger(input.passed, 'passed');
  assertNonNegativeInteger(input.failed, 'failed');
  assertNonNegativeInteger(input.skipped, 'skipped');
  assertNonNegativeInteger(input.total, 'total');

  if (input.passed + input.failed + input.skipped !== input.total) {
    throw new TestRunArithmeticError(
      input.passed,
      input.failed,
      input.skipped,
      input.total,
    );
  }

  const { startedAt, finishedAt, durationMs } = resolveTimestamps(
    input.startedAt,
    input.finishedAt,
  );

  // Narrow once. `input.kind` is structurally `'suite' | 'partial'` but
  // we still pin it into a `TestRunKind` local so the assignment below
  // is type-checked, never widened via inference.
  const kind: TestRunKind = input.kind;

  // Build the canonical event in two passes so the required-fields shape
  // is type-checked first, then optional fields are layered on top with
  // omit-when-undefined semantics. `Object.keys(event)` therefore reflects
  // only the producer-supplied fields, which makes downstream test
  // assertions (`Object.keys(event).sort()`) deterministic.
  const required = {
    version: 1 as const,
    eventId: input.eventId ?? randomUUID(),
    ts: finishedAt,
    repoRoot: input.repoRoot,
    projectKey: input.projectKey,
    runner: input.framework,
    kind,
    passed: input.passed,
    failed: input.failed,
    skipped: input.skipped,
    total: input.total,
    producerKind: input.producerKind,
    producerId: input.producerId,
  };

  const event: TestRunEventV1 = {
    ...required,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.sourceFingerprint !== undefined
      ? { sourceFingerprint: input.sourceFingerprint }
      : {}),
  };

  const paths = statuslinePaths(projectRoot);
  // Dedupe on a SINGLE field (`eventId`) so re-deliveries of the same
  // logical run drop without surfacing a write. We deliberately do NOT
  // pass a compound key here: the runbook reserves compound dedupe for
  // scoreboard-calls, and tests-recorder must let two distinct
  // `eventId`s with the same `(runner, scope)` coexist (see the
  // no-compound-dedupe test in `tests-recorder.test.ts`).
  const appendResult = await appendUniqueJsonlLocked<TestRunEventV1>({
    ledgerPath: paths.testsLedger,
    spoolRoot: paths.spoolRoot,
    ledgerName: 'tests',
    event,
    uniqueField: 'eventId',
    ...(options.spoolOnLockFailure !== undefined
      ? { spoolOnLockFailure: options.spoolOnLockFailure }
      : {}),
    ...(options.staleAfterMs !== undefined
      ? { staleAfterMs: options.staleAfterMs }
      : {}),
  });

  return { event, startedAt, finishedAt, result: appendResult };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TestRunFieldError(field);
  }
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new TestRunCountError(field, typeof value === 'number' ? value : Number.NaN);
  }
}

function parseIsoTimestamp(field: string, value: string): number {
  const isoTimestampPattern =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const match = isoTimestampPattern.exec(value);
  if (match === null) {
    throw new TestRunTimestampError(field, `not an ISO 8601 timestamp: ${value}`);
  }
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, rawZone] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new TestRunTimestampError(field, `not a valid ISO 8601 timestamp: ${value}`);
  }
  if (rawZone !== 'Z') {
    const offsetHour = Number(rawZone.slice(1, 3));
    const offsetMinute = Number(rawZone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw new TestRunTimestampError(field, `not a valid ISO 8601 timestamp: ${value}`);
    }
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TestRunTimestampError(field, `not a parseable ISO 8601 timestamp: ${value}`);
  }
  return parsed;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface ResolvedTimestamps {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number | undefined;
}

function resolveTimestamps(
  startedAtInput: string | undefined,
  finishedAtInput: string | undefined,
): ResolvedTimestamps {
  // Four cases handled exhaustively. Each branch returns early so the
  // function has no fall-through. We rely on direct `!== undefined` checks
  // (rather than `as string` casts) so control-flow narrows the locals
  // for TypeScript.

  // Case 1: neither timestamp supplied. Stamp `now` for both and report
  // a zero-length duration; the materializer can fold this into a
  // `staleReason: 'no-timestamps'` flag if it wants.
  if (startedAtInput === undefined && finishedAtInput === undefined) {
    const now = new Date().toISOString();
    return { startedAt: now, finishedAt: now, durationMs: 0 };
  }

  // Case 2: startedAt only — compute finishedAt as `now`.
  if (startedAtInput !== undefined && finishedAtInput === undefined) {
    const startedAtMs = parseIsoTimestamp('startedAt', startedAtInput);
    const finishedAt = new Date().toISOString();
    const finishedAtMs = Date.parse(finishedAt);
    const durationMs = Math.max(0, finishedAtMs - startedAtMs);
    return { startedAt: startedAtInput, finishedAt, durationMs };
  }

  // Case 3: finishedAt only — treat as point-in-time. Don't synthesize
  // a fake start because the materializer cannot disambiguate it from a
  // genuinely-zero-duration run.
  if (startedAtInput === undefined && finishedAtInput !== undefined) {
    parseIsoTimestamp('finishedAt', finishedAtInput);
    return {
      startedAt: finishedAtInput,
      finishedAt: finishedAtInput,
      durationMs: undefined,
    };
  }

  // Case 4: both present. The two `if` guards above already narrowed
  // away the `undefined` branches; this branch knows both are defined,
  // but TS cannot prove that from negated unions alone, so we re-check.
  if (startedAtInput === undefined || finishedAtInput === undefined) {
    // Unreachable: cases 1-3 cover the undefined permutations. Re-check
    // present to give TS the narrowing it needs without an `as` cast.
    throw new TestRunTimestampError('startedAt', 'unreachable: timestamp narrowing fell through');
  }
  const startedAtMs = parseIsoTimestamp('startedAt', startedAtInput);
  const finishedAtMs = parseIsoTimestamp('finishedAt', finishedAtInput);
  if (finishedAtMs < startedAtMs) {
    throw new TestRunTimestampError(
      'finishedAt',
      `finishedAt (${finishedAtInput}) is before startedAt (${startedAtInput})`,
    );
  }
  return {
    startedAt: startedAtInput,
    finishedAt: finishedAtInput,
    durationMs: finishedAtMs - startedAtMs,
  };
}
