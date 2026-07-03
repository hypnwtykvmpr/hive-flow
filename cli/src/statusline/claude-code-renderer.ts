// cli/src/statusline/claude-code-renderer.ts
//
// Phase 12 — Renderer replacement. Composes prior waves (palette, inline-
// collectors, last-render, refresher, types, config, project-scope) into the
// cohesive Claude Code statusline renderer.
//
// Three modes (Codex round-5 finding — ALL THREE must be implemented):
//
//   1. Snapshot mode (preferred). Reads `.hive-flow/state/cache.json` via
//      bounded storage. Uses the snapshot directly when the cached context is
//      fresh enough.
//
//   2. Inline-collector mode (fallback when snapshot is stale or absent BUT
//      `.hive-flow/` exists). Invokes Wave 8 `collectInlineSnapshot` for a
//      bounded-budget partial snapshot, then renders from that.
//
//   3. Header-only mode (when `.hive-flow/` does not exist OR every snapshot
//      / inline collection failed). Renders ONLY the project + git + model
//      header — never invents swarm / scoreboard / tests / attention data.
//
// Binding constraints (canonical runbook + Phase 5 binding + Codex round-5
// review):
//
//   - <200ms render budget end-to-end. Tests assert `performance.now() - start`.
//   - NO shell-outs in the render hot path. The inline-collector module is
//     allowed to spawn `git` under a strict deadline; the renderer itself
//     does not call `execSync`, `spawnSync`, `tput`, `du`, `gh`, etc.
//   - NO synchronous I/O on the render path — all reads via async primitives.
//   - NO `\x1b[1;33m` (bright yellow CSI body) anywhere — palette guards plus
//     a renderer-side static-audit grep test enforce this.
//   - NO `as any` / unsafe casts — `stdinData` typed as `unknown` and narrowed
//     defensively via type guards.
//   - NO literal control bytes in source — every ANSI sequence flows through
//     the palette object (`palette.project`, etc.) or via the `\x1b` escape.
//   - stdin-first ADR-051 context — the refresher already merged stdin into
//     `snapshot.context`; the renderer re-merges with live stdin context
//     when present so live percentage trumps cache.
//   - 3 modes ALL implemented (the round-5 review found only 2 were wired).
//     Each mode emits a coherent line.
//   - The PURE RENDERER must be side-effect-free: it does NOT call
//     `writeLastRender`. The COMMAND WRAPPER (`bin/statusline.js` and
//     `commands/statusline.ts`) is responsible for persisting the
//     last-render mirror via `writeLastRender` after invoking the renderer,
//     using `.catch(() => undefined)` so a cache-write hiccup never crashes
//     the wrapper.
//   - Visual design (locked): see `Claude-statusline-design-final-2026-05-20.md`.
//     The board is a MULTI-ROW box: header / separator rule / scoreboard /
//     swarm / memory / attention / separator rule / footer. Rows are joined
//     by `\n` (Claude Code statusLine supports multi-line stdout natively).
//     Within a row, cells are delimited by a space-pipe-space in the palette
//     `separator` color; between rows a full-width `─` rule renders whenever
//     at least one body row is present (per the design doc's row table). Each
//     row is independently omitted when its backing data is absent
//     (OMIT > FAKE).

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { sessionKeyFor } from '../shared/index.js';

