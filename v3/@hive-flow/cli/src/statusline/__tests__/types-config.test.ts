// v3/@hive-flow/cli/src/statusline/__tests__/types-config.test.ts
//
// Wave 1 regression tests. Covers the typed contracts in `types.ts` and the
// bounded config parser in `config.ts`. These tests are part of the
// release-checklist enumeration and must remain green after every wave.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_STATUSLINE_CONFIG,
  loadStatuslineConfig,
  normalizeStatuslineConfig,
  parseStatuslineConfig,
  readPositiveIntEnv,
} from '../config.js';
import {
  FORBIDDEN_ANSI_BRIGHT_YELLOW,
  MAX_INIT_BUFFER_BYTES,
  RENDER_BUDGET_MS,
  SCOREBOARD_PRESENCE_DEGRADED_MS,
  SCOREBOARD_PRESENCE_STALE_MS,
  normalizeAgentStatus,
  normalizeInlineStatus,
  parseAutopilotPercentage,
  type ActiveAgents,
  type ActiveAgentDetailMode,
  type AdrStatus,
  type AdrSummary,
  type AttentionEvent,
  type AttentionEventV1,
  type AttentionLedgerEntry,
  type AttentionResolved,
  type AttentionResolvedV1,
  type AttentionSummary,
  type ColorDepth,
  type ContextSource,
  type ContextSummary,
  type DaemonState,
  type DaemonSummary,
  type FreshnessState,
  type FreshnessTag,
  type GitInfo,
  type GitSummary,
  type HookInventoryV1,
  type HooksSummary,
  type HostCli,
  type McpHealth,
  type McpSummary,
  type MemoryStats,
  type MemorySummary,
  type NormalizedAgentRow,
  type NormalizedAgentStatus,
  type PaletteCodes,
  type ProducerKind,
  type ProviderCallEventV1,
  type ScoreboardCurrent,
  type ScoreboardEventV1,
  type ScoreboardPresenceEventV1,
  type ScoreProvider,
  type SessionEventV1,
  type SessionSummary,
  type SessionsCurrent,
  type SourceFingerprintV1,
  type SourceFreshness,
  type StatuslineInspectV1,
  type StatuslineSnapshot,
  type StatuslineSnapshotV1,
  type StatuslineSource,
  type SwarmInfo,
  type SwarmSummary,
  type TestRunEventV1,
  type TestsCurrent,
  type TestsSummary,
} from '../types.js';

// ---------------------------------------------------------------------------
// Compile-time type assertions
// ---------------------------------------------------------------------------
//
// These constructions exist purely so the type-checker exercises every
// public export. They use `satisfies` so any drift (renamed field, removed
// enum member, accidental `any` introduction) becomes a compile error.

const _typecheckHost: HostCli = 'claude-code';
const _typecheckProvider: ScoreProvider = 'openrouter';
const _typecheckProducerKind: ProducerKind = 'mcp-tool';
const _typecheckFreshnessState: FreshnessState = 'fresh';
const _typecheckStatuslineSource: StatuslineSource = 'context';
const _typecheckAdrStatus: AdrStatus = 'implemented';
const _typecheckColorDepth: ColorDepth = 256;
const _typecheckActiveAgentDetail: ActiveAgentDetailMode = 'off';
const _typecheckContextSource: ContextSource = 'autopilot-state';

const _typecheckSourceFreshness: SourceFreshness = {
  source: 'mcp',
  state: 'degraded',
  observedAt: '2026-05-21T00:00:00.000Z',
  ttlMs: 30_000,
};
const _typecheckFreshnessTag: FreshnessTag = _typecheckSourceFreshness;

const _typecheckGit: GitInfo = { branch: 'main' };
const _typecheckGitSummary: GitSummary = _typecheckGit;

const _typecheckAgentRow: NormalizedAgentRow = {
  id: 'agent-1',
  role: 'worker',
  status: 'busy',
};
const _typecheckActiveAgents: ActiveAgents = [_typecheckAgentRow];

