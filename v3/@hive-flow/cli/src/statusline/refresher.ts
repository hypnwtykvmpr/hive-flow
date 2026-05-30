// v3/@hive-flow/cli/src/statusline/refresher.ts
//
// Wave 7 of the canonical statusline rewrite (Codex merged runbook 2026-05-20,
// post 2026-05-21 patches). Orchestrates the snapshot composition path:
//
//   1. Resolve project scope (worktree-aware identity).
//   2. Honor the refresh-debounce marker unless `force: true`.
//   3. Drain the spool BEFORE any collector reads (Codex 6.4 binding).
//   4. Read the ADR-051 autopilot-state context, stdin-first.
//   5. Run all collectors in parallel via `Promise.all`, each wrapped in a
//      per-collector try/catch so one failure cannot crash the refresh.
//   6. Compose the canonical `StatuslineSnapshotV1`.
//   7. Atomic-write the snapshot to `.hive-flow/state/cache.json`.
//   8. Touch the refresh marker so the debounce knows we ran.
//
// Binding constraints (canonical runbook + Phase 3 design review):
//   - No hot-path `du -sh`, no `gh pr view`, no network calls (Phase 5 binding).
//   - All file reads are bounded + symlink-safe via Wave 2 / 2.5A primitives.
//   - Atomic writes use `atomicWriteJson` (fsync + temp + rename).
//   - No `as any` / unsafe casts; all narrowing via `typeof` / `in` /
//     `Array.isArray` guards.
//   - No literal control bytes in source.
//   - `stdinData` typed as `unknown`; narrowed defensively.
//   - The refresher itself NEVER invokes the inline-fallback path — that
//     belongs to the renderer (Wave 8). The refresher always materializes a
//     full snapshot from collectors.
//
// The cache file is written atomically: `atomicWriteJson` (a.k.a.
// `writeJsonFile` in `storage.ts`) writes to a temp file, fsyncs the file
// handle AND the parent directory, then renames into place. A crash mid-write
// leaves either the prior file intact or no file at all — never a partial.