import { resolveSessionId } from '../mcp-tools/session-id.js';
import { parseStatuslineConfig, type StatuslineConfig } from './config.js';
import { collectInlineSnapshot } from './inline-collectors.js';
import { collectSwarm } from './collectors/swarm.js';
import { collectEnforcementStatus, type EnforcementLiveStatus } from './enforcement-installed.js';
import {
  type LastRenderMode,
} from './last-render.js';
import { detectColorDepth, makePalette, type PaletteCodes } from './palette.js';
import { resolveProjectScope, type ProjectScope } from './project-scope.js';
import { readJsonFile } from './storage.js';
import { globalStatuslinePaths, statuslinePaths } from './paths.js';
import { resolveModelDisplay } from './model-display.js';
import {
  normalizeAgentStatus,
  type AttentionSummary,
  type ContextSummary,
  type DaemonSummary,
  type GitSummary,
  type NormalizedAgentRow,
  type NormalizedAgentStatus,
  type ScoreboardSummary,
  type ScoreProvider,
  type SessionSummary,
  type StatuslineSnapshotV1,
  type SwarmSummary,
  type TestsSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Public types + entry points
// ---------------------------------------------------------------------------

/**
 * Maximum stdin bytes accepted by {@link readStatuslineStdin}. Anything larger
 * is rejected (defence-in-depth against pathological payloads).
 */
const MAX_STATUSLINE_STDIN_BYTES = 256 * 1024;

/**
 * Default snapshot freshness window (ms). A cached snapshot older than this is
 * considered stale enough to attempt inline-collector mode. Matches the
 * runbook's 5-minute context-freshness window.
 */
const DEFAULT_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Read parsed JSON from stdin with a hard byte cap. Returns `undefined` on
 * TTY input, empty input, oversize input, or unparseable JSON. Never throws.
 *
 * Exported so `bin/statusline.js` and `commands/statusline.ts` can keep their
 * existing two-step pattern (read stdin -> render).
 */
export async function readStatuslineStdin(): Promise<Record<string, unknown> | undefined> {
  if (process.stdin.isTTY) return undefined;
  let raw = '';
  let truncated = false;
  for await (const chunk of process.stdin) {
    raw += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_STATUSLINE_STDIN_BYTES) {
      truncated = true;
      break;
    }
  }
  if (truncated) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Result returned by {@link renderClaudeCodeStatuslineWithMeta}. Bundles the
 * rendered string with the metadata the wrapper needs to invoke
 * `writeLastRender` (mode, projectKey, projectRoot, optional snapshot).
 *
 * The pure renderer MUST NOT write the last-render mirrors itself — that side
 * effect belongs in the COMMAND WRAPPER (`bin/statusline.js` and
 * `commands/statusline.ts`) which calls this function and then `writeLastRender`.
 */
export interface RenderClaudeCodeStatuslineResult {
  /** Multi-row ANSI-decorated statusline output (rows joined by `\n`). */
  readonly rendered: string;
  /** Which rendering path produced this output. */
  readonly mode: LastRenderMode;
  /** The snapshot the renderer used, when one was available. */
  readonly snapshot?: StatuslineSnapshotV1;
  /** 16-char lowercase hex sha256 prefix identifying the project. */
  readonly projectKey?: string;
  /** Absolute path to the worktree/checkout root. */
  readonly projectRoot?: string;
}

/**
 * Render the Claude Code statusline AND return enough metadata for the
 * command wrapper to persist the last-render mirror.
 *
 * The pure renderer is side-effect-free: it does not write `writeLastRender`
 * mirrors itself. The wrapper (`bin/statusline.js`, `commands/statusline.ts`)
 * is responsible for calling `writeLastRender` after this returns.
 *
 * @param stdinData  The Claude Code statusline payload. Accepts either:
 *                   - an already-parsed object (the normal path: `bin/statusline.js`
 *                     pre-parses via `readStatuslineStdin`);
 *                   - a raw JSON string (callers can also hand us the raw bytes);
 *                   - `undefined` (header-only render of `cwd`).
 *                   Always narrowed defensively — never cast.
 * @param projectRoot Optional explicit project root. When omitted, falls back
 *                   to `stdinData.workspace.current_dir` or `process.cwd()`.
 *
 * On internal failure collapses to `{ rendered: '', mode: 'header-only' }` —
 * never throws.
 */
export async function renderClaudeCodeStatuslineWithMeta(
  stdinData?: unknown,
  projectRoot?: string,
): Promise<RenderClaudeCodeStatuslineResult> {
  try {
    return await renderInternal(stdinData, projectRoot);
  } catch {
    // Render failures degrade silently to empty output — never stack traces
    // (Claude Code expects clean stdout for statusLine commands).
    return { rendered: '', mode: 'header-only' };
  }
}

/**
 * Render the Claude Code statusline. Returns a multi-row ANSI-decorated box
 * (rows joined by `\n`) — or the empty string when the render failed every
 * mode.
 *
 * Thin string-returning wrapper around {@link renderClaudeCodeStatuslineWithMeta}.
 * The string form is intentionally side-effect-free; callers that need to
 * persist a last-render mirror must use the `WithMeta` variant and invoke
 * `writeLastRender` themselves.
 *
 * @param stdinData  The Claude Code statusline payload. Accepts either:
 *                   - an already-parsed object (the normal path: `bin/statusline.js`
 *                     pre-parses via `readStatuslineStdin`);
 *                   - a raw JSON string (callers can also hand us the raw bytes);
 *                   - `undefined` (header-only render of `cwd`).
 *                   Always narrowed defensively — never cast.
 * @param projectRoot Optional explicit project root. When omitted, falls back
 *                   to `stdinData.workspace.current_dir` or `process.cwd()`.
 *
 * Returns a multi-row box (rows joined by `\n`). On internal failure
 * collapses to the empty string — never throws.
 */
export async function renderClaudeCodeStatusline(
  stdinData?: unknown,
  projectRoot?: string,
): Promise<string> {
  const result = await renderClaudeCodeStatuslineWithMeta(stdinData, projectRoot);
  return result.rendered;
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

async function renderInternal(
  rawStdin: unknown,
  projectRoot: string | undefined,
): Promise<RenderClaudeCodeStatuslineResult> {
  // 1) Parse stdin defensively. Accept object or raw string; everything else
  // collapses to `undefined`. Narrowed via type guards — no unsafe casts.
  const stdin = normalizeStdin(rawStdin);

  // 2) Resolve project scope. `resolveProjectScope` falls back to `cwd` when
  // not in a git repo. The stdin `workspace.current_dir` override is honoured
  // by the positional async form (Wave 3 contract).
  const cwd = projectRoot ?? readStdinActiveCwd(stdin) ?? process.cwd();
  const scope = await resolveProjectScope(cwd, stdin);

  // 3) Load config (renderBudgetMs, useRoleIcons, allow16ColorYellowFallback).
  // `parseStatuslineConfig` is bounded + symlink-safe; falls back to defaults
  // on any error.
  const configResult = await parseStatuslineConfig(scope.projectRoot);
  const config = configResult.config;
  const renderBudgetMs = config.renderBudgetMs;
  const snapshotMaxAgeMs = readSnapshotMaxAge(scope.projectRoot, config);

  // 4) Detect color depth + build palette. `detectColorDepth` is pure (env
  // parameter, no global reads). The palette guards against the forbidden
  // bright-yellow CSI body internally.
  const depth = detectColorDepth(process.env);
  const palette = makePalette({
    colorDepth: depth,
    noColor: depth === 0,
    allow16ColorYellowFallback: config.allow16ColorYellowFallback,
  });

  // 5) Three-mode resolution. Total budget = renderBudgetMs.
  const startTime = Date.now();
  const deadlineMs = startTime + renderBudgetMs;
  const resolved = await resolveModeForRender(scope, stdin, snapshotMaxAgeMs, deadlineMs);
  const enforcementStatus = await collectEnforcementStatus(scope.projectRoot);

  // 6) Render rows per locked visual design — composed into a MULTI-ROW box
  // (rows joined by `\n`, with full-width `─` separator rules between the
  // header / body / footer groups when ≥1 body row is present).
  const rendered = composeStatusline({
    snapshot: resolved.snapshot,
    mode: resolved.mode,
    palette,
    scope,
    stdin,
    enforcementStatus,
  });

  // 7) Return meta for the COMMAND WRAPPER to persist the last-render mirror.
  // The pure renderer never writes mirrors itself; the wrapper invokes
  // `writeLastRender` after rendering.
  return {
    rendered,
    mode: resolved.mode,
    projectRoot: scope.projectRoot,
    projectKey: scope.projectKey,
    ...(resolved.snapshot !== undefined ? { snapshot: resolved.snapshot } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stdin narrowing
// ---------------------------------------------------------------------------

/**
 * Narrow an `unknown` stdin payload to a plain object. Accepts either:
 *   - parsed object (the normal path)
 *   - raw JSON string (parsed defensively within the byte cap)
 *
 * Returns `undefined` for arrays, primitives, oversized strings, or
 * unparseable inputs. Never throws.
 */
function normalizeStdin(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_STATUSLINE_STDIN_BYTES) return undefined;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (typeof raw !== 'object') return undefined;
  if (Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/**
 * Resolve the active working directory override from a stdin payload. Walks
 * the documented override paths (`workspace.current_dir`, `cwd`,
 * `workspace.project_dir`). Returns `undefined` when none is present.
 */
function readStdinActiveCwd(stdin: Record<string, unknown> | undefined): string | undefined {
  if (stdin === undefined) return undefined;
  const direct = stringAt(stdin, ['workspace', 'current_dir']);
  if (direct !== undefined) return direct;
  const cwd = stringAt(stdin, ['cwd']);
  if (cwd !== undefined) return cwd;
  return stringAt(stdin, ['workspace', 'project_dir']);
}

function stringAt(value: unknown, path: ReadonlyArray<string>): string | undefined {
  let cur: unknown = value;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined;
}

function numberAt(value: unknown, path: ReadonlyArray<string>): number | undefined {
  let cur: unknown = value;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur === 'number' && Number.isFinite(cur)) return cur;
  if (typeof cur === 'string' && cur.trim() !== '') {
    const n = Number(cur);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function resolveStatuslineSessionId(stdin: Record<string, unknown> | undefined): string | undefined {
  if (stdin === undefined) return undefined;
  return resolveSessionId(stdin, {}) ?? undefined;
}

function resolveStatuslineSessionKey(stdin: Record<string, unknown> | undefined): string {
  if (stdin === undefined) return sessionKeyFor({}, {});
  return sessionKeyFor(stdin, {});
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

interface ResolvedRenderSnapshot {
  readonly snapshot?: StatuslineSnapshotV1;
  readonly mode: LastRenderMode;
}

/**
 * Resolve which of the three rendering modes applies to this call.
 *
 *   - Snapshot mode: cache.json present + fresh enough.
 *   - Inline-collector mode: cache stale or unparseable but `.hive-flow/` exists.
 *   - Header-only mode: no `.hive-flow/` at all OR inline collection failed.
 */
async function resolveModeForRender(
  scope: ProjectScope,
  stdin: Record<string, unknown> | undefined,
  snapshotMaxAgeMs: number,
  deadlineMs: number,
): Promise<ResolvedRenderSnapshot> {
  const paths = statuslinePaths(scope.projectRoot);
  const globalPaths = globalStatuslinePaths(scope.projectKey, resolveStatuslineSessionKey(stdin));
  const hiveFlowExists = existsSync(paths.root);
  // Try the snapshot path first when cache.json is present.
  const cached = await tryReadSnapshot(paths.cache).catch(() => undefined);
  if (cached !== undefined) {
    if (isSnapshotFreshEnough(cached, snapshotMaxAgeMs)) {
      // Snapshot mode — happy path for stable rows. Swarm is live-process
      // state, so a fresh cache still cannot keep dead/no-PID records visible.
      return { snapshot: await revalidateCachedSwarm(scope, cached), mode: 'snapshot' };
    }
    // Snapshot present but stale. Fall through to inline-collector if
    // `.hive-flow/` exists; otherwise stick with the stale snapshot as
    // header-only-style data (we still prefer ANY cache over inventing rows).
    if (hiveFlowExists) {
      const inline = await tryInlineCollect(scope, deadlineMs);
      if (inline !== undefined) {
        return { snapshot: mergeSnapshots(cached, inline), mode: 'inline-collector' };
      }
    }
    // No inline available — degrade to header-only using cached header bits.
    return { snapshot: withoutCachedSwarm(cached), mode: 'header-only' };
  }

  // No project-local cache. Fall back to the global project/session index so
  // statusline invocations launched from outside the checkout still populate
  // from the daemon's durable Hive Flow state.
  const globalCached = await tryReadSnapshot(globalPaths.cache).catch(() => undefined);
  if (globalCached !== undefined) {
    if (isSnapshotFreshEnough(globalCached, snapshotMaxAgeMs)) {
      return { snapshot: await revalidateCachedSwarm(scope, globalCached), mode: 'snapshot' };
    }
    if (hiveFlowExists) {
      const inline = await tryInlineCollect(scope, deadlineMs);
      if (inline !== undefined) {
        return { snapshot: mergeSnapshots(globalCached, inline), mode: 'inline-collector' };
      }
    }
    return { snapshot: withoutCachedSwarm(globalCached), mode: 'header-only' };
  }

  // No cache anywhere. If `.hive-flow/` is absent, header-only.
  if (!hiveFlowExists) {
    // Suppress unused-stdin warnings — we deliberately let the header pull
    // model/context from stdin downstream.
    void stdin;
    return { mode: 'header-only' };
  }

  // `.hive-flow/` present, no cache: inline-collector mode.
  const inline = await tryInlineCollect(scope, deadlineMs);
  if (inline !== undefined) {
    return { snapshot: inline, mode: 'inline-collector' };
  }
  return { mode: 'header-only' };
}

async function tryReadSnapshot(cachePath: string): Promise<StatuslineSnapshotV1 | undefined> {
  const parsed = await readJsonFile<unknown>(cachePath);
  if (parsed === undefined) return undefined;
  if (!isSnapshotV1(parsed)) return undefined;
  return parsed;
}

function isSnapshotV1(value: unknown): value is StatuslineSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { version?: unknown; projectRoot?: unknown; projectKey?: unknown };
  if (v.version !== 1) return false;
  if (typeof v.projectRoot !== 'string') return false;
  if (typeof v.projectKey !== 'string') return false;
  return true;
}

function isSnapshotFreshEnough(snapshot: StatuslineSnapshotV1, maxAgeMs: number): boolean {
  // A snapshot is "fresh enough" when `generatedAt` is within `maxAgeMs`.
  const generated = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generated)) return false;
  const age = Date.now() - generated;
  if (!Number.isFinite(age) || age < 0) return false;
  return age <= maxAgeMs;
}

async function tryInlineCollect(
  scope: ProjectScope,
  deadlineMs: number,
): Promise<StatuslineSnapshotV1 | undefined> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 25) return undefined;
  const inline = await collectInlineSnapshot({
    projectRoot: scope.projectRoot,
    ...(scope.worktreeRoot !== undefined ? { worktreeRoot: scope.worktreeRoot } : {}),
    deadlineMs: remaining,
  }).catch(() => undefined);
  if (inline === undefined) return undefined;
  return materializeInlineSnapshot(inline, scope);
}

/**
 * Materialize a `Partial<StatuslineSnapshotV1>` returned by
 * `collectInlineSnapshot` into a fully-typed `StatuslineSnapshotV1` so the
 * downstream renderer can dereference fields uniformly. Identity fields come
 * from the project scope when the inline partial omits them.
 */
function materializeInlineSnapshot(
  partial: Partial<StatuslineSnapshotV1>,
  scope: ProjectScope,
): StatuslineSnapshotV1 {
  return {
    version: 1,
    projectRoot: partial.projectRoot ?? scope.projectRoot,
    repoIdentity: partial.repoIdentity ?? scope.repoIdentity,
    ...(partial.displayName ?? scope.displayName ? { displayName: partial.displayName ?? scope.displayName } : {}),
    ...(partial.worktreeRoot ?? scope.worktreeRoot ? { worktreeRoot: partial.worktreeRoot ?? scope.worktreeRoot } : {}),
    projectKey: partial.projectKey ?? scope.projectKey,
    generatedAt: partial.generatedAt ?? new Date().toISOString(),
    sources: partial.sources ?? {},
    ...(partial.context !== undefined ? { context: partial.context } : {}),
    ...(partial.git !== undefined ? { git: partial.git } : {}),
    ...(partial.scoreboard !== undefined ? { scoreboard: partial.scoreboard } : {}),
    ...(partial.sessions !== undefined ? { sessions: partial.sessions } : {}),
    ...(partial.swarm !== undefined ? { swarm: partial.swarm } : {}),
    ...(partial.hooks !== undefined ? { hooks: partial.hooks } : {}),
    ...(partial.memory !== undefined ? { memory: partial.memory } : {}),
    ...(partial.tests !== undefined ? { tests: partial.tests } : {}),
    ...(partial.mcp !== undefined ? { mcp: partial.mcp } : {}),
    ...(partial.attention !== undefined ? { attention: partial.attention } : {}),
    ...(partial.adrs !== undefined ? { adrs: partial.adrs } : {}),
    ...(partial.daemon !== undefined ? { daemon: partial.daemon } : {}),
    ...(partial.rendererHints !== undefined ? { rendererHints: partial.rendererHints } : {}),
  };
}

/**
 * Merge `inline` into `cached` so the renderer prefers the inline-collector's
 * freshly-probed sources over the stale cache, while keeping the cached
 * identity fields (the cache was authored by the full refresher, which has
 * worktree-aware identity). Every probe-derived source the inline collector
 * read off the materialized roll-ups (git / swarm / daemon / scoreboard /
 * memory / tests / attention / mcp) overrides its stale cached counterpart
 * ONLY when the inline probe actually populated it; absent inline fields fall
 * back to the cache so a transient probe miss never blanks a populated row.
 */
function mergeSnapshots(cached: StatuslineSnapshotV1, inline: StatuslineSnapshotV1): StatuslineSnapshotV1 {
  const { sessions: _cachedSessions, ...base } = withoutCachedSwarm(cached);
  return {
    ...base,
    ...(inline.git !== undefined ? { git: inline.git } : {}),
    ...(inline.swarm !== undefined ? { swarm: inline.swarm } : {}),
    ...(inline.daemon !== undefined ? { daemon: inline.daemon } : {}),
    ...(inline.scoreboard !== undefined ? { scoreboard: inline.scoreboard } : {}),
    ...(inline.sessions !== undefined ? { sessions: inline.sessions } : {}),
    ...(inline.memory !== undefined ? { memory: inline.memory } : {}),
    ...(inline.tests !== undefined ? { tests: inline.tests } : {}),
    ...(inline.attention !== undefined ? { attention: inline.attention } : {}),
    ...(inline.mcp !== undefined ? { mcp: inline.mcp } : {}),
    generatedAt: inline.generatedAt ?? cached.generatedAt,
  };
}

async function revalidateCachedSwarm(
  scope: ProjectScope,
  cached: StatuslineSnapshotV1,
): Promise<StatuslineSnapshotV1> {
  const validation = await collectLiveSwarm(scope).catch(() => undefined);
  if (validation?.swarm !== undefined) {
    return { ...withoutCachedSwarm(cached), swarm: validation.swarm };
  }
  if (validation?.hasLiveSwarmSource === true) {
    return withoutCachedSwarm(cached);
  }
  return cached;
}

interface LiveSwarmValidation {
  readonly swarm?: SwarmSummary;
  readonly hasLiveSwarmSource: boolean;
}

async function collectLiveSwarm(scope: ProjectScope): Promise<LiveSwarmValidation> {
  const s = await collectSwarm({ projectRoot: scope.projectRoot });
  const hasLiveSwarmSource =
    s.freshness.state !== 'absent' ||
    s.activeHives !== undefined ||
    s.agents.length > 0;
  if (s.workersAlive <= 0 && s.queensAlive <= 0) {
    return { hasLiveSwarmSource };
  }
  const idleAgents = Math.max(0, s.workersAlive - s.workersExecuting);
  const agentsList: NormalizedAgentRow[] = s.agents.map((row) => ({ ...row }));
  return {
    hasLiveSwarmSource: true,
    swarm: {
      activeAgents: s.workersExecuting,
      idleAgents,
      queuedAgents: 0,
      maxAgents: s.cap,
      activeQueens: s.queensAlive,
      executingQueens: s.queensExecuting,
      ...(agentsList.length > 0 ? { agents: agentsList } : {}),
      ...(s.activeHives !== undefined ? { activeHives: s.activeHives } : {}),
    },
  };
}

function withoutCachedSwarm(snapshot: StatuslineSnapshotV1): StatuslineSnapshotV1 {
  const { swarm: _discardSwarm, sources, ...rest } = snapshot;
  const { swarm: _discardSwarmSource, ...remainingSources } = sources;
  void _discardSwarm;
  void _discardSwarmSource;
  return {
    ...rest,
    sources: remainingSources,
  };
}

function readSnapshotMaxAge(_projectRoot: string, config: StatuslineConfig): number {
  // Honor the per-source context TTL if the user configured one; otherwise
  // use the default 5-minute window.
  const ctx = config.sourceTtlsMs.context;
  if (typeof ctx === 'number' && Number.isFinite(ctx) && ctx > 0) return ctx;
  return DEFAULT_SNAPSHOT_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Composition (single-line render)
// ---------------------------------------------------------------------------

interface ComposeContext {
  readonly snapshot: StatuslineSnapshotV1 | undefined;
  readonly mode: LastRenderMode;
  readonly palette: PaletteCodes;
  readonly scope: ProjectScope;
  readonly stdin: Record<string, unknown> | undefined;
  readonly enforcementStatus: EnforcementLiveStatus;
}

/**
 * Width (in box-drawing `─` characters) of the inter-row separator rules.
 * Matches the design doc's example board (~65 columns).
 */
const SEPARATOR_RULE_WIDTH = 65;

/**
 * Render a full-width horizontal `─` rule in the palette `separator` colour.
 * Used between the header / body / footer groups per the design doc's row
 * table ("Separator | When ≥1 body row").
 */
function renderSeparatorRule(p: PaletteCodes): string {
  return `${p.separator}${'─'.repeat(SEPARATOR_RULE_WIDTH)}${p.reset}`;
}

/**
 * Produce the multi-row statusline box. Order matches the locked visual
 * design (header -> [rule] -> scoreboard -> swarm -> memory/tests ->
 * attention -> [rule] -> footer) but every row is omitted when its backing
 * data is absent (OMIT > FAKE rule).
 *
 * Rows are joined by `\n` (Claude Code statusLine renders multi-line stdout
 * natively). Within a row, cells stay delimited by a palette-coloured
 * space-pipe-space. Full-width `─` rules separate the header / body / footer
 * groups whenever at least one body row is present.
 */
function composeStatusline(ctx: ComposeContext): string {
  const p = ctx.palette;
  const rows: string[] = [];

  // 1) Header — always rendered. Project anchor + git + model + context.
  const header = renderHeader(ctx);
  if (header.length > 0) rows.push(header);

  // 2) Scoreboard / Swarm / Memory / Attention rows render only when there
  // is backing snapshot data. Header-only mode falls through this block and
  // emits just the header (+ footer when a signal exists).
  const bodyRows: string[] = [];
  const snapshot = ctx.snapshot;
  if (snapshot !== undefined && ctx.mode !== 'header-only') {
    const scoreboard = renderScoreboard(snapshot, p);
    if (scoreboard !== undefined) bodyRows.push(scoreboard);

    const swarm = renderSwarm(snapshot, p, resolveStatuslineSessionId(ctx.stdin));
    if (swarm !== undefined) bodyRows.push(swarm);

    const memory = renderMemoryRow(snapshot, p);
    if (memory !== undefined) bodyRows.push(memory);

    const attention = renderAttention(snapshot.attention, p);
    if (attention !== undefined) bodyRows.push(attention);
  }

  // 3) Footer — daemon + freshness summary. Rendered for all modes when
  // there's a daemon signal or a generatedAt timestamp.
  const footer = renderFooter(ctx);

  // Assemble the box. A `─` rule precedes the first body row (when present)
  // and another precedes the footer (when ≥1 body row was rendered), exactly
  // as the design doc's row table specifies ("Separator | When ≥1 body row").
  const hasBody = bodyRows.length > 0;
  if (hasBody) {
    rows.push(renderSeparatorRule(p));
    rows.push(...bodyRows);
    rows.push(renderSeparatorRule(p));
  }
  if (footer !== undefined && footer.length > 0) rows.push(footer);

  return rows.filter((s) => s.length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(ctx: ComposeContext): string {
  const p = ctx.palette;
  const displayName = ctx.snapshot?.displayName ?? ctx.scope.displayName ?? basename(ctx.scope.projectRoot);
  const parts: string[] = [`${p.project}▊ ${displayName}${p.reset}`];

  // Git summary — branch + deltas. Prefer the snapshot's git, fall back to
  // none (the refresher omits git outside a real probe).
  const gitPart = renderGit(ctx.snapshot?.git, p);
  if (gitPart !== undefined) parts.push(gitPart);

  // Model — from stdin via `resolveModelDisplay` (synchronous, no I/O).
  const model = resolveModelDisplay(ctx.stdin);
  if (model.value.modelDisplay.length > 0) {
    parts.push(`${p.model}${model.value.modelDisplay}${p.reset}`);
  }

  // Context (ADR-051) — stdin-first merge with snapshot.context.
  const context = mergeRenderContext(ctx.stdin, ctx.snapshot?.context);
  if (context !== undefined) {
    const ctxLine = renderContext(context, ctx.stdin, p);
    if (ctxLine !== undefined) parts.push(ctxLine);
  }

  // Cost — only when > 0. Sourced exclusively from stdin (the refresher does
  // not materialize cost; it's a Claude Code per-session signal).
  const cost = numberAt(ctx.stdin, ['cost', 'total_cost_usd']);
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
    parts.push(`${p.gray}$${cost.toFixed(2)}${p.reset}`);
  }

  // Duration — Claude Code reports `cost.total_duration_ms`.
  const durationMs = numberAt(ctx.stdin, ['cost', 'total_duration_ms']);
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    parts.push(`${p.gray}⏱ ${formatDuration(durationMs)}${p.reset}`);
  }

  return parts.join(`  ${p.separator}│${p.reset}  `);
}

function renderGit(git: GitSummary | undefined, p: PaletteCodes): string | undefined {
  if (git === undefined) return undefined;
  const branch = git.branch ?? '';
  if (branch.length === 0) {
    // No branch label — only render git when we have deltas to show.
    if (!hasDeltas(git)) return undefined;
  }
  const tokens: string[] = [];
  if (branch.length > 0) tokens.push(`${p.branch}${branch}${p.reset}`);
  if (git.staged !== undefined && git.staged > 0) tokens.push(`${p.safe}+${git.staged}${p.reset}`);
  if (git.modified !== undefined && git.modified > 0) tokens.push(`${p.warn}~${git.modified}${p.reset}`);
  if (git.untracked !== undefined && git.untracked > 0) tokens.push(`${p.dim}?${git.untracked}${p.reset}`);
  if (git.ahead !== undefined && git.ahead > 0) tokens.push(`${p.queen}↑${git.ahead}${p.reset}`);
  if (git.behind !== undefined && git.behind > 0) tokens.push(`${p.fail}↓${git.behind}${p.reset}`);
  return tokens.join(' ');
}

function hasDeltas(git: GitSummary): boolean {
  return (
    (git.staged ?? 0) > 0 ||
    (git.modified ?? 0) > 0 ||
    (git.untracked ?? 0) > 0 ||
    (git.ahead ?? 0) > 0 ||
    (git.behind ?? 0) > 0
  );
}

// ---------------------------------------------------------------------------
// Context (ADR-051)
// ---------------------------------------------------------------------------

function mergeRenderContext(
  stdin: Record<string, unknown> | undefined,
  cached: ContextSummary | undefined,
): ContextSummary | undefined {
  const live = contextFromStdin(stdin);
  if (live === undefined) return cached;
  if (cached === undefined) return live;
  // stdin wins per field — matches the refresher's merge semantics.
  return {
    percentage: live.percentage ?? cached.percentage,
    tokenEstimate: live.tokenEstimate ?? cached.tokenEstimate,
    inputTokens: live.inputTokens ?? cached.inputTokens,
    outputTokens: live.outputTokens ?? cached.outputTokens,
    contextWindow: live.contextWindow ?? cached.contextWindow,
    pruneCount: live.pruneCount ?? cached.pruneCount,
    lastCheck: live.lastCheck ?? cached.lastCheck,
    history: live.history ?? cached.history,
    source: live.source,
    observedAt: live.observedAt,
  };
}

function contextFromStdin(stdin: Record<string, unknown> | undefined): ContextSummary | undefined {
  if (stdin === undefined) return undefined;
  const pctRaw =
    numberAt(stdin, ['context_window', 'used_percentage']) ??
    numberAt(stdin, ['context', 'percentage']) ??
    numberAt(stdin, ['context', 'percent']);
  const inputTokens =
    numberAt(stdin, ['context_window', 'total_input_tokens']) ??
    numberAt(stdin, ['context_window', 'input_tokens']) ??
    numberAt(stdin, ['usage', 'input_tokens']);
  const outputTokens =
    numberAt(stdin, ['context_window', 'total_output_tokens']) ??
    numberAt(stdin, ['context_window', 'output_tokens']) ??
    numberAt(stdin, ['usage', 'output_tokens']);
  const contextWindow =
    numberAt(stdin, ['context_window', 'context_window_size']) ??
    numberAt(stdin, ['context_window', 'max_tokens']) ??
    numberAt(stdin, ['context', 'max_tokens']);
  const usedTokens =
    numberAt(stdin, ['context_window', 'used_tokens']) ?? numberAt(stdin, ['context', 'used_tokens']);
  const derivedPct =
    normalizePercentage(pctRaw) ??
    (typeof usedTokens === 'number' && typeof contextWindow === 'number' && contextWindow > 0
      ? normalizePercentage(usedTokens / contextWindow)
      : undefined);
  if (
    derivedPct === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined &&
    contextWindow === undefined
  ) {
    return undefined;
  }
  return {
    ...(derivedPct !== undefined ? { percentage: derivedPct } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    source: 'stdin',
    observedAt: new Date().toISOString(),
  };
}

function normalizePercentage(raw: number | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const scaled = raw <= 1 ? raw * 100 : raw;
  if (!Number.isFinite(scaled)) return undefined;
  if (scaled < 0) return 0;
  if (scaled > 100) return 100;
  return scaled;
}

function renderContext(
  context: ContextSummary,
  stdin: Record<string, unknown> | undefined,
  p: PaletteCodes,
): string | undefined {
  const pct = context.percentage;
  if (pct === undefined) return undefined;
  const color = contextColor(pct, p);
  const pctText = `${color}📖 ${Math.round(pct)}% ctx${p.reset}`;
  // Token detail — prefer stdin's raw input/output counts when present so the
  // header surfaces the live numbers, falling back to the cached context.
  const inputTokens = context.inputTokens;
  const outputTokens = context.outputTokens;
  if (typeof inputTokens === 'number' || typeof outputTokens === 'number') {
    const tokens = `${inputTokens ?? 0} in/${outputTokens ?? 0} out`;
    return `${pctText} ${p.gray}· ${tokens}${p.reset}`;
  }
  // Mark `stdin` as referenced so an unused-parameter lint cannot escalate.
  void stdin;
  return pctText;
}

function contextColor(pct: number, p: PaletteCodes): string {
  if (pct > 85) return p.critical;
  if (pct >= 70) return p.warn;
  return p.safe;
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

const SCOREBOARD_PROVIDER_LABEL: Readonly<Record<ScoreProvider, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  forge: 'Forge',
  cursor: 'Cursor',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  qwen: 'Qwen',
  opencode: 'OpenCode',
  unknown: 'Unknown',
};

function renderScoreboard(snapshot: StatuslineSnapshotV1, p: PaletteCodes): string | undefined {
  const board: ScoreboardSummary | undefined = snapshot.scoreboard;
  if (board === undefined) return undefined;
  const calls = board.callsByProvider ?? {};
  const agents = board.agentsByProvider ?? {};
  const keys = new Set<string>([...Object.keys(calls), ...Object.keys(agents)]);
  if (keys.size === 0) return undefined;
  // Patch B: OpenRouter defaults to aggregate (single token); Claude always
  // model-split (visual design). Honour `rendererHints.openRouterBreakdown`
  // when set; default to `'aggregate'` when undefined.
  const openRouterMode = snapshot.rendererHints?.openRouterBreakdown ?? 'aggregate';
  const tokens: string[] = [];
  // Stable alphabetical order so the line is deterministic test-side.
  for (const raw of [...keys].sort()) {
    if (!isScoreProvider(raw)) continue;
    const provider = raw;
    const presence = agents[provider];
    const usage = calls[provider];
    const presentCount =
      (presence?.activeAgents ?? 0) + (presence?.idleAgents ?? 0);
    const count = presentCount > 0 ? presentCount : usage?.calls ?? 0;
    if (count <= 0) continue;
    const label = SCOREBOARD_PROVIDER_LABEL[provider];
    const color = providerColor(provider, p);
    const countColor = providerCountColor(presence, p);
    // Per-model breakdown rules:
    //   - Claude: always model-split when models present (visual design).
    //   - OpenRouter: model-split ONLY when `openRouterBreakdown === 'model'`;
    //     defaults to aggregate (single token with combined call count).
    //   - Other providers: aggregate.
    const models = presence?.models && Object.keys(presence.models).length > 0 ? presence.models : usage?.models;
    const wantsBreakdown =
      provider === 'claude' ||
      (provider === 'openrouter' && openRouterMode === 'model');
    if (wantsBreakdown && models && Object.keys(models).length > 0) {
      const modelParts = Object.entries(models)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, n]) => `${name} ${countColor}${n}${p.reset}`);
      tokens.push(`${color}${label}${p.reset} ${modelParts.join(` ${p.gray}·${p.reset} `)}`);
      continue;
    }
    tokens.push(`${color}${label}${p.reset} ${countColor}${count}${p.reset}`);
  }
  if (tokens.length === 0) return undefined;
  return `🤖 ${tokens.join(`  ${p.separator}│${p.reset}  `)}`;
}

function isScoreProvider(value: string): value is ScoreProvider {
  return value in SCOREBOARD_PROVIDER_LABEL;
}

function providerColor(provider: ScoreProvider, p: PaletteCodes): string {
  if (provider === 'claude') return p.claude;
  if (provider === 'codex') return p.codex;
  if (provider === 'gemini') return p.gemini;
  if (provider === 'forge') return p.forge;
  if (provider === 'cursor') return p.cursor;
  if (provider === 'deepseek') return p.deepseek;
  if (provider === 'openrouter') return p.openrouter;
  if (provider === 'qwen') return p.qwen;
  if (provider === 'opencode') return p.opencode;
  return p.gray;
}

function providerCountColor(
  presence: ScoreboardSummary['agentsByProvider'][ScoreProvider] | undefined,
  p: PaletteCodes,
): string {
  if ((presence?.activeAgents ?? 0) > 0) return p.active;
  if ((presence?.idleAgents ?? 0) > 0) return p.warn;
  return p.number;
}

// ---------------------------------------------------------------------------
// Swarm
// ---------------------------------------------------------------------------

function renderSwarm(
  snapshot: StatuslineSnapshotV1,
  p: PaletteCodes,
  currentSessionId: string | undefined,
): string | undefined {
  const swarm: SwarmSummary | undefined = snapshot.swarm;
  if (swarm === undefined) return undefined;
  const total = swarm.activeAgents + swarm.idleAgents + swarm.queuedAgents;
  if (total <= 0 && swarm.activeQueens <= 0) return undefined;

  const executing = swarm.activeAgents > 0;
  // Tri-state indicator per locked visual design:
  //   activeAgents > 0           => ◉ bright-green (executing)
  //   total > 0, no executing    => ○ teal (idle workers present)
  //   total == 0 (queens-only)   => ○ dim
  const indicator = executing
    ? `${p.active}◉${p.reset}`
    : total > 0
      ? `${p.warn}○${p.reset}`
      : `${p.dim}○${p.reset}`;

  const numberColor = executing ? p.active : total > 0 ? p.warn : p.dim;
  const slot = `[${numberColor}${String(total).padStart(2, ' ')}${p.reset}${p.gray}/${p.reset}${p.number}${swarm.maxAgents}${p.reset}]`;

  const queenPart = swarm.activeQueens > 0
    ? `  ${swarm.executingQueens > 0 ? p.queen : p.queenIdle}♛${swarm.activeQueens}${p.reset}`
    : '';

  const detailTags = [
    maybeRenderParentSessionTag(swarm, currentSessionId, p),
    maybeRenderHiveSessionTag(swarm, currentSessionId, p),
  ].filter((tag): tag is string => tag !== undefined);
  const detailPart = detailTags.length > 0
    ? `  ${p.separator}·${p.reset}  ${detailTags.join(`  ${p.separator}·${p.reset}  `)}`
    : '';
  const detailMode = snapshot.rendererHints?.activeAgentDetail ?? 'off';
  const useRoleIcons = snapshot.rendererHints?.useRoleIcons === true;
  const swarmCore = `🪪 Swarm ${indicator} ${slot}${queenPart}${detailPart}`;

  // Active agents row collapses into the same section when role-icons toggle
  // is on (visual design 3.5). Default is `off` per config.
  const active = maybeRenderActive(swarm, p, detailMode, useRoleIcons);
  if (active !== undefined) {
    return `${swarmCore}  ${p.separator}·${p.reset}  ${active}`;
  }
  return swarmCore;
}

function maybeRenderParentSessionTag(
  swarm: SwarmSummary,
  currentSessionId: string | undefined,
  p: PaletteCodes,
): string | undefined {
  if (currentSessionId === undefined) return undefined;
  const agents = swarm.agents;
  if (agents === undefined || agents.length === 0) return undefined;

  let knownOwnerRows = 0;
  let currentOwnerRows = 0;
  for (const agent of agents) {
    if (typeof agent.ownerSessionId !== 'string' || agent.ownerSessionId.length === 0) continue;
    knownOwnerRows++;
    if (agent.ownerSessionId === currentSessionId) currentOwnerRows++;
  }
  if (knownOwnerRows <= 0) return undefined;
  return `${p.gray}parent ${p.number}${currentOwnerRows}${p.reset}`;
}

function maybeRenderHiveSessionTag(
  swarm: SwarmSummary,
  currentSessionId: string | undefined,
  p: PaletteCodes,
): string | undefined {
  if (currentSessionId === undefined) return undefined;
  const activeHives = swarm.activeHives;
  if (activeHives === undefined) return undefined;

  const current = activeHives.byOwnerSessionId[currentSessionId] ?? 0;
  let other = 0;
  for (const [ownerSessionId, count] of Object.entries(activeHives.byOwnerSessionId)) {
    if (ownerSessionId !== currentSessionId) other += count;
  }
  if (other <= 0) return undefined;

  const parts = [
    `${p.number}${current}${p.reset}${p.gray} this`,
    ...(other > 0 ? [`${p.number}${other}${p.reset}${p.gray} other`] : []),
  ];

  return `${p.gray}hives ${p.reset}${parts.join(`${p.gray}/${p.reset}`)}${p.reset}`;
}

function maybeRenderActive(
  swarm: SwarmSummary,
  p: PaletteCodes,
  mode: 'off' | 'auto' | 'on',
  useIcons: boolean,
): string | undefined {
  if (mode === 'off') return undefined;
  // Patch C: drop terminal agents BEFORE rendering. `normalizeAgentStatus`
  // returns `undefined` for terminal states (terminated/failed/complete/
  // cancelled). We filter them out entirely rather than falling back to
  // 'stale' — terminal agents should not appear in the live "Active" row.
  const allAgents = swarm.agents ?? [];
  const liveAgents = allAgents.filter(
    (agent) => normalizeAgentStatus(agent.status) !== undefined,
  );
  if (liveAgents.length === 0) return undefined;
  if (mode === 'auto' && (liveAgents.length > 8 || !liveAgents.some((a) => a.status === 'busy'))) {
    return undefined;
  }
  const tokens = liveAgents.map((agent) => renderAgentToken(agent, p, useIcons));
  return `🜁 ${p.memory}Active${p.reset} ${tokens.join(`${p.number},${p.reset} `)}`;
}

const ROLE_ICONS: Readonly<Record<string, string>> = {
  queen: '♛',
  coder: '🔧',
  reviewer: '🔍',
  tester: '🧪',
  analyst: '📊',
  architect: '🏛',
  'bug-hunter': '🐛',
  researcher: '📚',
  planner: '🗺',
  documenter: '📝',
  debugger: '🐞',
  security: '🔒',
  worker: '•',
};

function renderAgentToken(agent: NormalizedAgentRow, p: PaletteCodes, useIcons: boolean): string {
  // Caller (`maybeRenderActive`) filters terminal agents BEFORE invoking this,
  // so `normalizeAgentStatus(agent.status)` is guaranteed non-undefined here.
  // We keep the fallback to 'stale' purely as defence-in-depth and only for
  // unknown-but-non-terminal inputs that slip past the filter — never for the
  // explicit terminal aliases (terminated/failed/complete/cancelled), which
  // the upstream filter already removed.
  const normalized = normalizeAgentStatus(agent.status);
  const status: NormalizedAgentStatus = normalized ?? 'stale';
  const isQueen = agent.role === 'queen';
  const busy = status === 'busy';
  const color = isQueen ? (busy ? p.queen : p.queenIdle) : busy ? p.active : p.memory;
  const role = String(agent.role ?? 'worker');
  const label = useIcons ? (ROLE_ICONS[role] ?? ROLE_ICONS.worker) : role;
  const model = agent.model ?? agent.provider ?? '';
  const parts = [agent.id, label, model, status].filter((s) => typeof s === 'string' && s.length > 0);
  return `${color}${parts.join(`${p.dim}·${p.reset}${color}`)}${p.reset}`;
}

// ---------------------------------------------------------------------------
// Memory row (Embeddings / Memories / DB / Tests / MCP)
// ---------------------------------------------------------------------------

function renderMemoryRow(snapshot: StatuslineSnapshotV1, p: PaletteCodes): string | undefined {
  const parts: string[] = [];
  const memory = snapshot.memory;
  if (memory?.embeddings && memory.embeddings.count > 0) {
    parts.push(`Embeddings ${p.embeddings}${memory.embeddings.count}${p.reset}`);
  }
  if (memory?.memories && memory.memories.count > 0) {
    parts.push(`Memories ${p.claude}${formatCount(memory.memories.count)}${p.reset}`);
  }
  if (typeof memory?.dbSizeBytes === 'number' && memory.dbSizeBytes > 0) {
    parts.push(`${p.gray}💾 ${formatBytes(memory.dbSizeBytes)}${p.reset}`);
  }
  const testsRow = renderTests(snapshot.tests, p);
  if (testsRow !== undefined) parts.push(testsRow);
  const mcp = snapshot.mcp;
  if (mcp !== undefined && mcp.total > 0) {
    const allUp = mcp.runtimeUp === mcp.total;
    const someDown = mcp.runtimeUp > 0 && mcp.runtimeUp < mcp.total;
    const color = allUp ? p.safe : someDown ? p.queen : p.fail;
    parts.push(`🔌 ${color}MCP ${mcp.runtimeUp}/${mcp.total}${p.reset}`);
  }
  if (parts.length === 0) return undefined;
  return `📊 ${p.memory}Memory${p.reset}  ${parts.join(`  ${p.separator}│${p.reset}  `)}`;
}

function renderTests(tests: TestsSummary | undefined, p: PaletteCodes): string | undefined {
  if (tests === undefined) return undefined;
  const suite = tests.suite;
  if (suite === undefined) return undefined;
  if (!Number.isFinite(suite.total) || suite.total < 0) return undefined;
  const labelColor = suite.stale === true ? p.gray : p.memory;
  if (suite.total === 0) {
    return `🧪 ${labelColor}Tests${p.reset} ${p.warn}0${p.reset}`;
  }
  if (suite.failed === 0 && suite.skipped === 0) {
    return `🧪 ${labelColor}Tests${p.reset} ${p.safe}${suite.total}${p.reset}`;
  }
  const denomColor = suite.failed > 0 ? p.fail : p.warn;
  return `🧪 ${labelColor}Tests${p.reset} ${p.safe}${suite.passed}${p.reset}/${denomColor}${suite.total}${p.reset}`;
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0KB';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.ceil(n / 1024)}KB`;
  return `${Math.max(0, Math.floor(n))}B`;
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

function renderAttention(attention: AttentionSummary | undefined, p: PaletteCodes): string | undefined {
  if (attention === undefined) return undefined;
  const items = attention.unresolved ?? [];
  if (items.length === 0) return undefined;
  const top = items.slice(0, 2);
  const tokens = top.map((item) => {
    const label = item.severity === 'critical' ? `${p.critical}!${p.reset}` : `${p.warn}!${p.reset}`;
    return `${label} ${item.message ?? ''}`.trim();
  });
  return `📌 ${p.warn}attention${p.reset}  ${tokens.join(`  ${p.gray}·${p.reset}  `)}`;
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function renderFooter(ctx: ComposeContext): string | undefined {
  const snapshot = ctx.snapshot;
  const p = ctx.palette;
  const tokens: string[] = [];
  if (ctx.enforcementStatus.active) {
    const level = ctx.enforcementStatus.level;
    const color = level === 0
      ? p.safe
      : level === 1
        ? p.warn
        : level === 2
          ? p.fail
          : level === 3
            ? p.critical
            : p.warn;
    tokens.push(`${color}ENFORCEMENT ON (${ctx.enforcementStatus.levelName ?? 'UNKNOWN'})${p.reset}`);
  } else {
    tokens.push(`${p.fail}⛔ ENFORCEMENT OFF${p.reset}`);
  }
  // Daemon state — header-only mode omits this since we have no signal.
  const daemon: DaemonSummary | undefined = snapshot?.daemon;
  if (daemon !== undefined) {
    if (daemon.running === true) {
      tokens.push(`${p.safe}daemon on${p.reset}`);
    } else if (daemon.health === 'stopped') {
      tokens.push(`${p.fail}daemon stopped${p.reset}`);
    } else if (daemon.health === 'unknown') {
      tokens.push(`${p.warn}daemon unknown${p.reset}`);
    }
    // Phase 12: no fake `daemon off` fallback. "off" is only valid when a
    // source explicitly reports stopped (handled above as `daemon stopped`).
    // Any other state (e.g. running=false with stale/healthy health) is an
    // undetermined signal and is omitted rather than asserted as "off".
  }
  const sessionsToken = renderSessions(snapshot?.sessions, p);
  if (sessionsToken !== undefined) tokens.push(sessionsToken);
  // Freshness — based on the snapshot's generatedAt when present.
  if (snapshot !== undefined) {
    const ageMs = ageOfSnapshot(snapshot);
    if (ageMs !== undefined) {
      const fresh = ageMs <= 30_000;
      const color = fresh ? p.safe : p.warn;
      tokens.push(`${color}data ${fresh ? 'fresh' : 'stale'} ${formatAge(ageMs)}${p.reset}`);
    }
  }
  if (tokens.length === 0) return undefined;
  return `${p.gray}►${p.reset} ${tokens.join(` ${p.gray}·${p.reset} `)}`;
}

function renderSessions(sessions: SessionSummary | undefined, p: PaletteCodes): string | undefined {
  if (sessions === undefined) return undefined;
  const active = Number.isFinite(sessions.active) ? sessions.active : 0;
  const degraded = Number.isFinite(sessions.degraded) ? sessions.degraded : 0;
  const stale = Number.isFinite(sessions.stale) ? sessions.stale : 0;
  const total = active + degraded + stale;
  if (total <= 0) return undefined;
  const color = active > 0 ? p.safe : degraded > 0 ? p.warn : p.gray;
  const suffix = degraded > 0 || stale > 0
    ? `${p.gray} (${degraded} degraded/${stale} stale)${p.reset}`
    : '';
  return `${p.memory}Sessions${p.reset} ${color}${total}${p.reset}${suffix}`;
}

function ageOfSnapshot(snapshot: StatuslineSnapshotV1): number | undefined {
  if (!snapshot.generatedAt) return undefined;
  const ts = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(ts)) return undefined;
  const ms = Date.now() - ts;
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return ms;
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / (60 * 60_000))}h`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// `resolveActiveCwd` legacy export
// ---------------------------------------------------------------------------
//
// Earlier callers imported `resolveActiveCwd` directly. Keep the compatibility
// export so other modules continue to compile during the migration window.

export function resolveActiveCwd(stdinData?: Record<string, unknown>, fallback = process.cwd()): string {
  return readStdinActiveCwd(stdinData) ?? fallback;
}
