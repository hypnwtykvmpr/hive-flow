// v3/@hive-flow/cli/src/statusline/storage.ts
//
// Wave 2 of the statusline rewrite. Bounded, atomic, symlink-safe storage
// primitives for the statusline ledgers, materialized snapshots, and spool.
//
// Design constraints (from the canonical runbook + Phase 5 patches):
//   - Reads are bounded by `MAX_JSONL_BYTES` / `MAX_JSONL_LINE_BYTES` and
//     classify the target via `lstat` so dangling/circular symlinks never
//     materialize a follow-the-link read.
//   - Writes go through `atomicWrite` (write-to-temp -> fsync -> rename) from
//     `integrations/atomic-merge.ts`. Sensitive markers land at mode 0o600;
//     append-only ledgers retain 0o600 (private to the project user).
//   - Locking is O_EXCL with stale-steal via `process.kill(pid, 0)` liveness;
//     the steal path is wrapped in try/catch because `kill(0)` throws for
//     dead PIDs and on EPERM (which we treat as "alive — give up the steal").
//   - When the lock is contended we spool a single-event JSON file under
//     `<spoolRoot>/<ledgerName>/` with a monotonic prefix; the drainer
//     reads back in mtime order and atomically rebuilds the ledger.
//   - The `appendUniqueJsonlLocked` helper enforces a compound dedupe key
//     (`eventId + event` on scoreboard-calls per Codex round-5; configurable
//     via `uniqueKey`) so partial drains never duplicate canonical ledger
//     rows.
//
// This module is intentionally thin: collectors and the drainer compose
// these primitives. Do NOT introduce business logic here.

import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWrite } from '../integrations/atomic-merge.js';
import { SPOOL_LEDGER_NAMES } from './paths.js';

// ---------------------------------------------------------------------------
// Caps (defaults mirror DEFAULT_STATUSLINE_CONFIG; recorders may override).
// ---------------------------------------------------------------------------

const MAX_JSONL_BYTES = 10 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 256 * 1024;
const MAX_SPOOL_BYTES = 256 * 1024;
const MAX_SPOOL_ENTRIES = 1000;
const MAX_JSON_FILE_BYTES = 1 * 1024 * 1024;
/** Lock bodies are ~50 bytes (`pid=...\nstartedAt=...`); 4 KiB is generous. */
const LOCK_BODY_MAX_BYTES = 4 * 1024;
/**
 * Default stale-lock threshold: 10 minutes. A lock owned by a dead PID is
 * always reclaimable; a lock owned by an unknown / no-PID body is reclaimable
 * after this threshold. Tests stub via `staleAfterMs` argument.
 */
const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an intermediate or terminal path component under `.hive-flow/`
 * resolves to a symbolic link. Carries a `relativeOffender` field rather than
 * the absolute path so error messages do not leak the project root.
 */
export class StatuslineStoragePathError extends Error {
  readonly code = 'STATUSLINE_STORAGE_PATH';
  /** Path of the offending segment relative to its `.hive-flow` ancestor. */
  readonly relativeOffender: string;
  constructor(relativeOffender: string) {
    super(`Refusing statusline storage path through symlink: .hive-flow/${relativeOffender}`);
    this.name = 'StatuslineStoragePathError';
    this.relativeOffender = relativeOffender;
  }
}

/**
 * Thrown when a spool primitive receives a `ledgerName` that is not in the
 * canonical `SPOOL_LEDGER_NAMES` set. Carries the rejected name (truncated to
 * avoid leaking large payloads) for diagnostic logging.
 */
export class StatuslineSpoolLedgerNameError extends Error {
  readonly code = 'STATUSLINE_SPOOL_LEDGER_NAME';
  readonly rejected: string;
  constructor(rejected: string) {
    // Truncate to 64 chars and strip non-printable bytes so the message stays
    // benign even if a caller passes a maliciously-crafted name.
    const safe = rejected
      .slice(0, 64)
      .replace(/[\x00-\x1f\x7f]/g, '?');
    super(`Refusing spool ledger name not in canonical set: ${safe}`);
    this.name = 'StatuslineSpoolLedgerNameError';
    this.rejected = rejected;
  }
}

function isSymlinkRejection(error: unknown): error is StatuslineStoragePathError {
  return error instanceof StatuslineStoragePathError;
}

/**
 * Thrown by the user-cache primitives when any path segment from `baseDir`
 * up to the leaf resolves to a symbolic link or a non-directory. This is the
 * user-cache equivalent of `StatuslineStoragePathError` (which is scoped to
 * `.hive-flow/`-anchored paths only). Carrying a typed error lets callers
 * (write paths propagate; read paths collapse to `undefined`) branch cleanly
 * without leaking the absolute path of the offending segment in the message.
 *
 * `relativeOffender` is the path component(s) from `baseDir` to the rejected
 * segment, NOT the absolute path, so error messages stay benign in logs.
 */
export class StatuslineUserCachePathError extends Error {
  readonly code = 'STATUSLINE_USER_CACHE_PATH';
  /** Path of the offending segment relative to `baseDir`. */
  readonly relativeOffender: string;
  constructor(relativeOffender: string) {
    super(`Refusing statusline user-cache path through symlink or non-directory: ${relativeOffender}`);
    this.name = 'StatuslineUserCachePathError';
    this.relativeOffender = relativeOffender;
  }
}

function isUserCacheRejection(error: unknown): error is StatuslineUserCachePathError {
  return error instanceof StatuslineUserCachePathError;
}

/**
 * Validate that `ledgerName` is one of the canonical spool ledger identifiers
 * declared in `paths.ts`. Throws a typed error before any path operation. The
 * frozen-set check is strictly more restrictive than a regex (it rejects
 * `..`, separators, null bytes, casing variants, and unknown identifiers in a
 * single comparison).
 */
function assertValidSpoolLedgerName(ledgerName: string): void {
  if (typeof ledgerName !== 'string') {
    throw new StatuslineSpoolLedgerNameError(String(ledgerName));
  }
  if (!(SPOOL_LEDGER_NAMES as ReadonlyArray<string>).includes(ledgerName)) {
    throw new StatuslineSpoolLedgerNameError(ledgerName);
  }
}

// ---------------------------------------------------------------------------
// Symlink / traversal guard
// ---------------------------------------------------------------------------

/**
 * Walk the directory chain leading to `filePath` (only the segments inside
 * `.hive-flow/`) and refuse any path component that resolves to a symbolic
 * link. Mirrors the Phase 5 patch — `lstat`-before-`realpath`, no follow.
 *
 * Symlinked intermediate directories are rejected via the typed
 * `StatuslineStoragePathError` so callers (read paths) can swallow them as a
 * `symlinked` classification while writes propagate the throw.
 *
 * Paths outside `.hive-flow/` are allowed unchecked because the renderer's
 * config loader (already in Wave 1) does the equivalent walk under its own
 * `projectRoot` and the storage primitives are only invoked for the
 * `.hive-flow/`-scoped ledgers and the per-user XDG cache.
 */