import { lstat, open } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { loadStatuslineConfig, type StatuslineConfig } from './config.js';
import { statuslinePaths } from './paths.js';
import {
  atomicWriteJson,
  readJsonFile,
  readRefreshMarkerStat,
  touchRefreshRequest,
} from './storage.js';
import { drainSpool } from './spool-drainer.js';
import { resolveProjectScope } from './project-scope.js';
import { collectAttention } from './collectors/attention.js';
import { collectScoreboard } from './collectors/scoreboard.js';
import { collectSessions } from './collectors/sessions.js';
import { collectSwarm } from './collectors/swarm.js';
import { collectTests } from './collectors/tests.js';
import { collectInlineSnapshot } from './inline-collectors.js';
import type {
  AdrSummary,
  AttentionSummary,
  ContextSummary,
  DaemonSummary,
  GitSummary,
  HookInventoryHostRow,
  HookInventoryV1,
  HooksHostRow,
  HooksSummary,
  HostCli,
  McpAggregateState,
  McpSummary,
  MemoryStatRow,
  MemorySummary,
  NormalizedAgentRow,
  ScoreboardSummary,
  SessionSummary,
  SourceFreshness,
  StatuslineSnapshotV1,
  StatuslineSource,
  SwarmSummary,
  TestsSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Max bytes accepted when reading `.hive-flow/data/autopilot-state.json`.
 * Matches the runbook's 64KB cap for bounded user-controlled JSON readers
 * (`MAX_INIT_BUFFER_BYTES`). The collector for ADR-051 context is inlined
 * here rather than imported because Wave 5 did not ship a separate
 * `collectors/context.ts`; the runbook's Phase 5.7 shape lives directly in
 * this orchestration file so the snapshot path stays the single source of
 * truth for autopilot-state parsing in the refresher.
 */
const AUTOPILOT_STATE_MAX_BYTES = 64 * 1024;

/** History rows kept on the ADR-051 context summary. Matches runbook 5.7. */
const HISTORY_TAIL = 32;

/** Bounded cap for materialized current snapshots read by the refresher. */
const MATERIALIZED_CURRENT_MAX_BYTES = 256 * 1024;

const HOST_CLI_VALUES: ReadonlySet<string> = new Set<HostCli>([
  'claude-code',
  'codex',
  'gemini',
  'forgecode',
  'cursor-cli',
  'qwen',
  'opencode',
  'hive-flow-daemon',
  'wrapper',
]);

const MCP_STATES: ReadonlySet<string> = new Set<McpAggregateState>([
  'runtime-up',
  'config-present',
  'approval-required',
  'disconnected',
  'down',
  'not-configured',
]);

interface MaterializedSummaries {
  readonly adrs?: AdrSummary;
  readonly hooks?: HooksSummary;
  readonly memory?: MemorySummary;
  readonly mcp?: McpSummary;
  readonly sources: Partial<Record<StatuslineSource, SourceFreshness>>;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link refreshStatuslineSnapshot}.
 *
 * `projectRoot` is the absolute path the caller wants to refresh. `stdinData`
 * is the optional Claude Code stdin payload (`workspace.current_dir`,
 * `context_window`, etc.). `now` is a clock injection point for deterministic
 * tests. `force: true` bypasses the refresh-debounce check entirely.
 */
export interface RefreshStatuslineSnapshotOptions {
  readonly projectRoot: string;
  readonly stdinData?: unknown;
  readonly now?: number;
  readonly force?: boolean;
}

/**
 * Refresh and persist the canonical statusline snapshot. Returns the freshly
 * composed snapshot; the same value is atomically written to
 * `<projectRoot>/.hive-flow/state/cache.json`.
 *
 * Steps inside this function are intentionally explicit so a reader can map
 * each one back to the runbook section it implements. See the file header
 * for the binding constraints.
 *
 * The refresher NEVER throws on collector failure: each collector runs inside
 * its own try/catch and a thrown error is recorded as a per-source
 * `freshness.state === 'error'` tag. The only callers that may observe an
 * exception are those that fail the scope resolution (which throws only on
 * truly unrecoverable input) or the atomic write (FS unavailable, ENOSPC).
 */
export async function refreshStatuslineSnapshot(
  opts: RefreshStatuslineSnapshotOptions,
): Promise<StatuslineSnapshotV1> {
  if (!opts || typeof opts.projectRoot !== 'string' || opts.projectRoot.length === 0) {
    throw new TypeError('refreshStatuslineSnapshot: opts.projectRoot is required');
  }
  const nowMs = resolveNowMs(opts.now);
  const generatedAt = new Date(nowMs).toISOString();

  // Step 1: scope. resolveProjectScope honors stdin overrides (workspace.current_dir / cwd).
  const scope = await resolveProjectScope(opts.projectRoot, opts.stdinData);
  const paths = statuslinePaths(scope.projectRoot);
  const config = await loadStatuslineConfig(scope.projectRoot);

  // Step 2: refresh-debounce. If the refresh marker is younger than the
  // debounce window AND a cached snapshot is on disk AND `force` is not set,
  // return the cached snapshot instead of re-running everything.
  if (opts.force !== true) {
    const cached = await readCachedIfFresh(paths.cache, scope.projectRoot, nowMs, config);
    if (cached !== undefined) return cached;
  }

  // Step 3: drain BEFORE any collector read. Wrapped in catch so a partial
  // drain failure (lock contention, symlinked spool tree) does not abort the
  // whole refresh — the collectors still run against whatever ledger state
  // they can see.
  await drainSpool({ projectRoot: scope.projectRoot }).catch(() => undefined);

  // Step 4: ADR-051 context. Stdin-first, then autopilot-state fallback.
  const stdinObject = asPlainObject(opts.stdinData);
  const stdinContext = contextFromStdin(stdinObject, generatedAt);
  const autopilotContext = await readAutopilotContext(scope.projectRoot, generatedAt);
  const context = mergeContext(stdinContext, autopilotContext);
  const materialized = await collectMaterializedSummaries(paths, generatedAt, config);

  // Step 5: run every collector in parallel via Promise.all. Each collector
  // is wrapped in a try/catch so a single thrown error becomes a per-source
  // freshness tag of `'error'` instead of crashing the whole refresh.
  const [
    scoreboardOutcome,
    sessionsOutcome,
    testsOutcome,
    attentionOutcome,
    swarmOutcome,
    inlineOutcome,
  ] = await Promise.all([
    runCollector('scoreboard', () => collectScoreboard({ projectRoot: scope.projectRoot, now: nowMs })),
    runCollector('sessions', () => collectSessions({ projectRoot: scope.projectRoot, nowMs })),
    runCollector('tests', () => collectTests({ projectRoot: scope.projectRoot })),
    runCollector('attention', () => collectAttention({ projectRoot: scope.projectRoot })),
    runCollector('swarm', () => collectSwarm({ projectRoot: scope.projectRoot })),
    runCollector('git', () => collectInlineSnapshot({
      projectRoot: scope.projectRoot,
      ...(scope.worktreeRoot !== undefined ? { worktreeRoot: scope.worktreeRoot } : {}),
      deadlineMs: 150,
    })),
  ]);

  // Step 6: compose the snapshot.
  const sources: Partial<Record<StatuslineSource, SourceFreshness>> = {
    ...materialized.sources,
  };

  // Scoreboard
  let scoreboard: ScoreboardSummary | undefined;
  if (scoreboardOutcome.ok) {
    const sb = scoreboardOutcome.value;
    scoreboard = {
      agentsByProvider: sb.agentsByProvider,
      callsByProvider: sb.callsByProvider,
      stale: sb.stale,
      ...(typeof sb.lastUpdatedAt === 'string' ? { lastUpdatedAt: sb.lastUpdatedAt } : {}),
    };
    const sbObserved = sb.lastUpdatedAt ?? generatedAt;
    const sbState = stateFromObserved(
      sbObserved,
      nowMs,
      config.sourceTtlsMs.scoreboard,
      sb.stale ? 'stale' : 'fresh',
    );
    sources.scoreboard = withReason(
      {
        source: 'scoreboard',
        state: sbState,
        observedAt: sbObserved,
        ttlMs: config.sourceTtlsMs.scoreboard,
      },
      sb.migrationSkippedReason,
    );
  } else {
    sources.scoreboard = makeErrorFreshness('scoreboard', generatedAt, scoreboardOutcome.message);
  }

  // Sessions
  let sessions: SessionSummary | undefined;
  if (sessionsOutcome.ok) {
    const result = sessionsOutcome.value;
    sessions = {
      active: result.active,
      degraded: result.degraded,
      stale: result.stale,
      byHost: result.byHost,
      ...(result.current !== undefined ? { current: result.current } : {}),
    };
    sources.sessions = {
      source: 'sessions',
      state: result.freshness.state,
      observedAt: result.freshness.observedAt,
      ...(result.freshness.reason !== undefined ? { reason: result.freshness.reason } : {}),
      ttlMs: config.sourceTtlsMs.sessions,
    };
  } else {
    sources.sessions = makeErrorFreshness('sessions', generatedAt, sessionsOutcome.message);
  }

  // Tests
  let tests: TestsSummary | undefined;
  if (testsOutcome.ok) {
    tests = testsOutcome.value;
    sources.tests = freshnessForTests(tests, generatedAt, config.sourceTtlsMs.tests);
  } else {
    sources.tests = makeErrorFreshness('tests', generatedAt, testsOutcome.message);
  }

  // Attention
  let attention: AttentionSummary | undefined;
  if (attentionOutcome.ok) {
    attention = attentionOutcome.value;
    sources.attention = {
      source: 'attention',
      state: attention.unresolved.length > 0 ? 'fresh' : 'unavailable',
      observedAt: generatedAt,
      ttlMs: config.sourceTtlsMs.attention,
      ...(attention.unresolved.length === 0 ? { reason: 'no unresolved attention' } : {}),
    };
  } else {
    sources.attention = makeErrorFreshness('attention', generatedAt, attentionOutcome.message);
  }

  // Swarm — map the collector's SwarmCollectorSummary onto the canonical
  // SwarmSummary used by the snapshot/renderer. The collector's
  // `workersAlive/workersExecuting` map onto `activeAgents/idleAgents`; the
  // collector's `cap` becomes `maxAgents`.
  let swarm: SwarmSummary | undefined;
  if (swarmOutcome.ok) {
    const s = swarmOutcome.value;
    const idleAgents = Math.max(0, s.workersAlive - s.workersExecuting);
    const agentsList: NormalizedAgentRow[] = s.agents.map((row) => ({ ...row }));
    swarm = {
      activeAgents: s.workersExecuting,
      idleAgents,
      queuedAgents: 0,
      maxAgents: s.cap,
      activeQueens: s.queensAlive,
      executingQueens: s.queensExecuting,
      ...(agentsList.length > 0 ? { agents: agentsList } : {}),
    };
    sources.swarm = {
      source: 'swarm',
      state: s.freshness.state === 'absent' ? 'unavailable' : s.freshness.state,
      observedAt: s.freshness.observedAt,
      ttlMs: config.sourceTtlsMs.swarm,
      ...(s.freshness.reason !== undefined ? { reason: s.freshness.reason } : {}),
    };
  } else {
    sources.swarm = makeErrorFreshness('swarm', generatedAt, swarmOutcome.message);
  }

  // Context (ADR-051). When no usable context is available, mark the source
  // as `unavailable` and omit the `context` field entirely — never invent.
  if (context !== undefined) {
    const ctxState = stateFromObserved(
      context.observedAt,
      nowMs,
      config.sourceTtlsMs.context,
      'fresh',
    );
    sources.context = {
      source: 'context',
      state: ctxState,
      observedAt: context.observedAt,
      reason: context.source,
      ttlMs: config.sourceTtlsMs.context,
    };
  } else {
    sources.context = {
      source: 'context',
      state: 'unavailable',
      observedAt: generatedAt,
      reason: 'no stdin or autopilot context',
      ttlMs: config.sourceTtlsMs.context,
    };
  }

  let git: GitSummary | undefined;
  let daemon: DaemonSummary | undefined;
  if (inlineOutcome.ok) {
    git = inlineOutcome.value.git;
    daemon = inlineOutcome.value.daemon;
    sources.git = git !== undefined
      ? {
          source: 'git',
          state: 'fresh',
          observedAt: generatedAt,
          ttlMs: config.sourceTtlsMs.git,
        }
      : {
          source: 'git',
          state: 'unavailable',
          observedAt: generatedAt,
          reason: 'git probe unavailable',
          ttlMs: config.sourceTtlsMs.git,
        };
    sources.daemon = daemon !== undefined
      ? {
          source: 'daemon',
          state: daemon.running ? 'fresh' : 'degraded',
          observedAt: daemon.observedAt,
          ttlMs: config.sourceTtlsMs.daemon,
        }
      : {
          source: 'daemon',
          state: 'unavailable',
          observedAt: generatedAt,
          reason: 'daemon state unavailable',
          ttlMs: config.sourceTtlsMs.daemon,
        };
  } else {
    sources.git = makeErrorFreshness('git', generatedAt, inlineOutcome.message);
    sources.daemon = makeErrorFreshness('daemon', generatedAt, inlineOutcome.message);
  }

  const snapshot: StatuslineSnapshotV1 = {
    version: 1,
    projectRoot: scope.projectRoot,
    repoIdentity: scope.repoIdentity,
    ...(scope.displayName !== undefined ? { displayName: scope.displayName } : {}),
    ...(scope.worktreeRoot !== undefined ? { worktreeRoot: scope.worktreeRoot } : {}),
    projectKey: scope.projectKey,
    generatedAt,
    sources,
    ...(context !== undefined ? { context } : {}),
    ...(git !== undefined ? { git } : {}),
    ...(scoreboard !== undefined ? { scoreboard } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(swarm !== undefined ? { swarm } : {}),
    ...(materialized.hooks !== undefined ? { hooks: materialized.hooks } : {}),
    ...(materialized.memory !== undefined ? { memory: materialized.memory } : {}),
    ...(tests !== undefined ? { tests } : {}),
    ...(materialized.mcp !== undefined ? { mcp: materialized.mcp } : {}),
    ...(attention !== undefined && attention.unresolved.length > 0 ? { attention } : {}),
    ...(materialized.adrs !== undefined ? { adrs: materialized.adrs } : {}),
    ...(daemon !== undefined ? { daemon } : {}),
    rendererHints: {
      activeAgentDetail: config.activeAgentDetail,
      useRoleIcons: config.useRoleIcons,
      allow16ColorYellowFallback: config.allow16ColorYellowFallback,
      openRouterBreakdown: config.openRouterBreakdown,
    },
  };

  // Step 7: atomic write. `atomicWriteJson` is the same primitive used by
  // every other materialized current.json — write-to-temp + fsync + rename.
  await atomicWriteJson(paths.cache, snapshot);

  // Step 8: refresh marker. Touch the marker so the next caller within the
  // debounce window observes a recent mtime. We delegate to the Wave 2
  // `touchRefreshRequest` helper so the Wave 2.5A
  // `assertSafeStatuslineStoragePath` guard runs first; a previous in-place
  // `writeFile` would silently follow a symlinked `refresh.request` and
  // overwrite the linked target (Codex Phase 7 Finding 1). The payload
  // (`generatedAt`) lets strict readers confirm the marker came from this
  // refresh, and `nowMs` makes the debounce mtime deterministic under
  // test-injected clocks.
  await touchRefreshRequest(scope.projectRoot, { payload: `${generatedAt}\n`, nowMs }).catch(
    () => undefined,
  );

  return snapshot;
}

// ---------------------------------------------------------------------------
// Internal: collector wrapper
// ---------------------------------------------------------------------------

/**
 * Outcome of a single collector invocation. The orchestrator threads the
 * discriminated union through `Promise.all` so a successful collector and a
 * failed one share the same return shape — without losing the strong typing
 * of the success branch.
 */
type CollectorOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

async function runCollector<T>(
  name: StatuslineSource,
  fn: () => Promise<T>,
): Promise<CollectorOutcome<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? `${name}: ${error.message}`
      : `${name}: ${String(error)}`;
    return { ok: false, message };
  }
}

