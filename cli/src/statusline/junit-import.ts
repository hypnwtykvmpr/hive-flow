// cli/src/statusline/junit-import.ts
//
// Wave-13 of the statusline rewrite (Phase 13.2 / Phase 15 import path).
// Ingests JUnit XML test reports and converts them to `TestRunEventV1`
// records appended to the tests ledger via the `recordTestRun` recorder.
//
// Design constraints (canonical merged runbook section 13.2 + Codex round-5
// finding on JUnit symlink and outside-project handling + task brief):
//
//   - Hand-rolled minimal XML parser: only `<testsuite name tests failures
//     errors skipped time>` attributes matter. NO `fast-xml-parser` or other
//     XML library dependency. Strip CDATA blocks and comments before
//     scanning so commented-out attributes do not corrupt the regex parse.
//
//   - LINEAR regex: every pattern used here matches against bounded sub-
//     strings (an open tag's attribute list, a single attribute), never the
//     full document with backtracking-prone alternation. The file as a whole
//     is capped at `MAX_JUNIT_BYTES`.
//
//   - Tolerate malformed XML: missing or garbage attributes degrade to `0`,
//     unparseable suites are silently skipped, the per-tree walker keeps
//     going even when one file blows up. Never throws to the caller from
//     the surface API.
//
//   - Symlink + outside-project safety (Codex round-5):
//       - `assertInsideProject`-equivalent check runs BEFORE any file read.
//       - `lstat` BEFORE `realpath` so a symlink is detected even when its
//         target resolves into the project.
//       - Symlinks pointing OUTSIDE the project root: rejected (typed
//         skip reason, never followed).
//       - Symlinks pointing INSIDE the project root: skipped during tree
//         walking (do NOT recurse, do NOT import). When the caller passes
//         a symlinked file path directly, it is rejected as a hostile
//         input.
//
//   - Bounded reads: refuses to ingest files larger than `MAX_JUNIT_BYTES`
//     (default 2 MiB) via an `lstat`-before-`open` size probe; the size is
//     re-validated after read to defend against TOCTOU races.
//
//   - Per-suite events use `recordTestRun({ projectRoot, input })` so the
//     ledger write inherits the recorder's symlink/path safety, byte caps,
//     spool-on-contention behaviour, and arithmetic validation. We do NOT
//     bypass the recorder by appending to the ledger directly.
//
//   - `framework` is an arbitrary non-empty string; defaults to
//     `'junit-xml'`. No closed enum.
//
//   - No `as any`, no unsafe casts, no literal control bytes in source.
//
// This module is intentionally a pure import path. It does no rendering, no
// freshness tagging, and no aggregation. Those live in the tests collector
// and renderer pipeline (other waves).

import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  recordTestRun,
  type RecordTestRunOutcome,
} from './recorders/tests.js';
import type { ProducerKind, TestRunEventV1 } from './types.js';

// ---------------------------------------------------------------------------
// Caps + defaults
// ---------------------------------------------------------------------------

/** Default framework identifier when the caller does not supply one. */
export const DEFAULT_JUNIT_FRAMEWORK = 'junit-xml';

/** Maximum recursion depth for `importJunitTree`. */
export const MAX_JUNIT_DEPTH = 8;

/** Maximum number of XML files visited in one `importJunitTree` invocation. */
export const MAX_JUNIT_FILES = 500;

/** Maximum on-disk size accepted for a single JUnit XML file. */
export const MAX_JUNIT_BYTES = 2 * 1024 * 1024;

/** Producer kind for events emitted via this importer. */
const PRODUCER_KIND: ProducerKind = 'manual';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an internal helper hits a path-safety violation. The surface
 * API (`importJunitFile` / `importJunitTree`) catches this and records it
 * on the returned summary so callers never see the bare throw, but the
 * typed shape is exported for tests and diagnostics that want to inspect
 * the failure mode directly.
 */