async function assertSafeStatuslineStoragePath(filePath: string): Promise<void> {
  const resolved = resolve(filePath);
  const parts = resolved.split(sep);
  const hiveIndex = parts.lastIndexOf('.hive-flow');
  if (hiveIndex < 0) return;

  const hivePrefix = parts.slice(0, hiveIndex + 1).join(sep) || sep;
  // Reconstruct each prefix from the `.hive-flow` segment onward and lstat
  // every intermediate INCLUDING `.hive-flow` itself so a symlinked parent is
  // rejected before any read or write proceeds. We separately lstat the leaf
  // below so a non-existent terminal segment is not misclassified.
  let current = resolved.startsWith(sep) ? sep : (parts[0] ?? '');
  const lastIdx = parts.length - 1;
  for (let i = 1; i < lastIdx; i++) {
    current = current === sep ? join(sep, parts[i] ?? '') : join(current, parts[i] ?? '');
    if (i < hiveIndex) continue;
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) {
        const rel = relative(dirname(hivePrefix), current) || basename(current);
        throw new StatuslineStoragePathError(rel);
      }
    } catch (error: unknown) {
      if (error instanceof StatuslineStoragePathError) throw error;
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
  }
  try {
    const final = await lstat(resolved);
    if (final.isSymbolicLink()) {
      const rel = relative(dirname(hivePrefix), resolved) || basename(resolved);
      throw new StatuslineStoragePathError(rel);
    }
  } catch (error: unknown) {
    if (error instanceof StatuslineStoragePathError) throw error;
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Bounded JSON file reads/writes
// ---------------------------------------------------------------------------

type JsonFileSafety =
  | { kind: 'safe'; size: number }
  | { kind: 'absent' }
  | { kind: 'symlinked' }
  | { kind: 'not-regular' }
  | { kind: 'oversize'; size: number };

async function classifyJsonFile(filePath: string, maxBytes: number): Promise<JsonFileSafety> {
  let st;
  try {
    st = await lstat(filePath);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'not-regular' };
  }
  if (st.isSymbolicLink()) return { kind: 'symlinked' };
  if (!st.isFile()) return { kind: 'not-regular' };
  if (st.size > maxBytes) return { kind: 'oversize', size: st.size };
  return { kind: 'safe', size: st.size };
}

/**
 * Read a JSON file, returning `undefined` on any non-recoverable error
 * (missing / oversized / symlinked / non-regular / parse error). Bounded by
 * `maxBytes`. Never throws to the caller.
 *
 * When the caller needs to distinguish those outcomes (for diagnostics or
 * the `statusline doctor` subcommand), use `readJsonFileStrict` instead.
 */
export async function readJsonFile<T = unknown>(
  filePath: string,
  maxBytes: number = MAX_JSON_FILE_BYTES,
): Promise<T | undefined> {
  const result = await readJsonFileStrict<T>(filePath, maxBytes);
  return result.kind === 'ok' ? result.value : undefined;
}

export type StrictReadResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'absent' }
  | { kind: 'symlinked' }
  | { kind: 'not-regular' }
  | { kind: 'oversize'; size: number }
  | { kind: 'corrupt'; message: string }
  | { kind: 'error'; message: string };

/**
 * Strict variant of `readJsonFile` that returns a discriminated outcome so
 * callers can surface oversize/symlink rejections in diagnostics. Bounded.
 *
 * Walks every intermediate `.hive-flow/` segment via `assertSafeStatuslineStoragePath`
 * BEFORE classifying the leaf, so a symlinked parent directory (e.g. a
 * symlinked `.hive-flow/` or `.hive-flow/state/`) is rejected even when the
 * leaf itself is a regular file. Closes the Phase 7 Codex finding that a
 * leaf-only `lstat` could be coaxed through a symlinked parent.
 */