const _typecheckSwarm: SwarmInfo = {
  activeAgents: 1,
  idleAgents: 0,
  queuedAgents: 0,
  maxAgents: 50,
  activeQueens: 0,
  executingQueens: 0,
  agents: [_typecheckAgentRow],
};
const _typecheckSwarmSummary: SwarmSummary = _typecheckSwarm;

const _typecheckSession: SessionEventV1 = {
  version: 1,
  eventId: 'evt-1',
  ts: '2026-05-21T00:00:00.000Z',
  repoRoot: '/tmp/repo',
  projectKey: 'abc',
  hostCli: 'claude-code',
  sessionId: 'session-1',
  event: 'session-start',
  sessionIdSource: 'native',
  confidence: 'direct',
  producerKind: 'interactive-host',
  producerId: 'host-1',
};
const _typecheckSessionSummary: SessionSummary = {
  active: 1,
  degraded: 0,
  stale: 0,
  byHost: {},
};
const _typecheckSessionsCurrent: SessionsCurrent = _typecheckSessionSummary;

const _typecheckPresence: ScoreboardPresenceEventV1 = {
  version: 1,
  eventId: 'p-1',
  ts: '2026-05-21T00:00:00.000Z',
  repoRoot: '/tmp/repo',
  projectKey: 'abc',
  hostCli: 'claude-code',
  provider: 'claude',
  producerKind: 'mcp-tool',
  producerId: 'tool-1',
  presenceKey: 'claude-code:agent-1',
  event: 'agent-spawn',
};
const _typecheckProviderCall: ProviderCallEventV1 = {
  version: 1,
  eventId: 'c-1',
  ts: '2026-05-21T00:00:00.000Z',
  repoRoot: '/tmp/repo',
  projectKey: 'abc',
  hostCli: 'claude-code',
  provider: 'claude',
  producerKind: 'mcp-tool',
  producerId: 'tool-1',
  event: 'call-start',
};
const _typecheckScoreboardEvent: ScoreboardEventV1 = _typecheckPresence;
const _typecheckScoreboardCurrent: ScoreboardCurrent = {
  agentsByProvider: {},
  callsByProvider: {},
  stale: false,
};

const _typecheckTestRun: TestRunEventV1 = {
  version: 1,
  eventId: 't-1',
  ts: '2026-05-21T00:00:00.000Z',
  repoRoot: '/tmp/repo',
  projectKey: 'abc',
  runner: 'vitest',
  kind: 'suite',
  passed: 1,
  failed: 0,
  skipped: 0,
  total: 1,
  producerKind: 'interactive-host',
  producerId: 'host-1',
};
const _typecheckTestsSummary: TestsSummary = { suite: _typecheckTestRun };
const _typecheckTestsCurrent: TestsCurrent = _typecheckTestsSummary;
const _typecheckSourceFingerprint: SourceFingerprintV1 = {
  version: 1,
  observedAt: '2026-05-21T00:00:00.000Z',
  sha256: 'a'.repeat(64),
  fileCount: 1,
  walkRoot: '/tmp/repo',
};

const _typecheckAttentionEvent: AttentionEventV1 = {
  eventId: 'attn-1',
  ts: '2026-05-21T00:00:00.000Z',
  event: 'emit',
  item: {
    id: 'attn-1',
    ts: '2026-05-21T00:00:00.000Z',
    severity: 'warn',
    source: 'tests',
    message: 'sample',
    redacted: false,
  },
};
const _typecheckAttentionEventAlias: AttentionEvent = _typecheckAttentionEvent;
const _typecheckAttentionResolved: AttentionResolvedV1 = {
  eventId: 'attn-resolve-1',
  ts: '2026-05-21T00:00:01.000Z',
  event: 'resolve',
  id: 'attn-1',
  reason: 'done',
  redacted: false,
};
const _typecheckAttentionResolvedAlias: AttentionResolved = _typecheckAttentionResolved;
const _typecheckAttentionLedger: AttentionLedgerEntry = _typecheckAttentionEvent;
const _typecheckAttentionSummary: AttentionSummary = { unresolved: [] };