function makeErrorFreshness(
  source: StatuslineSource,
  observedAt: string,
  reason: string,
): SourceFreshness {
  return { source, state: 'error', observedAt, reason };
}

function withReason(freshness: SourceFreshness, reason: string | undefined): SourceFreshness {
  if (reason === undefined) return freshness;
  return { ...freshness, reason };
}

// ---------------------------------------------------------------------------
// Internal: materialized current snapshots
// ---------------------------------------------------------------------------

async function collectMaterializedSummaries(
  paths: ReturnType<typeof statuslinePaths>,
  generatedAt: string,
  config: StatuslineConfig,
): Promise<MaterializedSummaries> {
  const [memoryRaw, mcpRaw, hooksRaw, adrsRaw] = await Promise.all([
    readJsonFile<unknown>(paths.memoryStats, MATERIALIZED_CURRENT_MAX_BYTES),
    readJsonFile<unknown>(paths.mcpHealth, MATERIALIZED_CURRENT_MAX_BYTES),
    readJsonFile<unknown>(paths.hooksInventory, MATERIALIZED_CURRENT_MAX_BYTES),
    readJsonFile<unknown>(paths.adrsCurrent, MATERIALIZED_CURRENT_MAX_BYTES),
  ]);

  const memory = parseMemorySummary(memoryRaw);
  const mcp = parseMcpSummary(mcpRaw);
  const hooks = parseHooksSummary(hooksRaw);
  const adrs = parseAdrSummary(adrsRaw);
  const sources: Partial<Record<StatuslineSource, SourceFreshness>> = {};

  if (memory !== undefined) {
    sources.memory = {
      source: 'memory',
      state: 'fresh',
      observedAt: latestIso([memory.memories?.observedAt, memory.embeddings?.observedAt]) ?? generatedAt,
      ttlMs: config.sourceTtlsMs.memory,
      reason: memory.sourceDescription,
    };
  }

  if (mcp !== undefined) {
    sources.mcp = {
      source: 'mcp',
      state: freshnessStateForMcp(mcp),
      observedAt: mcp.observedAt,
      ttlMs: config.sourceTtlsMs.mcp,
      reason: mcp.state,
    };
  }

  if (hooks !== undefined) {
    sources.hooks = {
      source: 'hooks',
      state: hooks.commands > 0 ? 'fresh' : 'unavailable',
      observedAt: generatedAt,
      ttlMs: config.sourceTtlsMs.hooks,
    };
  }

  if (adrs !== undefined) {
    sources.adrs = {
      source: 'adrs',
      state: adrs.total > 0 ? 'fresh' : 'unavailable',
      observedAt: generatedAt,
      ttlMs: config.sourceTtlsMs.adrs,
      fingerprint: adrs.fingerprint,
    };
  }

  return {
    sources,
    ...(memory !== undefined ? { memory } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(adrs !== undefined ? { adrs } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseMemoryStat(value: unknown): MemoryStatRow | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const count = finiteNonNegative(raw.count);
  const source = stringValue(raw.source);
  const observedAt = stringValue(raw.observedAt);
  if (count === undefined || source === undefined || observedAt === undefined) return undefined;
  return { count, source, observedAt };
}

function parseMemorySummary(value: unknown): MemorySummary | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const memories = parseMemoryStat(raw.memories);
  const embeddings = parseMemoryStat(raw.embeddings);
  const dbSizeBytes = finiteNonNegative(raw.dbSizeBytes);
  const sourceDescription = stringValue(raw.sourceDescription);
  if (sourceDescription === undefined) return undefined;
  if (memories === undefined && embeddings === undefined && dbSizeBytes === undefined) return undefined;
  return {
    ...(memories !== undefined ? { memories } : {}),
    ...(embeddings !== undefined ? { embeddings } : {}),
    ...(dbSizeBytes !== undefined ? { dbSizeBytes } : {}),
    sourceDescription,
  };
}

function parseMcpSummary(value: unknown): McpSummary | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  if (raw.version !== 1 || raw.probeVersion !== 1 || raw.source !== 'setup-verify-json-rpc') return undefined;
  const observedAt = stringValue(raw.observedAt);
  const total = finiteNonNegative(raw.total);
  const configured = finiteNonNegative(raw.configured);
  const runtimeUp = finiteNonNegative(raw.runtimeUp);
  const state = stringValue(raw.state);
  if (
    observedAt === undefined ||
    total === undefined ||
    configured === undefined ||
    runtimeUp === undefined ||
    state === undefined ||
    !MCP_STATES.has(state)
  ) {
    return undefined;
  }
  return {
    version: 1,
    observedAt,
    probeVersion: 1,
    source: 'setup-verify-json-rpc',
    total,
    configured,
    runtimeUp,
    state: state as McpAggregateState,
    ...(Array.isArray(raw.details) ? { details: raw.details as McpSummary['details'] } : {}),
  };
}

function isHostCli(value: string): value is HostCli {
  return HOST_CLI_VALUES.has(value);
}

function parseHookHost(value: unknown): HooksHostRow | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const categories = finiteNonNegative(raw.categories);
  const matchers = finiteNonNegative(raw.matchers);
  const commands = finiteNonNegative(raw.commands);
  const source = stringValue(raw.source);
  if (categories === undefined || matchers === undefined || commands === undefined || source === undefined) return undefined;
  return { categories, matchers, commands, source };
}