export async function readJsonFileStrict<T = unknown>(
  filePath: string,
  maxBytes: number = MAX_JSON_FILE_BYTES,
): Promise<StrictReadResult<T>> {
  try {
    await assertSafeStatuslineStoragePath(filePath);
  } catch (error: unknown) {
    if (isSymlinkRejection(error)) return { kind: 'symlinked' };
    throw error;
  }
  const safety = await classifyJsonFile(filePath, maxBytes);
  if (safety.kind === 'absent') return { kind: 'absent' };
  if (safety.kind === 'symlinked') return { kind: 'symlinked' };
  if (safety.kind === 'not-regular') return { kind: 'not-regular' };
  if (safety.kind === 'oversize') return { kind: 'oversize', size: safety.size };
  // Bounded read (NOT readFile): the classify() lstat above is informational —
  // a hostile writer can swap a small "safe" file for a multi-GB payload in the
  // TOCTOU window before this read, and readFile() would materialize the whole
  // post-swap file before any post-hoc size guard could fire. The bounded loop
  // allocates exactly `maxBytes + 1` and aborts the instant it overflows.
  const bounded = await readBoundedUtf8(filePath, maxBytes);
  if (bounded.kind === 'absent') return { kind: 'absent' };
  if (bounded.kind === 'oversize') return { kind: 'oversize', size: maxBytes + 1 };
  if (bounded.kind === 'error') return { kind: 'error', message: bounded.message };
  const raw = bounded.text;
  try {
    return { kind: 'ok', value: JSON.parse(raw) as T };
  } catch (error: unknown) {
    return { kind: 'corrupt', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Atomically write a private JSON file. Refuses to write through a symlink
 * inside `.hive-flow/`. After the rename completes the file mode is forced
 * to 0o600 (in case an existing file had loose permissions).
 */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await assertSafeStatuslineStoragePath(filePath);
  await atomicWrite(filePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, fsync: true });
  await chmod(filePath, 0o600).catch(() => undefined);
}

/**
 * Alias maintained for callers expressing the operation as "atomic JSON
 * write" rather than the bare "writeJsonFile". Identical semantics.
 */
export const atomicWriteJson = writeJsonFile;

/**
 * Symlink-safe `unlink` for a leaf path beneath `.hive-flow/`.
 *
 * Walks every intermediate `.hive-flow/` segment via the same
 * `assertSafeStatuslineStoragePath` helper used by `writeJsonFile` /
 * `readJsonFile` (Wave 2.5A): refuses if `.hive-flow/`, any intermediate
 * directory, or the leaf itself resolves through a symbolic link. Only after
 * the walk passes does the function issue the final `unlink`.
 *
 * Returns:
 *   - `'unlinked'`  — the leaf existed and was removed.
 *   - `'absent'`    — the leaf was missing (ENOENT). Callers treat this as
 *     idempotent success; matches `removeMarker`'s no-op contract.
 *   - `'rejected'`  — any intermediate or leaf is a symbolic link. The path
 *     was NOT followed and NO `unlink` was issued. Callers that wish to
 *     fail-loud on rejection can throw on this value.
 *
 * Closes the project-scope hole in `integrations/integration-marker.ts`:
 * before this helper, `removeMarker` issued a raw `unlink(path)` after the
 * existing `assertSafeStatuslineStoragePath` walk only ran on the WRITE
 * side. An attacker who swapped `.hive-flow/` for a symlink between
 * `writeMarker` and `removeMarker` could redirect the `unlink` at an
 * outside file. The walk-then-unlink ordering here closes that gap.
 *
 * Non-symlink errors (EACCES, EBUSY, etc.) propagate so the caller can
 * surface them. This matches the contract of `writeJsonFile` (which
 * propagates write errors) rather than silently treating every failure as
 * absent.
 */
export type SafeUnlinkResult = 'unlinked' | 'absent' | 'rejected';

export async function safeUnlinkInHiveFlow(filePath: string): Promise<SafeUnlinkResult> {
  try {
    await assertSafeStatuslineStoragePath(filePath);
  } catch (error: unknown) {
    if (isSymlinkRejection(error)) return 'rejected';
    throw error;
  }
  try {
    await unlink(filePath);
    return 'unlinked';
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// File locking (O_EXCL + PID liveness)
// ---------------------------------------------------------------------------

/**
 * `process.kill(pid, 0)` is the POSIX liveness probe. It throws ESRCH for
 * dead PIDs (steal OK), throws EPERM when the PID is owned by a different
 * user (treat as alive — do NOT steal), and resolves silently for live PIDs
 * owned by us. The try/catch is mandatory: the bare call would otherwise
 * propagate ESRCH up to the caller.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM => process exists but is not owned by us. Treat as alive.
    return errorCode(error) === 'EPERM';
  }
}

async function isLockStale(lockPath: string, staleAfterMs: number): Promise<boolean> {
  // Bounded read: lock bodies are ~50 bytes (`pid=...\nstartedAt=...`). A
  // hostile swap to a multi-GB file must never be slurped via readFile() — cap
  // the body at LOCK_BODY_MAX_BYTES. An overflow (`undefined` text) means the
  // file is not a real lock body, so we treat the lock as stale/reclaimable.
  let bounded: BoundedReadResult;
  let st;
  try {
    [bounded, st] = await Promise.all([
      readBoundedUtf8(lockPath, LOCK_BODY_MAX_BYTES),
      stat(lockPath),
    ]);
  } catch {
    // Lock file vanished between EEXIST and the read — treat as stale.
    return true;
  }
  // Non-text outcome (absent / oversize / read error): treat as stale so a
  // corrupt or hostile lock body never wedges the lock forever.
  const body = bounded.kind === 'ok' ? bounded.text : '';
  const pidMatch = body.match(/pid=(\d+)/);
  const pid = pidMatch ? Number(pidMatch[1]) : -1;
  const ageMs = Date.now() - st.mtimeMs;
  if (pid > 0) {
    // PID present: liveness is the authority. Mtime is irrelevant for live PIDs.
    return !pidIsAlive(pid);
  }
  // No PID in body: fall back to mtime threshold.
  return ageMs > staleAfterMs;
}

export type LockResult<T> = { acquired: true; result: T } | { acquired: false };

/**
 * Acquire an exclusive lock at `lockPath` and run `fn`. The lock file is
 * created with O_EXCL (`'wx'`); on EEXIST we test for staleness one time and
 * try to reclaim. Stale-lock reclaim uses PID liveness, NOT mtime alone, so
 * a long-running owner is never evicted.
 *
 * Callback errors propagate. Lock cleanup runs in `finally` so a thrown `fn`
 * still releases the lock file on exit.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: { staleAfterMs?: number } = {},
): Promise<LockResult<T>> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  let handle: import('node:fs/promises').FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await assertSafeStatuslineStoragePath(lockPath);
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`pid=${process.pid}\nstartedAt=${new Date().toISOString()}\n`);
      break;
    } catch (err: unknown) {
      if (errorCode(err) !== 'EEXIST') throw err;
      if (attempt === 0 && (await isLockStale(lockPath, staleAfterMs))) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      return { acquired: false };
    }
  }
  try {
    if (!handle) return { acquired: false };
    return { acquired: true, result: await fn() };
  } finally {
    try {
      await handle?.close();
    } catch {
      // Closing a stale handle is non-fatal.
    }
    try {
      await unlink(lockPath);
    } catch {
      // Lock may have been reclaimed by another owner; do not propagate.
    }
  }
}

// ---------------------------------------------------------------------------
// JSONL serialization + reads
// ---------------------------------------------------------------------------

/**
 * Serialize a single JSONL line. Verifies the serialized record does not
 * contain a record terminator before the trailing newline (a JSON value
 * whose string fields contained an inner newline would split the ledger).
 */
function serializeJsonlLine(kind: string, value: unknown, maxLineBytes: number): string {
  const line = JSON.stringify(value) + '\n';
  const record = line.slice(0, -1);
  if (record.includes('\n') || record.includes('\r')) {
    throw new Error(`${kind}: serialized event contained a newline before the record terminator`);
  }
  if (Buffer.byteLength(record, 'utf8') > maxLineBytes) {
    throw new Error(`${kind}: serialized event exceeds ${maxLineBytes} bytes`);
  }
  return line;
}

export interface ReadJsonlOptions {
  /** Override the file-level size cap. Defaults to MAX_JSONL_BYTES. */
  maxBytes?: number;
  /** Override the per-line cap. Defaults to MAX_JSONL_LINE_BYTES. */
  maxLineBytes?: number;
}

/**
 * Read a JSONL ledger, returning the parsed events plus a count of corrupt
 * (oversized or unparseable) lines. Bounded by `maxBytes`; oversized files
 * return `{ events: [], corrupt: 1 }` so the caller can flag the staleness
 * without crashing the renderer.
 *
 * Symlink-safe: rejects the file when it resolves through a symlink under
 * `.hive-flow/`, INCLUDING via a symlinked intermediate directory (Phase 7
 * Codex finding). Tolerates trailing newlines (LF or CRLF).
 */
export async function readJsonl<T = unknown>(
  filePath: string,
  options: ReadJsonlOptions = {},
): Promise<{ events: T[]; corrupt: number }> {
  const maxBytes = options.maxBytes ?? MAX_JSONL_BYTES;
  const maxLineBytes = options.maxLineBytes ?? MAX_JSONL_LINE_BYTES;
  // Walk every intermediate `.hive-flow/` segment before opening the leaf so
  // a symlinked parent directory is rejected up front.
  await assertSafeStatuslineStoragePath(filePath);
  // lstat-before-read: classify the path before we open it. (Final-segment
  // symlink rejection is also covered by the path walk above, but we keep
  // the explicit branch here for callers passing paths outside `.hive-flow/`.)
  let st;
  try {
    st = await lstat(filePath);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { events: [], corrupt: 0 };
    return { events: [], corrupt: 0 };
  }
  if (st.isSymbolicLink()) {
    throw new StatuslineStoragePathError(basename(filePath));
  }
  if (!st.isFile()) return { events: [], corrupt: 0 };
  if (st.size > maxBytes) {
    return { events: [], corrupt: 1 };
  }
  // Bounded read (NOT readFile): the lstat above is informational — a racing
  // append (or hostile swap) can grow the file past `maxBytes` in the TOCTOU
  // window, and readFile() would slurp the whole post-growth payload into
  // memory before any post-hoc guard. The bounded loop caps allocation at
  // `maxBytes + 1` and treats overflow as a single corrupt marker.
  const bounded = await readBoundedUtf8(filePath, maxBytes);
  if (bounded.kind === 'absent') return { events: [], corrupt: 0 };
  if (bounded.kind === 'error') return { events: [], corrupt: 0 };
  if (bounded.kind === 'oversize') return { events: [], corrupt: 1 };
  const raw = bounded.text;
  const events: T[] = [];
  let corrupt = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
      corrupt++;
      continue;
    }
    try {
      events.push(JSON.parse(line) as T);
    } catch {
      corrupt++;
    }
  }
  return { events, corrupt };
}

/**
 * Bounded tail read: return at most `maxLines` parsed events plus the
 * corrupt-count from the underlying read. Equivalent to `readJsonl` slicing
 * but expressed as a single helper so callers do not duplicate `.slice(-N)`.
 */
export async function readJsonlTail<T = unknown>(
  filePath: string,
  maxLines: number,
  options: ReadJsonlOptions = {},
): Promise<{ events: T[]; corrupt: number }> {
  const parsed = await readJsonl<T>(filePath, options);
  return { events: parsed.events.slice(-Math.max(0, maxLines)), corrupt: parsed.corrupt };
}

// ---------------------------------------------------------------------------
// Spool primitives (single-event JSON files under <spoolRoot>/<ledgerName>/)
// ---------------------------------------------------------------------------

/**
 * Spool a single event for later drainage. Each entry is its own file under
 * `<spoolRoot>/<ledgerName>/`; filenames are `<ts>-<pid>-<uuid>.json` so the
 * default lexicographic sort matches mtime ordering (assuming `Date.now()`
 * resolution).
 *
 * `ledgerName` is validated against the frozen `SPOOL_LEDGER_NAMES` set
 * BEFORE any path operation so a malicious caller cannot inject a traversal
 * fragment (`..`, separators, null bytes) into the spool path.
 *
 * Refuses to spool when the per-ledger queue would exceed
 * `MAX_SPOOL_ENTRIES` or the serialized event exceeds `MAX_SPOOL_BYTES`.
 */
export async function spoolJsonEvent(
  spoolRoot: string,
  ledgerName: string,
  value: unknown,
): Promise<void> {
  assertValidSpoolLedgerName(ledgerName);
  const body = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(body, 'utf8') > MAX_SPOOL_BYTES) {
    throw new Error(`spoolJsonEvent: serialized event exceeds ${MAX_SPOOL_BYTES} bytes`);
  }
  const dir = join(spoolRoot, ledgerName);
  await mkdir(dir, { recursive: true });
  await assertSafeStatuslineStoragePath(dir);
  const existing = await readdir(dir).catch(() => [] as string[]);
  const pending = existing.filter(
    (name) => name.endsWith('.json') || name.includes('.json.processing-'),
  ).length;
  if (pending >= MAX_SPOOL_ENTRIES) {
    throw new Error(`spoolJsonEvent: ${ledgerName} spool exceeds ${MAX_SPOOL_ENTRIES} pending entries`);
  }
  await atomicWrite(
    join(dir, `${Date.now()}-${process.pid}-${randomUUID()}.json`),
    body,
    { mode: 0o600, fsync: true },
  );
}