export class JunitImportPathError extends Error {
  readonly code = 'STATUSLINE_JUNIT_IMPORT_PATH';
  readonly reason: 'symlink' | 'outside-project' | 'not-found' | 'not-regular';
  readonly relativeOffender: string;
  constructor(
    reason: 'symlink' | 'outside-project' | 'not-found' | 'not-regular',
    relativeOffender: string,
  ) {
    super(
      `Refusing JUnit import: ${reason} (${relativeOffender || '<unknown>'})`,
    );
    this.name = 'JunitImportPathError';
    this.reason = reason;
    this.relativeOffender = relativeOffender;
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type JunitImportSkipReason =
  | 'symlink'
  | 'outside-project'
  | 'not-found'
  | 'not-regular'
  | 'oversize'
  | 'unreadable'
  | 'malformed'
  | 'no-suites';

export interface JunitImportSummary {
  /** Absolute path of the imported file. Empty string when import was refused at the path-safety check. */
  readonly filePath: string;
  /** Number of `<testsuite>` elements successfully recognised and appended. */
  readonly suites: number;
  /** Number of `TestRunEventV1` records appended to the ledger. */
  readonly events: number;
  /**
   * Non-zero when this file or directory entry was refused at the surface
   * boundary. Mutually exclusive with a positive `suites` count: a refused
   * file emits exactly one `skipped` and zero suites/events.
   */
  readonly skipped: number;
  /** Diagnostic reason populated when `skipped > 0`. */
  readonly reason?: JunitImportSkipReason;
}

export interface ImportJunitFileOptions {
  /** Absolute path to the project root. */
  readonly projectRoot: string;
  /** Absolute or relative path to a single JUnit XML file. */
  readonly filePath: string;
  /** Optional framework identifier. Defaults to `'junit-xml'`. */
  readonly framework?: string;
  /** Optional opaque project key for the canonical event. Defaults to `basename(projectRoot)`. */
  readonly projectKey?: string;
  /** Optional opaque producer identifier. Defaults to `'junit-import'`. */
  readonly producerId?: string;
}

export interface ImportJunitTreeOptions {
  /** Absolute path to the project root. */
  readonly projectRoot: string;
  /** Absolute or relative path to a directory of JUnit XML files. */
  readonly rootDir: string;
  /** Optional framework identifier. Defaults to `'junit-xml'`. */
  readonly framework?: string;
  /** Optional opaque project key for canonical events. Defaults to `basename(projectRoot)`. */
  readonly projectKey?: string;
  /** Optional opaque producer identifier. Defaults to `'junit-import'`. */
  readonly producerId?: string;
}

/**
 * Import a single JUnit XML file and append one `TestRunEventV1` per
 * `<testsuite>` element. Never throws; reasons for refusal are surfaced on
 * the returned summary.
 *
 * Path-safety order: `lstat` first (catches symlinks even when their target
 * is inside the project), then `realpath` (so the inside-project check uses
 * the resolved canonical path), then the inside-project comparison. The
 * recorder (`recordTestRun`) layers its own `.hive-flow/`-segment symlink
 * guard on top when the actual write hits the ledger.
 */
export async function importJunitFile(
  opts: ImportJunitFileOptions,
): Promise<JunitImportSummary> {
  const projectRoot = resolve(opts.projectRoot);
  const framework = sanitizeFramework(opts.framework);
  const projectKey = sanitizeOpaque(opts.projectKey, basename(projectRoot));
  const producerId = sanitizeOpaque(opts.producerId, 'junit-import');

  const candidatePath = isAbsolute(opts.filePath)
    ? opts.filePath
    : resolve(projectRoot, opts.filePath);

  // Step 1: classify the leaf BEFORE any open/read.
  //   1a. lstat - detect symlinks WITHOUT following them.
  //   1b. realpath the leaf - only after step 1a has confirmed the leaf
  //       itself is not a symlink.
  //   1c. inside-project check - the canonicalized leaf must be a
  //       descendant of the canonical project root.
  const safety = await classifyLeafPath(projectRoot, candidatePath);
  if (safety.kind !== 'ok') {
    return refused(candidatePath, safety.kind);
  }

  // Step 2: bounded size probe via `stat` on the resolved real path.
  const statResult = await statSafe(safety.realPath);
  if (statResult.kind === 'not-found') return refused(safety.realPath, 'not-found');
  if (statResult.kind === 'not-regular') return refused(safety.realPath, 'not-regular');
  if (statResult.isDirectory) return refused(safety.realPath, 'not-regular');
  if (statResult.size > MAX_JUNIT_BYTES) return refused(safety.realPath, 'oversize');

  // Step 3: bounded read. We pass the byte cap directly so a TOCTOU race
  // that grows the file between `stat` and `readFile` is also rejected.
  const xmlResult = await readBoundedUtf8(safety.realPath, MAX_JUNIT_BYTES);
  if (xmlResult.kind === 'unreadable') return refused(safety.realPath, 'unreadable');
  if (xmlResult.kind === 'oversize') return refused(safety.realPath, 'oversize');

  // Step 4: parse suites. The parser is hand-rolled, linear in the input,
  // tolerant of malformed XML, and skips suites that fail validation.
  const suites = parseTestsuites(xmlResult.text);
  if (suites.length === 0) {
    return {
      filePath: safety.realPath,
      suites: 0,
      events: 0,
      skipped: 1,
      reason: 'no-suites',
    };
  }

  // Step 4a: compute a per-file source fingerprint over the raw XML text.
  // Folded into each per-suite eventId so any byte-level change in the
  // report (test reorderings, message edits, etc.) produces a fresh
  // eventId even when the headline counts coincidentally match. We hash
  // the parsed text exactly once per file, reuse it across every suite
  // in this file, and surface it on the canonical event so downstream
  // materializers can group runs by source content.
  const sourceFingerprint = createHash('sha256')
    .update(xmlResult.text)
    .digest('hex');

  // Step 5: per-suite recordTestRun. Each suite is its own event; failure
  // to record one suite never aborts the rest of the file.
  let recordedSuites = 0;
  let recordedEvents = 0;
  for (let index = 0; index < suites.length; index++) {
    const parsed = suites[index];
    if (parsed === undefined) continue;
    const outcome = await recordOneSuite({
      projectRoot,
      filePath: safety.realPath,
      index,
      parsed,
      framework,
      projectKey,
      producerId,
      sourceFingerprint,
    });
    if (outcome !== undefined) {
      recordedSuites++;
      recordedEvents++;
    }
  }

  if (recordedSuites === 0) {
    return {
      filePath: safety.realPath,
      suites: 0,
      events: 0,
      skipped: 1,
      reason: 'malformed',
    };
  }

  return {
    filePath: safety.realPath,
    suites: recordedSuites,
    events: recordedEvents,
    skipped: 0,
  };
}

/**
 * Recursively walk `rootDir` and import every `*.xml` / `*.junit.xml`
 * encountered. Symlinks are NEVER followed during the walk (round-5 fix);
 * the entrypoint itself is also subject to the symlink + inside-project
 * check via `importJunitFile`.
 *
 * Returns one `JunitImportSummary` per file visited (including refused
 * files). The summaries are ordered by traversal order so callers can
 * aggregate or log them deterministically.
 */
export async function importJunitTree(
  opts: ImportJunitTreeOptions,
): Promise<ReadonlyArray<JunitImportSummary>> {
  const projectRoot = resolve(opts.projectRoot);
  const framework = sanitizeFramework(opts.framework);
  const projectKey = sanitizeOpaque(opts.projectKey, basename(projectRoot));
  const producerId = sanitizeOpaque(opts.producerId, 'junit-import');

  const rootCandidate = isAbsolute(opts.rootDir)
    ? opts.rootDir
    : resolve(projectRoot, opts.rootDir);

  // Step 1: classify the root entrypoint.
  const safety = await classifyLeafPath(projectRoot, rootCandidate);
  if (safety.kind !== 'ok') {
    return Object.freeze([refused(rootCandidate, safety.kind)]);
  }

  // Step 2: if the entrypoint is a regular file, import it as a single file.
  const rootStat = await statSafe(safety.realPath);
  if (rootStat.kind === 'not-found') {
    return Object.freeze([refused(safety.realPath, 'not-found')]);
  }
  if (rootStat.kind === 'ok' && !rootStat.isDirectory) {
    const summary = await importJunitFile({
      projectRoot,
      filePath: safety.realPath,
      framework,
      projectKey,
      producerId,
    });
    return Object.freeze([summary]);
  }
  if (rootStat.kind === 'not-regular') {
    return Object.freeze([refused(safety.realPath, 'not-regular')]);
  }

  // Step 3: walk the directory. Symlinks are skipped (NOT followed) and
  // depth/file caps cut off pathological trees before they exhaust memory.
  const counter: WalkCounter = { files: 0 };
  const xmlFiles: string[] = [];
  await walkXmlFiles(safety.realPath, 0, counter, xmlFiles);

  const summaries: JunitImportSummary[] = [];
  for (const filePath of xmlFiles) {
    // Each per-file import re-runs the symlink + inside-project guard.
    // This is intentional: walkXmlFiles also rejects symlinks, but the
    // double-check defends against a TOCTOU race where a regular file is
    // replaced by a symlink between `readdir` and the per-file `lstat`.
    const summary = await importJunitFile({
      projectRoot,
      filePath,
      framework,
      projectKey,
      producerId,
    });
    summaries.push(summary);
  }

  return Object.freeze(summaries);
}

// ---------------------------------------------------------------------------
// Path-safety helpers
// ---------------------------------------------------------------------------

type LeafSafety =
  | { kind: 'ok'; realPath: string }
  | { kind: 'symlink' }
  | { kind: 'outside-project' }
  | { kind: 'not-found' };

async function classifyLeafPath(
  projectRoot: string,
  candidate: string,
): Promise<LeafSafety> {
  // lstat BEFORE realpath: symlinks-into-the-project must still be detected.
  let leaf: Awaited<ReturnType<typeof lstat>>;
  try {
    leaf = await lstat(candidate);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { kind: 'not-found' };
    return { kind: 'not-found' };
  }
  if (leaf.isSymbolicLink()) {
    return { kind: 'symlink' };
  }

  let rootReal: string;
  try {
    rootReal = await realpath(projectRoot);
  } catch {
    return { kind: 'not-found' };
  }
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch {
    return { kind: 'not-found' };
  }

  if (!isInsideProject(rootReal, candidateReal)) {
    return { kind: 'outside-project' };
  }
  return { kind: 'ok', realPath: candidateReal };
}

function isInsideProject(rootReal: string, candidateReal: string): boolean {
  // `relative` returns "" when paths are identical (entrypoint == root is
  // allowed), starts with ".." or an absolute path when the candidate
  // escapes the root.
  const rel = relative(rootReal, candidateReal);
  if (rel === '') return true;
  if (rel === '..') return false;
  if (rel.startsWith('..' + sep)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

type StatResult =
  | { kind: 'ok'; size: number; isDirectory: boolean }
  | { kind: 'not-regular' }
  | { kind: 'not-found' };

async function statSafe(p: string): Promise<StatResult> {
  try {
    const st = await stat(p);
    if (st.isDirectory()) {
      return { kind: 'ok', size: 0, isDirectory: true };
    }
    if (!st.isFile()) {
      return { kind: 'not-regular' };
    }
    return { kind: 'ok', size: st.size, isDirectory: false };
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { kind: 'not-found' };
    return { kind: 'not-regular' };
  }
}

type ReadResult =
  | { kind: 'ok'; text: string }
  | { kind: 'unreadable' }
  | { kind: 'oversize' };

/**
 * Hard-bounded UTF-8 read.
 *
 * Allocates exactly `maxBytes + 1` bytes of buffer once and streams the file
 * through it in capped chunks. The instant the accumulator reaches
 * `maxBytes + 1`, we close the handle and return `'oversize'`. Memory usage
 * is therefore O(`maxBytes`) regardless of how the file grew between the
 * earlier `stat()` size probe and this read (TOCTOU defence) — we never
 * load more bytes than the cap into memory.
 *
 * We do NOT use `readFile()` here because `readFile` slurps the entire file
 * into memory before the caller has a chance to reject it; a hostile or
 * grown-since-stat file could push heap usage well past the documented cap
 * before the post-read size check runs.
 */
async function readBoundedUtf8(p: string, maxBytes: number): Promise<ReadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(p, 'r');
  } catch {
    return { kind: 'unreadable' };
  }
  try {
    // Fixed allocation: `maxBytes + 1` lets us detect the overflow byte
    // (anything strictly larger than `maxBytes`) without ever growing past
    // it. 64 KiB streaming chunks match the rest of the statusline IO and
    // keep per-iteration syscall cost predictable.
    const buf = Buffer.alloc(maxBytes + 1);
    const chunkSize = 64 * 1024;
    let totalRead = 0;
    while (totalRead <= maxBytes) {
      const room = maxBytes + 1 - totalRead;
      if (room <= 0) break;
      const want = room < chunkSize ? room : chunkSize;
      let chunk: { bytesRead: number };
      try {
        chunk = await handle.read(buf, totalRead, want, null);
      } catch {
        return { kind: 'unreadable' };
      }
      if (chunk.bytesRead === 0) break;
      totalRead += chunk.bytesRead;
      if (totalRead > maxBytes) {
        // Hard cap: abort BEFORE the next read can grow `buf` further.
        // `buf` is `maxBytes + 1` bytes, so even the overflow byte itself
        // is bounded.
        return { kind: 'oversize' };
      }
    }
    return { kind: 'ok', text: buf.subarray(0, totalRead).toString('utf8') };
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing a handle on an unreadable file may already have failed;
      // suppress so we don't leak the inner error past the caller.
    }
  }
}

// ---------------------------------------------------------------------------
// Hand-rolled XML parser
// ---------------------------------------------------------------------------

/** Parsed shape of one `<testsuite>` element. */
interface ParsedTestsuite {
  readonly name: string | undefined;
  readonly total: number;
  readonly failed: number;
  readonly skipped: number;
  readonly passed: number;
  readonly durationMs: number | undefined;
}

/**
 * CDATA + comment stripper. Both forms can contain `<testsuite ...>`
 * substrings that would otherwise be picked up by the regex parser, so we
 * remove them BEFORE the open-tag scan.
 *
 * The replacement uses two narrowly-anchored regexes:
 *   `<![CDATA[ ... ]]>` and `<!-- ... -->`. Each pattern is linear in its
 *   own (bounded) match span; neither uses catastrophic-backtracking
 *   alternation against the rest of the document.
 */
function stripCdataAndComments(xml: string): string {
  return xml
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Scan stripped XML for `<testsuite ...>` open tags and parse the
 * attribute list of each one. Tolerates malformed or missing attributes: a
 * suite with no `tests` attribute is treated as `tests=0`. A suite whose
 * counts cannot be reconciled (`failed + skipped > total`) is corrected by
 * deriving `passed = max(0, total - failed - skipped)` rather than thrown
 * out - the task brief explicitly calls for arithmetic correction here.
 *
 * Returns one parsed shape per open tag; the order matches the order of
 * occurrence in the document so deterministic per-suite event indices
 * stay stable across runs.
 */
function parseTestsuites(xml: string): ParsedTestsuite[] {
  const stripped = stripCdataAndComments(xml);
  const out: ParsedTestsuite[] = [];

  // Linear, anchored regex: matches the literal open tag with bounded
  // attribute span. The `[^>]*` segment is bounded by the closing `>` and
  // cannot match across multiple tags.
  const openTag = /<testsuite\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = openTag.exec(stripped)) !== null) {
    const attrSpan = match[1] ?? '';
    const attrs = parseAttributes(attrSpan);
    const total = nonNegativeIntegerOrZero(attrs.tests);
    const failures = nonNegativeIntegerOrZero(attrs.failures);
    const errors = nonNegativeIntegerOrZero(attrs.errors);
    const skipped = nonNegativeIntegerOrZero(attrs.skipped);
    const failed = failures + errors;
    // Round-5 brief: derive passed = max(0, total - failed - skipped) to
    // tolerate arithmetic that doesn't sum. We never throw on a count
    // mismatch - the importer is best-effort.
    const passedRaw = total - failed - skipped;
    const passed = passedRaw < 0 ? 0 : passedRaw;
    // When tests < failed + skipped, also clamp total to keep the recorder's
    // arithmetic invariant happy: passed + failed + skipped === total.
    const correctedTotal = passed + failed + skipped;
    const durationMs = nonNegativeMillisFromSecondsOrUndefined(attrs.time);

    out.push({
      name: attrs.name === undefined || attrs.name === '' ? undefined : attrs.name,
      total: correctedTotal,
      failed,
      skipped,
      passed,
      durationMs,
    });
  }
  return out;
}

