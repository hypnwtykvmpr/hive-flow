// cli/src/statusline/project-scope.ts
//
// Wave 3 — Project Scope helper.
//
// Synchronous, pure, no FS writes. Provides worktree-aware identity:
//   - `worktreeRoot`  : output of `git rev-parse --show-toplevel`
//   - `repoIdentity`  : parent of `git rev-parse --git-common-dir`, so multiple
//                       linked worktrees of the same repository collide on a
//                       single identity instead of fragmenting state.
//   - `projectKey`    : deterministic 16-char hex sha256 of `repoIdentity`,
//                       stable across worktrees and process restarts.
//   - `displayName`   : `basename(worktreeRoot)` — this module deliberately
//                       does NOT call the asynchronous
//                       `resolveProjectIdentity` from `project-identity.ts`
//                       (the 6-tier display-name resolver). The two helpers
//                       compose at the renderer layer: project-scope answers
//                       "which repo, which worktree?", project-identity
//                       answers "what should we call it?".
//   - `freshness`     : `{ state, source, observedAt }` — describes how the
//                       resolver obtained its data. `state` is `'resolved'`
//                       when at least `worktreeRoot` was obtained from git,
//                       and `'inferred'` when both `worktreeRoot` and
//                       `repoIdentity` had to fall back to `cwd` (i.e. not
//                       in a git repo or git unavailable).
//
// Binding constraints (Phase 5):
//   - No `execSync`. Only `spawnSync` with argv array and bounded timeout.
//   - No shell strings ever — only argv arrays.
//   - In-process cache keyed on the realpath of the absolute `cwd` to
//     prevent cache-poisoning via user-controlled relative input and to
//     coalesce repeat calls in the same render to a single git invocation.
//   - No `as any`, no unsafe casts.
//   - `lstatSync` would be the right call if we ever needed to follow
//     symlinks on git's output. We use `realpathSync.native` defensively
//     and tolerate `ENOENT`/`EACCES` by falling back to `resolve(path)`.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type ProjectScopeFreshnessState = 'resolved' | 'inferred';
export type ProjectScopeFreshnessSource = 'git' | 'fallback';

export interface ProjectScopeFreshness {
  readonly state: ProjectScopeFreshnessState;
  readonly source: ProjectScopeFreshnessSource;
  readonly observedAt: string;
  readonly reason?: string;
}

export interface ProjectScope {
  /**
   * Active checkout root. Equal to `cwd` when not in a git repo. For linked
   * worktrees this is the worktree's own path, not the main repo's.
   *
   * `projectRoot` and `worktreeRoot` are intentional aliases on this shape:
   *   - `projectRoot` is the runbook's preferred name and is what downstream
   *     code (recorders, statuslinePaths, refresh, etc.) reads.
   *   - `worktreeRoot` is retained for callers that already use it.
   * Both fields ALWAYS hold the same canonical absolute path. Do not write
   * one without writing the other.
   */
  readonly projectRoot: string;
  /** Alias of `projectRoot`. See `projectRoot` for canonical semantics. */
  readonly worktreeRoot: string;
  /**
   * Stable repository identity. For linked worktrees this is the parent of
   * `git rev-parse --git-common-dir`, so all worktrees of the same repo
   * share the same identity. Falls back to `cwd` when git is unavailable.
   */
  readonly repoIdentity: string;
  /** 16-char hex prefix of sha256(repoIdentity). Stable & deterministic. */
  readonly projectKey: string;
  /** `basename(worktreeRoot)` — display label only, not an identity. */
  readonly displayName: string;
  /** How the resolver obtained its data. */
  readonly freshness: ProjectScopeFreshness;
}

export interface ResolveProjectScopeOptions {
  readonly cwd: string;
}

/**
 * Loose shape accepted in the runbook's positional async form. We accept
 * `unknown` at the boundary and narrow defensively before reading any field.
 * The only keys we ever consult are:
 *   - `workspace.current_dir` (string)
 *   - `cwd` (string)
 * Anything else is ignored. This is intentionally lenient — Claude Code
 * statusline stdin payloads carry many fields, and we only care about the
 * two that determine the "active root" override.
 */
export type ProjectScopeStdinData = unknown;