/**
 * Alias for `spoolJsonEvent` so callers can express the operation as
 * "append spool entry" when they prefer that phrasing.
 */
export const appendSpoolEntry = spoolJsonEvent;

/**
 * Read claimable spool entries for a given ledger. Each entry is renamed to
 * a `<name>.processing-<pid>-<uuid>` suffix so concurrent drainers do not
 * double-process the same file. Returns sorted by name (which matches mtime
 * order under our naming scheme).
 *
 * `ledgerName` is validated against `SPOOL_LEDGER_NAMES` BEFORE any path
 * operation. The spool directory itself is walked through
 * `assertSafeStatuslineStoragePath` so a symlinked spool parent (e.g.
 * `.hive-flow/spool` itself replaced with a symlink) is rejected before any
 * file is opened.
 *
 * Symlink-safe and oversize-safe: entries pointing through symlinks or
 * exceeding `MAX_SPOOL_BYTES` are quarantined with a `.unsafe-` or
 * `.oversized-` suffix so they do not block the drainer.
 */
export async function readSpoolEntries<T = unknown>(
  spoolRoot: string,
  ledgerName: string,
): Promise<Array<{ path: string; originalPath: string; event: T }>> {
  assertValidSpoolLedgerName(ledgerName);
  const dir = join(spoolRoot, ledgerName);
  await assertSafeStatuslineStoragePath(dir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; originalPath: string; event: T }> = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort().slice(0, MAX_SPOOL_ENTRIES)) {
    const originalPath = join(dir, name);
    const path = join(dir, `${name}.processing-${process.pid}-${randomUUID()}`);
    try {
      const st = await lstat(originalPath);
      if (st.isSymbolicLink() || !st.isFile()) {
        await rename(originalPath, `${originalPath}.unsafe-${Date.now()}`).catch(() => {});
        continue;
      }
      if (st.size > MAX_SPOOL_BYTES) {
        await rename(originalPath, `${originalPath}.oversized-${Date.now()}`).catch(() => {});
        continue;
      }
      await rename(originalPath, path);
      const claimed = await lstat(path);
      if (claimed.isSymbolicLink() || !claimed.isFile()) {
        await rename(path, `${originalPath}.unsafe-${Date.now()}`).catch(() => {});
        continue;
      }
      if (claimed.size > MAX_SPOOL_BYTES) {
        await rename(path, `${originalPath}.oversized-${Date.now()}`).catch(() => {});
        continue;
      }
      try {
        // Bounded read: the double-lstat above narrows but does not close the
        // TOCTOU window — a swap after the claimed-file lstat would still feed
        // readFile() an oversized payload. Cap at MAX_SPOOL_BYTES so a grown
        // entry quarantines instead of materializing.
        const bounded = await readBoundedUtf8(path, MAX_SPOOL_BYTES);
        if (bounded.kind !== 'ok') {
          await rename(path, `${originalPath}.oversized-${Date.now()}`).catch(() => {});
          continue;
        }
        const event = JSON.parse(bounded.text) as T;
        out.push({ path, originalPath, event });
      } catch {
        await rename(path, `${originalPath}.corrupt-${Date.now()}`).catch(() => {});
      }
    } catch {
      // Another drainer may have claimed the file between readdir and rename.
    }
  }
  return out;
}

/**
 * List spool files in a single ledger directory, sorted by mtime ascending
 * so a drainer replays in the same order recorders produced them. Includes
 * both unclaimed (`*.json`) and processing (`*.json.processing-*`) files so
 * the drainer can recover stale processing entries on the next pass.
 *
 * `ledgerName` is validated against `SPOOL_LEDGER_NAMES` BEFORE any path
 * operation. The spool directory is walked through
 * `assertSafeStatuslineStoragePath` so a symlinked spool parent is rejected.
 *
 * Returns an empty array when the directory does not exist.
 */
export async function listSpoolFiles(
  spoolRoot: string,
  ledgerName: string,
): Promise<Array<{ name: string; path: string; mtimeMs: number; isProcessing: boolean }>> {
  assertValidSpoolLedgerName(ledgerName);
  const dir = join(spoolRoot, ledgerName);
  await assertSafeStatuslineStoragePath(dir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const rows: Array<{ name: string; path: string; mtimeMs: number; isProcessing: boolean }> = [];
  for (const name of names) {
    if (!name.endsWith('.json') && !name.includes('.json.processing-')) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      rows.push({
        name,
        path,
        mtimeMs: st.mtimeMs,
        isProcessing: name.includes('.json.processing-'),
      });
    } catch {
      // Skipped: file vanished between readdir and stat.
    }
  }
  // Stable sort by mtime ascending; ties broken by name so the order is
  // deterministic across runs even when timestamps collide.
  rows.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return rows;
}

/**
 * Restore a previously claimed spool entry (move the `.processing-*` file
 * back to its original name) so a different drainer pass can retry. Best-
 * effort: a missing source file is not an error.
 */
export async function restoreSpoolEntry(path: string, originalPath: string): Promise<void> {
  await rename(path, originalPath).catch(() => undefined);
}

/**
 * Delete a claimed (`.processing-*`) spool entry after the drainer has
 * applied it to the canonical ledger. Best-effort: a missing file is not
 * an error.
 */