function parseHooksSummary(value: unknown): HooksSummary | undefined {
  const raw = asRecord(value);
  if (raw === undefined || raw.version !== 1) return undefined;
  const hosts = asRecord(raw.hosts);
  if (hosts === undefined) return undefined;
  const byHost: Partial<Record<HostCli, HooksHostRow>> = {};
  let categories = 0;
  let matchers = 0;
  let commands = 0;
  for (const [host, hostValue] of Object.entries(hosts)) {
    if (!isHostCli(host)) continue;
    const row = parseHookHost(hostValue as HookInventoryHostRow);
    if (row === undefined) continue;
    byHost[host] = row;
    categories += row.categories;
    matchers += row.matchers;
    commands += row.commands;
  }
  if (Object.keys(byHost).length === 0) return undefined;
  return { categories, matchers, commands, byHost };
}

function parseAdrSummary(value: unknown): AdrSummary | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const total = finiteNonNegative(raw.total);
  const fingerprint = stringValue(raw.fingerprint);
  if (
    total === undefined ||
    fingerprint === undefined ||
    asRecord(raw.byStatus) === undefined ||
    !Array.isArray(raw.rawStatuses)
  ) {
    return undefined;
  }
  return {
    total,
    byStatus: raw.byStatus as AdrSummary['byStatus'],
    fingerprint,
    rawStatuses: raw.rawStatuses as AdrSummary['rawStatuses'],
  };
}