const _typecheckAdrSummary: AdrSummary = {
  total: 0,
  byStatus: {
    proposed: 0,
    accepted: 0,
    implemented: 0,
    deprecated: 0,
    superseded: 0,
    rejected: 0,
    unknown: 0,
  },
  fingerprint: 'sha256-empty',
  rawStatuses: [],
};

const _typecheckMemory: MemoryStats = {
  sourceDescription: 'memory/stats.json',
};
const _typecheckMemorySummary: MemorySummary = _typecheckMemory;

const _typecheckMcp: McpHealth = {
  version: 1,
  observedAt: '2026-05-21T00:00:00.000Z',
  probeVersion: 1,
  source: 'setup-verify-json-rpc',
  total: 0,
  configured: 0,
  runtimeUp: 0,
  state: 'not-configured',
};
const _typecheckMcpSummary: McpSummary = _typecheckMcp;

const _typecheckHooks: HooksSummary = { categories: 0, matchers: 0, commands: 0 };
const _typecheckHookInventory: HookInventoryV1 = {
  version: 1,
  projectKey: 'abc',
  updatedAt: '2026-05-21T00:00:00.000Z',
  hosts: {},
};

const _typecheckDaemon: DaemonState = {
  running: false,
  health: 'unknown',
  observedAt: '2026-05-21T00:00:00.000Z',
};
const _typecheckDaemonSummary: DaemonSummary = _typecheckDaemon;

const _typecheckContext: ContextSummary = {
  source: 'stdin',
  observedAt: '2026-05-21T00:00:00.000Z',
};

const _typecheckPalette: PaletteCodes = {
  reset: '',
  dim: '',
  project: '',
  branch: '',
  model: '',
  safe: '',
  warn: '',
  fail: '',
  critical: '',
  active: '',
  queen: '',
  queenIdle: '',
  memory: '',
  embeddings: '',
  claude: '',
  codex: '',
  gemini: '',
  forge: '',
  cursor: '',
  deepseek: '',
  openrouter: '',
  qwen: '',
  opencode: '',
  gray: '',
  number: '',
  separator: '',
};

const _typecheckSnapshot: StatuslineSnapshotV1 = {
  version: 1,
  projectRoot: '/tmp/repo',
  repoIdentity: 'repo',
  projectKey: 'abc',
  generatedAt: '2026-05-21T00:00:00.000Z',
  sources: {},
};
const _typecheckSnapshotAlias: StatuslineSnapshot = _typecheckSnapshot;
const _typecheckInspect: StatuslineInspectV1 = {
  version: 1,
  projectRoot: '/tmp/repo',
  projectKey: 'abc',
  rows: {},
};

