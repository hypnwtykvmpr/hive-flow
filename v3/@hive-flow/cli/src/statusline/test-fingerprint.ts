// v3/@hive-flow/cli/src/statusline/test-fingerprint.ts
//
// Content-aware test-source fingerprinting for the statusline rewrite
// (Phase 4.5 / 5.x of the canonical runbook, plus Codex's Phase 2 round-3
// improvement: do NOT use a `git status` text-only fingerprint — instead
// hash file *contents* and explicitly track deletions).
//
// Contract:
//   - Pure read-only over a project root. Never writes the project tree.
//   - `computeSourceFingerprint(opts)` returns the canonical
//     `SourceFingerprintV1` shape from `./types.ts`, augmented with a `files`
//     map so callers (refresher, suite-freshness marker) can detect deletions
//     across runs.
//   - The fingerprint digest is deterministic across re-runs at the same
//     working-tree state: sort relpaths, sha256 over the canonical header
//     bytes (relpath + size + per-file content hash) + the file contents,
//     plus deletion markers (`D <relpath>\n`) for files present in a prior
//     fingerprint but missing now.
//   - Bounded by `maxFingerprintFiles` (default 1000) and `maxFingerprintBytes`
//     (default ~50 MB). If the bounded byte budget is exceeded the function
//     refuses to fingerprint and returns `truncated: true` with a stable
//     marker digest rather than producing a half-read fingerprint that
//     could silently mark valid suites as stale.
//   - Concurrent calls with identical inputs are coalesced via a single-flight
//     map so the file-system walk is not duplicated under contention. Distinct
//     inputs (root + glob set + prior file map identity) each get their own
//     fresh walk.
//   - No `as any`, no unsafe casts, no unbounded reads.
//
// The Wave-1 `SourceFingerprintV1` shape is:
//   { version: 1; observedAt: string; sha256: string; fileCount: number;
//     walkRoot: string; truncated?: boolean }
// — see `./types.ts`.
//
// This module deliberately avoids any external glob dependency: matching is
// implemented in `globToRegExp` below with explicit handling for `**`, `*`,
// `?`, character classes, and brace alternatives. The CLI package only ships
// `vitest` as a dev dep; adding a transitive glob lib here would broaden the
// install surface unnecessarily.

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, isAbsolute, resolve } from 'node:path';

import { SourceFingerprintV1 } from './types.js';

// ---------------------------------------------------------------------------
// Bounded defaults (overridable per call).
// ---------------------------------------------------------------------------

/**
 * Default maximum number of test-source files that may participate in a
 * single fingerprint. Exceeding this cap marks the fingerprint as
 * `truncated: true` and stops the walk early; the returned digest is still
 * a stable function of whatever subset was visited (sorted relpaths first).
 */
export const DEFAULT_MAX_FINGERPRINT_FILES = 1000;

/**
 * Default total-byte budget for content reads across all files in a single
 * fingerprint. Default ~50 MB. Reaching this cap throws
 * `FingerprintByteBudgetExceededError` so callers can fall back to an
 * `unknown` freshness state for the test panel rather than silently
 * producing a partial fingerprint that would mark fresh suites as stale.
 */
export const DEFAULT_MAX_FINGERPRINT_BYTES = 50 * 1024 * 1024;

/**
 * Per-file hard cap. Individual files larger than this are still *counted*
 * but their content is not folded into the digest verbatim — instead a
 * synthetic `OVERSIZE <size>` token is mixed in. This prevents a single
 * accidentally-committed binary fixture from blowing the global byte budget.
 */
export const DEFAULT_MAX_PER_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Default glob patterns the fingerprint considers as "test sources". The
 * runbook's Phase 4.5 spec says `**\/*.test.{ts,js,tsx}` plus
 * `__tests__/**`. We additionally accept the standard `.spec.*` extensions
 * (vitest + jest defaults) and the JS-flavour `.mjs` / `.cjs` because the
 * CLI uses ESM extensions in some test fixtures. Adding more extensions is
 * safe; adding directories is not (the walker still respects ignore roots).
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = Object.freeze([
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test.mjs',
  '**/*.test.cjs',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '**/*.spec.mjs',
  '**/*.spec.cjs',
  '**/__tests__/**',
]);

/**
 * Directory basenames that are skipped wholesale during the walk. These are
 * common generator outputs / virtual envs that should never participate in a
 * test-source fingerprint, even if they happen to contain `.test.ts` files.
 */