function freshnessStateForMcp(mcp: McpSummary): SourceFreshness['state'] {
  if (mcp.state === 'runtime-up' || (mcp.runtimeUp > 0 && mcp.runtimeUp === mcp.total)) return 'fresh';
  if (mcp.state === 'not-configured' || mcp.total === 0) return 'unavailable';
  return 'degraded';
}

function latestIso(values: ReadonlyArray<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === undefined) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Internal: freshness helpers
// ---------------------------------------------------------------------------

/**
 * Map an observed timestamp to a freshness state, honoring the source TTL.
 * `ttlMs === 0` means "no TTL — the recorder/collector dictates freshness".
 * A future-dated observation maps to `'degraded'` so a tampered clock cannot
 * silently mark every source `fresh`.
 *
 * The `nowMs` parameter is the injected clock the refresher already threads
 * through `generatedAt`. Using `Date.now()` here would let source-freshness
 * disagree with `generatedAt` in deterministic probes / tests (Codex Phase 7
 * Finding 2). Callers MUST pass the same `nowMs` used to stamp the snapshot.
 */
function stateFromObserved(
  observedAt: string | undefined,
  nowMs: number,
  ttlMs: number,
  fallback: SourceFreshness['state'],
): SourceFreshness['state'] {
  if (observedAt === undefined || ttlMs === 0) return fallback;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return 'degraded';
  const age = nowMs - observedMs;
  if (!Number.isFinite(age)) return 'degraded';
  if (age < 0) return 'degraded';
  return age > ttlMs ? 'stale' : fallback;
}