// Force the compiler to keep the assignments (and therefore the typecheck) live.
void _typecheckHost;
void _typecheckProvider;
void _typecheckProducerKind;
void _typecheckFreshnessState;
void _typecheckStatuslineSource;
void _typecheckAdrStatus;
void _typecheckColorDepth;
void _typecheckActiveAgentDetail;
void _typecheckContextSource;
void _typecheckSourceFreshness;
void _typecheckFreshnessTag;
void _typecheckGit;
void _typecheckGitSummary;
void _typecheckAgentRow;
void _typecheckActiveAgents;
void _typecheckSwarm;
void _typecheckSwarmSummary;
void _typecheckSession;
void _typecheckSessionSummary;
void _typecheckSessionsCurrent;
void _typecheckPresence;
void _typecheckProviderCall;
void _typecheckScoreboardEvent;
void _typecheckScoreboardCurrent;
void _typecheckTestRun;
void _typecheckTestsSummary;
void _typecheckTestsCurrent;
void _typecheckSourceFingerprint;
void _typecheckAttentionEvent;
void _typecheckAttentionEventAlias;
void _typecheckAttentionResolved;
void _typecheckAttentionResolvedAlias;
void _typecheckAttentionLedger;
void _typecheckAttentionSummary;
void _typecheckAdrSummary;
void _typecheckMemory;
void _typecheckMemorySummary;
void _typecheckMcp;
void _typecheckMcpSummary;
void _typecheckHooks;
void _typecheckHookInventory;
void _typecheckDaemon;
void _typecheckDaemonSummary;
void _typecheckContext;
void _typecheckPalette;
void _typecheckSnapshot;
void _typecheckSnapshotAlias;
void _typecheckInspect;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('statusline types', () => {
  it('exports the locked FORBIDDEN_ANSI_BRIGHT_YELLOW byte sequence', () => {
    // ESC [ 1 ; 3 3 m = 7 characters total
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.length).toBe(7);
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.charCodeAt(0)).toBe(0x1b);
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.charCodeAt(1)).toBe(0x5b); // '['
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.charCodeAt(2)).toBe(0x31); // '1'
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.charCodeAt(3)).toBe(0x3b); // ';'
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.charCodeAt(4)).toBe(0x33); // '3'
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.charCodeAt(5)).toBe(0x33); // '3'
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.charCodeAt(6)).toBe(0x6d); // 'm'
    expect(FORBIDDEN_ANSI_BRIGHT_YELLOW.slice(-2)).toBe('3m');
  });

  it('exposes the documented render budget and bounded-read cap', () => {
    expect(RENDER_BUDGET_MS).toBe(200);
    expect(MAX_INIT_BUFFER_BYTES).toBe(64 * 1024);
  });

  it('exposes scoreboard presence freshness constants', () => {
    expect(SCOREBOARD_PRESENCE_DEGRADED_MS).toBe(15_000);
    expect(SCOREBOARD_PRESENCE_STALE_MS).toBe(120_000);
  });
});

describe('normalizeAgentStatus', () => {
  it('maps busy aliases to "busy"', () => {
    for (const value of ['busy', 'running', 'executing', 'delegating', 'working']) {
      expect(normalizeAgentStatus(value)).toBe('busy');
    }
  });

  it('maps idle aliases to "idle"', () => {
    for (const value of ['idle', 'ready', 'available']) {
      expect(normalizeAgentStatus(value)).toBe('idle');
    }
  });

  it('maps queued aliases to "queued"', () => {
    for (const value of ['queued', 'spawning', 'pending']) {
      expect(normalizeAgentStatus(value)).toBe('queued');
    }
  });

  it('maps stale/unknown markers to "stale"', () => {
    for (const value of ['stale', 'degraded', 'unknown']) {
      expect(normalizeAgentStatus(value)).toBe('stale');
    }
  });

  it('drops terminal statuses (returns undefined)', () => {
    for (const value of ['terminated', 'failed', 'complete', 'completed', 'cancelled', 'canceled']) {
      expect(normalizeAgentStatus(value)).toBeUndefined();
    }
  });

  it('is case-insensitive; defaults nullish values to "idle"; classifies empty string as "stale"', () => {
    expect(normalizeAgentStatus('BUSY')).toBe('busy');
    expect(normalizeAgentStatus('Idle')).toBe('idle');
    // `undefined` short-circuits to 'idle' via `?? 'idle'` in the implementation.
    expect(normalizeAgentStatus(undefined)).toBe('idle');
    // Empty string is non-nullish, so the normalizer treats it as unknown.
    expect(normalizeAgentStatus('')).toBe('stale');
  });

  it('inline status normalizer matches agent-status semantics on terminals', () => {
    for (const value of ['terminated', 'failed', 'complete', 'completed', 'cancelled', 'canceled']) {
      expect(normalizeInlineStatus(value)).toBeUndefined();
    }
    expect(normalizeInlineStatus('busy')).toBe('busy');
    expect(normalizeInlineStatus(undefined)).toBe('idle');
  });

  it('returns a value typed as NormalizedAgentStatus | undefined', () => {
    const out: NormalizedAgentStatus | undefined = normalizeAgentStatus('busy');
    expect(out).toBe('busy');
  });
});