/**
 * Parse the attribute-list region of an open tag. Accepts double-quoted
 * or single-quoted values; ignores attributes whose value contains
 * unescaped quote-mismatches. Linear scan over the input.
 */
function parseAttributes(span: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Pattern: name = "value" | name = 'value'. The character classes for
  // the name match the XML 1.0 NameStartChar / NameChar in their ASCII
  // subset, which is sufficient for JUnit emitters in the wild.
  // No catastrophic backtracking: each segment is anchored and the value
  // characters are restricted to the non-quote class.
  const attrPattern = /([A-Za-z_:][\w:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrPattern.exec(span)) !== null) {
    const key = m[1];
    if (key === undefined) continue;
    const valueDouble = m[2];
    const valueSingle = m[3];
    const value = valueDouble !== undefined ? valueDouble : (valueSingle ?? '');
    // Decode the small set of XML entities a JUnit emitter may produce.
    // We intentionally avoid a full entity decoder; only these five are
    // used by every real-world emitter we have observed.
    out[key] = decodeXmlEntities(value);
  }
  return out;
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function nonNegativeIntegerOrZero(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  // Reject anything that isn't a plain integer literal. `Number('oops')`
  // returns `NaN`; `Number('1.5')` returns a non-integer; both degrade to 0.
  if (!/^[+-]?\d+$/.test(trimmed)) return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
}

function nonNegativeMillisFromSecondsOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // JUnit `time` is seconds-as-float. Accept integers and fractions.
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

// ---------------------------------------------------------------------------
// Per-suite recorder
// ---------------------------------------------------------------------------

interface RecordOneSuiteArgs {
  readonly projectRoot: string;
  readonly filePath: string;
  readonly index: number;
  readonly parsed: ParsedTestsuite;
  readonly framework: string;
  readonly projectKey: string;
  readonly producerId: string;
  /**
   * Content-derived fingerprint of the raw XML file. Folded into the
   * deterministic eventId so two imports of the same `filePath` with
   * different XML bytes (e.g. a pass-to-fail flip that does NOT change
   * the count summary, or a re-run that adds new test cases) mint
   * distinct eventIds and reach the ledger instead of being deduped.
   */
  readonly sourceFingerprint: string;
}

async function recordOneSuite(args: RecordOneSuiteArgs): Promise<RecordTestRunOutcome | undefined> {
  // Recorder enforces `passed + failed + skipped === total` and throws a
  // typed `TestRunArithmeticError` if violated. Our `parseTestsuites`
  // already corrects the total so a violation here is a programmer bug,
  // but we still swallow exceptions so the per-tree walker keeps going.
  //
  // The recorder derives `durationMs` from the (startedAt, finishedAt)
  // pair, NOT from a direct `durationMs` input. To surface the JUnit
  // `time` attribute on the canonical event we must therefore synthesize
  // a matching start/finish pair: `finishedAt = now`, `startedAt = now -
  // durationMs`. When the suite carries no `time` attribute we omit both
  // timestamps so the recorder stamps `durationMs: 0` (its "no real
  // duration was reported" sentinel).
  try {
    const timestamps = synthesizeTimestamps(args.parsed.durationMs);
    const eventId = buildDeterministicEventId({
      projectRoot: args.projectRoot,
      filePath: args.filePath,
      suiteName: args.parsed.name,
      suiteIndex: args.index,
      framework: args.framework,
      total: args.parsed.total,
      failed: args.parsed.failed,
      skipped: args.parsed.skipped,
      sourceFingerprint: args.sourceFingerprint,
    });
    const outcome = await recordTestRun({
      projectRoot: args.projectRoot,
      input: {
        kind: 'suite',
        framework: args.framework,
        projectKey: args.projectKey,
        repoRoot: args.projectRoot,
        producerKind: PRODUCER_KIND,
        producerId: args.producerId,
        passed: args.parsed.passed,
        failed: args.parsed.failed,
        skipped: args.parsed.skipped,
        total: args.parsed.total,
        eventId,
        sourceFingerprint: args.sourceFingerprint,
        ...(args.parsed.name !== undefined ? { scope: args.parsed.name } : {}),
        ...(timestamps !== undefined
          ? { startedAt: timestamps.startedAt, finishedAt: timestamps.finishedAt }
          : {}),
      },
    });
    void buildSuiteFingerprint(args, outcome.event);
    return outcome;
  } catch {
    return undefined;
  }
}

/**
 * Compute a DETERMINISTIC eventId for the suite. Inputs (ordered, all
 * derived from parsed XML or stable file-path identifiers — never from
 * the wall clock):
 *
 *   - the suite's relative path under the project root (anchors source),
 *   - the suite name (or its in-file index when unnamed),
 *   - the framework string (anchors which producer's semantics apply),
 *   - the headline counts `total`, `failed`, `skipped` (Codex Phase-7
 *     blocker: a pass-to-fail re-run that does NOT change the file path
 *     or suite name MUST mint a fresh eventId so the recorder appends
 *     the new outcome instead of deduping it away),
 *   - the per-file content fingerprint (catches XML edits that don't
 *     surface in the headline counts, e.g. a test case rename or a
 *     different ordering that still passes the same totals).
 *
 * Intentionally NOT in the hash input: timestamps, mtime, `Date.now`,
 * `startedAt`/`finishedAt`, or any other clock-derived value. Including
 * any of those would make a re-import of the SAME XML produce a fresh
 * eventId, defeating the recorder's single-field dedupe and re-appending
 * a duplicate ledger row on every re-import. We preserve idempotency by
 * deriving every input from the parsed XML or stable file identifiers.
 *
 * Output is a 64-char SHA-256 hex digest (no length validation upstream,
 * full entropy = effectively zero collision risk across suites in the
 * lifetime of any plausible repository).
 */
interface DeterministicEventIdArgs {
  readonly projectRoot: string;
  readonly filePath: string;
  readonly suiteName: string | undefined;
  readonly suiteIndex: number;
  readonly framework: string;
  readonly total: number;
  readonly failed: number;
  readonly skipped: number;
  /**
   * Optional but recommended: content-derived fingerprint of the parent
   * XML file. When omitted, the hash falls back to path + counts only.
   */
  readonly sourceFingerprint?: string;
}

function buildDeterministicEventId(args: DeterministicEventIdArgs): string {
  // `relative` may emit platform-specific separators (`\` on Windows). We
  // normalise to forward-slash so an XML file imported on Windows and the
  // same file checked-in then imported on Linux produce the SAME eventId.
  const relRaw = relative(args.projectRoot, args.filePath);
  const relPath = relRaw.split(sep).join('/');
  // `suiteName` may be undefined (anonymous `<testsuite>` tags). Use the
  // in-file index as a deterministic tiebreaker so two anonymous suites in
  // the same file still get distinct eventIds.
  const suiteKey =
    args.suiteName !== undefined && args.suiteName !== ''
      ? `name=${args.suiteName}`
      : `idx=${args.suiteIndex}`;
  // All inputs are pushed onto a strictly ordered parts array - no
  // `Object.keys()` iteration, no map traversal - so a JS engine that
  // reorders object property iteration cannot change the hash.
  const parts: string[] = [
    'junit-import',
    relPath,
    suiteKey,
    args.framework,
    `total=${args.total}`,
    `failed=${args.failed}`,
    `skipped=${args.skipped}`,
  ];
  if (args.sourceFingerprint !== undefined && args.sourceFingerprint !== '') {
    parts.push(`fp=${args.sourceFingerprint}`);
  }
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

/**
 * Build a (startedAt, finishedAt) pair whose difference equals
 * `durationMs`. The recorder uses this difference as the canonical
 * `durationMs` on the emitted `TestRunEventV1`. Returns `undefined` when
 * the suite did not declare a `time` attribute so the recorder stamps its
 * own "no-duration" sentinel.
 */
function synthesizeTimestamps(
  durationMs: number | undefined,
): { startedAt: string; finishedAt: string } | undefined {
  if (durationMs === undefined) return undefined;
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const finishedAt = new Date();
  const startedAt = new Date(finishedAt.getTime() - durationMs);
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

/**
 * Reserved for future use: the runbook anticipates folding per-suite
 * fingerprints into a `tests/source-fingerprint.json` marker so repeated
 * imports of the same report tree are detected at the materializer.
 * Wave-13 deliberately does not write this file (it belongs to the tests
 * collector); the helper is kept here only as a typed placeholder so the
 * import surface stays stable.
 */
function buildSuiteFingerprint(_args: RecordOneSuiteArgs, _event: TestRunEventV1): void {
  // Intentionally empty. The collector owns the fingerprint marker.
}

// ---------------------------------------------------------------------------
// Tree walker
// ---------------------------------------------------------------------------

interface WalkCounter {
  files: number;
}

async function walkXmlFiles(
  dir: string,
  depth: number,
  counter: WalkCounter,
  out: string[],
): Promise<void> {
  if (depth > MAX_JUNIT_DEPTH) return;
  if (counter.files >= MAX_JUNIT_FILES) return;

  let entries: ReadonlyArray<Dirent>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Deterministic ordering: sort by name so tests can assert ordering of
  // returned summaries without relying on filesystem entry order.
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    if (counter.files >= MAX_JUNIT_FILES) return;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isIgnoredDirName(entry.name)) continue;
      // Re-lstat to confirm the dirent's type AND to detect symlinks. We
      // do NOT recurse into symlinked directories (round-5 finding).
      const link = await lstatSafe(full);
      if (link === undefined || link.isSymbolicLink()) continue;
      if (!link.isDirectory()) continue;
      await walkXmlFiles(full, depth + 1, counter, out);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!isJunitXmlFilename(entry.name)) continue;

    // Lstat to reject symlinked files. A symlink in a JUnit dump dir is
    // a hostile-input signal; the per-file `importJunitFile` will also
    // catch it, but we cut it off here so we never even count it.
    const link = await lstatSafe(full);
    if (link === undefined || link.isSymbolicLink()) continue;
    if (!link.isFile()) continue;

    counter.files++;
    out.push(full);
  }
}

