// v3/@hive-flow/cli/src/statusline/types.ts
//
// Wave 1 of the statusline rewrite. Typed contracts shared across recorders,
// collectors, the refresher, the renderer, command surfaces, and connectors.
//
// Binding constraints (see Phase 2 verifier, Phase 4 design verifier, and the
// patched merged runbook 2026-05-20):
//   - Use reader-side status normalization. Do NOT change MCP AgentRecord.status.
//   - Do NOT add a recent-task-timestamp field that the current AgentRecord
//     does not already expose (idleSince/createdAt/terminatedAt are the only
//     legitimate options today).
//   - Preserve the full ADR-051 autopilot-state shape inside `ContextSummary`.
//   - Bright yellow ANSI is forbidden across the renderer/palette/generator;
//     the structurally-constructed `FORBIDDEN_ANSI_BRIGHT_YELLOW` constant
//     below is the only allowed mention of that sequence.

// ---------------------------------------------------------------------------
// Host CLI / provider identity
// ---------------------------------------------------------------------------

export type HostCli =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'forgecode'
  | 'cursor-cli'
  | 'qwen'
  | 'opencode'
  | 'hive-flow-daemon'
  | 'wrapper';

export type ScoreProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'forge'
  | 'cursor'
  | 'deepseek'
  | 'openrouter'
  | 'qwen'
  | 'opencode'
  | 'unknown';

export type ProducerKind =
  | 'interactive-host'
  | 'provider-subprocess'
  | 'daemon'
  | 'wrapper'
  | 'native-plugin'
  | 'mcp-tool'
  | 'manual';

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export type FreshnessState = 'fresh' | 'stale' | 'degraded' | 'unavailable' | 'error';

export type StatuslineSource =
  | 'stdin'
  | 'context'
  | 'git'
  | 'swarm'
  | 'scoreboard'
  | 'agents'
  | 'hives'
  | 'hooks'
  | 'memory'
  | 'tests'
  | 'mcp'
  | 'attention'
  | 'adrs'
  | 'sessions'
  | 'daemon';

export interface SourceFreshnessRetryPolicy {
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly forceRefreshCommand?: string;
}

export interface SourceFreshness {
  readonly source: StatuslineSource;
  readonly state: FreshnessState;
  readonly observedAt: string;
  readonly reason?: string;
  readonly ttlMs?: number;
  readonly fingerprint?: string;
  readonly retryPolicy?: SourceFreshnessRetryPolicy;
}

/** Convenience alias used by the renderer's freshness tagger. */
export type FreshnessTag = SourceFreshness;

// ---------------------------------------------------------------------------
// Session events / summary
// ---------------------------------------------------------------------------

export type SessionEventKind = 'session-start' | 'session-heartbeat' | 'session-end';
export type SessionIdSource = 'native' | 'wrapper' | 'derived';
export type SessionConfidence = 'direct' | 'derived';
export type SessionEndReason = 'normal-exit' | 'signal' | 'timeout' | 'replaced' | 'unknown';

export interface SessionEventV1 {
  readonly version: 1;
  readonly eventId: string;
  readonly ts: string;
  readonly repoRoot: string;
  readonly projectKey: string;
  readonly hostCli: HostCli;
  readonly sessionId: string;
  readonly event: SessionEventKind;
  readonly sessionIdSource: SessionIdSource;
  readonly confidence: SessionConfidence;
  readonly producerKind: ProducerKind;
  readonly producerId: string;
  readonly nativeSessionId?: string;
  readonly parentSessionId?: string;
  readonly pid?: number;
  readonly ppid?: number;
  readonly exitCode?: number;
  readonly reason?: SessionEndReason;
}

export type SessionState = 'active' | 'degraded' | 'stale';

export interface SessionHostRow {
  active: number;
  degraded: number;
  stale: number;
  lastSeenAt: string;
}

export interface SessionsCurrentRow {
  readonly hostCli: HostCli;
  readonly sessionId: string;
  readonly state: SessionState;
  readonly lastSeenAt: string;
  readonly producerKind: ProducerKind;
  readonly confidence: SessionConfidence;
}

export interface SessionSummary {
  active: number;
  degraded: number;
  stale: number;
  byHost: Partial<Record<HostCli, SessionHostRow>>;
  current?: SessionsCurrentRow[];
}

/** Alias for the renderer/refresher view of `sessions/current.json`. */
export type SessionsCurrent = SessionSummary;