// ---------------------------------------------------------------------------
// Internal config
// ---------------------------------------------------------------------------

/**
 * Bounded timeout for every `git rev-parse` invocation. 500ms is well above
 * the worst observed time for a healthy repo (sub-10ms) and below the
 * statusline render budget. Anything slower (lock-contended index, slow FS)
 * is treated as failure and falls back to cwd-based identity.
 */
const GIT_TIMEOUT_MS = 500;

/**
 * In-process cache. Key is the *realpath* of the absolute cwd so that
 * `./foo` and `/abs/path/foo` and `/abs/path/foo-symlink` all collapse to a
 * single cache entry, defeating cache-poisoning via relative input.
 */
const scopeCache = new Map<string, ProjectScope>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the project scope for `cwd`. Synchronous, pure, no FS writes.
 *
 * Two call shapes are supported:
 *
 *   1. Options object (Wave 3, sync):
 *      `resolveProjectScope({ cwd })  -> ProjectScope`
 *
 *   2. Positional async (runbook shape):
 *      `await resolveProjectScope(cwd, stdinData?)  -> Promise<ProjectScope>`
 *      `stdinData.workspace.current_dir` or `stdinData.cwd`, if present and
 *      string-typed, overrides the positional `cwd` argument. All other
 *      fields are ignored. `stdinData` is accepted as `unknown` and narrowed
 *      defensively — no unchecked casts.
 *
 * Both call shapes share the same in-process cache keyed by the canonical
 * absolute resolved path. The positional async form does NOT spawn `git`
 * a second time when the resolved path is already cached.
 *
 * Multiple calls with the same effective `cwd` (after stdin override and
 * canonicalization) within the same process return the cached `ProjectScope`
 * without re-invoking git.
 */
export function resolveProjectScope(opts: ResolveProjectScopeOptions): ProjectScope;
export function resolveProjectScope(
  cwd: string,
  stdinData?: ProjectScopeStdinData,
): Promise<ProjectScope>;
export function resolveProjectScope(
  arg: ResolveProjectScopeOptions | string,
  stdinData?: ProjectScopeStdinData,
): ProjectScope | Promise<ProjectScope> {
  if (typeof arg === 'string') {
    // Positional async form (runbook signature). Apply stdin override before
    // delegating to the sync core so the cache key reflects the effective
    // root, not the raw `cwd` argument.
    const override = readStdinActiveRoot(stdinData);
    const effectiveCwd = override ?? arg;
    return Promise.resolve(resolveProjectScopeSync({ cwd: effectiveCwd }));
  }
  return resolveProjectScopeSync(arg);
}

/**
 * Internal sync resolver. Identical to Wave 3's original implementation.
 * Both the public sync entry (options-object form) and the async entry
 * (positional form) delegate here so `git rev-parse` is only invoked at
 * most twice per unique canonical cwd, ever, across both call shapes.
 */
function resolveProjectScopeSync(opts: ResolveProjectScopeOptions): ProjectScope {
  const absCwd = resolve(opts.cwd);
  const cacheKey = canonicalize(absCwd);
  const cached = scopeCache.get(cacheKey);
  if (cached) return cached;

  const observedAt = new Date().toISOString();

  const worktreeRaw = gitShowToplevel(absCwd);
  const commonDirRaw = gitCommonDir(absCwd);

  const worktreeRoot = worktreeRaw ? safeRealpath(worktreeRaw) : absCwd;

  // `git rev-parse --git-common-dir` returns a path that may be relative to
  // the cwd of the spawn (commonly the case for the main repo, where it's
  // literally ".git"). Resolve it against the spawn cwd before lifting to
  // its parent. The parent of the common dir is the repo's checkout root
  // for the main worktree, OR the *main* repo's directory for linked
  // worktrees — which is exactly the property we want for `repoIdentity`.
  let repoIdentity: string;
  if (commonDirRaw) {
    const commonAbs = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(absCwd, commonDirRaw);
    repoIdentity = safeRealpath(dirname(commonAbs));
  } else if (worktreeRoot !== absCwd) {
    // We got a toplevel but not a common-dir (unusual). Use toplevel as identity.
    repoIdentity = worktreeRoot;
  } else {
    repoIdentity = absCwd;
  }

  const projectKey = createHash('sha256')
    .update(repoIdentity)
    .digest('hex')
    .slice(0, 16);

  const displayName = basename(worktreeRoot) || worktreeRoot;

  // Freshness: 'resolved' when at least one git probe succeeded; otherwise
  // 'inferred' (the fallback path used cwd for both worktreeRoot and
  // repoIdentity).
  const gotAnyGit = Boolean(worktreeRaw) || Boolean(commonDirRaw);
  const freshness: ProjectScopeFreshness = gotAnyGit
    ? { state: 'resolved', source: 'git', observedAt }
    : {
        state: 'inferred',
        source: 'fallback',
        observedAt,
        reason: 'not-in-git-repo-or-git-unavailable',
      };

  const scope: ProjectScope = {
    // `projectRoot` and `worktreeRoot` are aliases — see ProjectScope doc.
    projectRoot: worktreeRoot,
    worktreeRoot,
    repoIdentity,
    projectKey,
    displayName,
    freshness,
  };

  scopeCache.set(cacheKey, scope);
  return scope;
}