async function lstatSafe(p: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await lstat(p);
  } catch {
    return undefined;
  }
}

function isJunitXmlFilename(name: string): boolean {
  // The runbook spec lists `*.xml` and `*.junit.xml`. We accept any `.xml`
  // (which subsumes `.junit.xml`). Use case-insensitive comparison so
  // emitters that capitalise `.XML` still match.
  const lower = name.toLowerCase();
  return lower.endsWith('.xml');
}

const IGNORED_DIR_BASENAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.hive-flow',
  '.cache',
  '.turbo',
  '.next',
  '.nuxt',
  '.vite',
  '.parcel-cache',
  '.yarn',
  'dist',
  'build',
  'out',
]);

function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIR_BASENAMES.has(name);
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function sanitizeFramework(raw: string | undefined): string {
  if (typeof raw !== 'string') return DEFAULT_JUNIT_FRAMEWORK;
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_JUNIT_FRAMEWORK;
  return trimmed.length > 128 ? trimmed.slice(0, 128) : trimmed;
}

function sanitizeOpaque(raw: string | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  return trimmed.length > 128 ? trimmed.slice(0, 128) : trimmed;
}

function refused(
  filePath: string,
  reason: JunitImportSkipReason,
): JunitImportSummary {
  return {
    filePath,
    suites: 0,
    events: 0,
    skipped: 1,
    reason,
  };
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