// ---------------------------------------------------------------------------
// Scoreboard (provider presence + provider calls)
// ---------------------------------------------------------------------------

export interface ProviderAgentPresence {
  activeAgents: number;
  idleAgents: number;
  staleAgents: number;
  models?: Record<string, number>;
  lastSeenAt?: string;
}

export const SCOREBOARD_PRESENCE_DEGRADED_MS = 15_000;
export const SCOREBOARD_PRESENCE_STALE_MS = 120_000;

export interface ProviderCallUsage {
  calls: number;
  failedCalls?: number;
  inFlightCalls?: number;
  models?: Record<string, number>;
  tokensTotal?: number;
  costUsd?: number;
  ttfbAvgMs?: number;
  ttfbSamples?: number;
  lastCallAt?: string;
}

export type ScoreboardPresenceEventKind =
  | 'agent-spawn'
  | 'agent-resume'
  | 'agent-idle'
  | 'agent-end'
  | 'session-seen';

export interface ScoreboardPresenceEventV1 {
  readonly version: 1;
  readonly eventId: string;
  readonly ts: string;
  readonly repoRoot: string;
  readonly projectKey: string;
  readonly hostCli: HostCli;
  readonly provider: ScoreProvider;
  readonly producerKind: ProducerKind;
  readonly producerId: string;
  readonly presenceKey: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly model?: string;
  readonly event: ScoreboardPresenceEventKind;
}

export type ProviderCallEventKind = 'call-start' | 'call-complete' | 'call-failed';

export interface ProviderCallEventV1 {
  readonly version: 1;
  readonly eventId: string;
  readonly ts: string;
  readonly repoRoot: string;
  readonly projectKey: string;
  readonly hostCli: HostCli;
  readonly provider: ScoreProvider;
  /** Wrapper producers are explicitly excluded from call telemetry. */
  readonly producerKind: Exclude<ProducerKind, 'wrapper'>;
  readonly producerId: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly event: ProviderCallEventKind;
  readonly countWeight?: number;
  readonly tokensTotal?: number;
  readonly costUsd?: number;
  readonly ttfbMs?: number;
}

export interface ProviderCallAggregate {
  provider: ScoreProvider;
  firstTs: string;
  model?: string;
  countWeight?: number;
  tokensTotal?: number;
  costUsd?: number;
  ttfbMs?: number;
  complete: boolean;
  failed: boolean;
}

export interface ScoreboardSummary {
  agentsByProvider: Partial<Record<ScoreProvider, ProviderAgentPresence>>;
  callsByProvider: Partial<Record<ScoreProvider, ProviderCallUsage>>;
  stale: boolean;
  lastUpdatedAt?: string;
}

/** Alias for `scoreboard/current.json` consumers. */
export type ScoreboardCurrent = ScoreboardSummary;

/** Discriminated union of scoreboard-write events appended to JSONL. */
export type ScoreboardEventV1 = ScoreboardPresenceEventV1 | ProviderCallEventV1;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export type TestRunKind = 'suite' | 'partial';

export interface TestRunEventV1 {
  readonly version: 1;
  readonly eventId: string;
  readonly ts: string;
  readonly repoRoot: string;
  readonly projectKey: string;
  readonly runner: string;
  readonly kind: TestRunKind;
  readonly scope?: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
  readonly durationMs?: number;
  readonly command?: string;
  readonly producerKind: ProducerKind;
  readonly producerId: string;
  readonly sourceFingerprint?: string;
}

export interface TestsSummary {
  suite?: TestRunEventV1 & { stale?: boolean; staleReason?: string };
  latestPartial?: TestRunEventV1;
}

/** Alias for consumers reading `tests/current.json`. */
export type TestsCurrent = TestsSummary;

export interface SourceFingerprintV1 {
  readonly version: 1;
  readonly observedAt: string;
  readonly sha256: string;
  readonly fileCount: number;
  readonly walkRoot: string;
  readonly truncated?: boolean;
}

// ---------------------------------------------------------------------------
// ADRs
// ---------------------------------------------------------------------------

export type AdrStatus =
  | 'proposed'
  | 'accepted'
  | 'implemented'
  | 'deprecated'
  | 'superseded'
  | 'rejected'
  | 'unknown';

export interface AdrRawStatusRow {
  file: string;
  rawStatus?: string;
  status: AdrStatus;
  statusSource: string;
}

