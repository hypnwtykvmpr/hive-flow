// cli/src/statusline/last-render.ts
//
// Phase 12 of the statusline rewrite — Wave 8 refactor (Codex Phase 7
// Finding 1 + Finding 2).
//
// Three concepts (per the canonical runbook §7.1 + §13 design):
//
//   1. **Global mirror** at the user-home statusline cache, namespaced by
//      `projectKey` (the 16-char sha256 from Wave 3 `resolveProjectScope`).
//      JSON record path: `${HIVE_FLOW_HOME ?? ~}/.hive-flow/statusline/projects/${projectKey}/last-render.json`
//      Plain-text mirror (compat with non-CLAUDE CLIs that just `cat` it):
//      `${HIVE_FLOW_HOME ?? ~}/.hive-flow/statusline/projects/${projectKey}/last-render.txt`
//
//   2. **"Current pointer"** — a global file pointing at the most recent
//      project's last-render so non-Claude CLIs that don't know the
//      `projectKey` can still find it.
//      Path: `${HIVE_FLOW_HOME ?? ~}/.hive-flow/statusline/current.json`
//      Body: `{ version: 1, projectKey, projectRoot, renderedAt, lastRender: <absolute path to JSON record> }`
//
//   3. **Project-local mirror** at `${projectRoot}/.hive-flow/state/last-render.txt`
//      (Wave 2 `statuslinePaths(projectRoot).lastRender`). Written ONLY when
//      `.hive-flow/` already exists for that project — we never create the
//      `.hive-flow/` tree from this code path. Plain text (compat with
//      `cat`); the JSON record lives only in the global mirror.
//
// Storage safety (Codex Phase 7 Finding 1):
//
//   - The global mirror sits OUTSIDE `.hive-flow/`, so the Wave 2.5A
//     `assertSafeStatuslineStoragePath` guard would be a no-op for it. We
//     route every global-mirror read/write through the new
//     `ensureSafeUserCacheDir` + `assertSafeUserCachePath` primitives in
//     `storage.ts` which walk EVERY segment from the user-home base to the
//     leaf and reject any symlinked intermediate. `mkdir` is single-segment
//     (no `recursive: true`) during the walk so symlinks cannot be followed
//     even during creation.
//   - The project-local mirror sits INSIDE `.hive-flow/`, so Wave 2.5A
//     `assertSafeStatuslineStoragePath` (via `atomicWriteJson` /
//     `touchRefreshRequest`-shaped helpers) is the load-bearing guard. We
//     additionally check that `.hive-flow/` exists as a real directory
//     before writing (refuses symlinked `.hive-flow/` etc.).
//   - All written files land at mode 0o600 (atomic temp + fsync + rename +
//     chmod). Reads are bounded by `MAX_INIT_BUFFER_BYTES` (64 KiB) for the
//     JSON record and by a 1 MiB cap for the plain-text mirrors.
//
// API shape (Codex Phase 7 Finding 2):
//
//   - `writeLastRender({ rendered, mode, projectRoot, projectKey, ... })`
//     ALWAYS writes the global mirror and the current pointer, and writes
//     the project-local mirror only when `.hive-flow/` exists.
//   - `readLastRender({ projectRoot? , projectKey?, ... })` prefers the
//     project-local mirror when `projectRoot` is supplied AND `.hive-flow/`
//     exists; falls back to the global mirror by `projectKey`. When only
//     `projectKey` is supplied, reads only the global mirror. When neither
//     is supplied, returns `undefined` — the caller must use
//     `readLastRenderViaCurrentPointer` for cross-CLI fallback.
//   - `readLastRenderViaCurrentPointer()` reads the current pointer then
//     the corresponding global mirror entry (validates the pointer schema
//     defensively first).

import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MAX_INIT_BUFFER_BYTES, type StatuslineSnapshotV1 } from './types.js';
import { statuslinePaths } from './paths.js';
import {
  ensureSafeUserCacheDir,
  readUserCacheJson,
  readUserCacheText,
  StatuslineUserCachePathError,
  writeUserCacheJson,
  writeUserCacheText,
} from './storage.js';

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

export type LastRenderMode = 'snapshot' | 'inline-collector' | 'header-only';

const VALID_MODES: ReadonlySet<LastRenderMode> = new Set([
  'snapshot',
  'inline-collector',
  'header-only',
]);

