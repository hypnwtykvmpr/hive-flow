// v3/@hive-flow/cli/src/integrations/integration-marker.ts
//
// Wave 11A — Per-CLI integration marker (read/write/remove).
//
// Every connector install writes a small marker file so `setup --diagnose
// connector` can report what Hive Flow believes it owns without grepping
// install logs. The marker is also the authoritative answer to "is this
// wrapper script Hive Flow's, or did a human-written file with the same name
// just happen to be there?" — the wrapper script body alone is not enough
// because a human could copy our template into their own script.
//
// Storage paths (Phase 16 `managed` scope is intentionally NOT modeled here):
//   - project scope: ${projectRoot}/.hive-flow/integrations/${target}.json
//     Wave 2.5A guarded primitives (assertSafeStatuslineStoragePath +
//     atomicWrite + chmod 0o600) handle path safety because everything under
//     `.hive-flow/` is already symlink-walked by `writeJsonFile`/`readJsonFile`
//     from `../statusline/storage.ts`.
//   - user scope:    ${HIVE_FLOW_HOME ?? ~}/.hive-flow/integrations/${target}.json
//     Wave 8.4 guarded user-cache primitives (`writeUserCacheJson` /
//     `readUserCacheJson` / `ensureSafeUserCacheDir`) walk every segment of
//     `${baseDir}/.hive-flow/integrations/` to reject symlinked parents during
//     creation and during read.
//
// Binding constraints (Phase 5 + Phase 10 + Phase 16):
//   - Atomic write everywhere; 0o600 file mode; fsync defaulted to true.
//   - Symlink-safe: refuse to write/read through a symlinked parent or leaf.
//     This is delegated to the existing guarded helpers — no new path-walk
//     logic in this module.
//   - Marker schema is versioned (`version: 1`). Unknown versions are rejected
//     on read (returns `undefined`).
//   - `removeMarker` is idempotent: removing an absent marker is a no-op.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  readJsonFile,
  readUserCacheJson,
  safeUnlinkInHiveFlow,
  safeUnlinkInUserCache,
  writeJsonFile,
  writeUserCacheJson,
} from '../statusline/storage.js';
import type { AdapterScope, AdapterTarget, AdapterTier } from './adapters/types.js';
import { ADAPTER_TARGETS } from './adapters/types.js';

// Re-export the union and the frozen array so neighbouring modules
// (`./diagnose.ts`, future per-CLI adapter files in Wave 11B) can import the
// adapter-target identity directly from the marker module without reaching
// across into the deeper `./adapters/types.js` foundation. The marker is the
// natural neighbour: it is the file that stamps a target onto disk, and the
// diagnose layer treats the marker as the authoritative source for what to
// inspect.
export type { AdapterScope, AdapterTarget, AdapterTier };
export { ADAPTER_TARGETS };

/**
 * Schema-versioned record persisted at the per-target marker path. Wave 11B's
 * per-CLI adapters fill this in during `install()` and read it back during
 * `uninstall()` and during `setup --diagnose connector`.
 *
 * `scriptPath` and `realCliBin` are wrapper-mode-only fields:
 *   - `scriptPath`: absolute path to the wrapper script the install wrote.
 *   - `realCliBin`: absolute path to the host CLI binary the wrapper delegates
 *     to. Recording it on the marker lets diagnose verify the real CLI still
 *     exists when the wrapper is invoked.
 *
 * Native-plugin tier installs leave these `undefined`; future native adapters
 * will add a `configPath` field at version 2 with a forward-compatible
 * upgrade path.
 */
export interface IntegrationMarker {
  readonly version: 1;
  readonly target: AdapterTarget;
  readonly tier: AdapterTier;
  readonly scope: AdapterScope;
  readonly installedAt: string;
  readonly scriptPath?: string;
  readonly realCliBin?: string;
}

/** Inputs accepted by `writeMarker`. */
export interface WriteMarkerOpts {
  readonly projectRoot: string;
  readonly target: AdapterTarget;
  readonly tier: AdapterTier;
  readonly scope: AdapterScope;
  readonly scriptPath?: string;
  readonly realCliBin?: string;
  /**
   * Override the install timestamp; defaults to `Date.now()`. Tests pass a
   * fixed value so the resulting marker is deterministic; production callers
   * leave this undefined.
   */
  readonly nowMs?: number;
}

/** Inputs accepted by `readMarker` / `removeMarker` / `markerPath`. */
export interface MarkerLocator {
  readonly projectRoot: string;
  readonly target: AdapterTarget;
  readonly scope: AdapterScope;
}

const MARKER_FILE_MODE = 0o600;

/**
 * Resolve the user-home base used for `scope: 'user'` markers. Honours
 * `HIVE_FLOW_HOME` (test/CI override) when it is set to a non-empty absolute
 * path; otherwise falls back to `homedir()`.
 *
 * Mirrors the canonical resolver in `statusline/last-render.ts` so the user
 * cache root for markers and the user cache root for the statusline last-
 * render mirror agree on the trusted-root base.
 */
function resolveUserHomeBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HIVE_FLOW_HOME;
  if (typeof override === 'string' && override.length > 0 && isAbsolute(override)) {
    return resolve(override);
  }
  return resolve(homedir());
}

/**
 * Compute the absolute path to the marker for `(target, scope)`. Pure — never
 * touches the filesystem. The path is identical for both reads and writes so
 * callers can pass the result through to logging without an extra resolver
 * call.
 *
 * Throws when `target` is not a known `AdapterTarget` or when `scope` is not
 * `'project'` or `'user'`. The throw is defensive: TypeScript already pins
 * both at compile time, but a future dynamic caller (e.g. a plugin
 * discovery layer) MUST hit a clear reject before the path concatenation
 * silently produces an off-tree filename.
 */
export function markerPath(opts: MarkerLocator): string {
  if (!isKnownTarget(opts.target)) {
    throw new TypeError(`markerPath: unknown target "${String(opts.target)}"`);
  }
  if (opts.scope !== 'project' && opts.scope !== 'user') {
    throw new TypeError(`markerPath: unsupported scope "${String(opts.scope)}"`);
  }
  if (typeof opts.projectRoot !== 'string' || opts.projectRoot.length === 0) {
    throw new TypeError('markerPath: projectRoot must be a non-empty string');
  }
  if (!isAbsolute(opts.projectRoot)) {
    throw new TypeError(`markerPath: projectRoot must be absolute (got: ${opts.projectRoot})`);
  }
  const base = opts.scope === 'project' ? opts.projectRoot : resolveUserHomeBase();
  return join(base, '.hive-flow', 'integrations', `${opts.target}.json`);
}

/**
 * Atomically write the integration marker for `(target, scope)`. Uses the
 * project-scope guarded primitive when scope=project (writes flow through
 * `assertSafeStatuslineStoragePath` which walks every `.hive-flow/` segment),
 * and the user-cache guarded primitive when scope=user (walks every segment
 * from `${HIVE_FLOW_HOME ?? ~}` to the leaf).
 *
 * Both paths use atomic write (tmp + rename), fsync defaulted to true, and
 * chmod 0o600 after rename.
 *
 * Propagates errors from the underlying primitives (write failure, symlink
 * rejection). The caller's connector install is expected to catch and
 * translate these into the adapter's failure outcome.
 */
export async function writeMarker(opts: WriteMarkerOpts): Promise<void> {
  if (!isKnownTarget(opts.target)) {
    throw new TypeError(`writeMarker: unknown target "${String(opts.target)}"`);
  }
  if (opts.scope !== 'project' && opts.scope !== 'user') {
    throw new TypeError(`writeMarker: unsupported scope "${String(opts.scope)}"`);
  }
  if (opts.tier !== 'wrapper-mode' && opts.tier !== 'native-plugin') {
    throw new TypeError(`writeMarker: unsupported tier "${String(opts.tier)}"`);
  }
  const installedAtMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)
    ? opts.nowMs
    : Date.now();
  const marker: IntegrationMarker = {
    version: 1,
    target: opts.target,
    tier: opts.tier,
    scope: opts.scope,
    installedAt: new Date(installedAtMs).toISOString(),
    ...(opts.scriptPath !== undefined ? { scriptPath: opts.scriptPath } : {}),
    ...(opts.realCliBin !== undefined ? { realCliBin: opts.realCliBin } : {}),
  };
  const path = markerPath({
    projectRoot: opts.projectRoot,
    target: opts.target,
    scope: opts.scope,
  });
  if (opts.scope === 'project') {
    // Project-scope: writeJsonFile already walks `.hive-flow/` segments via
    // `assertSafeStatuslineStoragePath` and forces 0o600 + fsync.
    await writeJsonFile(path, marker);
    return;
  }
  // User-scope: writeUserCacheJson walks every segment from baseDir to leaf
  // and atomically writes with the requested mode. `baseDir` is the trusted
  // root (`${HIVE_FLOW_HOME ?? ~}`), so `${baseDir}/.hive-flow/integrations/`
  // is walked by the helper.
  const baseDir = resolveUserHomeBase();
  await writeUserCacheJson(path, baseDir, marker, { mode: MARKER_FILE_MODE, fsync: true });
}

/**
 * Read the integration marker for `(target, scope)`. Returns `undefined` for
 * any non-recoverable case: absent file, corrupt JSON, schema mismatch,
 * symlinked path, oversize file, mismatched `target`/`scope`/`tier`/`version`,
 * or a wrong shape on a future-format marker. Never throws — the diagnose
 * layer treats missing/corrupt as "not installed".
 *
 * Schema validation is strict: a marker whose `target` does not equal the
 * locator's `target` (e.g. a marker file was copied between targets) is
 * treated as corrupt. This matches the runbook's diagnose contract.
 */