describe('parseAutopilotPercentage', () => {
  it('normalizes 0..1 inputs by scaling to 0..100', () => {
    expect(parseAutopilotPercentage(0)).toBe(0);
    expect(parseAutopilotPercentage(0.5)).toBe(50);
    expect(parseAutopilotPercentage(0.434)).toBeCloseTo(43.4, 5);
    expect(parseAutopilotPercentage(1)).toBe(100);
  });

  it('passes through 0..100 inputs unchanged', () => {
    expect(parseAutopilotPercentage(43.4)).toBe(43.4);
    expect(parseAutopilotPercentage(99)).toBe(99);
    expect(parseAutopilotPercentage(100)).toBe(100);
  });

  it('clamps out-of-range inputs', () => {
    expect(parseAutopilotPercentage(150)).toBe(100);
    expect(parseAutopilotPercentage(-5)).toBe(0);
  });

  it('accepts numeric strings', () => {
    expect(parseAutopilotPercentage('43.4')).toBe(43.4);
    expect(parseAutopilotPercentage('0.5')).toBe(50);
  });

  it('returns undefined for non-numeric or non-finite inputs', () => {
    expect(parseAutopilotPercentage(undefined)).toBeUndefined();
    expect(parseAutopilotPercentage(null)).toBeUndefined();
    expect(parseAutopilotPercentage(Number.NaN)).toBeUndefined();
    expect(parseAutopilotPercentage(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseAutopilotPercentage('not a number')).toBeUndefined();
    expect(parseAutopilotPercentage({})).toBeUndefined();
  });
});

describe('DEFAULT_STATUSLINE_CONFIG', () => {
  it('matches the locked Settled Decisions exactly', () => {
    expect(DEFAULT_STATUSLINE_CONFIG.allow16ColorYellowFallback).toBe(false);
    expect(DEFAULT_STATUSLINE_CONFIG.activeAgentDetail).toBe('off');
    expect(DEFAULT_STATUSLINE_CONFIG.useRoleIcons).toBe(false);
    expect(DEFAULT_STATUSLINE_CONFIG.openRouterBreakdown).toBe('aggregate');
  });

  it('declares the documented ADR scan paths and exclusions', () => {
    expect(DEFAULT_STATUSLINE_CONFIG.adrPaths).toEqual([
      'v3/implementation/adrs',
      'docs/adrs',
      '.hive-flow/adrs',
    ]);
    expect(DEFAULT_STATUSLINE_CONFIG.adrPatterns).toEqual([
      'ADR-*.md',
      'adr-*.md',
      '[0-9][0-9][0-9][0-9]-*.md',
    ]);
    expect(DEFAULT_STATUSLINE_CONFIG.adrExcludePatterns).toEqual([
      '*SUMMARY.md',
      '*summary.md',
      'README.md',
      '*implementation-summary.md',
      'v3-adrs.md',
    ]);
  });

  it('declares per-source TTLs matching the runbook contract', () => {
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.context).toBe(5 * 60_000);
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.git).toBe(2_000);
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.hooks).toBe(60_000);
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.mcp).toBe(30_000);
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.adrs).toBe(60_000);
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.sessions).toBe(5_000);
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.daemon).toBe(5_000);
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.tests).toBe(0);
    expect(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.memory).toBe(0);
  });

  it('uses 500ms debounce by default and 200ms render budget', () => {
    expect(DEFAULT_STATUSLINE_CONFIG.refreshDebounceMs).toBe(500);
    expect(DEFAULT_STATUSLINE_CONFIG.renderBudgetMs).toBe(200);
  });

  it('caps bounded reads at 64 KiB', () => {
    expect(DEFAULT_STATUSLINE_CONFIG.maxConfigBytes).toBe(64 * 1024);
    expect(DEFAULT_STATUSLINE_CONFIG.maxInitBufferBytes).toBe(64 * 1024);
  });

  it('declares JSONL and spool caps', () => {
    expect(DEFAULT_STATUSLINE_CONFIG.maxJsonlBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_STATUSLINE_CONFIG.maxJsonlLineBytes).toBe(256 * 1024);
    expect(DEFAULT_STATUSLINE_CONFIG.maxSpoolBytes).toBe(256 * 1024);
    expect(DEFAULT_STATUSLINE_CONFIG.maxSpoolEntries).toBe(1000);
  });
});