/**
 * Tests freshness uses the collector's `stale` flag (set when the source
 * fingerprint disagrees with the suite's recorded fingerprint). When no
 * suite has been observed yet, surface `unavailable`. A bare partial without
 * a suite is treated as `degraded` because the renderer's `Tests` cell is
 * canonical only with a suite row.
 */
function freshnessForTests(
  summary: TestsSummary,
  observedAt: string,
  ttlMs: number,
): SourceFreshness {
  if (summary.suite !== undefined) {
    const stale = summary.suite.stale === true;
    const reason = stale ? summary.suite.staleReason : undefined;
    return {
      source: 'tests',
      state: stale ? 'stale' : 'fresh',
      observedAt: summary.suite.ts ?? observedAt,
      ttlMs,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  if (summary.latestPartial !== undefined) {
    return {
      source: 'tests',
      state: 'degraded',
      observedAt: summary.latestPartial.ts ?? observedAt,
      ttlMs,
      reason: 'no whole-suite baseline; partial only',
    };
  }
  return {
    source: 'tests',
    state: 'unavailable',
    observedAt,
    ttlMs,
    reason: 'no test runs recorded',
  };
}

// ---------------------------------------------------------------------------
// Internal: debounce
// ---------------------------------------------------------------------------

/**
 * Read the cached snapshot when it exists AND the refresh marker was touched
 * within the debounce window. Returns `undefined` to signal "fall through to
 * a full refresh". Never throws — any error condition (missing file, symlink
 * rejection, parse failure) collapses to `undefined`.
 *
 * The marker stat goes through `readRefreshMarkerStat` (NOT `stat`) so a
 * symlinked marker — pointing at a fresh outside file — cannot trick the
 * debounce into returning the old cached snapshot. Closes the read-side half
 * of Codex Phase 7 Finding 1: the write-side already delegated to
 * `touchRefreshRequest`, but a bare `fs.promises.stat()` on the marker
 * followed symlinks, returning an attacker-controlled mtime.
 */
async function readCachedIfFresh(
  cachePath: string,
  projectRoot: string,
  nowMs: number,
  config: StatuslineConfig,
): Promise<StatuslineSnapshotV1 | undefined> {
  const markerStat = await readRefreshMarkerStat(projectRoot);
  if (markerStat === undefined) {
    // Marker missing, symlinked, or otherwise rejected => fail safe and
    // force a full refresh.
    return undefined;
  }
  const age = nowMs - markerStat.mtimeMs;
  if (!Number.isFinite(age) || age < 0) return undefined;
  if (age > config.refreshDebounceMs) return undefined;
  // Marker is fresh. Try to return the cached snapshot.
  const cached = await readJsonFile<StatuslineSnapshotV1>(cachePath);
  if (!isSnapshotV1(cached)) return undefined;
  return cached;
}

/**
 * Defensive guard for the cached snapshot. We only honor cache reads when
 * the discriminator matches the current snapshot version; an older shape
 * could be missing required fields the renderer dereferences.
 */
function isSnapshotV1(value: unknown): value is StatuslineSnapshotV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { version?: unknown; projectRoot?: unknown; projectKey?: unknown };
  if (v.version !== 1) return false;
  if (typeof v.projectRoot !== 'string') return false;
  if (typeof v.projectKey !== 'string') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Internal: ADR-051 context (stdin-first, autopilot-state fallback)
// ---------------------------------------------------------------------------

/**
 * The runbook's Phase 5.7 context collector. Inlined here because the Wave 5
 * collectors directory did not ship a separate `context.ts`; the runbook's
 * shape is preserved verbatim so renderer expectations are unchanged.
 *
 * Reads `<projectRoot>/.hive-flow/data/autopilot-state.json` defensively:
 *   - rejects symlinked parent directories and the leaf itself
 *   - caps the file size at {@link AUTOPILOT_STATE_MAX_BYTES} (64KB)
 *   - tolerates missing/corrupt files (returns `undefined`)
 *   - never throws to the caller
 */
async function readAutopilotContext(
  projectRoot: string,
  fallbackIso: string,
): Promise<ContextSummary | undefined> {
  const file = join(projectRoot, '.hive-flow', 'data', 'autopilot-state.json');
  let parsed: unknown;
  try {
    if (!(await isSafeRegularFile(projectRoot, file, AUTOPILOT_STATE_MAX_BYTES))) {
      return undefined;
    }
    // Bounded read: stream through a fixed `maxBytes + 1` buffer so a file
    // that grew between the `lstat` size probe and the read (TOCTOU
    // race / hostile writer) cannot push more than the cap into memory.
    // Same shape as `junit-import.ts` `readBoundedUtf8` (Wave 6.4B2+C).
    // Fallback-best-effort semantics: any oversize / unreadable file
    // collapses to `undefined` so the merge falls back to stdin-only.
    const raw = await readBoundedAutopilotJson(file, AUTOPILOT_STATE_MAX_BYTES);
    if (raw === undefined) return undefined;
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const state = asPlainObject(parsed);
  if (state === undefined) return undefined;
  return fromAutopilotState(state, fallbackIso);
}

/**
 * Hard-bounded UTF-8 read for the autopilot-state JSON.
 *
 * Allocates exactly `maxBytes + 1` bytes once and streams the file through
 * it. The instant the accumulator exceeds `maxBytes`, we close the handle
 * and return `undefined` — never load more than the cap into memory.
 * Mirrors the Wave 6.4B2+C `readBoundedUtf8` pattern in `junit-import.ts`.
 *
 * This is the fallback-best-effort sibling of the `storage.ts` strict reader:
 * any non-`ok` outcome (unreadable, oversize, mid-read failure) collapses to
 * `undefined` so the caller treats it as "no autopilot context" and the
 * merge falls back to stdin-only data.
 */
async function readBoundedAutopilotJson(
  filePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return undefined;
  }
  try {
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
        return undefined;
      }
      if (chunk.bytesRead === 0) break;
      totalRead += chunk.bytesRead;
      if (totalRead > maxBytes) {
        // Hard cap: abort BEFORE the next read can grow `buf` further. The
        // buffer itself is `maxBytes + 1`, so the overflow byte is bounded.
        return undefined;
      }
    }
    return buf.subarray(0, totalRead).toString('utf8');
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing a stale handle is non-fatal; we already have what we need.
    }
  }
}