export async function deleteSpoolEntry(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/**
 * Recover stale `*.processing-*` files (left behind by a crashed drainer)
 * by renaming them back to fresh canonical names with a `-recovered-`
 * marker so the next drain picks them up. Returns the number recovered.
 *
 * `ledgerName` is validated against `SPOOL_LEDGER_NAMES` BEFORE any path
 * operation. The spool directory is walked through
 * `assertSafeStatuslineStoragePath` so a symlinked spool parent is rejected.
 */
export async function recoverStaleProcessingSpool(
  spoolRoot: string,
  ledgerName: string,
  staleAfterMs = 5 * 60 * 1000,
): Promise<number> {
  assertValidSpoolLedgerName(ledgerName);
  const dir = join(spoolRoot, ledgerName);
  await assertSafeStatuslineStoragePath(dir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const name of names.filter((n) => n.includes('.json.processing-')).sort()) {
    const processingPath = join(dir, name);
    const jsonEnd = name.indexOf('.json.processing-') + '.json'.length;
    const originalName = name.slice(0, jsonEnd);
    const recoveredPath = join(
      dir,
      `${Date.now()}-${process.pid}-recovered-${originalName}`,
    );
    try {
      const st = await stat(processingPath);
      if (Date.now() - st.mtimeMs < staleAfterMs) continue;
      await rename(processingPath, recoveredPath);
      recovered++;
    } catch {
      // Another drainer may have recovered or removed the file.
    }
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Locked JSONL append (with spool fallback)
// ---------------------------------------------------------------------------

export interface AppendJsonlLockedOptions {
  ledgerPath: string;
  spoolRoot: string;
  ledgerName: string;
  event: unknown;
  /** When true (default), contended-lock appends spool. When false, they
   *  return `{ written: false, spooled: false }` and the caller decides. */
  spoolOnLockFailure?: boolean;
  /** Override the per-line byte cap. Defaults to MAX_JSONL_LINE_BYTES. */
  maxLineBytes?: number;
  /** Forwarded to `withFileLock`. */
  staleAfterMs?: number;
}

export type AppendJsonlLockedResult =
  | { written: true; spooled: false }
  | { written: false; spooled: true }
  | { written: false; spooled: false };

/**
 * Append `event` to the JSONL ledger under an exclusive lock. On contention
 * (live owner) the event is spooled instead so the drainer can apply it
 * later. Refuses to write through a symlink and refuses serialized events
 * that exceed `maxLineBytes`.
 *
 * The lock callback uses O_APPEND semantics (the underlying `appendFile`
 * opens with O_APPEND on POSIX and an equivalent atomic-append on Windows).
 * The ledger mode is forced to 0o600 after every append to undo any
 * accidental permission loosening.
 */
export async function appendJsonlLocked(
  opts: AppendJsonlLockedOptions,
): Promise<AppendJsonlLockedResult> {
  const maxLineBytes = opts.maxLineBytes ?? MAX_JSONL_LINE_BYTES;
  const line = serializeJsonlLine('appendJsonlLocked', opts.event, maxLineBytes);
  const result = await withFileLock(
    `${opts.ledgerPath}.lock`,
    async () => {
      await assertSafeStatuslineStoragePath(opts.ledgerPath);
      await mkdir(dirname(opts.ledgerPath), { recursive: true });
      await appendFile(opts.ledgerPath, line, { encoding: 'utf8', mode: 0o600 });
      await chmod(opts.ledgerPath, 0o600).catch(() => undefined);
      return true;
    },
    { staleAfterMs: opts.staleAfterMs },
  );
  if (!result.acquired) {
    if (opts.spoolOnLockFailure === false) {
      return { written: false, spooled: false };
    }
    await spoolJsonEvent(opts.spoolRoot, opts.ledgerName, opts.event);
    return { written: false, spooled: true };
  }
  return { written: true, spooled: false };
}

export interface AppendUniqueJsonlLockedOptions<T extends object> {
  ledgerPath: string;
  spoolRoot: string;
  ledgerName: string;
  event: T;
  /**
   * Either a single key (legacy callers, e.g. attention `eventId`) or an
   * array of keys forming a compound dedupe key. Codex round-5 binding:
   * scoreboard-calls dedupe on the pair `['eventId', 'event']` so the same
   * `call-start` + `call-complete` pair is not duplicated.
   */
  uniqueField: keyof T | ReadonlyArray<keyof T>;
  spoolOnLockFailure?: boolean;
  maxLineBytes?: number;
  staleAfterMs?: number;
}

export type AppendUniqueJsonlLockedResult =
  | { written: true; spooled: false; duplicate: false }
  | { written: false; spooled: true; duplicate: false }
  | { written: false; spooled: false; duplicate: true }
  | { written: false; spooled: false; duplicate: false };

/**
 * Same as `appendJsonlLocked` but rejects the append when an existing
 * ledger row has the same `uniqueField` value(s). Used by the drainer to
 * deduplicate replays of partial drains.
 */
export async function appendUniqueJsonlLocked<T extends object>(
  opts: AppendUniqueJsonlLockedOptions<T>,
): Promise<AppendUniqueJsonlLockedResult> {
  const maxLineBytes = opts.maxLineBytes ?? MAX_JSONL_LINE_BYTES;
  const line = serializeJsonlLine('appendUniqueJsonlLocked', opts.event, maxLineBytes);
  const keys: ReadonlyArray<keyof T> = Array.isArray(opts.uniqueField)
    ? opts.uniqueField
    : ([opts.uniqueField] as ReadonlyArray<keyof T>);
  const wantedKey = compoundKey(opts.event, keys);
  const result = await withFileLock(
    `${opts.ledgerPath}.lock`,
    async () => {
      await assertSafeStatuslineStoragePath(opts.ledgerPath);
      const existing = await readJsonl<T>(opts.ledgerPath);
      for (const item of existing.events) {
        if (compoundKey(item, keys) === wantedKey) return 'duplicate' as const;
      }
      await mkdir(dirname(opts.ledgerPath), { recursive: true });
      await appendFile(opts.ledgerPath, line, { encoding: 'utf8', mode: 0o600 });
      await chmod(opts.ledgerPath, 0o600).catch(() => undefined);
      return 'written' as const;
    },
    { staleAfterMs: opts.staleAfterMs },
  );
  if (!result.acquired) {
    if (opts.spoolOnLockFailure === false) {
      return { written: false, spooled: false, duplicate: false };
    }
    await spoolJsonEvent(opts.spoolRoot, opts.ledgerName, opts.event);
    return { written: false, spooled: true, duplicate: false };
  }
  if (result.result === 'duplicate') {
    return { written: false, spooled: false, duplicate: true };
  }
  return { written: true, spooled: false, duplicate: false };
}

function compoundKey<T extends object>(value: T, keys: ReadonlyArray<keyof T>): string {
  // Stable per-key JSON encoding so two equivalent compound keys collide
  // regardless of property order. Keys are passed in a fixed order so the
  // ordering itself is deterministic.
  const parts: string[] = [];
  for (const key of keys) {
    const raw = (value as Record<string, unknown>)[key as string];
    parts.push(JSON.stringify(raw ?? null));
  }
  return parts.join('\x01');
}

// ---------------------------------------------------------------------------
// Refresh marker
// ---------------------------------------------------------------------------

/**
 * Touch the renderer refresh-request marker. Lazily imports `paths.js` so
 * tests can stub the path module without forcing a circular import at
 * load time.
 *
 * The Wave 2.5A `assertSafeStatuslineStoragePath` walk is the load-bearing
 * symlink guard: it rejects every intermediate `.hive-flow/` segment AND the
 * leaf itself when any link is found. Any caller that needs to write the
 * marker — including the Wave 7 refresher's post-write touch — MUST go
 * through this helper rather than calling `writeFile` directly on
 * `paths.refreshRequest`. A direct `writeFile` would happily follow a
 * symlink and overwrite the linked target, defeating the Wave 2.5A guard.
 *
 * `opts.payload` overrides the default `String(Date.now())` body so the
 * refresher can stamp the `generatedAt` ISO it just wrote into the cache.
 * `opts.nowMs` overrides the natural `writeFile` mtime via `utimes` so the
 * debounce window is deterministic under test-injected clocks. Both are
 * optional; omitting them preserves the legacy behaviour exercised by the
 * Wave 2 storage tests.
 */
export async function touchRefreshRequest(
  projectRoot: string,
  opts?: { payload?: string; nowMs?: number },
): Promise<void> {
  const { statuslinePaths } = await import('./paths.js');
  const paths = statuslinePaths(projectRoot);
  await mkdir(dirname(paths.refreshRequest), { recursive: true });
  await assertSafeStatuslineStoragePath(paths.refreshRequest);
  const body = typeof opts?.payload === 'string' ? opts.payload : String(Date.now());
  await writeFile(paths.refreshRequest, body, { encoding: 'utf8', mode: 0o600 });
  await chmod(paths.refreshRequest, 0o600).catch(() => undefined);
  if (typeof opts?.nowMs === 'number' && Number.isFinite(opts.nowMs) && opts.nowMs >= 0) {
    const at = new Date(opts.nowMs);
    await utimes(paths.refreshRequest, at, at).catch(() => undefined);
  }
}

/**
 * Result of {@link readRefreshMarkerStat}. Carries only the fields the
 * debounce caller needs (`mtimeMs`) so the helper does not leak a raw
 * `fs.Stats` shape — and never carries a follow-the-symlink mtime.
 */
export interface RefreshMarkerStat {
  readonly mtimeMs: number;
}

// ---------------------------------------------------------------------------
// User-cache guarded primitives (path-walk symlink rejection, no recursive mkdir)
// ---------------------------------------------------------------------------
//
// Wave 8 Codex Phase 7 Finding 1 fix.
//
// The Wave 2.5A `assertSafeStatuslineStoragePath` walk is scoped to paths
// containing `.hive-flow/` — it is intentionally a no-op for user-cache paths
// (`${HIVE_FLOW_HOME ?? ~}/.hive-flow/statusline/...`, `${XDG_CACHE_HOME}/...`),
// so it does not protect those paths from a symlinked parent directory.
//
// `mkdir(path, { recursive: true })` follows symlinked PARENT segments during
// creation. Codex reproduced: with `${HIVE_FLOW_HOME}/.hive-flow` (or any
// intermediate) replaced by a symlink to an outside directory, a write would
// land at the symlink target, defeating the per-user isolation of the user
// cache.
//
// `ensureSafeUserCacheDir` walks every segment from `baseDir` to `absDir`:
//   - If the segment exists, `lstat` it. Reject when it is a symbolic link OR
//     when it exists but is not a directory.
//   - If the segment does not exist, create it with a SINGLE-SEGMENT `mkdir`
//     (no `recursive: true`) so the kernel cannot resolve a freshly-created
//     symlink mid-walk.
//
// `readUserCacheJson` / `writeUserCacheJson` / `readUserCacheText` /
// `writeUserCacheText` are bounded read/write helpers that lstat every parent
// AND the leaf before performing any IO. Writes route through `atomicWrite`
// for tmp + fsync + rename + chmod 0o600 semantics.

/** Default cap for `readUserCacheJson` payloads when the caller does not set one. */
const DEFAULT_USER_CACHE_READ_BYTES = 1 * 1024 * 1024;

/**
 * Walk every path segment from `baseDir` to `absDir`, lstat-checking each
 * existing segment and creating any missing segment with a single-segment
 * `mkdir` so symlinked parents can never be followed (neither during the walk
 * nor during creation).
 *
 * `baseDir` MUST be an ABSOLUTE path that is a prefix of `absDir` after
 * resolution. The function checks `baseDir` itself first (the same lstat
 * rules apply) and then walks each intermediate segment beneath it.
 *
 * Throws `StatuslineUserCachePathError` for:
 *   - any existing segment that is a symbolic link;
 *   - any existing segment that is not a directory;
 *   - any segment whose `lstat` fails with a non-`ENOENT` error (defence
 *     in depth — we never silently fall through);
 *   - `baseDir` not absolute or not a prefix of `absDir`;
 *   - `absDir` containing `..` segments after `resolve`.
 *
 * The function is idempotent on successful invocations: missing segments are
 * created and existing directories pass the check unchanged.
 */
export async function ensureSafeUserCacheDir(absDir: string, baseDir: string): Promise<void> {
  if (typeof absDir !== 'string' || absDir.length === 0) {
    throw new TypeError('ensureSafeUserCacheDir: absDir must be a non-empty string');
  }
  if (typeof baseDir !== 'string' || baseDir.length === 0) {
    throw new TypeError('ensureSafeUserCacheDir: baseDir must be a non-empty string');
  }
  if (!isAbsolute(baseDir)) {
    throw new TypeError('ensureSafeUserCacheDir: baseDir must be absolute');
  }
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(absDir);
  if (resolvedTarget !== resolvedBase &&
      !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new TypeError(
      'ensureSafeUserCacheDir: absDir must be inside baseDir after resolution',
    );
  }

  // Ensure `baseDir` itself exists and is a real directory (NOT a symlink).
  await ensureSingleSegment(resolvedBase, resolvedBase);

  if (resolvedTarget === resolvedBase) return;

  const tail = resolvedTarget.slice(resolvedBase.length + sep.length);
  // After `resolve` no `.` or `..` segments survive at the start; reject any
  // stray separators or empties defensively (e.g. doubled slashes that
  // somehow survived). Each segment is a flat directory name.
  const segments = tail.split(sep).filter((s) => s.length > 0);
  let current = resolvedBase;
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new StatuslineUserCachePathError(relative(resolvedBase, join(current, segment)));
    }
    current = join(current, segment);
    await ensureSingleSegment(current, resolvedBase);
  }
}

/**
 * lstat or single-segment-create one path. Helper for `ensureSafeUserCacheDir`.
 * `relRoot` is the base used to compute a relative offender path for error
 * messages — kept relative to `baseDir` so absolute paths never leak.
 */
async function ensureSingleSegment(absPath: string, relRoot: string): Promise<void> {
  let st;
  try {
    st = await lstat(absPath);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      // Single-segment mkdir (NO `recursive: true`) so the kernel cannot
      // resolve a symlink mid-walk during creation. Mode 0o700 — owner only.
      try {
        await mkdir(absPath, { mode: 0o700 });
      } catch (mkErr: unknown) {
        // EEXIST is a race: another process created the dir between lstat
        // and mkdir. Re-lstat below to validate the now-existing segment.
        if (errorCode(mkErr) !== 'EEXIST') throw mkErr;
      }
      try {
        st = await lstat(absPath);
      } catch (lstErr: unknown) {
        // If lstat still fails after a (possibly racing) mkdir, surface as a
        // typed rejection — we can never proceed without verifying the
        // segment is a real directory.
        const rel = relative(relRoot, absPath) || basename(absPath);
        throw new StatuslineUserCachePathError(rel);
      }
    } else {
      // Any other lstat failure is a hard reject — the bug-hunt rule against
      // silently treating ENOENT/EACCES the same applies here.
      const rel = relative(relRoot, absPath) || basename(absPath);
      throw new StatuslineUserCachePathError(rel);
    }
  }
  if (st.isSymbolicLink()) {
    const rel = relative(relRoot, absPath) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
  if (!st.isDirectory()) {
    const rel = relative(relRoot, absPath) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
}

/**
 * Walk every existing parent segment under `baseDir` up to the LEAF
 * (`absPath`) and refuse on any symlinked segment. Does NOT create missing
 * segments — read helpers use this on paths that may legitimately not exist
 * yet. Returns true when the parent walk passed cleanly OR a parent segment
 * was absent (legitimate "no file yet" case).
 *
 * Throws `StatuslineUserCachePathError` for symlinked intermediate or leaf.
 * The leaf-symlink rejection is intentional: we never want to read through
 * a symlink even when the leaf itself happens to be a regular file via the
 * link target — the link could be redirected at any time.
 */
async function assertSafeUserCachePath(absPath: string, baseDir: string): Promise<void> {
  if (!isAbsolute(baseDir)) {
    throw new TypeError('assertSafeUserCachePath: baseDir must be absolute');
  }
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(absPath);
  if (resolvedTarget !== resolvedBase &&
      !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new TypeError(
      'assertSafeUserCachePath: absPath must be inside baseDir after resolution',
    );
  }
  // Check `baseDir` itself.
  await assertExistingSegmentSafe(resolvedBase, resolvedBase, { allowMissing: true, requireDir: true });

  if (resolvedTarget === resolvedBase) return;

  const tail = resolvedTarget.slice(resolvedBase.length + sep.length);
  const segments = tail.split(sep).filter((s) => s.length > 0);
  if (segments.length === 0) return;
  let current = resolvedBase;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? '';
    if (segment === '.' || segment === '..') {
      throw new StatuslineUserCachePathError(relative(resolvedBase, join(current, segment)));
    }
    current = join(current, segment);
    // The leaf (last segment) is allowed to be a regular file; intermediate
    // segments must be directories.
    const isLeaf = i === segments.length - 1;
    await assertExistingSegmentSafe(current, resolvedBase, {
      allowMissing: true,
      requireDir: !isLeaf,
    });
  }
}

/**
 * Single-segment safety check for the read-side walk. Tolerates missing
 * segments (the caller is reading; a missing parent is an absent file).
 * Rejects symlinks unconditionally. Rejects non-directory intermediate
 * segments. The leaf can be either a regular file or absent.
 */
async function assertExistingSegmentSafe(
  absPath: string,
  relRoot: string,
  opts: { allowMissing: boolean; requireDir: boolean },
): Promise<void> {
  let st;
  try {
    st = await lstat(absPath);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      if (opts.allowMissing) return;
      const rel = relative(relRoot, absPath) || basename(absPath);
      throw new StatuslineUserCachePathError(rel);
    }
    const rel = relative(relRoot, absPath) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
  if (st.isSymbolicLink()) {
    const rel = relative(relRoot, absPath) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
  if (opts.requireDir && !st.isDirectory()) {
    const rel = relative(relRoot, absPath) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
}

/**
 * Read a bounded JSON file under `baseDir` after walking every parent and the
 * leaf for symlinks. Returns:
 *   - the parsed JSON value on success;
 *   - `undefined` for any of: missing file, oversize file, symlinked parent
 *     or leaf, non-regular leaf, unparseable JSON, or any I/O error.
 *
 * Never throws to the caller. The `maxBytes` cap defaults to
 * `DEFAULT_USER_CACHE_READ_BYTES` (1 MiB) and is treated as a hard ceiling
 * by a bounded `open()`+`read()` loop, NOT by `readFile()`. A pre-read
 * `lstat()` size probe is informational only — between that probe and the
 * read the file may grow (TOCTOU / hostile writer), and `readFile()` would
 * slurp the whole post-growth payload into memory before we could reject
 * it. The bounded loop allocates exactly `cap + 1` bytes once and aborts
 * the instant the accumulator exceeds `cap`, so memory usage stays
 * O(`cap`) regardless of post-stat growth.
 *
 * NOTE: this mirrors the `readBoundedUtf8` pattern in `junit-import.ts` and
 * `readBoundedAutopilotJson` in `refresher.ts`. The loop is intentionally
 * duplicated here rather than extracted because junit-import's helper is
 * file-private and a shared-helper refactor would touch four call sites
 * (Phase 7 stay-in-scope rule).
 */
export async function readUserCacheJson(
  absPath: string,
  baseDir: string,
  maxBytes: number = DEFAULT_USER_CACHE_READ_BYTES,
): Promise<unknown | undefined> {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_USER_CACHE_READ_BYTES;
  try {
    await assertSafeUserCachePath(absPath, baseDir);
  } catch (error: unknown) {
    if (isUserCacheRejection(error)) return undefined;
    return undefined;
  }
  let st;
  try {
    st = await lstat(absPath);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined;
    return undefined;
  }
  if (st.isSymbolicLink()) return undefined;
  if (!st.isFile()) return undefined;
  // Pre-read lstat size is informational: a hostile writer can grow the file
  // between this probe and the bounded read. The cap is enforced by the
  // open()+read() loop below, which never loads more than `cap + 1` bytes
  // into the fixed buffer.
  if (st.size > cap) return undefined;
  const raw = await readBoundedUserCacheUtf8(absPath, cap);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Read a bounded text file under `baseDir` after walking every parent and
 * the leaf for symlinks. Returns the file contents as a string, or
 * `undefined` on any rejection / missing / oversize / I/O error. Never
 * throws to the caller.
 *
 * Used by callers that want to re-emit a previously rendered statusline
 * text (no parsing required) and by the project-local mirror reader.
 *
 * TOCTOU-safe: uses the same bounded `open()`+`read()` loop as
 * `readUserCacheJson`. The pre-read `lstat()` size is informational only;
 * the loop allocates exactly `cap + 1` bytes once and aborts on overflow,
 * so a file that grows between the probe and the read cannot push more
 * than the cap into memory.
 */
export async function readUserCacheText(
  absPath: string,
  baseDir: string,
  maxBytes: number = DEFAULT_USER_CACHE_READ_BYTES,
): Promise<string | undefined> {
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_USER_CACHE_READ_BYTES;
  try {
    await assertSafeUserCachePath(absPath, baseDir);
  } catch {
    return undefined;
  }
  let st;
  try {
    st = await lstat(absPath);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined;
    return undefined;
  }
  if (st.isSymbolicLink()) return undefined;
  if (!st.isFile()) return undefined;
  // See `readUserCacheJson`: pre-read size is informational; the bounded
  // loop is the load-bearing TOCTOU defence.
  if (st.size > cap) return undefined;
  return readBoundedUserCacheUtf8(absPath, cap);
}

/**
 * Hard-bounded UTF-8 read for the user-cache helpers.
 *
 * Allocates exactly `maxBytes + 1` bytes once and streams the file through
 * it in capped chunks. The instant the accumulator exceeds `maxBytes`, we
 * close the handle and return `undefined`. Memory usage is therefore
 * O(`maxBytes`) regardless of how the file grew between the caller's
 * `lstat()` size probe and this read (TOCTOU defence): we never load more
 * than `maxBytes + 1` bytes into memory.
 *
 * We do NOT use `readFile()` here because `readFile` slurps the entire
 * file into memory before any post-read size check can run; a hostile or
 * grown-since-stat file could push heap usage well past the documented
 * cap before the function rejects it.
 *
 * Returns the read bytes decoded as UTF-8 on success, `undefined` on any
 * open/read failure or when the file exceeds `maxBytes`. Never throws —
 * the user-cache read helpers are "fallback best-effort": any failure
 * collapses to `undefined` so the renderer falls back gracefully.
 *
 * This pattern mirrors `readBoundedUtf8` in `junit-import.ts` (Wave
 * 6.4B2+C) and `readBoundedAutopilotJson` in `refresher.ts`. We do NOT
 * import junit-import's helper because it is file-private; deliberately
 * duplicating the loop here keeps the patch scoped to storage.ts per the
 * Phase 7 stay-in-scope rule (the parallel autopilot/junit call sites
 * already work; a cross-file refactor would expand scope to four sites).
 */
async function readBoundedUserCacheUtf8(
  absPath: string,
  maxBytes: number,
): Promise<string | undefined> {
  const result = await readBoundedUtf8(absPath, maxBytes);
  return result.kind === 'ok' ? result.text : undefined;
}

/**
 * Discriminated outcome of {@link readBoundedUtf8}.
 *  - `ok`       — the file was read in full within the cap.
 *  - `absent`   — the file did not exist (ENOENT on open).
 *  - `oversize` — the file exceeded `maxBytes` (grew past the cap mid-read).
 *  - `error`    — any other open/read failure (EACCES, EIO, ...).
 */
type BoundedReadResult =
  | { kind: 'ok'; text: string }
  | { kind: 'absent' }
  | { kind: 'oversize' }
  | { kind: 'error'; message: string };

/**
 * Hard-bounded UTF-8 read — the single TOCTOU-safe primitive every
 * `.hive-flow/`-scoped AND user-cache read routes through.
 *
 * Allocates exactly `maxBytes + 1` bytes once and streams the file through it
 * in capped chunks. The instant the accumulator exceeds `maxBytes`, the handle
 * is closed and `{ kind: 'oversize' }` is returned. Memory usage is therefore
 * O(`maxBytes`) regardless of how the file grew between a caller's `lstat()`
 * size probe and this read (TOCTOU defence): we never load more than
 * `maxBytes + 1` bytes into memory.
 *
 * We do NOT use `readFile()` here because `readFile` slurps the entire file
 * into memory before any post-read size check can run; a hostile or
 * grown-since-stat file could push heap usage well past the documented cap
 * before the function rejects it.
 *
 * This pattern mirrors `readBoundedUtf8` in `junit-import.ts` (Wave 6.4B2+C)
 * and `readBoundedAutopilotJson` in `refresher.ts`. Those file-private helpers
 * stay duplicated (they predate this consolidation and a cross-file refactor
 * would widen scope); within storage.ts, all bounded reads share THIS loop.
 */
async function readBoundedUtf8(
  absPath: string,
  maxBytes: number,
): Promise<BoundedReadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absPath, 'r');
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  try {
    // Fixed allocation: `maxBytes + 1` lets us detect the overflow byte
    // (anything strictly larger than `maxBytes`) without ever growing
    // past it. 64 KiB streaming chunks match the rest of the statusline
    // IO and keep per-iteration syscall cost predictable.
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
      } catch (error: unknown) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      }
      if (chunk.bytesRead === 0) break;
      totalRead += chunk.bytesRead;
      if (totalRead > maxBytes) {
        // Hard cap: abort BEFORE the next read can grow `buf` further.
        // The buffer itself is `maxBytes + 1` bytes, so even the
        // overflow byte is bounded.
        return { kind: 'oversize' };
      }
    }
    return { kind: 'ok', text: buf.subarray(0, totalRead).toString('utf8') };
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing a stale handle on a partial read is non-fatal; we
      // already have what we need.
    }
  }
}