/**
 * Drop the in-process cache. Intended for tests; safe to call from any
 * production code that knows the filesystem moved beneath it (e.g.
 * `git worktree add`).
 */
export function clearProjectScopeCache(): void {
  scopeCache.clear();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Narrow `unknown` stdin payload to a string at one of the documented
 * override paths:
 *   - `workspace.current_dir`
 *   - `cwd`
 *
 * Both must be plain non-empty strings to be honored. Anything else
 * (numbers, null, objects, prototype-poisoning attempts, missing keys)
 * yields `undefined`, signaling "no override". We deliberately read only
 * own-properties on plain objects — `Reflect.has`-style descent would let
 * `__proto__.cwd` smuggle a value, which we will not accept.
 */
function readStdinActiveRoot(stdinData: ProjectScopeStdinData): string | undefined {
  if (!isPlainObject(stdinData)) return undefined;
  const workspace = stdinData['workspace'];
  if (isPlainObject(workspace)) {
    const current = workspace['current_dir'];
    if (typeof current === 'string' && current.length > 0) return current;
  }
  const cwd = stdinData['cwd'];
  if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  return undefined;
}

/**
 * Plain-object guard. Rejects `null`, arrays, class instances we don't
 * trust, and any non-object input. We use this as a precondition before
 * indexing into untrusted JSON, so prototype-chain access cannot smuggle
 * malicious values.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Canonicalize `absCwd` for cache keying. Uses `realpathSync` (resolves
 * symlinks) and falls back to the resolved input if the path doesn't yet
 * exist. We deliberately key on the canonicalized absolute path, never on
 * the raw user input, so a relative segment can't poison another caller's
 * cache slot.
 */
function canonicalize(absCwd: string): string {
  try {
    return realpathSync.native(absCwd);
  } catch {
    // Path may not exist (rare in practice for cwd). Use the resolved
    // absolute form as a stable, normalized cache key.
    return absCwd;
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function gitShowToplevel(cwd: string): string | undefined {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

function gitCommonDir(cwd: string): string | undefined {
  return runGit(['rev-parse', '--git-common-dir'], cwd);
}

/**
 * Spawn `git` with the supplied argv. Returns trimmed stdout on success,
 * `undefined` for any non-zero exit, missing binary, timeout, or
 * unparseable output. Never throws.
 *
 * Invariants:
 *   - argv is always an array (never a shell string).
 *   - `timeout` is always set; we will not block past `GIT_TIMEOUT_MS`.
 *   - stderr is piped (not 'ignore') so node tears it down promptly; we
 *     drop it on the floor because git's diagnostics are not used here.
 */
function runGit(args: ReadonlyArray<string>, cwd: string): string | undefined {
  let result;
  try {
    result = spawnSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
  // `spawnSync` does not throw on ENOENT in normal Node; it sets `error`.
  if (result.error) return undefined;
  // Killed by timeout signal => result.signal is set.
  if (result.signal) return undefined;
  if (result.status !== 0) return undefined;
  const out = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  return out.length > 0 ? out : undefined;
}