/**
 * Persisted record. `version` is fixed at 1; future revisions bump this and
 * `readLastRender` rejects mismatches (returns `undefined`).
 *
 * The `rendered` field carries the ANSI-decorated statusline output exactly
 * as the renderer produced it. ANSI control bytes are *data* here, not source
 * code: the bug-hunt rule prohibiting literal control bytes applies to the
 * source of this module, not to the runtime payload.
 *
 * `projectRoot` and `projectKey` are persisted alongside the body so a
 * cross-CLI consumer reading the global mirror can identify which project
 * the record belongs to without consulting the current pointer.
 */
export interface LastRenderRecord {
  readonly version: 1;
  readonly renderedAt: string;
  readonly mode: LastRenderMode;
  readonly rendered: string;
  readonly snapshot?: StatuslineSnapshotV1;
  readonly projectKey?: string;
  readonly projectRoot?: string;
}

/**
 * Current-pointer record. Lives at
 * `${HIVE_FLOW_HOME ?? ~}/.hive-flow/statusline/current.json`. Non-Claude
 * CLIs read this file to find the latest project's last-render without
 * needing to know `projectKey` ahead of time.
 */
export interface LastRenderCurrentPointer {
  readonly version: 1;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly renderedAt: string;
  /** Absolute path to the global-mirror JSON record for this projectKey. */
  readonly lastRender: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `writeLastRender` when a target path resolves through a
 * symbolic link or a non-directory parent. Wraps the typed
 * `StatuslineUserCachePathError` raised by the user-cache primitives so
 * callers that just want a single class to catch can use this one. Reads
 * never surface this — they collapse to `undefined`.
 */
export class StatuslineLastRenderSymlinkError extends Error {
  readonly code = 'STATUSLINE_LAST_RENDER_SYMLINK';
  constructor(message: string) {
    super(message);
    this.name = 'StatuslineLastRenderSymlinkError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PROJECT_KEY_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Validate that `projectKey` is a 16-char lowercase hex string, matching the
 * shape produced by Wave 3 `resolveProjectScope`. We refuse anything that
 * looks like a path fragment (separators, `..`) before it can reach
 * `path.join` and create cross-project collisions or escapes.
 */
function assertValidProjectKey(projectKey: unknown): asserts projectKey is string {
  if (typeof projectKey !== 'string' || !PROJECT_KEY_PATTERN.test(projectKey)) {
    throw new TypeError(
      `writeLastRender: opts.projectKey must be 16-char lowercase hex (got: ${String(projectKey)})`,
    );
  }
}

/**
 * Validate that `projectRoot` is a non-empty absolute path. Refuses
 * relative paths so the same string can be persisted in records and read
 * back deterministically by cross-CLI consumers.
 */
function assertValidProjectRoot(projectRoot: unknown): asserts projectRoot is string {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('writeLastRender: opts.projectRoot must be a non-empty string');
  }
  if (!isAbsolute(projectRoot)) {
    throw new TypeError(`writeLastRender: opts.projectRoot must be absolute (got: ${projectRoot})`);
  }
}

/**
 * Resolve the user-home base for the current process.
 *
 *   - `HIVE_FLOW_HOME` (test/CI override; absolute path) wins
 *   - otherwise `homedir()`
 *
 * The returned path is always absolute. The runbook §7.1 uses this exact
 * shape; tests stub it via `HIVE_FLOW_HOME` rather than mutating the real
 * homedir.
 *
 * This is the TRUSTED ROOT for the user-cache walker. We assume the user's
 * home directory itself is trusted (it is the user-owned root the OS gives
 * them); every segment BENEATH it is symlink-checked.
 */
function resolveUserHomeBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HIVE_FLOW_HOME;
  if (typeof override === 'string' && override.length > 0 && isAbsolute(override)) {
    return resolve(override);
  }
  return resolve(homedir());
}

/**
 * Logical root of the user-home statusline cache:
 * `${home}/.hive-flow/statusline`. This is the conceptual base from the
 * runbook's perspective but is NOT what we pass to the user-cache walker
 * (the walker needs a known-good root that already exists). The walker is
 * always called with `resolveUserHomeBase(env)` so each of `.hive-flow/`,
 * `statusline/`, `projects/`, `${projectKey}/` are individually walked,
 * created, and lstat-checked.
 */
function resolveUserCacheBase(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveUserHomeBase(env), '.hive-flow', 'statusline');
}