export interface WriteUserCacheJsonOptions {
  /** Override file mode. Defaults to 0o600 (owner-only). */
  readonly mode?: number;
  /** fsync after write for durability. Defaults to true. */
  readonly fsync?: boolean;
}

/**
 * Atomically write a JSON value at `absPath` under `baseDir`. Refuses to
 * write through a symlinked parent or leaf. Creates missing parent
 * directories with single-segment `mkdir` so symlink-following during
 * creation is impossible. After rename, the leaf is force-chmodded to mode
 * (default 0o600) so any pre-existing loose permission is tightened.
 *
 * Throws `StatuslineUserCachePathError` for symlinked parents/leaf. Other
 * errors propagate so the caller can surface them.
 */
export async function writeUserCacheJson(
  absPath: string,
  baseDir: string,
  value: unknown,
  opts: WriteUserCacheJsonOptions = {},
): Promise<void> {
  const mode = typeof opts.mode === 'number' ? opts.mode : 0o600;
  const fsync = opts.fsync ?? true;
  await ensureSafeUserCacheDir(dirname(absPath), baseDir);
  // Final-segment lstat: the parent walk above guarantees parents are
  // symlink-free, but the leaf may already exist as a symlink (set up by an
  // attacker between mkdir calls). Reject before atomicWrite renames over it.
  let st;
  try {
    st = await lstat(absPath);
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      const rel = relative(resolve(baseDir), resolve(absPath)) || basename(absPath);
      throw new StatuslineUserCachePathError(rel);
    }
    st = undefined;
  }
  if (st && st.isSymbolicLink()) {
    const rel = relative(resolve(baseDir), resolve(absPath)) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
  if (st && !st.isFile()) {
    const rel = relative(resolve(baseDir), resolve(absPath)) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
  await atomicWrite(absPath, JSON.stringify(value, null, 2) + '\n', { mode, fsync });
  await chmod(absPath, mode).catch(() => undefined);
}

export interface WriteUserCacheTextOptions {
  /** Override file mode. Defaults to 0o600. */
  readonly mode?: number;
  /** fsync after write for durability. Defaults to false. Text mirrors are
   *  rebuildable, so default is non-durable for write latency. */
  readonly fsync?: boolean;
}

/**
 * Atomically write `text` at `absPath` under `baseDir`. Same guarantees as
 * `writeUserCacheJson` (symlink-rejecting parent walk, single-segment mkdir
 * during creation, atomic rename, chmod 0o600). Used for the global mirror
 * `last-render.txt` and the project-local `state/last-render.txt`.
 */
export async function writeUserCacheText(
  absPath: string,
  baseDir: string,
  text: string,
  opts: WriteUserCacheTextOptions = {},
): Promise<void> {
  const mode = typeof opts.mode === 'number' ? opts.mode : 0o600;
  const fsync = opts.fsync ?? false;
  await ensureSafeUserCacheDir(dirname(absPath), baseDir);
  let st;
  try {
    st = await lstat(absPath);
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      const rel = relative(resolve(baseDir), resolve(absPath)) || basename(absPath);
      throw new StatuslineUserCachePathError(rel);
    }
    st = undefined;
  }
  if (st && st.isSymbolicLink()) {
    const rel = relative(resolve(baseDir), resolve(absPath)) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
  if (st && !st.isFile()) {
    const rel = relative(resolve(baseDir), resolve(absPath)) || basename(absPath);
    throw new StatuslineUserCachePathError(rel);
  }
  await atomicWrite(absPath, text, { mode, fsync });
  await chmod(absPath, mode).catch(() => undefined);
}

/**
 * Symlink-safe `unlink` for a leaf path beneath `baseDir` in the user cache.
 *
 * Companion to `safeUnlinkInHiveFlow`. Walks every segment from `baseDir` to
 * the LEAF (`absPath`) via `assertSafeUserCachePath` (the same walk that
 * `writeUserCacheJson` / `readUserCacheJson` use): refuses on a symlinked
 * intermediate directory or a symlinked leaf. Only after the walk passes
 * does the function issue the `unlink`.
 *
 * Returns:
 *   - `'unlinked'`  — the leaf existed and was removed.
 *   - `'absent'`    — the leaf was missing (ENOENT). Idempotent success.
 *   - `'rejected'`  — any intermediate or leaf is a symbolic link. The path
 *     was NOT followed and NO `unlink` was issued.
 *
 * Closes the user-scope hole in `integrations/integration-marker.ts`. Prior
 * to this helper, `removeMarker` validated only the PARENT directory via
 * `ensureSafeUserCacheDir` — which has a creation side effect (it would
 * create the integrations directory). The dedicated read-side
 * `assertSafeUserCachePath` walk used here both lstat-rejects symlinked
 * parents AND inspects the leaf itself for symlinks before any unlink.
 *
 * Non-symlink errors (EACCES, EBUSY, ...) propagate so the caller can
 * surface them.
 */
export async function safeUnlinkInUserCache(
  absPath: string,
  baseDir: string,
): Promise<SafeUnlinkResult> {
  try {
    await assertSafeUserCachePath(absPath, baseDir);
  } catch (error: unknown) {
    if (isUserCacheRejection(error)) return 'rejected';
    throw error;
  }
  try {
    await unlink(absPath);
    return 'unlinked';
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return 'absent';
    throw error;
  }
}

/**
 * Read the renderer refresh-request marker's mtime via a symlink-rejecting
 * path. Mirrors `touchRefreshRequest`'s path-resolution logic so the read
 * and write halves of the debounce loop agree on the canonical location.
 *
 * Closes Codex Phase 7 Finding 1 (HIGH, read-side): the prior refresher
 * called `fs/promises.stat()` directly on `paths.refreshRequest`, which
 * follows symlinks. A symlinked marker pointing at a fresh outside file
 * therefore made the debounce think the marker was recent, the cached
 * snapshot was returned, and a real refresh was suppressed. Combined with
 * Codex's earlier write-side fix this guarantees both halves of the
 * marker loop are symlink-safe.
 *
 * Semantics:
 *   - Walks every intermediate `.hive-flow/` segment via
 *     `assertSafeStatuslineStoragePath` (rejects a symlinked `.hive-flow/`,
 *     `.hive-flow/state/`, etc.).
 *   - Uses `lstat` (NOT `stat`) on the marker leaf itself so a symlinked
 *     marker file is rejected before its mtime can be observed.
 *   - Returns `undefined` on ANY rejection (missing, symlinked, non-regular,
 *     path walk failure). The refresher treats `undefined` as "no marker
 *     -> perform a full refresh", which is the correct fail-safe.
 *   - Returns `{ mtimeMs }` only when the marker is a real regular file
 *     under a symlink-free `.hive-flow/` chain.
 */
export async function readRefreshMarkerStat(
  projectRoot: string,
): Promise<RefreshMarkerStat | undefined> {
  const { statuslinePaths } = await import('./paths.js');
  const paths = statuslinePaths(projectRoot);
  try {
    await assertSafeStatuslineStoragePath(paths.refreshRequest);
  } catch (error: unknown) {
    if (isSymlinkRejection(error)) return undefined;
    // Any other path-walk failure is also a hard reject; fail safe.
    return undefined;
  }
  let st;
  try {
    st = await lstat(paths.refreshRequest);
  } catch {
    // Missing marker (ENOENT) AND any other lstat error collapse to
    // "no marker": the refresher will then do a full refresh.
    return undefined;
  }
  // Symlinked marker leaf: refuse (the lstat above doesn't follow the link).
  if (st.isSymbolicLink()) return undefined;
  // Anything other than a regular file (e.g. dir, socket, fifo) is rejected.
  if (!st.isFile()) return undefined;
  return { mtimeMs: st.mtimeMs };
}