describe('normalizeStatuslineConfig', () => {
  it('returns canonical defaults when called with no input', () => {
    const cfg = normalizeStatuslineConfig();
    expect(cfg.activeAgentDetail).toBe('off');
    expect(cfg.useRoleIcons).toBe(false);
    expect(cfg.allow16ColorYellowFallback).toBe(false);
    expect(cfg.refreshDebounceMs).toBe(500);
  });

  it('clamps refresh debounce into [250, 1000]', () => {
    expect(normalizeStatuslineConfig({ refreshDebounceMs: 99 }).refreshDebounceMs).toBe(250);
    expect(normalizeStatuslineConfig({ refreshDebounceMs: 1_000_000 }).refreshDebounceMs).toBe(1000);
    expect(normalizeStatuslineConfig({ refreshDebounceMs: 333 }).refreshDebounceMs).toBe(333);
  });

  it('rejects unknown activeAgentDetail values and falls back to "off"', () => {
    const cfg = normalizeStatuslineConfig({ activeAgentDetail: 'bad' as never });
    expect(cfg.activeAgentDetail).toBe('off');
  });

  it('strictly narrows openRouterBreakdown to "aggregate" unless "model" is explicit', () => {
    expect(normalizeStatuslineConfig({ openRouterBreakdown: 'model' }).openRouterBreakdown).toBe(
      'model',
    );
    expect(
      normalizeStatuslineConfig({ openRouterBreakdown: 'weird' as never }).openRouterBreakdown,
    ).toBe('aggregate');
  });

  it('ignores non-string entries in array overrides and falls back to defaults when empty', () => {
    const cfg = normalizeStatuslineConfig({
      adrPaths: [1, '', 'docs/adrs'] as unknown as string[],
    });
    expect(cfg.adrPaths).toEqual(['docs/adrs']);
    const cfgEmpty = normalizeStatuslineConfig({ adrPaths: [] });
    expect(cfgEmpty.adrPaths).toEqual(DEFAULT_STATUSLINE_CONFIG.adrPaths);
  });

  it('ignores non-finite numeric env-style overrides', () => {
    const cfg = normalizeStatuslineConfig({
      refreshDebounceMs: Number.NaN as unknown as number,
      maxJsonlBytes: -5 as unknown as number,
    });
    expect(cfg.refreshDebounceMs).toBe(500);
    expect(cfg.maxJsonlBytes).toBe(DEFAULT_STATUSLINE_CONFIG.maxJsonlBytes);
  });

  it('uses defaults when source TTLs override is malformed', () => {
    const cfg = normalizeStatuslineConfig({
      sourceTtlsMs: 'not-an-object' as unknown as Record<StatuslineSource, number>,
    });
    expect(cfg.sourceTtlsMs.context).toBe(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.context);
    expect(cfg.sourceTtlsMs.mcp).toBe(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.mcp);
  });

  it('accepts partial source-TTL overrides while preserving the rest', () => {
    const cfg = normalizeStatuslineConfig({
      sourceTtlsMs: { hooks: 90_000 } as unknown as Record<StatuslineSource, number>,
    });
    expect(cfg.sourceTtlsMs.hooks).toBe(90_000);
    expect(cfg.sourceTtlsMs.context).toBe(DEFAULT_STATUSLINE_CONFIG.sourceTtlsMs.context);
  });
});

