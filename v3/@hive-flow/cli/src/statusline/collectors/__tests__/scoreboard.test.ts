// v3/@hive-flow/cli/src/statusline/collectors/__tests__/scoreboard.test.ts
//
// Regression tests for the Wave-3 scoreboard collector. All fixtures are
// hand-authored JSONL strings written to a tmp project root — the recorder
// module is intentionally NOT imported so the collector's contract is exercised
// in isolation.
//
// Test plan (matches the brief):
//   - empty → empty summary
//   - one agent-spawn → presence count 1 for that provider
//   - one call-start + call-complete → call count 1
//   - duplicate event (same eventId + event) appears only once
//   - presence > 15s without heartbeat → degraded (idle bucket)
//   - presence > 2m → stale (stale bucket)
//   - legacy `provider-usage.json` migration: file exists → values merged
//   - legacy migration: file absent → no error
//   - migration parse failure → `migrationSkippedReason` returned, no throw
//   - wrapper-only scenario: presence rows exist with no call rows

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectScoreboard } from '../scoreboard.js';
import {
  SCOREBOARD_PRESENCE_DEGRADED_MS,
  SCOREBOARD_PRESENCE_STALE_MS,
  type ProviderCallEventV1,
  type ScoreboardPresenceEventV1,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse('2026-05-20T12:00:00.000Z');

function makePresenceEvent(
  overrides: Partial<ScoreboardPresenceEventV1> & {
    eventId: string;
    event: ScoreboardPresenceEventV1['event'];
    provider: ScoreboardPresenceEventV1['provider'];
    presenceKey: string;
    ts?: string;
  },
): ScoreboardPresenceEventV1 {
  const defaults: ScoreboardPresenceEventV1 = {
    version: 1,
    eventId: overrides.eventId,
    ts: overrides.ts ?? new Date(FIXED_NOW - 1_000).toISOString(),
    repoRoot: '/repo',
    projectKey: 'project-key',
    hostCli: 'claude-code',
    provider: overrides.provider,
    producerKind: 'interactive-host',
    producerId: 'producer-1',
    presenceKey: overrides.presenceKey,
    event: overrides.event,
  };
  return { ...defaults, ...overrides };
}

function makeCallEvent(
  overrides: Partial<ProviderCallEventV1> & {
    eventId: string;
    event: ProviderCallEventV1['event'];
    provider: ProviderCallEventV1['provider'];
    ts?: string;
  },
): ProviderCallEventV1 {
  const defaults: ProviderCallEventV1 = {
    version: 1,
    eventId: overrides.eventId,
    ts: overrides.ts ?? new Date(FIXED_NOW - 1_000).toISOString(),
    repoRoot: '/repo',
    projectKey: 'project-key',
    hostCli: 'claude-code',
    provider: overrides.provider,
    producerKind: 'interactive-host',
    producerId: 'producer-1',
    event: overrides.event,
  };
  return { ...defaults, ...overrides };
}

function writeJsonl(filePath: string, events: ReadonlyArray<object>): void {
  mkdirSync(filePath.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
}

function projectPaths(root: string): {
  presence: string;
  calls: string;
  legacy: string;
} {
  return {
    presence: join(root, '.hive-flow', 'scoreboard', 'presence.jsonl'),
    calls: join(root, '.hive-flow', 'scoreboard', 'calls.jsonl'),
    legacy: join(root, '.hive-flow', 'metrics', 'provider-usage.json'),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('collectScoreboard', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-scoreboard-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns an empty summary when no ledgers and no legacy file exist', async () => {
    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.agentsByProvider).toEqual({});
    expect(result.callsByProvider).toEqual({});
    expect(result.stale).toBe(false);
    expect(result.lastUpdatedAt).toBeUndefined();
    expect(result.migrationSkippedReason).toBeUndefined();
  });

  it('counts a single agent-spawn event as one active agent for the provider', async () => {
    const p = projectPaths(projectRoot);
    const spawn = makePresenceEvent({
      eventId: 'evt-1',
      event: 'agent-spawn',
      provider: 'claude',
      presenceKey: 'agent-claude-1',
      ts: new Date(FIXED_NOW - 500).toISOString(),
    });
    writeJsonl(p.presence, [spawn]);

    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.agentsByProvider.claude).toEqual({
      activeAgents: 1,
      idleAgents: 0,
      staleAgents: 0,
      lastSeenAt: spawn.ts,
    });
    // No call ledger exists; callsByProvider must be empty.
    expect(result.callsByProvider).toEqual({});
  });

  it('counts a paired call-start + call-complete as one completed call', async () => {
    const p = projectPaths(projectRoot);
    const start = makeCallEvent({
      eventId: 'call-1',
      event: 'call-start',
      provider: 'codex',
      ts: new Date(FIXED_NOW - 2_000).toISOString(),
      model: 'gpt-5.5',
    });
    const complete = makeCallEvent({
      eventId: 'call-1',
      event: 'call-complete',
      provider: 'codex',
      ts: new Date(FIXED_NOW - 1_000).toISOString(),
      model: 'gpt-5.5',
      tokensTotal: 1_234,
      costUsd: 0.01,
      ttfbMs: 450,
    });
    writeJsonl(p.calls, [start, complete]);

    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.callsByProvider.codex?.calls).toBe(1);
    expect(result.callsByProvider.codex?.failedCalls ?? 0).toBe(0);
    expect(result.callsByProvider.codex?.inFlightCalls ?? 0).toBe(0);
    expect(result.callsByProvider.codex?.tokensTotal).toBe(1_234);
    expect(result.callsByProvider.codex?.lastCallAt).toBe(complete.ts);
    expect(result.callsByProvider.codex?.models?.['gpt-5.5']).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates a duplicate event (same eventId + event) into a single entry', async () => {
    const p = projectPaths(projectRoot);
    const start = makeCallEvent({
      eventId: 'call-dup',
      event: 'call-start',
      provider: 'gemini',
      ts: new Date(FIXED_NOW - 5_000).toISOString(),
    });
    // Same eventId + event written twice (e.g. partial-drain replay).
    writeJsonl(p.calls, [start, start]);

    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    // `calls`, `failedCalls`, and `inFlightCalls` are mutually exclusive
    // (recorder-side contract — see `recorders/__tests__/scoreboard.test.ts`
    // assertion `calls=0, inFlightCalls=1` for a start-only entry). A
    // `call-start` without a terminal event is in-flight, not completed.
    expect(result.callsByProvider.gemini?.calls ?? 0).toBe(0);
    expect(result.callsByProvider.gemini?.inFlightCalls).toBe(1);
    expect(result.callsByProvider.gemini?.failedCalls ?? 0).toBe(0);
  });

  it('classifies presence between 15s and 2m as degraded (idle bucket)', async () => {
    const p = projectPaths(projectRoot);
    const degraded = makePresenceEvent({
      eventId: 'evt-degraded',
      event: 'agent-spawn',
      provider: 'claude',
      presenceKey: 'agent-claude-stale',
      // 30s ago — past 15s degraded threshold but well under 2m stale threshold.
      ts: new Date(FIXED_NOW - 30_000).toISOString(),
    });
    writeJsonl(p.presence, [degraded]);

    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.agentsByProvider.claude?.activeAgents).toBe(0);
    expect(result.agentsByProvider.claude?.idleAgents).toBe(1);
    expect(result.agentsByProvider.claude?.staleAgents).toBe(0);
  });

  it('classifies presence older than 2m as stale', async () => {
    const p = projectPaths(projectRoot);
    const stale = makePresenceEvent({
      eventId: 'evt-stale',
      event: 'agent-spawn',
      provider: 'codex',
      presenceKey: 'agent-codex-stale',
      // 5 minutes ago.
      ts: new Date(FIXED_NOW - 5 * 60_000).toISOString(),
    });
    writeJsonl(p.presence, [stale]);

    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.agentsByProvider.codex?.activeAgents).toBe(0);
    expect(result.agentsByProvider.codex?.idleAgents).toBe(0);
    expect(result.agentsByProvider.codex?.staleAgents).toBe(1);
    // The summary is also marked stale because the most recent ledger event is
    // older than the canonical STALE window.
    expect(result.stale).toBe(true);
  });

  it('asserts the freshness constants match the runbook values', () => {
    // Defensive check: if anyone tunes these without updating the collector
    // the test must fail. This is the only place we assert on the constants.
    expect(SCOREBOARD_PRESENCE_DEGRADED_MS).toBe(15_000);
    expect(SCOREBOARD_PRESENCE_STALE_MS).toBe(120_000);
  });

  it('merges legacy provider-usage.json when present', async () => {
    const p = projectPaths(projectRoot);
    mkdirSync(join(projectRoot, '.hive-flow', 'metrics'), { recursive: true });
    writeFileSync(
      p.legacy,
      JSON.stringify({
        sessionId: 'sess-1',
        startedAt: new Date(FIXED_NOW - 60_000).toISOString(),
        providers: {
          opus: { calls: 3, tokens: 100, ttfb_avg_ms: 250, last_used: new Date(FIXED_NOW - 1_000).toISOString() },
          sonnet: { calls: 7, tokens: 200, ttfb_avg_ms: 0, last_used: null },
          'gpt-4o': { calls: 2 },
        },
      }),
    );
    // Add one ledger call so we can also confirm merge semantics with existing entries.
    const start = makeCallEvent({
      eventId: 'call-claude-ledger',
      event: 'call-start',
      provider: 'claude',
      ts: new Date(FIXED_NOW - 10_000).toISOString(),
    });
    writeJsonl(p.calls, [start]);

    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    // opus(3) + sonnet(7) both map to `claude.calls` (completed legacy calls).
    // The lone `call-start` ledger event is in-flight under the mutually
    // exclusive counter semantics and contributes to `inFlightCalls` only.
    expect(result.callsByProvider.claude?.calls).toBe(3 + 7);
    expect(result.callsByProvider.claude?.inFlightCalls).toBe(1);
    expect(result.callsByProvider.claude?.tokensTotal).toBe(100 + 200);
    // gpt-4o maps to `codex`.
    expect(result.callsByProvider.codex?.calls).toBe(2);
    expect(result.migrationSkippedReason).toBeUndefined();
  });

  it('returns no error and no skippedReason when legacy file is absent', async () => {
    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.migrationSkippedReason).toBeUndefined();
    expect(result.callsByProvider).toEqual({});
  });

  it('does not throw and returns migrationSkippedReason when legacy file is malformed', async () => {
    const p = projectPaths(projectRoot);
    mkdirSync(join(projectRoot, '.hive-flow', 'metrics'), { recursive: true });
    writeFileSync(p.legacy, '{not-json');
    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.migrationSkippedReason).toBe('parse-error');
    // Collector still returns a well-formed empty summary.
    expect(result.callsByProvider).toEqual({});
    expect(result.agentsByProvider).toEqual({});
  });

  it('also returns migrationSkippedReason when legacy shape is invalid', async () => {
    const p = projectPaths(projectRoot);
    mkdirSync(join(projectRoot, '.hive-flow', 'metrics'), { recursive: true });
    writeFileSync(p.legacy, JSON.stringify({ providers: 'not-a-record' }));
    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.migrationSkippedReason).toBe('invalid-shape');
  });

  it('renders presence even when no call events exist (wrapper-only producer)', async () => {
    // Wrapper producers can emit presence but are excluded from call events
    // (Codex round-3 finding). The collector must therefore populate
    // agentsByProvider while leaving callsByProvider empty.
    const p = projectPaths(projectRoot);
    const spawn = makePresenceEvent({
      eventId: 'wrap-1',
      event: 'agent-spawn',
      provider: 'cursor',
      presenceKey: 'cursor-wrap-1',
      ts: new Date(FIXED_NOW - 500).toISOString(),
      producerKind: 'wrapper',
      hostCli: 'wrapper',
    });
    writeJsonl(p.presence, [spawn]);

    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.agentsByProvider.cursor?.activeAgents).toBe(1);
    expect(result.callsByProvider).toEqual({});
  });

  it('excludes agent-end from active counts', async () => {
    const p = projectPaths(projectRoot);
    const ts1 = new Date(FIXED_NOW - 2_000).toISOString();
    const ts2 = new Date(FIXED_NOW - 1_000).toISOString();
    const spawn = makePresenceEvent({
      eventId: 'evt-spawn',
      event: 'agent-spawn',
      provider: 'claude',
      presenceKey: 'agent-1',
      ts: ts1,
    });
    const end = makePresenceEvent({
      eventId: 'evt-end',
      event: 'agent-end',
      provider: 'claude',
      presenceKey: 'agent-1',
      ts: ts2,
    });
    writeJsonl(p.presence, [spawn, end]);

    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    // Latest event for this presence key is `agent-end` → excluded entirely.
    expect(result.agentsByProvider.claude).toBeUndefined();
  });

  it('treats unknown provider strings as `unknown`', async () => {
    const p = projectPaths(projectRoot);
    const spawn = makePresenceEvent({
      eventId: 'weird',
      event: 'agent-spawn',
      // Cast: ledger may carry a stale/garbage provider; collector must
      // normalize to `unknown`. We intentionally bypass the TS narrow by
      // structuring the cast through `as` (no `any`).
      provider: 'mystery' as unknown as ScoreboardPresenceEventV1['provider'],
      presenceKey: 'mystery-1',
      ts: new Date(FIXED_NOW - 500).toISOString(),
    });
    writeJsonl(p.presence, [spawn]);
    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.agentsByProvider.unknown?.activeAgents).toBe(1);
  });

  it('marks the summary stale when ledger contains corrupt lines', async () => {
    const p = projectPaths(projectRoot);
    mkdirSync(join(projectRoot, '.hive-flow', 'scoreboard'), { recursive: true });
    const spawn = makePresenceEvent({
      eventId: 'good',
      event: 'agent-spawn',
      provider: 'claude',
      presenceKey: 'agent-good',
      ts: new Date(FIXED_NOW - 500).toISOString(),
    });
    writeFileSync(
      p.presence,
      `${JSON.stringify(spawn)}\n{not-json\n`,
      { mode: 0o600 },
    );
    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    // Corrupt line tripped the stale flag despite a valid fresh event.
    expect(result.stale).toBe(true);
    expect(result.agentsByProvider.claude?.activeAgents).toBe(1);
  });

  it('treats a fresh agent-idle event as idle (not active)', async () => {
    const p = projectPaths(projectRoot);
    const idle = makePresenceEvent({
      eventId: 'idle-1',
      event: 'agent-idle',
      provider: 'codex',
      presenceKey: 'idle-key',
      ts: new Date(FIXED_NOW - 500).toISOString(),
    });
    writeJsonl(p.presence, [idle]);
    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    expect(result.agentsByProvider.codex?.activeAgents).toBe(0);
    expect(result.agentsByProvider.codex?.idleAgents).toBe(1);
    expect(result.agentsByProvider.codex?.staleAgents).toBe(0);
  });

  it('flags call-failed as a failed call rather than completed', async () => {
    const p = projectPaths(projectRoot);
    const start = makeCallEvent({
      eventId: 'call-fail',
      event: 'call-start',
      provider: 'openrouter',
      ts: new Date(FIXED_NOW - 3_000).toISOString(),
    });
    const failed = makeCallEvent({
      eventId: 'call-fail',
      event: 'call-failed',
      provider: 'openrouter',
      ts: new Date(FIXED_NOW - 2_000).toISOString(),
    });
    writeJsonl(p.calls, [start, failed]);
    const result = await collectScoreboard({ projectRoot, now: FIXED_NOW });
    // Mutually exclusive counters: failed calls populate `failedCalls` ONLY,
    // not `calls` (which is reserved for observably completed calls). See
    // recorder-side semantics in `recorders/__tests__/scoreboard.test.ts:93`.
    expect(result.callsByProvider.openrouter?.calls ?? 0).toBe(0);
    expect(result.callsByProvider.openrouter?.failedCalls).toBe(1);
    expect(result.callsByProvider.openrouter?.inFlightCalls ?? 0).toBe(0);
  });
});
