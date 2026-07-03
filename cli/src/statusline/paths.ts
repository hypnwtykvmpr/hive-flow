// cli/src/statusline/paths.ts
//
// Wave 2 of the statusline rewrite. Pure path-resolution helpers. No I/O.
//
// Returns absolute paths only. Accepts `projectRoot` as input.
//
// Two path families are exported:
//   1. `statuslinePaths(projectRoot)` — the project-scoped `.hive-flow/` tree
//      (sessions, scoreboard, tests, attention, ADRs, mcp health, hooks,
//      memory, materialized state, refresh marker, spool root, cache).
//   2. `statuslineUserCachePaths()` — the OS-scoped user cache rooted at
//      `${XDG_CACHE_HOME ?? ~/.cache}/hive-flow/statusline`. This avoids the
//      predictable `${tmpdir()}/hive-flow-statusline-<sha256>` pattern flagged
//      by the round-3 bug-hunter finding and the `__dirname`-relative pattern.
//
// Notes:
//   - `cache` in `StatuslinePaths` is the project-scoped materialized cache
//     under `.hive-flow/state/cache.json`. The user-machine cache (rate-limit
//     state, last-render snapshot for crash-recovery, etc.) lives under
//     `statuslineUserCachePaths().root` and is never project-portable.
//   - All paths are constructed via `path.join` from sanitized inputs; no
//     filesystem traversal is performed in this module.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { resolveHiveHome } from '../shared/index.js';

// ---------------------------------------------------------------------------
// Project-scoped paths
// ---------------------------------------------------------------------------

export interface StatuslinePaths {
  /** Absolute path to `<projectRoot>/.hive-flow`. */
  root: string;
  /** JSONL ledger for scoreboard presence/agent visibility events. */
  scoreboardPresenceLedger: string;
  /** JSONL ledger for scoreboard provider-call events. */
  scoreboardCallsLedger: string;
  /** Materialized scoreboard summary (atomic JSON). */
  scoreboardCurrent: string;
  /** JSONL ledger for the most recent test runs. */
  testsLedger: string;
  /** Materialized aggregate test summary (atomic JSON). */
  testsCurrent: string;
  /** Materialized "latest full suite" record (atomic JSON). */
  testsCurrentSuite: string;
  /** Materialized "latest partial run" record (atomic JSON). */
  testsLatestPartial: string;
  /** Source-fingerprint marker used for staleness detection. */
  testsFingerprint: string;
  /** JSONL ledger for session-start/heartbeat/end events. */
  sessionsLedger: string;
  /** Materialized current-session summary (atomic JSON). */
  sessionsCurrent: string;
  /** JSONL ledger for emit/resolve attention events. */
  attentionLedger: string;
  /** Materialized active-attention list (atomic JSON). */
  attentionCurrent: string;
  /** Materialized ADR roll-up (atomic JSON). */
  adrsCurrent: string;
  /** Materialized MCP health snapshot (atomic JSON). */
  mcpHealth: string;
  /** Materialized hooks inventory snapshot (atomic JSON). */
  hooksInventory: string;
  /** Materialized memory stats snapshot (atomic JSON). */
  memoryStats: string;
  /** Project-scoped materialized cache file (atomic JSON). */
  cache: string;
  /** Materialized last-render text snapshot. */
  lastRender: string;
  /** Marker file touched to request a refresh. */
  refreshRequest: string;
  /** Root of the per-ledger spool tree (drainer reads/writes here). */
  spoolRoot: string;
}

/**
 * Compute the canonical `.hive-flow/` paths used by the statusline. Pure;
 * never touches the filesystem. The caller is responsible for creating
 * directories as part of the storage primitives.
 *
 * Path components are derived from `path.join`; this module never mutates the
 * filesystem and never accepts user-supplied path fragments beyond
 * `projectRoot` itself, so injection via path-fragment overrides is not
 * possible from inside this function.
 */
export function statuslinePaths(projectRoot: string): StatuslinePaths {
  const hf = join(projectRoot, '.hive-flow');
  return Object.freeze({
    root: hf,
    scoreboardPresenceLedger: join(hf, 'scoreboard', 'presence.jsonl'),
    scoreboardCallsLedger: join(hf, 'scoreboard', 'calls.jsonl'),
    scoreboardCurrent: join(hf, 'scoreboard', 'current.json'),
    testsLedger: join(hf, 'tests', 'last-run.jsonl'),
    testsCurrent: join(hf, 'tests', 'current.json'),
    testsCurrentSuite: join(hf, 'tests', 'current-suite.json'),
    testsLatestPartial: join(hf, 'tests', 'latest-partial.json'),
    testsFingerprint: join(hf, 'tests', 'source-fingerprint.json'),
    sessionsLedger: join(hf, 'sessions', 'events.jsonl'),
    sessionsCurrent: join(hf, 'sessions', 'current.json'),
    attentionLedger: join(hf, 'attention.jsonl'),
    attentionCurrent: join(hf, 'attention', 'current.json'),
    adrsCurrent: join(hf, 'adrs', 'current.json'),
    mcpHealth: join(hf, 'mcp', 'health.json'),
    hooksInventory: join(hf, 'hooks', 'inventory.json'),
    memoryStats: join(hf, 'memory', 'stats.json'),
    cache: join(hf, 'state', 'cache.json'),
    lastRender: join(hf, 'state', 'last-render.txt'),
    refreshRequest: join(hf, 'state', 'refresh.request'),
    spoolRoot: join(hf, 'spool'),
  });
}