/**
 * Per-project namespace directory under the global mirror.
 * `${base}/projects/${projectKey}/`. Single-segment-safe because each
 * intermediate (`projects/`, `${projectKey}/`) is a flat directory name.
 */
function globalMirrorProjectDir(projectKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveUserCacheBase(env), 'projects', projectKey);
}

/**
 * Absolute path to the global-mirror JSON record for `projectKey`.
 */
function globalMirrorJsonPath(projectKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMirrorProjectDir(projectKey, env), 'last-render.json');
}

/**
 * Absolute path to the global-mirror plain-text file for `projectKey`. This
 * is the compat surface for non-Claude CLIs that want to `cat` the latest
 * rendered output without parsing JSON.
 */
function globalMirrorTextPath(projectKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMirrorProjectDir(projectKey, env), 'last-render.txt');
}

/**
 * Absolute path to the current-pointer file. There is only one per user.
 */
function currentPointerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveUserCacheBase(env), 'current.json');
}

/**
 * Validate that `value` matches the {@link LastRenderRecord} shape. Returns
 * the typed record on success and `undefined` on any mismatch. Strict so the
 * read path never returns half-validated data.
 */
function validateRecord(value: unknown): LastRenderRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return undefined;
  if (typeof obj.renderedAt !== 'string' || obj.renderedAt.length === 0) return undefined;
  // Cheap ISO check: Date.parse returns NaN for non-ISO inputs. This rejects
  // empty strings, "not a date", and similar without bringing in a full ISO
  // regex. We then re-stringify to confirm round-tripping via Date does not
  // silently coerce a permissive input (e.g. `Date.parse('1')` succeeds on
  // some engines).
  const ts = Date.parse(obj.renderedAt);
  if (!Number.isFinite(ts)) return undefined;
  if (typeof obj.mode !== 'string' || !VALID_MODES.has(obj.mode as LastRenderMode)) {
    return undefined;
  }
  if (typeof obj.rendered !== 'string') return undefined;
  // Optional snapshot: when present, must be an object. We do not attempt to
  // re-validate the entire snapshot shape (that is the renderer's
  // responsibility); we only refuse non-object values so an attacker cannot
  // smuggle an array or primitive through the typed alias.
  if (obj.snapshot !== undefined) {
    if (!obj.snapshot || typeof obj.snapshot !== 'object' || Array.isArray(obj.snapshot)) {
      return undefined;
    }
  }
  if (obj.projectKey !== undefined && typeof obj.projectKey !== 'string') return undefined;
  if (obj.projectRoot !== undefined && typeof obj.projectRoot !== 'string') return undefined;
  return obj as unknown as LastRenderRecord;
}

/**
 * Validate that `value` matches the {@link LastRenderCurrentPointer} shape.
 * Returns the typed pointer on success and `undefined` on any mismatch.
 * Used by `readLastRenderViaCurrentPointer` so a corrupted pointer file
 * can never escalate into reading an arbitrary global-mirror path.
 */
function validateCurrentPointer(value: unknown): LastRenderCurrentPointer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return undefined;
  if (typeof obj.projectKey !== 'string' || !PROJECT_KEY_PATTERN.test(obj.projectKey)) {
    return undefined;
  }
  if (typeof obj.projectRoot !== 'string' || obj.projectRoot.length === 0) return undefined;
  if (typeof obj.renderedAt !== 'string') return undefined;
  if (!Number.isFinite(Date.parse(obj.renderedAt))) return undefined;
  if (typeof obj.lastRender !== 'string' || obj.lastRender.length === 0) return undefined;
  if (!isAbsolute(obj.lastRender)) return undefined;
  return obj as unknown as LastRenderCurrentPointer;
}

/**
 * Test whether `projectRoot/.hive-flow/` exists AND is a real directory (NOT
 * a symlink). Used to decide whether to write the project-local mirror. We
 * never create `.hive-flow/` from this code path — the rule is "mirror only
 * when the project already opted in".
 *
 * Returns false on any error (missing, symlinked, non-directory, EACCES, …)
 * so a hostile or odd filesystem can never trick us into thinking
 * `.hive-flow/` exists when it should not.
 */