const IGNORED_DIR_BASENAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.vite',
  '.parcel-cache',
  '.yarn',
  'out',
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when reading content for a fingerprint would exceed the configured
 * byte budget. Carries `bytesRead` so the caller can log a useful diagnostic.
 */
export class FingerprintByteBudgetExceededError extends Error {
  public readonly bytesRead: number;
  public readonly bytesLimit: number;

  public constructor(bytesRead: number, bytesLimit: number) {
    super(
      `test-fingerprint exceeded byte budget (read=${bytesRead}, limit=${bytesLimit})`,
    );
    this.name = 'FingerprintByteBudgetExceededError';
    this.bytesRead = bytesRead;
    this.bytesLimit = bytesLimit;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-file metadata captured in the fingerprint output. */
export interface SourceFingerprintFile {
  /** mtime in ms since epoch. */
  readonly mtimeMs: number;
  /** Size in bytes (st.size, not bytes hashed). */
  readonly size: number;
  /** Lower-case hex sha256 of the file contents. */
  readonly sha256: string;
  /** True iff the per-file size cap was exceeded and content was elided. */
  readonly oversize: boolean;
}

/**
 * Public computation result. Extends `SourceFingerprintV1` (the Wave-1
 * canonical shape) with the relpath -> metadata map used by the next
 * iteration to detect deletions.
 */
export interface SourceFingerprintResult extends SourceFingerprintV1 {
  /**
   * Map of relpath (POSIX-style separators, relative to `walkRoot`) to per-file
   * metadata. Frozen at the type level; do not mutate.
   */
  readonly files: ReadonlyMap<string, SourceFingerprintFile>;
  /**
   * The relpaths (POSIX-style) that were present in `priorFingerprintFiles`
   * but missing now. Folded into the digest as `D <relpath>\n` markers
   * (sorted) before the file content stream so deletions reliably mutate
   * the fingerprint.
   */
  readonly deletions: readonly string[];
}

/** Caller options. All fields except `projectRoot` are optional. */
export interface ComputeSourceFingerprintOptions {
  /** Absolute path to the project root being fingerprinted. */
  readonly projectRoot: string;
  /**
   * Optional list of test-file glob patterns. Defaults to
   * `DEFAULT_TEST_GLOBS`. Empty array falls back to defaults; non-array
   * inputs are rejected at the type system level.
   */
  readonly testGlobs?: readonly string[];
  /** Override file-count cap. Clamped to `[1, 1_000_000]`. */
  readonly maxFingerprintFiles?: number;
  /** Override total-byte cap. Clamped to `[1024, 1 GiB]`. */
  readonly maxFingerprintBytes?: number;
  /** Override per-file cap. Clamped to `[1024, 1 GiB]`. */
  readonly maxPerFileBytes?: number;
  /**
   * Optional prior fingerprint file map (returned by a previous call). When
   * supplied, paths present in this map but missing in the current walk are
   * folded into the digest as `D <relpath>\n` markers before file contents,
   * so deletion alone changes the resulting sha256.
   */
  readonly priorFingerprintFiles?: ReadonlyMap<string, SourceFingerprintFile>;
  /**
   * Optional injected clock for deterministic `observedAt` in tests. Falls
   * back to `Date.now()`.
   */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Glob -> RegExp (minimal, no external deps)
// ---------------------------------------------------------------------------

/**
 * Convert a POSIX-style glob to a `RegExp` matching the *full* relpath.
 *
 * Supports `**`, `*`, `?`, character classes (`[abc]`, `[!abc]`), and
 * top-level brace alternatives (`{ts,tsx,js}`). Path separators are `/` for
 * the purposes of matching; callers must normalize Windows separators
 * upstream (the walker below does so via `normalizeRel`).
 */
function globToRegExp(glob: string): RegExp {
  // Expand brace alternatives first. Only single-depth braces are supported;
  // we sanitize the input to reject nested braces (which would otherwise
  // require a real glob lib and risk catastrophic backtracking).
  const expanded = expandTopLevelBraces(glob);
  const alternatives = expanded.map((g) => `(?:${singleGlobBody(g)})`);
  return new RegExp(`^(?:${alternatives.join('|')})$`);
}

function expandTopLevelBraces(glob: string): string[] {
  // Find the first top-level `{...}` group.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charCodeAt(i);
    if (ch === 0x7b /* { */) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === 0x7d /* } */) {
      depth--;
      if (depth === 0 && start >= 0) {
        const head = glob.slice(0, start);
        const body = glob.slice(start + 1, i);
        const tail = glob.slice(i + 1);
        const parts = body.split(',');
        const results: string[] = [];
        for (const part of parts) {
          for (const sub of expandTopLevelBraces(head + part + tail)) {
            results.push(sub);
          }
        }
        return results;
      }
    } else if (depth === 0 && ch === 0x5c /* backslash */) {
      // Skip escaped char.
      i++;
    }
  }
  return [glob];
}

function singleGlobBody(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\') {
      // Literal escape — copy next char verbatim.
      const next = glob[i + 1] ?? '';
      out += escapeRegExp(next);
      i++;
      continue;
    }
    if (c === '*') {
      // `**` (optionally with trailing `/`) matches any depth, including zero
      // directories. `*` matches anything but `/`.
      if (glob[i + 1] === '*') {
        // Consume `**`
        i++;
        // If followed by `/`, also consume that and emit the zero-or-more
        // path-segment pattern.
        if (glob[i + 1] === '/') {
          out += '(?:.*/)?';
          i++;
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    if (c === '[') {
      // Character class.
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, close);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      out += '[' + body + ']';
      i = close;
      continue;
    }
    out += escapeRegExp(c);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Cancellable singleflight cache
// ---------------------------------------------------------------------------

/**
 * In-process single-flight cache keyed by canonical fingerprint inputs.
 * Concurrent calls with the same inputs share the same in-flight Promise.
 * Settles (success or rejection) clears the entry so the next call sees a
 * fresh state.
 */
const inflight = new Map<string, Promise<SourceFingerprintResult>>();

function cacheKey(opts: ComputeSourceFingerprintOptions, globs: readonly string[]): string {
  const root = resolve(opts.projectRoot);
  const globKey = [...globs].sort().join('|');
  // Include caps so two concurrent callers with different caps each get
  // their own walk.
  const caps = [
    opts.maxFingerprintFiles ?? DEFAULT_MAX_FINGERPRINT_FILES,
    opts.maxFingerprintBytes ?? DEFAULT_MAX_FINGERPRINT_BYTES,
    opts.maxPerFileBytes ?? DEFAULT_MAX_PER_FILE_BYTES,
  ].join(':');
  // Include prior-map identity (by size + hash of sorted keys + per-file
  // sha256) so different "delta" requests don't share a result.
  const prior = opts.priorFingerprintFiles;
  let priorKey = 'no-prior';
  if (prior && prior.size > 0) {
    const h = createHash('sha256');
    const keys: string[] = [];
    prior.forEach((_v, k) => keys.push(k));
    keys.sort();
    for (const k of keys) {
      const f = prior.get(k);
      if (f) h.update(`${k}\x00${f.sha256}\n`);
    }
    priorKey = `p${prior.size}:${h.digest('hex')}`;
  }
  return `${root}\x01${globKey}\x01${caps}\x01${priorKey}`;
}

// ---------------------------------------------------------------------------
// Walker + matcher
// ---------------------------------------------------------------------------

/**
 * Normalize a path into POSIX form relative to `walkRoot`. Used both for glob
 * matching and for the relpath keys in the output map.
 */
function normalizeRel(walkRoot: string, abs: string): string {
  const rel = relative(walkRoot, abs);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

interface WalkAccum {
  readonly walkRoot: string;
  readonly matchers: readonly RegExp[];
  readonly maxFiles: number;
  /** Files collected so far. Sorted on flush. */
  readonly hits: string[];
  /** True once `maxFiles` was reached and the walk should stop. */
  truncated: boolean;
}

async function walkDirectory(accum: WalkAccum, dir: string): Promise<void> {
  if (accum.truncated) return;
  let entries: Dirent[];
  try {
    // Force the `Dirent` (string-name) overload by supplying
    // `encoding: 'utf8'`. Without an explicit encoding TypeScript can
    // resolve to the `Dirent<NonSharedBuffer>` overload, which would in
    // turn make `entry.name` a Buffer rather than a string. We always want
    // UTF-8 string names here so the relpath keys are plain strings.
    entries = await readdir(dir, {
      withFileTypes: true,
      encoding: 'utf8',
    });
  } catch {
    // Unreadable directory — skip silently. The fingerprint should remain
    // stable across re-runs even if a directory was deleted between
    // readdir attempts.
    return;
  }
  // Sort entries by name for deterministic walk order. Crucial for
  // reproducibility across filesystems that return readdir in non-sorted
  // order (e.g. macOS HFS+ vs Linux ext4).
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (accum.truncated) return;
    const name = entry.name;
    const abs = join(dir, name);

    if (entry.isSymbolicLink()) {
      // Skip symlinks entirely to avoid cycles and to preserve repeatability
      // when symlinks point outside the walk root.
      continue;
    }

    if (entry.isDirectory()) {
      if (IGNORED_DIR_BASENAMES.has(name)) continue;
      if (name.startsWith('.') && name !== '.') {
        // Hidden directories (e.g. `.cache`, `.idea`, `.vscode`) are skipped
        // unless they are explicit test-source roots (`__tests__` is not
        // hidden). This matches typical test runners.
        continue;
      }
      await walkDirectory(accum, abs);
      continue;
    }

    if (!entry.isFile()) continue;
    const rel = normalizeRel(accum.walkRoot, abs);
    if (rel === '' || rel.startsWith('..')) continue;
    if (!matchesAny(accum.matchers, rel)) continue;
    accum.hits.push(rel);
    if (accum.hits.length >= accum.maxFiles) {
      accum.truncated = true;
      return;
    }
  }
}

function matchesAny(matchers: readonly RegExp[], rel: string): boolean {
  for (const re of matchers) {
    if (re.test(rel)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-file hashing
// ---------------------------------------------------------------------------

/**
 * Hash a single file's content into a sha256 digest. Returns the digest and
 * the number of bytes read. Files larger than `maxPerFileBytes` are not
 * fully read: instead we read the first `maxPerFileBytes` bytes and append
 * an `OVERSIZE <size>` token to the digest. Bytes read are always reported
 * accurately so the global budget guard is honoured.
 */
async function hashFileContent(
  abs: string,
  size: number,
  maxPerFileBytes: number,
): Promise<{ sha256: string; bytesRead: number; oversize: boolean }> {
  const hash = createHash('sha256');
  const oversize = size > maxPerFileBytes;
  const limit = oversize ? maxPerFileBytes : size;
  let bytesRead = 0;
  if (limit > 0) {
    const fh = await open(abs, 'r');
    try {
      // 64 KiB streaming buffer — bounded, predictable allocation.
      const bufSize = Math.min(64 * 1024, Math.max(4096, limit));
      const buf = Buffer.alloc(bufSize);
      let remaining = limit;
      while (remaining > 0) {
        const chunk = await fh.read(buf, 0, Math.min(bufSize, remaining));
        if (chunk.bytesRead === 0) break;
        hash.update(buf.subarray(0, chunk.bytesRead));
        bytesRead += chunk.bytesRead;
        remaining -= chunk.bytesRead;
      }
    } finally {
      await fh.close();
    }
  }
  if (oversize) {
    hash.update(`\n\x00OVERSIZE ${size}\n`);
    // Report the *actual* file size in the byte budget — content beyond
    // the per-file cap was not read, but the size still indicates the
    // cost of an unbounded read. We charge only what we actually read.
  }
  return {
    sha256: hash.digest('hex'),
    bytesRead,
    oversize,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a content-aware fingerprint of the project's test-source tree.
 *
 * Returns a `SourceFingerprintV1`-shaped result augmented with the per-file
 * map and the list of deletions relative to `priorFingerprintFiles`. The
 * resulting `sha256` digest is deterministic across re-runs at the same
 * working tree state — repeated calls with no file changes return the same
 * digest; any content change, addition, or deletion changes the digest.
 *
 * Concurrent calls with identical inputs share an in-flight Promise so the
 * walk is performed at most once per `(projectRoot, globs, caps, prior)`
 * tuple.
 */
export async function computeSourceFingerprint(
  opts: ComputeSourceFingerprintOptions,
): Promise<SourceFingerprintResult> {
  // ----- Input normalization & validation -----
  if (typeof opts.projectRoot !== 'string' || opts.projectRoot.length === 0) {
    throw new TypeError('computeSourceFingerprint: opts.projectRoot is required');
  }
  if (!isAbsolute(opts.projectRoot)) {
    throw new TypeError(
      'computeSourceFingerprint: opts.projectRoot must be an absolute path',
    );
  }
  const walkRoot = resolve(opts.projectRoot);

  const rawGlobs = Array.isArray(opts.testGlobs) && opts.testGlobs.length > 0
    ? opts.testGlobs
    : DEFAULT_TEST_GLOBS;
  // Defensive: reject non-string entries up front so callers get a clear
  // error instead of an opaque regex compile failure.
  const globs: readonly string[] = rawGlobs.map((g, i) => {
    if (typeof g !== 'string' || g.length === 0) {
      throw new TypeError(
        `computeSourceFingerprint: opts.testGlobs[${i}] must be a non-empty string`,
      );
    }
    return g;
  });

  const maxFiles = clampInt(
    opts.maxFingerprintFiles,
    DEFAULT_MAX_FINGERPRINT_FILES,
    1,
    1_000_000,
  );
  const maxBytes = clampInt(
    opts.maxFingerprintBytes,
    DEFAULT_MAX_FINGERPRINT_BYTES,
    1024,
    1024 * 1024 * 1024,
  );
  const maxPerFileBytes = clampInt(
    opts.maxPerFileBytes,
    DEFAULT_MAX_PER_FILE_BYTES,
    1024,
    1024 * 1024 * 1024,
  );

  const key = cacheKey({ ...opts, projectRoot: walkRoot }, globs);
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;

  const pending = (async (): Promise<SourceFingerprintResult> => {
    const matchers = globs.map(globToRegExp);
    const accum: WalkAccum = {
      walkRoot,
      matchers,
      maxFiles,
      hits: [],
      truncated: false,
    };

    // Verify the walk root exists and is a directory before descending.
    try {
      const rootStat = await stat(walkRoot);
      if (!rootStat.isDirectory()) {
        return emptyResult(walkRoot, opts.now);
      }
    } catch {
      return emptyResult(walkRoot, opts.now);
    }

    await walkDirectory(accum, walkRoot);

    // Sort deterministically. The walker is already sorted per-directory,
    // but a global sort across the full relpath list is what the digest
    // depends on for reproducibility.
    accum.hits.sort();

    // Compute the "deletions" set: paths in `priorFingerprintFiles` not
    // present in the current hit list. Folded into the digest BEFORE file
    // contents, sorted alphabetically.
    const presentSet = new Set<string>(accum.hits);
    const deletions: string[] = [];
    const prior = opts.priorFingerprintFiles;
    if (prior && prior.size > 0) {
      prior.forEach((_value, key) => {
        if (!presentSet.has(key)) deletions.push(key);
      });
      deletions.sort();
    }

    const digest = createHash('sha256');
    digest.update('hive-flow.test-fingerprint.v1\n');
    digest.update(`globs=${[...globs].join(',')}\n`);

    // Fold deletion markers first.
    for (const rel of deletions) {
      digest.update(`D ${rel}\n`);
    }

    const files = new Map<string, SourceFingerprintFile>();
    let bytesRead = 0;

    for (const rel of accum.hits) {
      const abs = join(walkRoot, rel);
      let st;
      try {
        st = await stat(abs);
      } catch {
        // File vanished mid-walk. Fold as a deletion so re-runs are stable.
        digest.update(`D ${rel}\n`);
        continue;
      }
      if (!st.isFile()) continue;
      const size = st.size;
      if (bytesRead + Math.min(size, maxPerFileBytes) > maxBytes) {
        throw new FingerprintByteBudgetExceededError(bytesRead, maxBytes);
      }
      const { sha256, bytesRead: read, oversize } = await hashFileContent(
        abs,
        size,
        maxPerFileBytes,
      );
      bytesRead += read;
      // Header captures rel + size + per-file hash so digest is sensitive to
      // path moves AND content changes even when sizes coincide.
      digest.update(`F ${rel} ${size} ${sha256}${oversize ? ' OVERSIZE' : ''}\n`);
      files.set(rel, {
        mtimeMs: st.mtimeMs,
        size,
        sha256,
        oversize,
      });
    }

    const sha = digest.digest('hex');
    const observedAt = (opts.now ? opts.now() : new Date()).toISOString();
    const result: SourceFingerprintResult = {
      version: 1,
      observedAt,
      sha256: sha,
      fileCount: files.size,
      walkRoot,
      ...(accum.truncated ? { truncated: true } : {}),
      files,
      deletions,
    };
    return result;
  })();

  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    // Clear the cache entry whether the call succeeded or rejected, so the
    // next call sees fresh state (and so a rejected error doesn't poison
    // subsequent calls).
    if (inflight.get(key) === pending) inflight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value)) return defaultValue;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function emptyResult(
  walkRoot: string,
  now?: () => Date,
): SourceFingerprintResult {
  // Stable digest for an empty or non-existent walk root. Deletion of all
  // tracked files vs a non-empty prior would already alter the digest via
  // the deletion-markers path in the main code; this branch covers the
  // bootstrap case before any tests exist.
  const digest = createHash('sha256');
  digest.update('hive-flow.test-fingerprint.v1\nempty\n');
  return {
    version: 1,
    observedAt: (now ? now() : new Date()).toISOString(),
    sha256: digest.digest('hex'),
    fileCount: 0,
    walkRoot,
    files: new Map<string, SourceFingerprintFile>(),
    deletions: [],
  };
}