// ---------------------------------------------------------------------------
// Global Hive Flow statusline index paths
// ---------------------------------------------------------------------------

export interface GlobalStatuslinePaths {
  /** Absolute root: `${HIVE_FLOW_HOME}/statusline`. */
  root: string;
  /** Absolute project index root. */
  projectRoot: string;
  /** Absolute session index root. */
  sessionRoot: string;
  /** Global indexed materialized cache for one project/session pair. */
  cache: string;
}

function flatPathSegment(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

/**
 * Compute the global statusline index paths. This is distinct from
 * `statuslineUserCachePaths()` because the index is durable Hive Flow state
 * under `HIVE_FLOW_HOME`, not a renderer-local debounce/cache directory.
 */
export function globalStatuslinePaths(
  projectKey: string,
  sessionKey: string,
  env: NodeJS.ProcessEnv = process.env,
): GlobalStatuslinePaths {
  const root = join(resolveHiveHome(env).home, 'statusline');
  const projectSegment = flatPathSegment(projectKey, 'unknown-project');
  const sessionSegment = flatPathSegment(sessionKey, 'unknown-session');
  const projectRoot = join(root, 'projects', projectSegment);
  const sessionRoot = join(projectRoot, 'sessions', sessionSegment);
  return Object.freeze({
    root,
    projectRoot,
    sessionRoot,
    cache: join(sessionRoot, 'state', 'cache.json'),
  });
}

// ---------------------------------------------------------------------------
// User-machine cache paths (OS-scoped, not project-portable)
// ---------------------------------------------------------------------------

export interface StatuslineUserCachePaths {
  /** Root of the per-user statusline cache: `${XDG_CACHE_HOME ?? ~/.cache}/hive-flow/statusline`. */
  root: string;
  /** Renderer rate-limit / debounce state file. */
  rateLimit: string;
  /** Renderer last-render output snapshot for crash-recovery and diffing. */
  lastRender: string;
  /** Renderer diagnostic log (bounded, JSON-lines). */
  diagnosticsLog: string;
}

/**
 * Resolve the per-user statusline cache root. Uses `XDG_CACHE_HOME` when set
 * and absolute; otherwise falls back to `${home}/.cache`. The runbook's
 * round-3 bug-hunter finding rejected `${tmpdir()}/hive-flow-statusline-<sha256>`
 * (predictable, world-writable on macOS) and any `__dirname`-relative path
 * (not durable across `npm i` reinstalls).
 *
 * Environment overrides (in order):
 *   1. `HIVE_FLOW_STATUSLINE_CACHE_DIR` — absolute path override (tests/CI).
 *   2. `XDG_CACHE_HOME` — XDG Base Directory spec.
 *   3. `${homedir()}/.cache` — POSIX fallback.
 */
export function statuslineUserCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HIVE_FLOW_STATUSLINE_CACHE_DIR;
  if (typeof override === 'string' && override.trim() !== '' && isAbsolute(override)) {
    return resolve(override);
  }
  const xdg = env.XDG_CACHE_HOME;
  if (typeof xdg === 'string' && xdg.trim() !== '' && isAbsolute(xdg)) {
    return join(resolve(xdg), 'hive-flow', 'statusline');
  }
  return join(homedir(), '.cache', 'hive-flow', 'statusline');
}

/**
 * Compute the per-user statusline cache paths. Pure; never touches the
 * filesystem. Used by the renderer and the launcher for state that is local
 * to the user/machine (not the project) — rate-limit counters, last-render
 * snapshots, diagnostic logs.
 */
export function statuslineUserCachePaths(
  env: NodeJS.ProcessEnv = process.env,
): StatuslineUserCachePaths {
  const root = statuslineUserCacheRoot(env);
  return Object.freeze({
    root,
    rateLimit: join(root, 'rate-limit.json'),
    lastRender: join(root, 'last-render.json'),
    diagnosticsLog: join(root, 'diagnostics.jsonl'),
  });
}

// ---------------------------------------------------------------------------
// Spool sub-paths (helpers for the drainer + recorders)
// ---------------------------------------------------------------------------

/**
 * Compute the per-ledger spool directory beneath `spoolRoot`. Used by the
 * storage primitives and the drainer. Pure; no I/O.
 *
 * `ledgerName` must be a stable identifier such as `tests`, `sessions`,
 * `scoreboard-calls`, `scoreboard-presence`, `attention`. The drainer pairs
 * each ledger name to a `LedgerPath` returned by `statuslinePaths`.
 */
export function spoolDirFor(spoolRoot: string, ledgerName: string): string {
  // path.join already prevents `..` traversal when ledgerName has no separators;
  // we keep ledgerName a flat identifier in practice. The caller is responsible
  // for passing a sanitized name from the closed set used by the recorders.
  return join(spoolRoot, ledgerName);
}

/**
 * Closed set of recorder identifiers backed by spool directories. Adding a
 * new spool ledger means adding the key here and wiring a corresponding drain
 * branch in the drainer.
 */
export const SPOOL_LEDGER_NAMES = Object.freeze([
  'tests',
  'sessions',
  'scoreboard-calls',
  'scoreboard-presence',
  'attention',
] as const);

export type SpoolLedgerName = (typeof SPOOL_LEDGER_NAMES)[number];