export interface AdrSummary {
  total: number;
  byStatus: Record<AdrStatus, number>;
  fingerprint: string;
  rawStatuses: AdrRawStatusRow[];
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface MemoryStatRow {
  count: number;
  source: string;
  observedAt: string;
}

export interface MemorySummary {
  memories?: MemoryStatRow;
  embeddings?: MemoryStatRow;
  /** DB size in bytes when available; never used to derive an embeddings count. */
  dbSizeBytes?: number;
  sourceDescription: string;
}

/** Alias for `memory/stats.json` consumers. */
export type MemoryStats = MemorySummary;

// ---------------------------------------------------------------------------
// MCP health
// ---------------------------------------------------------------------------

export type McpRuntimeState = 'up' | 'down' | 'approval-required' | 'disconnected';

export interface McpDetailRow {
  id: string;
  configured: boolean;
  runtime?: McpRuntimeState;
  reason?: string;
}

export type McpAggregateState =
  | 'runtime-up'
  | 'config-present'
  | 'approval-required'
  | 'disconnected'
  | 'down'
  | 'not-configured';

export interface McpSummary {
  readonly version: 1;
  readonly observedAt: string;
  readonly probeVersion: 1;
  readonly source: 'setup-verify-json-rpc';
  total: number;
  configured: number;
  runtimeUp: number;
  state: McpAggregateState;
  details?: McpDetailRow[];
}

/** Alias for `mcp/health.json` consumers. */
export type McpHealth = McpSummary;

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

export type AttentionSeverity = 'info' | 'warn' | 'critical';

export interface AttentionItem {
  id: string;
  ts: string;
  severity: AttentionSeverity;
  source: string;
  message: string;
  action?: string;
  redacted: boolean;
}

export interface AttentionSummaryRow extends AttentionItem {
  ageSeconds: number;
}

export interface AttentionSummary {
  unresolved: AttentionSummaryRow[];
}

/** Single-event "emit" record appended to the attention ledger. */
export interface AttentionEventV1 {
  readonly eventId: string;
  readonly ts: string;
  readonly event: 'emit';
  readonly item: AttentionItem;
}

/** Single-event "resolve" record appended to the attention ledger. */
export interface AttentionResolvedV1 {
  readonly eventId: string;
  readonly ts: string;
  readonly event: 'resolve';
  readonly id: string;
  readonly reason: string;
  readonly redacted: boolean;
}

/** Compact aliases used by recorders and command surfaces. */
export type AttentionEvent = AttentionEventV1;
export type AttentionResolved = AttentionResolvedV1;
export type AttentionLedgerEntry = AttentionEventV1 | AttentionResolvedV1;

// ---------------------------------------------------------------------------
// Swarm / agents
// ---------------------------------------------------------------------------

/**
 * Reader-side status normalization. Terminal statuses map to `undefined` so
 * they are excluded from live counts. The MCP `AgentRecord.status` enum
 * (`spawning | idle | busy | terminated`) is NOT changed; legacy aliases
 * (`running`, `working`, `queued`, etc.) are accepted for back-compat.
 */
export type NormalizedAgentStatus = 'busy' | 'idle' | 'queued' | 'stale';

export type AgentRole =
  | 'queen'
  | 'worker'
  | 'coordinator'
  | 'reviewer'
  | 'coder'
  | 'tester'
  | 'researcher'
  | 'architect'
  | string;

export interface NormalizedAgentRow {
  id: string;
  role: AgentRole;
  ownerSessionId?: string;
  provider?: ScoreProvider | string;
  model?: string;
  status: NormalizedAgentStatus;
}

export interface ActiveHiveOwnershipSummary {
  active: number;
  unknownOwner: number;
  byOwnerSessionId: Record<string, number>;
}

export interface SwarmSummary {
  activeAgents: number;
  idleAgents: number;
  queuedAgents: number;
  maxAgents: number;
  activeQueens: number;
  executingQueens: number;
  agents?: NormalizedAgentRow[];
  activeHives?: ActiveHiveOwnershipSummary;
}

/** Aliases used by renderer/refresher modules in later waves. */
export type SwarmInfo = SwarmSummary;
export type ActiveAgents = readonly NormalizedAgentRow[];

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HooksHostRow {
  categories: number;
  matchers: number;
  commands: number;
  source: string;
}

export interface HooksSummary {
  categories: number;
  matchers: number;
  commands: number;
  byHost?: Partial<Record<HostCli, HooksHostRow>>;
}

export interface HookInventoryHostRow extends HooksHostRow {
  observedAt: string;
}

export interface HookInventoryV1 {
  readonly version: 1;
  readonly projectKey: string;
  readonly updatedAt: string;
  hosts: Partial<Record<HostCli, HookInventoryHostRow>>;
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export type DaemonHealth = 'healthy' | 'degraded' | 'stopped' | 'unknown';

export interface DaemonSummary {
  running: boolean;
  health: DaemonHealth;
  pid?: number;
  observedAt: string;
}

/** Alias used by the renderer when consuming `daemon/current.json`. */
export type DaemonState = DaemonSummary;

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitSummary {
  branch?: string;
  staged?: number;
  modified?: number;
  untracked?: number;
  ahead?: number;
  behind?: number;
}

/** Alias for compatibility with renderer/refresher modules. */
export type GitInfo = GitSummary;

// ---------------------------------------------------------------------------
// Context (ADR-051 autopilot-state + Claude Code stdin)
// ---------------------------------------------------------------------------

export type ContextSource = 'stdin' | 'autopilot-state';

export interface ContextHistoryRow {
  ts: string | number;
  tokens?: number;
  pct?: number;
  turns?: number;
}

export interface ContextSummary {
  /** Normalized 0..100 percentage. */
  percentage?: number;
  tokenEstimate?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
  pruneCount?: number;
  lastCheck?: string;
  history?: ContextHistoryRow[];
  source: ContextSource;
  observedAt: string;
}

// ---------------------------------------------------------------------------
// Renderer hints + snapshot
// ---------------------------------------------------------------------------

export type ActiveAgentDetailMode = 'off' | 'auto' | 'on';
export type OpenRouterBreakdownMode = 'aggregate' | 'model';

export interface RendererHints {
  activeAgentDetail: ActiveAgentDetailMode;
  useRoleIcons: boolean;
  allow16ColorYellowFallback: boolean;
  openRouterBreakdown: OpenRouterBreakdownMode;
}

export interface StatuslineSnapshotV1 {
  readonly version: 1;
  readonly projectRoot: string;
  readonly repoIdentity: string;
  readonly displayName?: string;
  readonly worktreeRoot?: string;
  readonly projectKey: string;
  readonly generatedAt: string;
  sources: Partial<Record<StatuslineSource, SourceFreshness>>;
  context?: ContextSummary;
  git?: GitSummary;
  scoreboard?: ScoreboardSummary;
  sessions?: SessionSummary;
  swarm?: SwarmSummary;
  hooks?: HooksSummary;
  memory?: MemorySummary;
  tests?: TestsSummary;
  mcp?: McpSummary;
  attention?: AttentionSummary;
  adrs?: AdrSummary;
  daemon?: DaemonSummary;
  rendererHints?: RendererHints;
}

/** Compact alias used by the renderer when handing snapshots to formatters. */
export type StatuslineSnapshot = StatuslineSnapshotV1;

export type StatuslineInspectRowState = 'rendered' | 'omitted' | 'degraded' | 'stale' | 'error';

export interface StatuslineInspectRow {
  state: StatuslineInspectRowState;
  source?: StatuslineSource;
  reason?: string;
  freshness?: SourceFreshness;
}

export interface StatuslineInspectV1 {
  readonly version: 1;
  readonly projectRoot: string;
  readonly projectKey: string;
  readonly generatedAt?: string;
  rows: Record<string, StatuslineInspectRow>;
  snapshot?: StatuslineSnapshotV1;
}

// ---------------------------------------------------------------------------
// Palette public types
// ---------------------------------------------------------------------------
//
// The full palette implementation lives in `palette.ts` (Wave 8). These public
// shapes/constants are declared here so types.ts is the single contract source
// and downstream waves can import them without depending on the renderer module.

export type ColorDepth = 0 | 16 | 256;

export interface PaletteCodes {
  reset: string;
  dim: string;
  project: string;
  branch: string;
  model: string;
  safe: string;
  warn: string;
  fail: string;
  critical: string;
  active: string;
  queen: string;
  queenIdle: string;
  memory: string;
  embeddings: string;
  claude: string;
  codex: string;
  gemini: string;
  forge: string;
  cursor: string;
  deepseek: string;
  openrouter: string;
  qwen: string;
  opencode: string;
  gray: string;
  number: string;
  separator: string;
}

/**
 * Bright yellow ANSI 1;33 is structurally forbidden across the renderer,
 * palette, and generator. Constructed from constant parts so the source file
 * itself does not contain the literal sequence and so static audits can grep
 * for the constant identifier as well as the encoded bytes.
 */
export const FORBIDDEN_ANSI_BRIGHT_YELLOW: string = '\x1b[' + '1;' + '33m';

// ---------------------------------------------------------------------------
// Status normalizers (reader-side only)
// ---------------------------------------------------------------------------

const BUSY_ALIASES: ReadonlySet<string> = new Set([
  'busy',
  'running',
  'executing',
  'delegating',
  'working',
]);
const IDLE_ALIASES: ReadonlySet<string> = new Set(['idle', 'ready', 'available']);
const QUEUED_ALIASES: ReadonlySet<string> = new Set(['queued', 'spawning', 'pending']);
const STALE_ALIASES: ReadonlySet<string> = new Set(['stale', 'degraded', 'unknown']);
const TERMINAL_ALIASES: ReadonlySet<string> = new Set([
  'terminated',
  'failed',
  'complete',
  'completed',
  'cancelled',
  'canceled',
]);

/**
 * Normalize an `AgentRecord.status` (or any equivalent agent-row status field)
 * onto the {@link NormalizedAgentStatus} vocabulary. Terminal statuses return
 * `undefined` so they are excluded from live counts. Unknown/empty values
 * conservatively map to `'stale'` so they appear in the idle row but not in
 * busy/queued counts.
 *
 * MUST NOT mutate the canonical MCP enum; this normalizer is reader-side only.
 */
export function normalizeAgentStatus(status: string | undefined): NormalizedAgentStatus | undefined {
  const value = String(status ?? 'idle').toLowerCase();
  if (BUSY_ALIASES.has(value)) return 'busy';
  if (IDLE_ALIASES.has(value)) return 'idle';
  if (QUEUED_ALIASES.has(value)) return 'queued';
  if (STALE_ALIASES.has(value)) return 'stale';
  if (TERMINAL_ALIASES.has(value)) return undefined;
  return 'stale';
}

/**
 * Inline-fallback variant. Structurally identical to {@link normalizeAgentStatus}
 * minus the `stale` alias (the inline path renders live data only). Kept as a
 * named function so the renderer's inline collector can import it explicitly.
 */
export function normalizeInlineStatus(
  status: unknown,
): 'busy' | 'idle' | 'queued' | 'stale' | undefined {
  const value = String(status ?? 'idle').toLowerCase();
  if (BUSY_ALIASES.has(value)) return 'busy';
  if (IDLE_ALIASES.has(value)) return 'idle';
  if (QUEUED_ALIASES.has(value)) return 'queued';
  if (TERMINAL_ALIASES.has(value)) return undefined;
  return 'stale';
}

// ---------------------------------------------------------------------------
// Autopilot-state percentage parser (ADR-051)
// ---------------------------------------------------------------------------

/**
 * Normalize an ADR-051 `lastPercentage` value. Accepts both `0..1` (fractional)
 * and `0..100` (already-percent) inputs. Clamps to `0..100`. Returns
 * `undefined` for non-finite, non-numeric, null, or boolean inputs.
 *
 * This helper is exported from types.ts so collectors, the renderer, and
 * inline-fallback paths all use the same parser. Do NOT inline this logic
 * elsewhere — the runbook requires identical semantics in every consumer.
 */
export function parseAutopilotPercentage(raw: unknown): number | undefined {
  // Reject null, undefined, boolean, and non-string/non-number inputs.
  // `Number(null)` returns 0, which would otherwise silently parse to 0%.
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'boolean') return undefined;
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    n = Number(trimmed);
  } else {
    return undefined;
  }
  if (!Number.isFinite(n)) return undefined;
  const scaled = n <= 1 ? n * 100 : n;
  if (!Number.isFinite(scaled)) return undefined;
  if (scaled <= 0) return 0;
  if (scaled > 100) return 100;
  return scaled;
}

// ---------------------------------------------------------------------------
// Render-budget constants
// ---------------------------------------------------------------------------

/** Default render deadline for the Claude Code statusline command. */
export const RENDER_BUDGET_MS = 200;

/**
 * Maximum size accepted when reading a user-controlled bounded JSON file
 * (autopilot-state.json, statusline config). 64KB matches the runbook cap.
 */
export const MAX_INIT_BUFFER_BYTES = 64 * 1024;
