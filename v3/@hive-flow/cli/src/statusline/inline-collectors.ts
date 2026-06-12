// v3/@hive-flow/cli/src/statusline/inline-collectors.ts
//
// Wave 8 — Inline-fallback collector. The third statusline renderer mode:
// fired when no fresh `.hive-flow/state/cache.json` exists but `.hive-flow/`
// itself is present. Probes the cheapest sources within a strict deadline
// (`deadlineMs`, default ~150ms) and returns a partial snapshot.
//
// Mode summary:
//   1. Cached  — read `.hive-flow/state/cache.json`. Fast path.
//   2. Header  — render OMIT lines only. No `.hive-flow/`.
//   3. Inline  — THIS module. `.hive-flow/` exists but cache is stale.
//
// Binding constraints (from Codex-merged runbook 2026-05-20 §"inline-collectors"
// and phase3 Wave-8 risk register):
//
//   * Round-4 bug ξ (CRITICAL):
//     Between MULTIPLE `spawnSync` git calls, the remaining-budget value MUST
//     be recomputed BEFORE each call. The original sketch in the runbook reused
//     a stale `remaining` after the first spawn, allowing the second call to
//     hold the renderer for the full deadline twice (once per `git` exec). The
//     fix is the `remainingBudget()` closure below: each call site evaluates
//     the closure for a freshly-computed budget.
//
//   * No `gh pr view`, NO `du -sh`, NO `curl`, NO `shell: true`, NO network,
//     NO synchronous fs walking. (Phase 5 binding + Wave 8 risk-(d).)
//
//   * `spawnSync` is permitted ONLY for `git` (argv array, no shell) and
//     ONLY in this module — the renderer itself remains spawn-free.
//
//   * Bounded JSON reads via `readJsonFile` from storage.ts — inherits the
//     Wave 2.5A symlink guard. A symlinked `.hive-flow/agents/store.json`
//     (or symlinked parent) is rejected without crashing the renderer.
//
//   * `normalizeAgentStatus` is REUSED from `./types.js` — do not duplicate
//     Wave 5 logic. Terminal statuses drop from live counts.
//
//   * Per-probe try/catch isolation: one probe failing must not crash the
//     inline collector. The function ALWAYS resolves, never throws.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { collectActiveHiveOwnership } from './hive-ownership.js';
import { statuslinePaths } from './paths.js';
import { readJsonFile } from './storage.js';
import {
  normalizeAgentStatus,
  type AttentionSummary,
  type DaemonSummary,
  type GitSummary,
  type McpSummary,
  type MemorySummary,
  type NormalizedAgentRow,
  type ScoreboardSummary,
  type StatuslineSnapshotV1,
  type SwarmSummary,
  type TestsSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CollectInlineSnapshotOptions {
  /** Absolute path to the project root (the `.hive-flow/` parent). */
  readonly projectRoot: string;
  /** Session whose owned agents should be counted. Unowned/other-session agents are excluded. */
  readonly sessionId?: string;
  /**
   * Optional worktree root override. When provided, `git` probes are spawned
   * with `cwd: worktreeRoot` so a linked worktree's branch / status is read
   * from the worktree itself rather than the project's main checkout. Falls
   * back to `projectRoot` when omitted.
   */
  readonly worktreeRoot?: string;
  /**
   * Total budget (in ms) the inline collector is allowed to consume across
   * ALL probes. Default `150` — below the statusline render budget so the
   * fallback never blows the overall 200ms ceiling.
   */
  readonly deadlineMs?: number;
  /**
   * Injection seam for test-deterministic timing. Replaces `Date.now()` for
   * the budget closure. Production callers omit this; only tests pass it.
   */
  readonly nowMs?: () => number;
}

/** Default inline-collector budget. Mirrors runbook §"inline-collectors". */
export const DEFAULT_INLINE_DEADLINE_MS = 150;

/**
 * Bounded per-spawn cap (ms). No individual `git` invocation may pin more
 * than this regardless of the remaining budget — guards against slow FS
 * pathologies (lock-contended index, NFS, etc.). Slightly above the
 * sub-10ms healthy-repo norm.
 */
const PER_SPAWN_CAP_MS = 90;

/**
 * Minimum slice of remaining budget required before we attempt a spawn.
 * Below this, the call is skipped — pinning a process for <25ms is more
 * likely to land in the kill window than to return useful output.
 */
const MIN_BUDGET_FOR_SPAWN_MS = 25;

/**
 * Maximum size (in bytes) for a bounded JSON read in this module. The agent
 * store embeds each agent's `conversationHistory`, so a live multi-hive
 * session pushes `store.json` into the multi-megabyte range; the prior 256KB
 * cap silently dropped it and left the swarm row empty. Raised to 16MB so the
 * swarm row populates with real counts (the read stays async + bounded; the
 * storage guard still rejects anything above this ceiling). Counts are never
 * derived from byte size.
 */
const MAX_INLINE_JSON_BYTES = 16 * 1024 * 1024;

/**
 * Bounded read cap for the small materialized summary files
 * (`scoreboard/current.json`, `memory/stats.json`, `tests/current.json`,
 * `attention/current.json`, `mcp/health.json`). These are atomic JSON
 * roll-ups the recorders maintain WITHOUT a running daemon — each is a
 * compact summary, never an event log, so 256KB is comfortably above their
 * worst case while keeping the inline read cheap and bounded.
 */
const MAX_INLINE_SUMMARY_BYTES = 256 * 1024;

/**
 * Probe `.hive-flow/` cheaply and return whatever can be collected before
 * `deadlineMs` elapses. Returns a `Partial<StatuslineSnapshotV1>` — fields
 * are present only when their respective probes succeeded.
 *
 * Always returns; never throws. Per-probe try/catch isolation guarantees a
 * single probe failure does not abort the others.
 *
 * Returns `{}` (empty partial) when no `.hive-flow/` exists at the project
 * root — header-only mode is owned by the renderer, not this module.
 */
export async function collectInlineSnapshot(
  opts: CollectInlineSnapshotOptions,
): Promise<Partial<StatuslineSnapshotV1>> {
  const projectRoot = opts.projectRoot;
  const worktreeRoot = opts.worktreeRoot ?? projectRoot;
  const deadlineMs =
    typeof opts.deadlineMs === 'number' && Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0
      ? Math.floor(opts.deadlineMs)
      : DEFAULT_INLINE_DEADLINE_MS;
  const now = typeof opts.nowMs === 'function' ? opts.nowMs : () => Date.now();

  // Skip everything if `.hive-flow/` is absent. The renderer should not be
  // calling us in that case, but we guard defensively so a misuse degrades
  // to an empty partial rather than spawning git for no benefit.
  if (!existsSync(join(projectRoot, '.hive-flow'))) {
    return {};
  }

  const startTime = now();
  /**
   * ROUND-4 BUG ξ FIX:
   * This closure MUST be re-evaluated before EACH `spawnSync` call so a
   * fresh budget is used. Reusing a stale `remaining` variable across two
   * git calls would let the second call hold the renderer for an additional
   * full deadline window, exactly the regression bug ξ tracks.
   */
  const remainingBudget = (): number => Math.max(0, deadlineMs - (now() - startTime));

  // Each probe is independently isolated. We resolve them sequentially (not
  // in parallel) because each one consumes a slice of the shared budget and
  // we want the budget to be honest about cumulative elapsed time.
  let git: GitSummary | undefined;
  try {
    git = probeGit(worktreeRoot, remainingBudget);
  } catch {
    git = undefined;
  }

  let swarm: SwarmSummary | undefined;
  try {
    if (remainingBudget() > 0) {
      swarm = await probeSwarm(projectRoot, opts.sessionId);
    }
  } catch {
    swarm = undefined;
  }

  let daemon: DaemonSummary | undefined;
  try {
    if (remainingBudget() > 0) {
      daemon = await probeDaemon(projectRoot, now);
    }
  } catch {
    daemon = undefined;
  }

  // Materialized-summary probes. These read the SMALL atomic roll-up files the
  // recorders maintain without a running daemon (scoreboard / memory / tests /
  // attention / mcp). Each is independently budget-gated and try/catch isolated
  // so a single bad file never aborts the others — the renderer omits any row
  // whose probe returned undefined (OMIT > FAKE).
  const paths = statuslinePaths(projectRoot);

  let scoreboard: ScoreboardSummary | undefined;
  try {
    if (remainingBudget() > 0) {
      scoreboard = await probeScoreboard(paths.scoreboardCurrent);
    }
  } catch {
    scoreboard = undefined;
  }

  let memory: MemorySummary | undefined;
  try {
    if (remainingBudget() > 0) {
      memory = await probeMemory(paths.memoryStats);
    }
  } catch {
    memory = undefined;
  }

  let tests: TestsSummary | undefined;
  try {
    if (remainingBudget() > 0) {
      tests = await probeTests(paths.testsCurrent);
    }
  } catch {
    tests = undefined;
  }

  let attention: AttentionSummary | undefined;
  try {
    if (remainingBudget() > 0) {
      attention = await probeAttention(paths.attentionCurrent);
    }
  } catch {
    attention = undefined;
  }

  let mcp: McpSummary | undefined;
  try {
    if (remainingBudget() > 0) {
      mcp = await probeMcp(paths.mcpHealth);
    }
  } catch {
    mcp = undefined;
  }

  // Assemble. Any field that the probe declined to populate stays undefined
  // so the renderer's "omit unavailable data" rule (runbook NN-Req #1) holds.
  //
  // `StatuslineSnapshotV1` declares identity fields (`projectRoot`,
  // `worktreeRoot`, `displayName`, `generatedAt`) as readonly. We can't
  // assign them post-construction on a `Partial<...>` view, so we build the
  // object literal in one pass and conditionally include the probe-derived
  // fields via spread.
  //
  // Identity is ALWAYS present so the renderer has labels even when every
  // individual probe failed.
  return {
    projectRoot,
    displayName: basename(worktreeRoot),
    worktreeRoot,
    generatedAt: new Date(now()).toISOString(),
    ...(git !== undefined ? { git } : {}),
    ...(swarm !== undefined ? { swarm } : {}),
    ...(daemon !== undefined ? { daemon } : {}),
    ...(scoreboard !== undefined ? { scoreboard } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(tests !== undefined ? { tests } : {}),
    ...(attention !== undefined ? { attention } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
  };
}

// ---------------------------------------------------------------------------
// Git probe (multiple spawnSync calls — ROUND-4 BUG ξ HOTSPOT)
// ---------------------------------------------------------------------------

interface GitProbeContext {
  readonly cwd: string;
  readonly remaining: () => number;
}

/**
 * Probe the git working tree: branch, dirty counts, ahead/behind. Each
 * `spawnSync` invocation RECOMPUTES the remaining budget via the closure so
 * a stale-budget regression (round-4 bug ξ) cannot occur.
 *
 * Returns `undefined` when:
 *   - the working directory is not in a git repo (`git rev-parse` fails)
 *   - the remaining budget is too small for any individual probe
 *   - every spawn returns no useful data
 */
function probeGit(cwd: string, remaining: () => number): GitSummary | undefined {
  const ctx: GitProbeContext = { cwd, remaining };

  // 1) Branch — `git rev-parse --abbrev-ref HEAD` is the single canonical
  // branch resolver; works for both regular HEAD and detached HEAD (returns
  // "HEAD"). Argv array only — never a shell string.
  const branch = spawnGit(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // If branch failed AND we're out of budget, there's nothing more to do.
  if (branch === undefined && remaining() <= MIN_BUDGET_FOR_SPAWN_MS) {
    return undefined;
  }

  // 2) Status — counts staged / modified / untracked. RECOMPUTED remaining
  // budget at this exact point (round-4 bug ξ regression site).
  const statusOut = spawnGit(ctx, ['status', '--porcelain']);

  let staged = 0;
  let modified = 0;
  let untracked = 0;
  if (statusOut !== undefined) {
    for (const line of statusOut.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith('??')) {
        untracked++;
        continue;
      }
      // Staged: index column is non-space; Modified: worktree column is non-space.
      // We classify both independently so an MM line counts as both staged and
      // modified — accurate for the renderer's per-cell display.
      if (line[0] && line[0] !== ' ' && line[0] !== '?') staged++;
      if (line[1] && line[1] !== ' ' && line[1] !== '?') modified++;
    }
  }

  // 3) Ahead/behind — `git rev-list --count HEAD..@{upstream}` for behind
  // (commits we don't have) and reverse for ahead. We compute both in one
  // shot via `--left-right` so it costs ONE spawn instead of two.
  let ahead: number | undefined;
  let behind: number | undefined;
  const counts = spawnGit(ctx, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts !== undefined) {
    const parts = counts.split(/\s+/).filter(Boolean);
    if (parts.length === 2) {
      const b = Number(parts[0]);
      const a = Number(parts[1]);
      if (Number.isFinite(b) && b >= 0) behind = b;
      if (Number.isFinite(a) && a >= 0) ahead = a;
    }
  }

  // Build the summary. Only include fields we actually resolved.
  const summary: GitSummary = {};
  const branchTrimmed = branch?.trim();
  if (branchTrimmed && branchTrimmed.length > 0) {
    summary.branch = branchTrimmed;
  }
  if (statusOut !== undefined) {
    summary.staged = staged;
    summary.modified = modified;
    summary.untracked = untracked;
  }
  if (ahead !== undefined) summary.ahead = ahead;
  if (behind !== undefined) summary.behind = behind;

  // Empty summary → not in a git repo, or every spawn failed. Return undefined
  // so the renderer omits the row entirely.
  if (
    summary.branch === undefined &&
    summary.staged === undefined &&
    summary.ahead === undefined &&
    summary.behind === undefined
  ) {
    return undefined;
  }
  return summary;
}

/**
 * Spawn a single `git` argv. Returns trimmed stdout on success, `undefined`
 * for every other outcome (failed exit, signal, ENOENT, timeout, empty
 * output, budget exhausted).
 *
 * ROUND-4 BUG ξ NOTE: The `timeout` value is freshly computed from
 * `ctx.remaining()` at THIS call site. Callers MUST NOT cache the remaining
 * value across multiple invocations.
 */
function spawnGit(ctx: GitProbeContext, args: ReadonlyArray<string>): string | undefined {
  const budget = ctx.remaining();
  if (budget < MIN_BUDGET_FOR_SPAWN_MS) {
    // Bail before the spawn. A <25ms timeout is more likely to land in the
    // kill window than to return useful output, and pinning a process for
    // a few ms still costs us fork+exec overhead.
    return undefined;
  }
  const timeout = Math.min(budget, PER_SPAWN_CAP_MS);
  let result;
  try {
    result = spawnSync('git', [...args], {
      cwd: ctx.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true,
      // NOTE: `shell: true` is FORBIDDEN here (Phase 5 binding + Wave 8 risk).
      // The argv array form is the only safe surface — it never spawns a shell.
    });
  } catch {
    return undefined;
  }
  if (result.error) return undefined;
  if (result.signal) return undefined; // killed by timeout
  if (result.status !== 0) return undefined;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return stdout.length > 0 ? stdout : undefined;
}

// ---------------------------------------------------------------------------
// Swarm probe (bounded read of .hive-flow/agents/store.json)
// ---------------------------------------------------------------------------

interface RawStoreShape {
  agents?: unknown;
}

interface RawAgentRecord {
  agentId?: unknown;
  agentType?: unknown;
  type?: unknown;
  role?: unknown;
  status?: unknown;
  provider?: unknown;
  model?: unknown;
  resolvedModel?: unknown;
  ownerSessionId?: unknown;
}

/**
 * Bounded read of the agent store. Reuses `readJsonFile` (symlink-safe,
 * byte-bounded) and `normalizeAgentStatus` (canonical Wave 1 normalizer).
 * Drops terminal statuses from live counts.
 *
 * Returns `undefined` when the store is missing / symlinked / oversize /
 * corrupt — the renderer omits the swarm row in those cases.
 */
async function probeSwarm(projectRoot: string, sessionId?: string): Promise<SwarmSummary | undefined> {
  const storePath = join(projectRoot, '.hive-flow', 'agents', 'store.json');
  const [raw, activeHives] = await Promise.all([
    readJsonFile<RawStoreShape>(storePath, MAX_INLINE_JSON_BYTES).catch(
      () => undefined,
    ),
    collectActiveHiveOwnership(projectRoot).catch(() => undefined),
  ]);
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;

  // Extract records: dict shape (canonical) OR array shape (legacy). Drop
  // null / non-object members so a corrupt slot can't propagate.
  const records: RawAgentRecord[] = [];
  const pushIf = (value: unknown): void => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      records.push(value as RawAgentRecord);
    }
  };
  const agentsField = (raw as RawStoreShape).agents;
  if (Array.isArray(agentsField)) {
    for (const item of agentsField) pushIf(item);
  } else if (agentsField && typeof agentsField === 'object') {
    for (const item of Object.values(agentsField as Record<string, unknown>)) {
      pushIf(item);
    }
  }

  if (records.length === 0) return undefined;

  // Build normalized rows. Terminal statuses → `undefined` and are dropped.
  let activeAgents = 0;
  let idleAgents = 0;
  let queuedAgents = 0;
  let activeQueens = 0;
  let executingQueens = 0;
  const rows: NormalizedAgentRow[] = [];

  for (const rec of records) {
    if (sessionId !== undefined && rec.ownerSessionId !== sessionId) continue;
    const rawStatus = typeof rec.status === 'string' ? rec.status : undefined;
    const status = normalizeAgentStatus(rawStatus);
    if (status === undefined) continue;
    const isQueen =
      (typeof rec.agentType === 'string' && rec.agentType.toLowerCase() === 'queen') ||
      (typeof rec.type === 'string' && rec.type.toLowerCase() === 'queen') ||
      (typeof rec.role === 'string' && rec.role.toLowerCase() === 'queen');

    const role = isQueen
      ? 'queen'
      : (typeof rec.agentType === 'string' && rec.agentType) ||
        (typeof rec.type === 'string' && rec.type) ||
        (typeof rec.role === 'string' && rec.role) ||
        'worker';

    const id =
      typeof rec.agentId === 'string' && rec.agentId.length > 0
        ? rec.agentId
        : `agent-${rows.length}`;

    const row: NormalizedAgentRow = { id, role, status };
    if (typeof rec.provider === 'string' && rec.provider.length > 0) {
      (row as { provider?: string }).provider = rec.provider;
    }
    if (typeof rec.resolvedModel === 'string' && rec.resolvedModel.length > 0) {
      (row as { model?: string }).model = rec.resolvedModel;
    } else if (typeof rec.model === 'string' && rec.model.length > 0) {
      (row as { model?: string }).model = rec.model;
    }
    rows.push(row);

    if (isQueen) {
      activeQueens++;
      if (status === 'busy') executingQueens++;
    } else {
      if (status === 'busy') activeAgents++;
      else if (status === 'idle' || status === 'stale') idleAgents++;
      else if (status === 'queued') queuedAgents++;
    }
  }

  return {
    activeAgents,
    idleAgents,
    queuedAgents,
    maxAgents: 50,
    activeQueens,
    executingQueens,
    agents: rows,
    ...(activeHives !== undefined ? { activeHives } : {}),
  };
}

// ---------------------------------------------------------------------------
// Daemon probe (bounded read of .hive-flow/daemon-state.json)
// ---------------------------------------------------------------------------

interface RawDaemonState {
  running?: unknown;
  startedAt?: unknown;
  pid?: unknown;
  health?: unknown;
}

/**
 * Bounded read of the daemon state file. Surfaces `running` (`'on'|'off'`)
 * and optional `pid`. Falls back to `'unknown'` when the state is absent
 * or unreadable.
 */
async function probeDaemon(
  projectRoot: string,
  now: () => number,
): Promise<DaemonSummary | undefined> {
  // The worker daemon (`services/worker-daemon.ts` `saveState()`) persists its
  // state to `<projectRoot>/.hive-flow/daemon-state.json` (the `.hive-flow`
  // root — NOT a `data/` subdir). The probe MUST read the producer's actual
  // path or the footer silently reports `daemon unknown` while a running
  // daemon exists. (Schema: `{ running: boolean, ... }`.)
  const statePath = join(projectRoot, '.hive-flow', 'daemon-state.json');
  const raw = await readJsonFile<RawDaemonState>(statePath, MAX_INLINE_JSON_BYTES).catch(
    () => undefined,
  );
  const observedAt = new Date(now()).toISOString();
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return {
      running: false,
      health: 'unknown',
      observedAt,
    };
  }
  const running = raw.running === true;
  const pid =
    typeof raw.pid === 'number' && Number.isFinite(raw.pid) && raw.pid > 0 ? raw.pid : undefined;
  const summary: DaemonSummary = {
    running,
    health: running ? 'healthy' : 'stopped',
    observedAt,
  };
  if (pid !== undefined) {
    (summary as { pid?: number }).pid = pid;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Materialized-summary probes (scoreboard / memory / tests / attention / mcp)
// ---------------------------------------------------------------------------
//
// The refresher materializes these compact roll-ups into `.hive-flow/<area>/`
// WITHOUT requiring a running daemon (the recorders write them on every
// scoreboard / test / attention event). The inline collector reads them so the
// scoreboard / memory / tests / attention / MCP rows populate even when no
// fresh `state/cache.json` exists. Each probe:
//   * uses the bounded, symlink-safe `readJsonFile` with the small-summary cap,
//   * validates the shape loosely (plain object) and returns the typed summary,
//   * returns `undefined` when the file is absent / unreadable / empty so the
//     renderer omits the row entirely (OMIT > FAKE).

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bounded read of `scoreboard/current.json` (`ScoreboardSummary`). Returns
 * `undefined` when no provider has any presence/calls, so the renderer omits
 * the scoreboard row rather than emitting a bare `🤖` label.
 */
async function probeScoreboard(path: string): Promise<ScoreboardSummary | undefined> {
  const raw = await readJsonFile<unknown>(path, MAX_INLINE_SUMMARY_BYTES).catch(() => undefined);
  if (!isPlainObject(raw)) return undefined;
  const agents = isPlainObject(raw.agentsByProvider) ? raw.agentsByProvider : {};
  const calls = isPlainObject(raw.callsByProvider) ? raw.callsByProvider : {};
  if (Object.keys(agents).length === 0 && Object.keys(calls).length === 0) return undefined;
  return {
    agentsByProvider: agents as ScoreboardSummary['agentsByProvider'],
    callsByProvider: calls as ScoreboardSummary['callsByProvider'],
    stale: raw.stale === true,
    ...(typeof raw.lastUpdatedAt === 'string' ? { lastUpdatedAt: raw.lastUpdatedAt } : {}),
  };
}

/**
 * Bounded read of `memory/stats.json` (`MemorySummary`). Returns `undefined`
 * when none of embeddings / memories / dbSize carries data, so the renderer
 * omits the memory row (unless tests/MCP populate it separately upstream).
 */
export async function probeMemory(path: string): Promise<MemorySummary | undefined> {
  const raw = await readJsonFile<unknown>(path, MAX_INLINE_SUMMARY_BYTES).catch(() => undefined);
  if (!isPlainObject(raw)) return undefined;
  const out: MemorySummary = {
    sourceDescription:
      typeof raw.sourceDescription === 'string' ? raw.sourceDescription : 'inline',
  };
  if (isPlainObject(raw.embeddings) && typeof raw.embeddings.count === 'number') {
    out.embeddings = raw.embeddings as unknown as MemorySummary['embeddings'];
  }
  if (isPlainObject(raw.memories) && typeof raw.memories.count === 'number') {
    out.memories = raw.memories as unknown as MemorySummary['memories'];
  }
  if (typeof raw.dbSizeBytes === 'number' && Number.isFinite(raw.dbSizeBytes)) {
    out.dbSizeBytes = raw.dbSizeBytes;
  }
  if (out.embeddings === undefined && out.memories === undefined && out.dbSizeBytes === undefined) {
    return undefined;
  }
  return out;
}

/**
 * Bounded read of `tests/current.json` (`TestsSummary`). Returns `undefined`
 * when no canonical suite record is present (the renderer's tests cell gates on
 * `suite`), so a partial-only file does not surface a bare cell.
 */
async function probeTests(path: string): Promise<TestsSummary | undefined> {
  const raw = await readJsonFile<unknown>(path, MAX_INLINE_SUMMARY_BYTES).catch(() => undefined);
  if (!isPlainObject(raw)) return undefined;
  const out: TestsSummary = {};
  if (isPlainObject(raw.suite) && typeof raw.suite.total === 'number') {
    out.suite = raw.suite as unknown as TestsSummary['suite'];
  }
  if (isPlainObject(raw.latestPartial)) {
    out.latestPartial = raw.latestPartial as unknown as TestsSummary['latestPartial'];
  }
  if (out.suite === undefined && out.latestPartial === undefined) return undefined;
  return out;
}

/**
 * Bounded read of `attention/current.json` (`AttentionSummary`). Returns
 * `undefined` when there are no unresolved entries so the renderer omits the
 * attention row (OMIT > FAKE — never an empty `📌` label).
 */
async function probeAttention(path: string): Promise<AttentionSummary | undefined> {
  const raw = await readJsonFile<unknown>(path, MAX_INLINE_SUMMARY_BYTES).catch(() => undefined);
  if (!isPlainObject(raw)) return undefined;
  const unresolved = Array.isArray(raw.unresolved) ? raw.unresolved : [];
  if (unresolved.length === 0) return undefined;
  return { unresolved: unresolved as AttentionSummary['unresolved'] };
}

/**
 * Bounded read of `mcp/health.json` (`McpSummary`). Returns `undefined` when
 * no MCP servers are configured (`total <= 0`) so the renderer omits the MCP
 * cell rather than rendering `MCP 0/0`.
 */
export async function probeMcp(path: string): Promise<McpSummary | undefined> {
  const raw = await readJsonFile<unknown>(path, MAX_INLINE_SUMMARY_BYTES).catch(() => undefined);
  if (!isPlainObject(raw)) return undefined;
  const total = typeof raw.total === 'number' ? raw.total : 0;
  if (!Number.isFinite(total) || total <= 0) return undefined;
  const configured = typeof raw.configured === 'number' ? raw.configured : 0;
  const runtimeUp = typeof raw.runtimeUp === 'number' ? raw.runtimeUp : 0;
  return {
    version: 1,
    observedAt: typeof raw.observedAt === 'string' ? raw.observedAt : new Date().toISOString(),
    probeVersion: 1,
    source: 'setup-verify-json-rpc',
    total,
    configured,
    runtimeUp,
    state: typeof raw.state === 'string' ? (raw.state as McpSummary['state']) : 'config-present',
    ...(Array.isArray(raw.details) ? { details: raw.details as McpSummary['details'] } : {}),
  };
}