async function hiveFlowDirExists(projectRoot: string): Promise<boolean> {
  try {
    const st = await lstat(join(projectRoot, '.hive-flow'));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Project-local mirror leaf path. Wave 2 `statuslinePaths` already encodes
 * `${projectRoot}/.hive-flow/state/last-render.txt`; we centralise the
 * lookup here so both the write and read halves agree.
 */
function projectLocalMirrorPath(projectRoot: string): string {
  return statuslinePaths(projectRoot).lastRender;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WriteLastRenderOptions {
  /** ANSI-decorated rendered output, as produced by the renderer. */
  readonly rendered: string;
  /** Optional snapshot the renderer used. Persisted as-is when present. */
  readonly snapshot?: StatuslineSnapshotV1;
  /** Override the "now" clock; epoch ms. Defaults to `Date.now()`. */
  readonly nowMs?: number;
  /** Which rendering path produced this output. */
  readonly mode: LastRenderMode;
  /** Absolute path to the worktree/checkout root. Required. */
  readonly projectRoot: string;
  /**
   * 16-char lowercase hex sha256 prefix identifying the project. Required.
   * Namespaces the global mirror so two projects never collide.
   */
  readonly projectKey: string;
  /** Override `process.env`; used by tests with explicit XDG / home paths. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Persist the last rendered statusline output.
 *
 * Always writes:
 *   - global-mirror JSON record at
 *     `${userCacheBase}/projects/${projectKey}/last-render.json`;
 *   - global-mirror plain-text file at
 *     `${userCacheBase}/projects/${projectKey}/last-render.txt` (compat for
 *     non-Claude CLIs that just `cat` the file);
 *   - current pointer at `${userCacheBase}/current.json`.
 *
 * Conditionally writes:
 *   - project-local mirror at `${projectRoot}/.hive-flow/state/last-render.txt`
 *     if and only if `.hive-flow/` already exists as a real directory.
 *
 * Caller contract:
 *   - `opts.mode` MUST be one of `'snapshot' | 'inline-collector' | 'header-only'`.
 *   - `opts.projectRoot` MUST be an absolute path.
 *   - `opts.projectKey` MUST be 16-char lowercase hex.
 *   - `opts.rendered` may carry ANSI bytes; that is data, not source.
 *
 * All writes go through symlink-rejecting parent walks (no recursive mkdir),
 * land mode 0o600, and use atomic temp + fsync + rename. Symlinked
 * `${userCacheBase}/projects/`, `${userCacheBase}/projects/${projectKey}/`,
 * `${userCacheBase}/`, or the leaf itself all REJECT the write entirely
 * (raises `StatuslineLastRenderSymlinkError`). A rejected global write
 * leaves the outside target untouched.
 */
export async function writeLastRender(opts: WriteLastRenderOptions): Promise<void> {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('writeLastRender: opts must be an object');
  }
  if (typeof opts.rendered !== 'string') {
    throw new TypeError('writeLastRender: opts.rendered must be a string');
  }
  if (!VALID_MODES.has(opts.mode)) {
    throw new TypeError(
      `writeLastRender: opts.mode must be one of snapshot|inline-collector|header-only (got: ${String(opts.mode)})`,
    );
  }
  assertValidProjectRoot(opts.projectRoot);
  assertValidProjectKey(opts.projectKey);
  const env = opts.env ?? process.env;
  // The walker's trusted root is the user's HOME directory (always exists,
  // owned by the user). Every segment beneath — `.hive-flow/`, `statusline/`,
  // `projects/`, `${projectKey}/` — is individually walked, lstat'd, and
  // single-segment-mkdir'd. This is the load-bearing symlink defence.
  const baseDir = resolveUserHomeBase(env);

  const nowMs =
    typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) && opts.nowMs >= 0
      ? opts.nowMs
      : Date.now();
  const renderedAt = new Date(nowMs).toISOString();

  const record: LastRenderRecord = {
    version: 1,
    renderedAt,
    mode: opts.mode,
    rendered: opts.rendered,
    projectKey: opts.projectKey,
    projectRoot: opts.projectRoot,
    ...(opts.snapshot !== undefined ? { snapshot: opts.snapshot } : {}),
  };

  const jsonPath = globalMirrorJsonPath(opts.projectKey, env);
  const textPath = globalMirrorTextPath(opts.projectKey, env);
  const pointerPath = currentPointerPath(env);
  const pointer: LastRenderCurrentPointer = {
    version: 1,
    projectKey: opts.projectKey,
    projectRoot: opts.projectRoot,
    renderedAt,
    lastRender: jsonPath,
  };

  try {
    // Ensure the cache base + per-project namespace exist as real
    // directories (not symlinks). Single-segment mkdir all the way down.
    await ensureSafeUserCacheDir(globalMirrorProjectDir(opts.projectKey, env), baseDir);
    // Three writes — JSON record, text mirror, pointer. Each routes through
    // the symlink-rejecting helpers. Order: JSON + text first so a reader
    // that catches the pointer post-write sees an intact mirror. The
    // pointer is the LAST write (with fsync) so a torn write before the
    // pointer leaves the previous pointer intact.
    await writeUserCacheJson(jsonPath, baseDir, record, { mode: 0o600, fsync: true });
    await writeUserCacheText(textPath, baseDir, opts.rendered + '\n', { mode: 0o600, fsync: false });
    await writeUserCacheJson(pointerPath, baseDir, pointer, { mode: 0o600, fsync: true });
  } catch (error: unknown) {
    if (error instanceof StatuslineUserCachePathError) {
      throw new StatuslineLastRenderSymlinkError(
        `writeLastRender: refusing to write through a symlinked user-cache path (${error.relativeOffender})`,
      );
    }
    throw error;
  }

  // Project-local mirror — text only, only when `.hive-flow/` exists AND
  // `opts.mode === 'snapshot'`. The local mirror is text-only (no JSON
  // envelope) so the read side (`synthesizeLocalRecord`) is forced to
  // synthesize `mode: 'snapshot'` for whatever it finds there. If we wrote
  // degraded (`inline-collector` / `header-only`) renders into the same
  // file, a subsequent `readLastRender({ projectRoot })` would mis-report
  // them as snapshots — and worse, a degraded write would clobber the last
  // full snapshot, which is the thing operators usually want when probing
  // "what did the user just see?".
  //
  // By gating the write on `snapshot`, the synthesized read is correct by
  // construction (we only ever write snapshots locally, so reading them
  // back as snapshots is true), and a degraded render leaves the previous
  // snapshot intact.
  //
  // We intentionally do NOT create `.hive-flow/` from here; the project
  // must opt in by initializing the tree itself. The Wave 2.5A guard inside
  // the generic `storage.touchRefreshRequest`-shaped helpers covers
  // symlinked `.hive-flow/`/`.hive-flow/state/`; we additionally lstat the
  // leaf before writing so a hostile leaf-symlink is rejected too.
  if (opts.mode === 'snapshot') {
    const wantsLocal = await hiveFlowDirExists(opts.projectRoot);
    if (wantsLocal) {
      await writeProjectLocalMirror(opts.projectRoot, opts.rendered);
    }
  }
}

/**
 * Write the project-local text mirror under `.hive-flow/state/`. Reuses the
 * `.hive-flow/`-scoped Wave 2.5A guard via the generic user-cache helpers
 * pointed at `projectRoot` as the base — the parent walk thus protects
 * every intermediate from `.hive-flow/` down to the leaf.
 *
 * Refuses to create the `.hive-flow/state/` parent if `.hive-flow/` is
 * itself a symlink (defence-in-depth — `hiveFlowDirExists` already returned
 * false in that case, but a TOCTOU race could otherwise let a hostile
 * symlink be inserted between the check and the write).
 */
async function writeProjectLocalMirror(projectRoot: string, rendered: string): Promise<void> {
  const leaf = projectLocalMirrorPath(projectRoot);
  // Use `projectRoot` as the baseDir so the user-cache walker validates
  // every segment from the project root down — `.hive-flow/` then `state/`
  // then `last-render.txt` — for symlinks. The walker accepts an already-
  // existing directory chain unchanged; it only CREATES `.hive-flow/state/`
  // (single-segment) if `.hive-flow/` already exists as a real directory.
  try {
    await ensureSafeUserCacheDir(dirname(leaf), projectRoot);
    await writeUserCacheText(leaf, projectRoot, rendered + '\n', {
      mode: 0o600,
      fsync: false,
    });
  } catch (error: unknown) {
    if (error instanceof StatuslineUserCachePathError) {
      throw new StatuslineLastRenderSymlinkError(
        `writeLastRender: refusing to write through a symlinked project-local mirror path (${error.relativeOffender})`,
      );
    }
    throw error;
  }
}

export interface ReadLastRenderOptions {
  /**
   * Absolute path to the project root. When supplied, the read prefers the
   * project-local mirror; falls back to the global mirror by `projectKey`
   * when the project-local file is missing/unreadable.
   */
  readonly projectRoot?: string;
  /**
   * 16-char hex project identifier. When supplied (with or without
   * `projectRoot`), reads from the global-mirror namespace for that key.
   */
  readonly projectKey?: string;
  /** Override `process.env`; tests use explicit `HIVE_FLOW_HOME` paths. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override the JSON-record byte cap. Default 64 KiB. */
  readonly maxBytes?: number;
}

/**
 * Read the persisted last-render record.
 *
 *   - `{ projectRoot }`: prefer the project-local TEXT mirror (synthesises a
 *     `LastRenderRecord` with `mode='snapshot'`-equivalent shape because the
 *     project-local file is text-only); fall back to the global mirror by
 *     `projectKey` when both `projectRoot` and `projectKey` are supplied
 *     AND the project-local mirror is missing.
 *   - `{ projectKey }`: read only the global mirror JSON record for that key.
 *   - Neither: returns `undefined`. Cross-CLI consumers should use
 *     `readLastRenderViaCurrentPointer` instead.
 *
 * Returns `undefined` for any of:
 *   - the target file does not exist;
 *   - the file is a symlink (refuse to follow);
 *   - the file is not a regular file (socket, fifo, etc.);
 *   - the file exceeds `maxBytes` (defaults to `MAX_INIT_BUFFER_BYTES`);
 *   - the file is unparseable JSON;
 *   - the parsed record fails {@link validateRecord} (including version mismatch);
 *   - any I/O error during the read.
 *
 * Never throws to the caller.
 */
export async function readLastRender(
  options: ReadLastRenderOptions = {},
): Promise<LastRenderRecord | undefined> {
  const env = options.env ?? process.env;
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : MAX_INIT_BUFFER_BYTES;

  if (typeof options.projectRoot === 'string' && options.projectRoot.length > 0) {
    if (!isAbsolute(options.projectRoot)) return undefined;
    // Prefer project-local TEXT mirror when `.hive-flow/` exists.
    if (await hiveFlowDirExists(options.projectRoot)) {
      const localText = await readProjectLocalMirror(options.projectRoot, maxBytes);
      if (typeof localText === 'string') {
        return synthesizeLocalRecord(options.projectRoot, localText);
      }
    }
    // Fall through to global mirror when `projectKey` is also supplied.
    if (typeof options.projectKey === 'string' && PROJECT_KEY_PATTERN.test(options.projectKey)) {
      return readGlobalMirror(options.projectKey, env, maxBytes);
    }
    return undefined;
  }

  if (typeof options.projectKey === 'string' && PROJECT_KEY_PATTERN.test(options.projectKey)) {
    return readGlobalMirror(options.projectKey, env, maxBytes);
  }

  return undefined;
}

/**
 * Read the global-mirror JSON record for `projectKey`. The user-cache
 * primitives lstat every parent and the leaf, so a symlinked any-segment
 * collapses to `undefined`. JSON parse failure and schema mismatch also
 * collapse to `undefined`.
 */
async function readGlobalMirror(
  projectKey: string,
  env: NodeJS.ProcessEnv,
  maxBytes: number,
): Promise<LastRenderRecord | undefined> {
  // See `writeLastRender`: the walker's trusted root is the user's HOME
  // directory; every segment from there down is symlink-checked.
  const baseDir = resolveUserHomeBase(env);
  const jsonPath = globalMirrorJsonPath(projectKey, env);
  const parsed = await readUserCacheJson(jsonPath, baseDir, maxBytes);
  if (parsed === undefined) return undefined;
  return validateRecord(parsed);
}

/**
 * Read the project-local text mirror. Uses `projectRoot` as the baseDir
 * for the user-cache walker so every intermediate (`.hive-flow/`, `state/`,
 * the leaf) is symlink-checked. Returns the raw text on success, undefined
 * on any rejection. Bounded by `maxBytes`.
 */
async function readProjectLocalMirror(
  projectRoot: string,
  maxBytes: number,
): Promise<string | undefined> {
  const leaf = projectLocalMirrorPath(projectRoot);
  return readUserCacheText(leaf, projectRoot, maxBytes);
}

/**
 * Synthesise a `LastRenderRecord` from the project-local text mirror. The
 * project-local file is text-only (no JSON envelope) so we infer the
 * structured shape callers expect:
 *   - `mode` is always `'snapshot'` (the local mirror is only written from
 *     a successful snapshot render — header-only/inline-collector callers
 *     emit only to the global mirror by design);
 *   - `renderedAt` is the mtime of the local mirror file;
 *   - `rendered` is the raw text with a single trailing newline stripped
 *     (we always append exactly one on write).
 *
 * Returns `undefined` if the local file mtime can't be lstat'd safely.
 */
async function synthesizeLocalRecord(
  projectRoot: string,
  text: string,
): Promise<LastRenderRecord | undefined> {
  const leaf = projectLocalMirrorPath(projectRoot);
  let mtimeMs: number;
  try {
    const st = await lstat(leaf);
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    mtimeMs = st.mtimeMs;
  } catch {
    return undefined;
  }
  // Strip exactly one trailing newline added by `writeUserCacheText`.
  const rendered = text.endsWith('\n') ? text.slice(0, -1) : text;
  return {
    version: 1,
    renderedAt: new Date(mtimeMs).toISOString(),
    mode: 'snapshot',
    rendered,
    projectRoot,
  };
}

/**
 * Cross-CLI fallback: read the current pointer at
 * `${userCacheBase}/current.json`, validate it against the typed pointer
 * schema, then read the global mirror it points to.
 *
 * Used by non-Claude CLIs that don't know `projectKey` in advance — they
 * follow the pointer to find whatever project last rendered. Returns
 * `undefined` if any step fails (no pointer, corrupted pointer, pointer
 * targets a non-existent global mirror entry, schema mismatch, etc.).
 *
 * The pointer is validated BEFORE being trusted: a forged pointer with an
 * absolute `lastRender` path outside the user-cache base would be caught
 * by the `lastRender` field check in `validateCurrentPointer` (requires an
 * absolute path) and then by the user-cache walker (rejects any path that
 * does not resolve inside the user-cache base). We re-derive the canonical
 * global-mirror path from `projectKey` here instead of trusting the
 * pointer's `lastRender` field, so a tampered pointer cannot redirect us
 * to an attacker-controlled file.
 */
export async function readLastRenderViaCurrentPointer(
  options: { env?: NodeJS.ProcessEnv; maxBytes?: number } = {},
): Promise<LastRenderRecord | undefined> {
  const env = options.env ?? process.env;
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : MAX_INIT_BUFFER_BYTES;
  const baseDir = resolveUserHomeBase(env);
  const pointerPath = currentPointerPath(env);
  const pointerRaw = await readUserCacheJson(pointerPath, baseDir, maxBytes);
  const pointer = validateCurrentPointer(pointerRaw);
  if (!pointer) return undefined;
  // Re-derive the canonical global-mirror path from projectKey rather than
  // trusting the pointer's `lastRender` field. This means a forged pointer
  // with a redirected lastRender cannot make us read an attacker-controlled
  // file even if the pointer somehow validated.
  return readGlobalMirror(pointer.projectKey, env, maxBytes);
}

// ---------------------------------------------------------------------------
// Exports for callers that prefer named-path helpers (e.g. inspect surface)
// ---------------------------------------------------------------------------

/**
 * Public path helpers — exposed so callers (the `statusline inspect` command,
 * documentation tooling, and the Wave 9 renderer dispatch) can show the
 * exact filesystem location used by `writeLastRender` for a given project.
 *
 * Tests use these to assert that writes landed where the runbook specifies.
 */
export function lastRenderPaths(
  projectKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<{
  base: string;
  projectDir: string;
  json: string;
  text: string;
  currentPointer: string;
}> {
  assertValidProjectKey(projectKey);
  const base = resolveUserCacheBase(env);
  return Object.freeze({
    base,
    projectDir: globalMirrorProjectDir(projectKey, env),
    json: globalMirrorJsonPath(projectKey, env),
    text: globalMirrorTextPath(projectKey, env),
    currentPointer: currentPointerPath(env),
  });
}

/** Re-export the snapshot type so callers handling `LastRenderRecord` can
 *  describe an attached snapshot without pulling in `types.js` themselves. */
export type { StatuslineSnapshotV1 };