describe('parseStatuslineConfig (bounded file parser)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-statusline-cfg-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns defaults when no config file is present', async () => {
    const result = await parseStatuslineConfig(root);
    expect(result.source).toBe('defaults');
    expect(result.config.activeAgentDetail).toBe('off');
    const cfg = await loadStatuslineConfig(root);
    expect(cfg.allow16ColorYellowFallback).toBe(false);
  });

  it('loads `.hive-flow/statusline.config.json` when present', async () => {
    mkdirSync(join(root, '.hive-flow'), { recursive: true });
    writeFileSync(
      join(root, '.hive-flow', 'statusline.config.json'),
      JSON.stringify({ activeAgentDetail: 'on', useRoleIcons: true, refreshDebounceMs: 400 }),
    );
    const result = await parseStatuslineConfig(root);
    expect(result.source).toBe('file');
    expect(result.config.activeAgentDetail).toBe('on');
    expect(result.config.useRoleIcons).toBe(true);
    expect(result.config.refreshDebounceMs).toBe(400);
  });

  it('falls back to defaults and surfaces a warning when JSON is malformed', async () => {
    mkdirSync(join(root, '.hive-flow'), { recursive: true });
    writeFileSync(join(root, '.hive-flow', 'statusline.config.json'), '{not valid json');
    const result = await parseStatuslineConfig(root);
    expect(result.source).toBe('defaults');
    expect(result.warning).toMatch(/JSON parse error/i);
    expect(result.config.activeAgentDetail).toBe('off');
  });

  it('rejects inputs larger than 64 KiB and returns defaults', async () => {
    mkdirSync(join(root, '.hive-flow'), { recursive: true });
    const oversize = 'x'.repeat(MAX_INIT_BUFFER_BYTES + 16);
    // Wrap the giant payload as a JSON string so the file is structurally
    // JSON (parser would otherwise succeed before we hit the size guard).
    writeFileSync(
      join(root, '.hive-flow', 'statusline.config.json'),
      JSON.stringify({ activeAgentDetail: 'on', _filler: oversize }),
    );
    const result = await parseStatuslineConfig(root);
    expect(result.source).toBe('defaults');
    expect(result.warning).toMatch(/exceeds/i);
    expect(result.config.activeAgentDetail).toBe('off');
  });

  it('rejects a symlinked config file (no symlink following)', async () => {
    mkdirSync(join(root, '.hive-flow'), { recursive: true });
    const outside = join(root, 'outside.json');
    writeFileSync(outside, JSON.stringify({ activeAgentDetail: 'on' }));
    symlinkSync(outside, join(root, '.hive-flow', 'statusline.config.json'));
    const result = await parseStatuslineConfig(root);
    expect(result.source).toBe('defaults');
    expect(result.config.activeAgentDetail).toBe('off');
  });

  it('falls back to the project-root candidate when .hive-flow file is missing', async () => {
    writeFileSync(
      join(root, 'hive-flow.statusline.json'),
      JSON.stringify({ openRouterBreakdown: 'model' }),
    );
    const result = await parseStatuslineConfig(root);
    expect(result.source).toBe('file');
    expect(result.config.openRouterBreakdown).toBe('model');
  });
});

describe('readPositiveIntEnv', () => {
  it('returns fallback on missing or empty env vars', () => {
    expect(readPositiveIntEnv({}, 'X', 7)).toBe(7);
    expect(readPositiveIntEnv({ X: '' }, 'X', 7)).toBe(7);
  });

  it('parses valid finite non-negative numbers', () => {
    expect(readPositiveIntEnv({ X: '42' }, 'X', 7)).toBe(42);
    expect(readPositiveIntEnv({ X: '0' }, 'X', 7)).toBe(0);
  });

  it('returns fallback on non-finite or negative input (strict-TS narrowing)', () => {
    expect(readPositiveIntEnv({ X: 'NaN' }, 'X', 7)).toBe(7);
    expect(readPositiveIntEnv({ X: 'Infinity' }, 'X', 7)).toBe(7);
    expect(readPositiveIntEnv({ X: '-3' }, 'X', 7)).toBe(7);
    expect(readPositiveIntEnv({ X: 'banana' }, 'X', 7)).toBe(7);
  });
});