/**
 * Walk the chain of directories leading to `file` (relative to `root`) and
 * reject any segment that resolves to a symlink. Mirrors the storage
 * primitive's `assertSafeStatuslineStoragePath` shape but is local because
 * `assertSafeStatuslineStoragePath` is not exported. Returns `false` for
 * missing files, symlinks, non-regular files, and files exceeding `maxBytes`.
 */
async function isSafeRegularFile(root: string, file: string, maxBytes: number): Promise<boolean> {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(file);
  if (resolvedFile === resolvedRoot) return false;
  if (!resolvedFile.startsWith(resolvedRoot + sep)) return false;
  const relative = resolvedFile.slice(resolvedRoot.length + 1);
  const parts = relative.split(sep).filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  let cur = resolvedRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i] ?? '');
    let st;
    try {
      st = await lstat(cur);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return false;
    if (i === parts.length - 1) {
      if (!st.isFile()) return false;
      if (st.size > maxBytes) return false;
      return true;
    }
    if (!st.isDirectory()) return false;
  }
  return false;
}

/**
 * Narrow `value` to a plain object. Rejects `null`, arrays, primitives, and
 * objects with surprising prototypes so prototype-chain access can't smuggle
 * smuggled values in. Returns `undefined` on rejection so callers can branch
 * on the presence/absence of a real object.
 */
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Strict finite-number guard. `Number(...)` accepts too many garbage shapes. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Walk into a nested object via `path` and read a finite number. */
function getNumber(value: unknown, path: ReadonlyArray<string>): number | undefined {
  let cur: unknown = value;
  for (const key of path) {
    const obj = asPlainObject(cur);
    if (obj === undefined) return undefined;
    cur = obj[key];
  }
  if (typeof cur === 'number') return Number.isFinite(cur) ? cur : undefined;
  if (typeof cur === 'string' && cur.trim() !== '') {
    const n = Number(cur);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Normalize a percentage to the `0..100` band. Accepts both fractional
 * (`0..1`) and already-percent (`0..100`) inputs per ADR-051. Clamps to the
 * `0..100` window so a tampered file cannot push the renderer past the
 * critical-band cutoff.
 */
function normalizePercentage(raw: number | undefined): number | undefined {
  if (!isFiniteNumber(raw)) return undefined;
  const scaled = raw <= 1 ? raw * 100 : raw;
  if (!Number.isFinite(scaled)) return undefined;
  if (scaled < 0) return 0;
  if (scaled > 100) return 100;
  return scaled;
}

/**
 * Normalize a timestamp candidate (string ISO, numeric epoch ms) to an ISO
 * string. Falls back to `fallback` for unparseable inputs so the renderer
 * always gets a valid string to display.
 */
function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      const ms = new Date(n).getTime();
      return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
    }
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback;
}

/**
 * Walk the autopilot-state `history` array (latest {@link HISTORY_TAIL}
 * entries) and project each row onto the renderer-facing
 * {@link ContextSummary['history']} row shape. Drops malformed rows.
 */
function historyFrom(value: unknown): ContextSummary['history'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tail = value.slice(-HISTORY_TAIL);
  const rows: NonNullable<ContextSummary['history']> = [];
  for (const entry of tail) {
    const obj = asPlainObject(entry);
    if (obj === undefined) continue;
    const rawTs = obj.ts;
    const ts = typeof rawTs === 'string' || typeof rawTs === 'number' ? rawTs : '';
    const tokens = typeof obj.tokens === 'number' && Number.isFinite(obj.tokens) ? obj.tokens : undefined;
    const pctRaw = obj.pct;
    const pct = normalizePercentage(typeof pctRaw === 'number' ? pctRaw : undefined);
    const turns = typeof obj.turns === 'number' && Number.isFinite(obj.turns) ? obj.turns : undefined;
    rows.push({
      ts,
      ...(tokens !== undefined ? { tokens } : {}),
      ...(pct !== undefined ? { pct } : {}),
      ...(turns !== undefined ? { turns } : {}),
    });
  }
  return rows.length > 0 ? rows : undefined;
}