export async function readMarker(opts: MarkerLocator): Promise<IntegrationMarker | undefined> {
  if (!isKnownTarget(opts.target)) return undefined;
  if (opts.scope !== 'project' && opts.scope !== 'user') return undefined;
  if (typeof opts.projectRoot !== 'string' || opts.projectRoot.length === 0) return undefined;
  if (!isAbsolute(opts.projectRoot)) return undefined;
  const path = markerPath(opts);
  let raw: unknown;
  if (opts.scope === 'project') {
    raw = await readJsonFile(path);
  } else {
    const baseDir = resolveUserHomeBase();
    raw = await readUserCacheJson(path, baseDir);
  }
  if (raw === undefined) return undefined;
  return validateMarker(raw, opts.target, opts.scope);
}

/**
 * Remove the integration marker for `(target, scope)`. Idempotent: calling
 * this on an absent marker is a no-op and never throws on the absence path.
 * Calls do not need to be ordered with respect to wrapper-script removal; a
 * stale marker without a wrapper is detected by `setup --diagnose connector`
 * and surfaced as a "fail" row.
 *
 * Symlink-safety: routes through the guarded `safeUnlinkInHiveFlow` (project
 * scope) or `safeUnlinkInUserCache` (user scope) primitives. Both walk every
 * intermediate directory (and the leaf itself) via `lstat` BEFORE issuing
 * the `unlink`, refusing if any segment resolves through a symbolic link.
 * This closes the Codex probe in which a swapped `.hive-flow/` -> outside
 * symlink would otherwise let `removeMarker` delete an outside file. A
 * symlink rejection is treated as "marker is not reachable / not ours";
 * idempotence is preserved by returning normally.
 *
 * Non-symlink filesystem errors (EACCES, EBUSY, etc.) propagate so a
 * permission or lock failure is not silently swallowed by the connector's
 * uninstall path.
 */
export async function removeMarker(opts: MarkerLocator): Promise<void> {
  if (!isKnownTarget(opts.target)) return;
  if (opts.scope !== 'project' && opts.scope !== 'user') return;
  if (typeof opts.projectRoot !== 'string' || opts.projectRoot.length === 0) return;
  if (!isAbsolute(opts.projectRoot)) return;
  const path = markerPath(opts);
  // `safeUnlinkInHiveFlow` / `safeUnlinkInUserCache` return a discriminated
  // result: 'unlinked' / 'absent' (both idempotent success) or 'rejected'
  // (symlinked path; we MUST NOT follow the link). Other I/O errors throw.
  if (opts.scope === 'project') {
    await safeUnlinkInHiveFlow(path);
    return;
  }
  const baseDir = resolveUserHomeBase();
  await safeUnlinkInUserCache(path, baseDir);
}

/**
 * Validate that `value` is a well-formed marker for `(target, scope)`. Returns
 * the typed record on success and `undefined` on any mismatch.
 *
 * Validation rules:
 *   - `version` MUST be exactly `1`. Future schema bumps return `undefined`
 *     (caller treats unknown schema as "not installed").
 *   - `target` MUST equal the locator's `target`.
 *   - `tier` MUST be a known `AdapterTier`.
 *   - `scope` MUST equal the locator's `scope`.
 *   - `installedAt` MUST be a non-empty ISO-parseable string.
 *   - Optional `scriptPath` / `realCliBin` MUST be strings when present; not
 *     required to be absolute (the diagnose layer surfaces relative paths as
 *     a separate "fail" row rather than rejecting them here).
 */
function validateMarker(
  raw: unknown,
  target: AdapterTarget,
  scope: AdapterScope,
): IntegrationMarker | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return undefined;
  if (obj.target !== target) return undefined;
  if (obj.scope !== scope) return undefined;
  if (obj.tier !== 'wrapper-mode' && obj.tier !== 'native-plugin') return undefined;
  if (typeof obj.installedAt !== 'string' || obj.installedAt.length === 0) return undefined;
  const ts = Date.parse(obj.installedAt);
  if (!Number.isFinite(ts)) return undefined;
  if (obj.scriptPath !== undefined && typeof obj.scriptPath !== 'string') return undefined;
  if (obj.realCliBin !== undefined && typeof obj.realCliBin !== 'string') return undefined;
  // Construct the result with only the validated fields so an attacker cannot
  // smuggle additional keys through. Optional fields are added conditionally
  // to keep the resulting object shape deterministic.
  const result: IntegrationMarker = {
    version: 1,
    target,
    tier: obj.tier,
    scope,
    installedAt: obj.installedAt,
    ...(typeof obj.scriptPath === 'string' ? { scriptPath: obj.scriptPath } : {}),
    ...(typeof obj.realCliBin === 'string' ? { realCliBin: obj.realCliBin } : {}),
  };
  return result;
}

/** Type-guard predicate: is `value` a known `AdapterTarget`? */
function isKnownTarget(value: unknown): value is AdapterTarget {
  if (typeof value !== 'string') return false;
  return (ADAPTER_TARGETS as ReadonlyArray<string>).includes(value);
}