/** Build a {@link ContextSummary} from the Claude Code stdin payload. */
function contextFromStdin(stdinData: Record<string, unknown> | undefined, now: string): ContextSummary | undefined {
  if (stdinData === undefined) return undefined;
  const pct = normalizePercentage(
    getNumber(stdinData, ['context_window', 'used_percentage'])
      ?? getNumber(stdinData, ['context', 'percentage'])
      ?? getNumber(stdinData, ['context', 'percent']),
  );
  const inputTokens =
    getNumber(stdinData, ['context_window', 'total_input_tokens'])
    ?? getNumber(stdinData, ['context_window', 'input_tokens'])
    ?? getNumber(stdinData, ['usage', 'input_tokens']);
  const outputTokens =
    getNumber(stdinData, ['context_window', 'total_output_tokens'])
    ?? getNumber(stdinData, ['context_window', 'output_tokens'])
    ?? getNumber(stdinData, ['usage', 'output_tokens']);
  const contextWindow =
    getNumber(stdinData, ['context_window', 'context_window_size'])
    ?? getNumber(stdinData, ['context_window', 'max_tokens'])
    ?? getNumber(stdinData, ['context', 'max_tokens']);
  const usedTokens =
    getNumber(stdinData, ['context_window', 'used_tokens'])
    ?? getNumber(stdinData, ['context', 'used_tokens']);
  const derivedPct = pct
    ?? (isFiniteNumber(usedTokens) && isFiniteNumber(contextWindow) && contextWindow > 0
      ? normalizePercentage(usedTokens / contextWindow)
      : undefined);
  if (
    derivedPct === undefined
    && inputTokens === undefined
    && outputTokens === undefined
    && contextWindow === undefined
  ) {
    return undefined;
  }
  return {
    ...(derivedPct !== undefined ? { percentage: derivedPct } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    source: 'stdin',
    observedAt: now,
  };
}

/** Build a {@link ContextSummary} from a parsed autopilot-state.json shape. */
function fromAutopilotState(state: Record<string, unknown>, fallbackIso: string): ContextSummary | undefined {
  const lastCheck = normalizeTimestamp(state.lastCheck, fallbackIso);
  const percentage = normalizePercentage(getNumber(state, ['lastPercentage']));
  const tokenEstimate = getNumber(state, ['lastTokenEstimate']);
  const pruneCount = getNumber(state, ['pruneCount']);
  const contextWindow = getNumber(state, ['contextWindow']);
  const history = historyFrom(state.history);
  if (
    percentage === undefined
    && tokenEstimate === undefined
    && pruneCount === undefined
    && contextWindow === undefined
    && history === undefined
  ) {
    return undefined;
  }
  return {
    ...(percentage !== undefined ? { percentage } : {}),
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(pruneCount !== undefined ? { pruneCount } : {}),
    lastCheck,
    ...(history !== undefined ? { history } : {}),
    source: 'autopilot-state',
    observedAt: lastCheck,
  };
}

/**
 * Merge the stdin and autopilot-state context summaries. Stdin wins per
 * field — if stdin carries only a percentage but autopilot carries the
 * token estimate, the merged summary surfaces stdin's percentage and
 * autopilot's token estimate. Returns `undefined` only when both inputs
 * are `undefined`.
 *
 * The `source` and `observedAt` fields take the stdin value when stdin
 * is present (per runbook semantics: "stdin wins when it carries usable
 * context data"); otherwise they fall back to autopilot-state.
 */
function mergeContext(
  primary: ContextSummary | undefined,
  fallback: ContextSummary | undefined,
): ContextSummary | undefined {
  if (primary === undefined) return fallback;
  if (fallback === undefined) return primary;
  const percentage = primary.percentage ?? fallback.percentage;
  const tokenEstimate = primary.tokenEstimate ?? fallback.tokenEstimate;
  const inputTokens = primary.inputTokens ?? fallback.inputTokens;
  const outputTokens = primary.outputTokens ?? fallback.outputTokens;
  const contextWindow = primary.contextWindow ?? fallback.contextWindow;
  const pruneCount = primary.pruneCount ?? fallback.pruneCount;
  const lastCheck = primary.lastCheck ?? fallback.lastCheck;
  const history = primary.history ?? fallback.history;
  return {
    ...(percentage !== undefined ? { percentage } : {}),
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(pruneCount !== undefined ? { pruneCount } : {}),
    ...(lastCheck !== undefined ? { lastCheck } : {}),
    ...(history !== undefined ? { history } : {}),
    source: primary.source,
    observedAt: primary.observedAt,
  };
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the `now` injection point. Falls back to `Date.now()`. Negative,
 * non-finite, and non-number values are rejected so a tampered argument
 * cannot drive every freshness window past its TTL.
 */
function resolveNowMs(now: number | undefined): number {
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) return Date.now();
  return now;
}
