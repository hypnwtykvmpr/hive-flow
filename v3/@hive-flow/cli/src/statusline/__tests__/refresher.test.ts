// v3/@hive-flow/cli/src/statusline/__tests__/refresher.test.ts
//
// Wave 7 regression tests for `refreshStatuslineSnapshot`. These tests use
// canned ledger fixtures so the refresher exercise is independent of the
// Wave-4 recorders, the Wave-5 collectors' internal control plane, and the
// renderer. The test scenarios match the brief from the task description:
//
//   1. End-to-end happy path with all 4 ledgers populated.
//   2. One collector fails -> per-source `error` state, others unaffected.
//   3. Drain-before-collect ordering enforced (spool -> ledger -> collector).
//   4. Debounce: force=false returns cached, doesn't re-collect.
//   5. Debounce: force=true bypasses cache, re-collects.
//   6. ADR-051 stdin-first: stdin context wins over autopilot-state.
//   7. ADR-051 fallback: stdin omits context, autopilot-state used.
//   8. ADR-051 missing both: context omitted, not invented.
//   9. Atomic write: cache.json never half-written (temp+rename via storage).
//  10. Symlinked cache rejected via Wave 2.5A guard.
//  11. Promise.all parallelism: every collector starts before any is released.
//  12. Snapshot version + identity stamped from `resolveProjectScope`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { sessionKeyFor } from '../../shared/index.js';

import { refreshStatuslineSnapshot } from '../refresher.js';
import { globalStatuslinePaths, statuslinePaths } from '../paths.js';
import { clearProjectScopeCache } from '../project-scope.js';
import type {
  ProviderCallEventV1,
  ScoreboardPresenceEventV1,
  SessionEventV1,
  StatuslineSnapshotV1,
  TestRunEventV1,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse('2026-05-21T12:00:00.000Z');

function writeJsonl(filePath: string, lines: ReadonlyArray<string>): void {
  mkdirSync(filePath.replace(/[/][^/]+$/, ''), { recursive: true });
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
}

function makeSessionEvent(
  ts: string,
  overrides: Partial<SessionEventV1> & { repoRoot: string },
): SessionEventV1 {
  return {
    version: 1,
    eventId: overrides.eventId ?? `sess-${ts}`,
    ts,
    repoRoot: overrides.repoRoot,
    projectKey: overrides.projectKey ?? 'project-key',
    hostCli: overrides.hostCli ?? 'claude-code',
    sessionId: overrides.sessionId ?? 's1',
    event: overrides.event ?? 'session-heartbeat',
    sessionIdSource: overrides.sessionIdSource ?? 'native',
    confidence: overrides.confidence ?? 'direct',
    producerKind: overrides.producerKind ?? 'interactive-host',
    producerId: overrides.producerId ?? 'host-1',
  };
}

function makePresenceEvent(
  overrides: Partial<ScoreboardPresenceEventV1> & {
    eventId: string;
    event: ScoreboardPresenceEventV1['event'];
    provider: ScoreboardPresenceEventV1['provider'];
    presenceKey: string;
  },
): ScoreboardPresenceEventV1 {
  return {
    version: 1,
    eventId: overrides.eventId,
    ts: overrides.ts ?? new Date(FIXED_NOW - 1_000).toISOString(),
    repoRoot: overrides.repoRoot ?? '/repo',
    projectKey: overrides.projectKey ?? 'project-key',
    hostCli: overrides.hostCli ?? 'claude-code',
    provider: overrides.provider,
    producerKind: overrides.producerKind ?? 'interactive-host',
    producerId: overrides.producerId ?? 'host-1',
    presenceKey: overrides.presenceKey,
    event: overrides.event,
  };
}

function makeCallEvent(
  overrides: Partial<ProviderCallEventV1> & {
    eventId: string;
    event: ProviderCallEventV1['event'];
    provider: ProviderCallEventV1['provider'];
  },
): ProviderCallEventV1 {
  return {
    version: 1,
    eventId: overrides.eventId,
    ts: overrides.ts ?? new Date(FIXED_NOW - 1_000).toISOString(),
    repoRoot: overrides.repoRoot ?? '/repo',
    projectKey: overrides.projectKey ?? 'project-key',
    hostCli: overrides.hostCli ?? 'claude-code',
    provider: overrides.provider,
    producerKind: overrides.producerKind ?? 'interactive-host',
    producerId: overrides.producerId ?? 'host-1',
    event: overrides.event,
  };
}

function makeSuiteEvent(
  ts: string,
  overrides: Partial<TestRunEventV1> = {},
): TestRunEventV1 {
  return {
    version: 1,
    eventId: overrides.eventId ?? `suite-${ts}`,
    ts,
    repoRoot: overrides.repoRoot ?? '/repo',
    projectKey: overrides.projectKey ?? 'project-key',
    runner: overrides.runner ?? 'vitest',
    kind: 'suite',
    passed: overrides.passed ?? 10,
    failed: overrides.failed ?? 0,
    skipped: overrides.skipped ?? 0,
    total: overrides.total ?? 10,
    producerKind: overrides.producerKind ?? 'manual',
    producerId: overrides.producerId ?? 'test',
  };
}

function makeAttentionEmit(
  id: string,
  ts: string,
): { eventId: string; ts: string; event: 'emit'; item: Record<string, unknown> } {
  return {
    eventId: `attn-emit-${id}`,
    ts,
    event: 'emit',
    item: {
      id,
      ts,
      severity: 'warn',
      source: 'test',
      message: `attention ${id}`,
      redacted: false,
    },
  };
}

/**
 * Populate the four canonical ledgers with valid events so the refresher
 * sees a "healthy" project.
 */
function populateAllLedgers(root: string): void {
  const paths = statuslinePaths(root);
  const tsRecent = new Date(FIXED_NOW - 5_000).toISOString();

  // Sessions
  writeJsonl(paths.sessionsLedger, [
    JSON.stringify(
      makeSessionEvent(tsRecent, {
        repoRoot: root,
        sessionId: 'sess-active',
        event: 'session-heartbeat',
      }),
    ),
  ]);

  // Scoreboard presence + calls
  writeJsonl(paths.scoreboardPresenceLedger, [
    JSON.stringify(
      makePresenceEvent({
        eventId: 'p-1',
        event: 'agent-spawn',
        provider: 'codex',
        presenceKey: 'codex:s-1:a-1',
      }),
    ),
  ]);
  writeJsonl(paths.scoreboardCallsLedger, [
    JSON.stringify(
      makeCallEvent({
        eventId: 'c-1',
        event: 'call-complete',
        provider: 'codex',
      }),
    ),
  ]);

  // Tests
  writeJsonl(paths.testsLedger, [JSON.stringify(makeSuiteEvent(tsRecent))]);

  // Attention
  writeJsonl(paths.attentionLedger, [JSON.stringify(makeAttentionEmit('a-1', tsRecent))]);
}

// ---------------------------------------------------------------------------
// Test root + setup/teardown
// ---------------------------------------------------------------------------

describe('refreshStatuslineSnapshot', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-refresher-'));
    clearProjectScopeCache();
  });

  afterEach(() => {
    clearProjectScopeCache();
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. End-to-end happy path
  // -------------------------------------------------------------------------

  it('composes a full snapshot from all 4 ledgers', async () => {
    populateAllLedgers(root);

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.generatedAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(snapshot.projectKey).toMatch(/^[0-9a-f]{16}$/);
    expect(snapshot.projectRoot).toBeDefined();

    // Sessions: 1 active session.
    expect(snapshot.sessions).toBeDefined();
    expect(snapshot.sessions?.active).toBe(1);
    expect(snapshot.sources.sessions?.state).toMatch(/fresh|degraded/);

    // Scoreboard: 1 presence, 1 call.
    expect(snapshot.scoreboard).toBeDefined();
    expect(snapshot.scoreboard?.callsByProvider.codex).toBeDefined();
    expect(snapshot.sources.scoreboard?.state).toMatch(/fresh|degraded/);

    // Tests: suite present.
    expect(snapshot.tests?.suite).toBeDefined();
    // No fingerprint passed in => no stale gate.

    // Attention: 1 unresolved item.
    expect(snapshot.attention).toBeDefined();
    expect(snapshot.attention?.unresolved.length).toBe(1);
    expect(snapshot.sources.attention?.state).toBe('fresh');

    // Swarm: no store.json present, so swarm freshness is 'unavailable'.
    expect(snapshot.sources.swarm?.state).toBe('unavailable');

    // Cache file landed on disk.
    expect(existsSync(statuslinePaths(root).cache)).toBe(true);
  });

  it('includes materialized memory, MCP, hooks, and ADR current snapshots', async () => {
    populateAllLedgers(root);
    const paths = statuslinePaths(root);
    const observedAt = new Date(FIXED_NOW - 1_000).toISOString();

    mkdirSync(join(root, '.hive-flow', 'memory'), { recursive: true });
    writeFileSync(
      paths.memoryStats,
      JSON.stringify({
        embeddings: { count: 12, source: 'hivememory', observedAt },
        memories: { count: 34, source: 'hivememory', observedAt },
        dbSizeBytes: 4096,
        sourceDescription: 'hivememory',
      }),
      'utf8',
    );

    mkdirSync(join(root, '.hive-flow', 'mcp'), { recursive: true });
    writeFileSync(
      paths.mcpHealth,
      JSON.stringify({
        version: 1,
        observedAt,
        probeVersion: 1,
        source: 'setup-verify-json-rpc',
        total: 3,
        configured: 3,
        runtimeUp: 2,
        state: 'config-present',
      }),
      'utf8',
    );

    mkdirSync(join(root, '.hive-flow', 'hooks'), { recursive: true });
    writeFileSync(
      paths.hooksInventory,
      JSON.stringify({
        version: 1,
        projectKey: 'project-key',
        updatedAt: observedAt,
        hosts: {
          'claude-code': {
            categories: 2,
            matchers: 3,
            commands: 4,
            source: 'settings.json',
            observedAt,
          },
        },
      }),
      'utf8',
    );

    mkdirSync(join(root, '.hive-flow', 'adrs'), { recursive: true });
    writeFileSync(
      paths.adrsCurrent,
      JSON.stringify({
        total: 1,
        byStatus: { accepted: 1 },
        fingerprint: 'adr-fingerprint',
        rawStatuses: [
          { file: 'docs/adrs/adr-001.md', rawStatus: 'accepted', status: 'accepted', statusSource: 'frontmatter' },
        ],
      }),
      'utf8',
    );

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    expect(snapshot.memory?.embeddings?.count).toBe(12);
    expect(snapshot.memory?.memories?.count).toBe(34);
    expect(snapshot.mcp?.runtimeUp).toBe(2);
    expect(snapshot.hooks?.commands).toBe(4);
    expect(snapshot.adrs?.fingerprint).toBe('adr-fingerprint');
    expect(snapshot.sources.memory?.state).toBe('fresh');
    expect(snapshot.sources.mcp?.state).toBe('degraded');
    expect(snapshot.sources.hooks?.state).toBe('fresh');
    expect(snapshot.sources.adrs?.fingerprint).toBe('adr-fingerprint');
  });

  it('populates a git summary in full snapshot mode when a git repo is present', async () => {
    const paths = statuslinePaths(root);
    mkdirSync(paths.root, { recursive: true });
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, 'untracked.txt'), 'changed\n', 'utf8');

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
      force: true,
    });

    expect(snapshot.git).toBeDefined();
    expect(snapshot.git?.untracked).toBeGreaterThanOrEqual(1);
    expect(snapshot.sources.git?.state).toBe('fresh');
  });

  // -------------------------------------------------------------------------
  // 2. One collector fails — others unaffected
  // -------------------------------------------------------------------------

  it('records error freshness when a collector throws; other sources unaffected', async () => {
    populateAllLedgers(root);
    // Corrupt the scoreboard CALLS ledger so it exceeds the readJsonl size cap
    // -- actually, malformed lines are tolerated; for an error we need the
    // collector to actually throw. We force this by writing a calls ledger
    // entry as a symlink target outside .hive-flow (storage rejects
    // symlinked .hive-flow paths). Simplest reliable approach: symlink the
    // calls ledger to point outside the project root.
    const paths = statuslinePaths(root);
    rmSync(paths.scoreboardCallsLedger, { force: true });
    const outside = join(tmpdir(), `outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(outside, '\n');
    symlinkSync(outside, paths.scoreboardCallsLedger);

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    // Scoreboard collector should error out (symlinked .hive-flow file).
    expect(snapshot.sources.scoreboard?.state).toBe('error');
    expect(snapshot.sources.scoreboard?.reason).toContain('scoreboard');

    // Other collectors still populated.
    expect(snapshot.sources.sessions?.state).not.toBe('error');
    expect(snapshot.sources.tests?.state).not.toBe('error');
    expect(snapshot.sources.attention?.state).not.toBe('error');

    rmSync(outside, { force: true });
  });

  // -------------------------------------------------------------------------
  // 3. Drain-before-collect ordering
  // -------------------------------------------------------------------------

  it('drains the spool BEFORE running the sessions collector', async () => {
    // Place a session event in the spool, NOT in the ledger.
    const paths = statuslinePaths(root);
    const spoolDir = join(paths.spoolRoot, 'sessions');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = join(spoolDir, `${Date.now()}-${process.pid}-spool-1.json`);
    writeFileSync(
      spoolFile,
      JSON.stringify(
        makeSessionEvent(new Date(FIXED_NOW - 3_000).toISOString(), {
          repoRoot: root,
          eventId: 'evt-spool-1',
          sessionId: 'sess-from-spool',
          event: 'session-heartbeat',
        }),
      ) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
    expect(existsSync(paths.sessionsLedger)).toBe(false);

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    // The drainer moved the spool entry into the ledger BEFORE the sessions
    // collector ran -- so the snapshot reports a live session.
    expect(snapshot.sessions?.active).toBeGreaterThanOrEqual(1);
    const ids = snapshot.sessions?.current?.map((row) => row.sessionId) ?? [];
    expect(ids).toContain('sess-from-spool');

    // Ledger now exists, spool entry gone.
    expect(existsSync(paths.sessionsLedger)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Debounce: force=false returns cached
  // -------------------------------------------------------------------------

  it('honors debounce: a quick second call returns the cached snapshot without re-collecting', async () => {
    populateAllLedgers(root);
    const first = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });
    expect(first.generatedAt).toBe(new Date(FIXED_NOW).toISOString());

    // Mutate the sessions ledger so a re-collect would see the change.
    const paths = statuslinePaths(root);
    appendFileSync(
      paths.sessionsLedger,
      JSON.stringify(
        makeSessionEvent(new Date(FIXED_NOW - 1_000).toISOString(), {
          repoRoot: root,
          sessionId: 'sess-new',
          eventId: 'sess-new-1',
        }),
      ) + '\n',
    );

    // Second call within debounce window -> returns cached snapshot.
    const second = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW + 100,
    });

    expect(second.generatedAt).toBe(first.generatedAt);
    // Cached sessions count must not reflect the new ledger entry.
    expect(second.sessions?.current?.map((r) => r.sessionId).includes('sess-new')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. Debounce: force=true bypasses cache
  // -------------------------------------------------------------------------

  it('force: true bypasses the debounce and re-collects', async () => {
    populateAllLedgers(root);
    const first = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    const paths = statuslinePaths(root);
    appendFileSync(
      paths.sessionsLedger,
      JSON.stringify(
        makeSessionEvent(new Date(FIXED_NOW - 500).toISOString(), {
          repoRoot: root,
          sessionId: 'sess-forced',
          eventId: 'sess-forced-1',
        }),
      ) + '\n',
    );

    const second = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW + 50,
      force: true,
    });

    // Forced refresh DID re-collect: generatedAt differs and the new session
    // appears in the live set.
    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect(second.sessions?.current?.map((r) => r.sessionId)).toContain('sess-forced');
  });

  // -------------------------------------------------------------------------
  // 6. ADR-051 stdin wins over autopilot-state
  // -------------------------------------------------------------------------

  it('uses stdin context when stdin carries percentage; ignores autopilot-state percentage', async () => {
    // Write an autopilot-state file with a different percentage.
    const autopilotDir = join(root, '.hive-flow', 'data');
    mkdirSync(autopilotDir, { recursive: true });
    writeFileSync(
      join(autopilotDir, 'autopilot-state.json'),
      JSON.stringify({
        lastPercentage: 0.9, // 90%
        lastTokenEstimate: 99_999,
        lastCheck: new Date(FIXED_NOW - 60_000).toISOString(),
      }),
    );

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
      stdinData: {
        context_window: {
          used_percentage: 42,
          total_input_tokens: 1234,
          total_output_tokens: 567,
          context_window_size: 1_000_000,
        },
      },
    });

    expect(snapshot.context).toBeDefined();
    expect(snapshot.context?.source).toBe('stdin');
    expect(snapshot.context?.percentage).toBe(42);
    expect(snapshot.context?.inputTokens).toBe(1234);
    expect(snapshot.context?.outputTokens).toBe(567);
    expect(snapshot.context?.contextWindow).toBe(1_000_000);
    // Token estimate is autopilot-only, but stdin wins on `source`. The token
    // estimate is filled from the fallback because stdin didn't carry it.
    expect(snapshot.context?.tokenEstimate).toBe(99_999);
  });

  // -------------------------------------------------------------------------
  // 7. ADR-051 fallback: stdin lacks context, autopilot-state used
  // -------------------------------------------------------------------------

  it('falls back to autopilot-state when stdin omits context', async () => {
    const autopilotDir = join(root, '.hive-flow', 'data');
    mkdirSync(autopilotDir, { recursive: true });
    const lastCheckIso = new Date(FIXED_NOW - 30_000).toISOString();
    writeFileSync(
      join(autopilotDir, 'autopilot-state.json'),
      JSON.stringify({
        lastPercentage: 73, // already-percent form
        lastTokenEstimate: 12_345,
        pruneCount: 2,
        lastCheck: lastCheckIso,
      }),
    );

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    expect(snapshot.context).toBeDefined();
    expect(snapshot.context?.source).toBe('autopilot-state');
    expect(snapshot.context?.percentage).toBe(73);
    expect(snapshot.context?.tokenEstimate).toBe(12_345);
    expect(snapshot.context?.pruneCount).toBe(2);
    expect(snapshot.context?.lastCheck).toBe(lastCheckIso);
    expect(snapshot.context?.observedAt).toBe(lastCheckIso);
  });

  // -------------------------------------------------------------------------
  // 8. ADR-051 missing both: context omitted
  // -------------------------------------------------------------------------

  it('omits context entirely when neither stdin nor autopilot-state has data', async () => {
    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    expect(snapshot.context).toBeUndefined();
    expect(snapshot.sources.context?.state).toBe('unavailable');
  });

  // -------------------------------------------------------------------------
  // 9. Atomic write
  // -------------------------------------------------------------------------

  it('writes the cache atomically: no partial-write window observable', async () => {
    populateAllLedgers(root);

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    const cachePath = statuslinePaths(root).cache;
    expect(existsSync(cachePath)).toBe(true);
    // The persisted file must parse to the SAME snapshot we returned.
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as StatuslineSnapshotV1;
    expect(persisted.version).toBe(1);
    expect(persisted.projectKey).toBe(snapshot.projectKey);
    expect(persisted.generatedAt).toBe(snapshot.generatedAt);

    // Temp files (`.tmp-<pid>-<ts>`) must NOT linger after a successful write.
    const cacheDir = cachePath.replace(/[/][^/]+$/, '');
    const cwd = readFileSync(cachePath, 'utf8');
    expect(cwd.length).toBeGreaterThan(0);
    // No `.tmp-` files in state/.
    const entries = readdirSync(cacheDir);
    const tmpEntries = entries.filter((e) => e.includes('.tmp-'));
    expect(tmpEntries).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 10. Symlinked cache rejected
  // -------------------------------------------------------------------------

  it('rejects a symlinked cache file via the Wave 2.5A guard', async () => {
    populateAllLedgers(root);
    // Pre-create the cache file as a symlink pointing outside the project.
    const cachePath = statuslinePaths(root).cache;
    mkdirSync(cachePath.replace(/[/][^/]+$/, ''), { recursive: true });
    const outside = join(tmpdir(), `outside-cache-${Date.now()}.json`);
    writeFileSync(outside, '{}');
    symlinkSync(outside, cachePath);

    await expect(
      refreshStatuslineSnapshot({ projectRoot: root, now: FIXED_NOW }),
    ).rejects.toThrowError(/symlink/i);

    rmSync(outside, { force: true });
  });

  // -------------------------------------------------------------------------
  // 11. Promise.all parallelism (structural proof via collector latches)
  // -------------------------------------------------------------------------

  it('starts every collector before releasing any collector result', async () => {
    const expectedCollectors = ['scoreboard', 'sessions', 'tests', 'attention', 'swarm', 'git'];
    const startedCollectors: string[] = [];
    let resolveFirstStart!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStart = resolve;
    });
    let releaseCollectors!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseCollectors = resolve;
    });

    async function waitAtCollectorLatch<T>(
      collector: string,
      actualCollect: () => Promise<T>,
    ): Promise<T> {
      startedCollectors.push(collector);
      resolveFirstStart();
      await release;
      return actualCollect();
    }

    vi.resetModules();
    vi.doMock('../collectors/sessions.js', async () => {
      const actual = await vi.importActual<typeof import('../collectors/sessions.js')>(
        '../collectors/sessions.js',
      );
      return {
        ...actual,
        collectSessions: async (opts: Parameters<typeof actual.collectSessions>[0]) => {
          return waitAtCollectorLatch('sessions', () => actual.collectSessions(opts));
        },
      };
    });
    vi.doMock('../collectors/scoreboard.js', async () => {
      const actual = await vi.importActual<typeof import('../collectors/scoreboard.js')>(
        '../collectors/scoreboard.js',
      );
      return {
        ...actual,
        collectScoreboard: async (opts: Parameters<typeof actual.collectScoreboard>[0]) => {
          return waitAtCollectorLatch('scoreboard', () => actual.collectScoreboard(opts));
        },
      };
    });
    vi.doMock('../collectors/tests.js', async () => {
      const actual = await vi.importActual<typeof import('../collectors/tests.js')>(
        '../collectors/tests.js',
      );
      return {
        ...actual,
        collectTests: async (opts: Parameters<typeof actual.collectTests>[0]) => {
          return waitAtCollectorLatch('tests', () => actual.collectTests(opts));
        },
      };
    });
    vi.doMock('../collectors/attention.js', async () => {
      const actual = await vi.importActual<typeof import('../collectors/attention.js')>(
        '../collectors/attention.js',
      );
      return {
        ...actual,
        collectAttention: async (opts: Parameters<typeof actual.collectAttention>[0]) => {
          return waitAtCollectorLatch('attention', () => actual.collectAttention(opts));
        },
      };
    });
    vi.doMock('../collectors/swarm.js', async () => {
      const actual = await vi.importActual<typeof import('../collectors/swarm.js')>(
        '../collectors/swarm.js',
      );
      return {
        ...actual,
        collectSwarm: async (opts: Parameters<typeof actual.collectSwarm>[0]) => {
          return waitAtCollectorLatch('swarm', () => actual.collectSwarm(opts));
        },
      };
    });
    vi.doMock('../inline-collectors.js', async () => {
      const actual = await vi.importActual<typeof import('../inline-collectors.js')>(
        '../inline-collectors.js',
      );
      return {
        ...actual,
        collectInlineSnapshot: async (opts: Parameters<typeof actual.collectInlineSnapshot>[0]) => {
          return waitAtCollectorLatch('git', () => actual.collectInlineSnapshot(opts));
        },
      };
    });

    try {
      const mod = await import('../refresher.js');
      populateAllLedgers(root);

      const refresh = mod.refreshStatuslineSnapshot({
        projectRoot: root,
        now: FIXED_NOW,
      });
      await firstStarted;

      expect(new Set(startedCollectors)).toEqual(new Set(expectedCollectors));

      releaseCollectors();
      await refresh;
    } finally {
      releaseCollectors();
      vi.resetModules();
      vi.doUnmock('../collectors/sessions.js');
      vi.doUnmock('../collectors/scoreboard.js');
      vi.doUnmock('../collectors/tests.js');
      vi.doUnmock('../collectors/attention.js');
      vi.doUnmock('../collectors/swarm.js');
      vi.doUnmock('../inline-collectors.js');
    }
  });

  // -------------------------------------------------------------------------
  // 12. Snapshot identity stamping
  // -------------------------------------------------------------------------

  it('stamps version, generatedAt, projectRoot, worktreeRoot, projectKey from resolveProjectScope', async () => {
    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.generatedAt).toBe(new Date(FIXED_NOW).toISOString());
    // generatedAt is a valid ISO timestamp (parses back to FIXED_NOW).
    expect(Date.parse(snapshot.generatedAt)).toBe(FIXED_NOW);

    expect(typeof snapshot.projectRoot).toBe('string');
    expect(snapshot.projectRoot.length).toBeGreaterThan(0);
    expect(typeof snapshot.projectKey).toBe('string');
    expect(snapshot.projectKey).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof snapshot.repoIdentity).toBe('string');
    // worktreeRoot is populated by the positional async scope resolver.
    expect(typeof snapshot.worktreeRoot).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Additional: refresh marker is touched after a successful refresh
  // -------------------------------------------------------------------------

  it('touches the refresh-request marker after writing the cache', async () => {
    populateAllLedgers(root);
    const paths = statuslinePaths(root);
    expect(existsSync(paths.refreshRequest)).toBe(false);

    await refreshStatuslineSnapshot({ projectRoot: root, now: FIXED_NOW });

    expect(existsSync(paths.refreshRequest)).toBe(true);
  });

  it('mirrors the refreshed snapshot into the global project/session cache', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-refresher-global-home-'));
    const origHome = process.env.HIVE_FLOW_HOME;
    const stdinData = {
      session_id: 'refresh-session-a',
      client_kind: 'claude-code',
      workspace: { current_dir: root, project_dir: root },
    };
    process.env.HIVE_FLOW_HOME = home;
    try {
      populateAllLedgers(root);
      const snapshot = await refreshStatuslineSnapshot({
        projectRoot: root,
        stdinData,
        now: FIXED_NOW,
        force: true,
      });
      const globalPaths = globalStatuslinePaths(
        snapshot.projectKey,
        sessionKeyFor(stdinData, {}),
        { HIVE_FLOW_HOME: home } as NodeJS.ProcessEnv,
      );

      expect(existsSync(statuslinePaths(root).cache)).toBe(true);
      expect(existsSync(globalPaths.cache)).toBe(true);
      const mirrored = JSON.parse(readFileSync(globalPaths.cache, 'utf8')) as StatuslineSnapshotV1;
      expect(mirrored.projectRoot).toBe(snapshot.projectRoot);
      expect(mirrored.projectKey).toBe(snapshot.projectKey);
      expect(mirrored.generatedAt).toBe(snapshot.generatedAt);
      expect(mirrored.swarm).toEqual(snapshot.swarm);
    } finally {
      if (origHome !== undefined) process.env.HIVE_FLOW_HOME = origHome;
      else delete process.env.HIVE_FLOW_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Additional: rendererHints are stamped from config
  // -------------------------------------------------------------------------

  it('stamps rendererHints from the resolved config', async () => {
    populateAllLedgers(root);
    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    expect(snapshot.rendererHints).toBeDefined();
    expect(snapshot.rendererHints?.activeAgentDetail).toBe('off');
    expect(snapshot.rendererHints?.useRoleIcons).toBe(false);
    expect(snapshot.rendererHints?.allow16ColorYellowFallback).toBe(false);
    expect(snapshot.rendererHints?.openRouterBreakdown).toBe('aggregate');
  });

  // -------------------------------------------------------------------------
  // Additional: missing projectRoot rejection
  // -------------------------------------------------------------------------

  it('rejects missing/empty projectRoot at the API boundary', async () => {
    await expect(
      refreshStatuslineSnapshot({ projectRoot: '' }),
    ).rejects.toThrowError(/projectRoot/);
  });

  // -------------------------------------------------------------------------
  // Codex Phase 7 Finding 1 (BLOCKER): refresh marker bypasses symlink guard
  //
  // Before the fix, the local `touchRefreshMarker` in refresher.ts called
  // `writeFile` directly on `paths.refreshRequest`, which silently followed
  // a pre-existing symlink at that path and overwrote the linked target.
  // After the fix, the refresher delegates to `touchRefreshRequest` from
  // `storage.ts` which runs `assertSafeStatuslineStoragePath` first; that
  // helper throws `StatuslineStoragePathError(/symlink/)` and the
  // refresher swallows it. The KEY assertion is that the OUTSIDE FILE is
  // untouched.
  // -------------------------------------------------------------------------

  it('rejects a symlinked refresh.request marker via Wave 2.5A guard (Finding 1)', async () => {
    populateAllLedgers(root);
    const paths = statuslinePaths(root);
    mkdirSync(paths.refreshRequest.replace(/[/][^/]+$/, ''), { recursive: true });

    // Pre-create the marker as a symlink to a known file OUTSIDE the project.
    const outside = join(
      tmpdir(),
      `hf-refresh-symlink-target-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    const originalContent = 'do-not-overwrite-me';
    writeFileSync(outside, originalContent, { encoding: 'utf8' });
    symlinkSync(outside, paths.refreshRequest);

    // The refresh itself must succeed (cache.json written, snapshot returned).
    // Only the marker-touch step fails, and the refresher swallows it.
    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });
    expect(snapshot.version).toBe(1);
    expect(existsSync(statuslinePaths(root).cache)).toBe(true);

    // CRITICAL: the outside file's content is unchanged. A direct `writeFile`
    // (the pre-fix behaviour) would have followed the symlink and replaced
    // `originalContent` with the new ISO timestamp.
    const after = readFileSync(outside, 'utf8');
    expect(after).toBe(originalContent);

    rmSync(outside, { force: true });
  });

  // -------------------------------------------------------------------------
  // Codex Phase 7 Finding (HIGH, READ-SIDE): debounce stat follows symlinks
  //
  // Pre-fix: `readCachedIfFresh` called `stat(refreshRequestPath)` (the
  // follow-symlinks variant) on `.hive-flow/state/refresh.request`. A
  // symlinked marker pointing at a fresh outside file therefore made the
  // debounce window think the marker was recently touched, the cached
  // snapshot was returned, and the real refresh was suppressed.
  //
  // Post-fix: `readCachedIfFresh` calls `readRefreshMarkerStat(projectRoot)`,
  // which (a) walks intermediate `.hive-flow/` segments through
  // `assertSafeStatuslineStoragePath` and (b) `lstat`s the marker leaf
  // itself. A symlinked marker collapses to `undefined`, the debounce
  // treats it as "no marker", and a full refresh runs.
  //
  // The bug-hunt assertion: between a normal refresh (which populates
  // `cache.json` and `refresh.request`) and a second `force: false` refresh,
  // we (1) replace the marker with a symlink to a fresh outside file and
  // (2) bump a ledger entry so a real re-collect would observe the new
  // session. The post-fix refresher MUST re-collect (= the new session is
  // present in the returned snapshot AND the outside symlink target is
  // untouched).
  // -------------------------------------------------------------------------

  it('rejects a symlinked refresh.request marker on the read side (Finding HIGH)', async () => {
    populateAllLedgers(root);
    const paths = statuslinePaths(root);

    // Step 1: warm the cache with a normal refresh.
    const first = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });
    expect(existsSync(paths.cache)).toBe(true);
    expect(existsSync(paths.refreshRequest)).toBe(true);

    // Step 2: append a NEW session event so a real re-collect would observe
    // it. Its presence in the second snapshot is the signal that the
    // debounce did NOT short-circuit on the attacker-controlled marker.
    appendFileSync(
      paths.sessionsLedger,
      JSON.stringify(
        makeSessionEvent(new Date(FIXED_NOW - 1_000).toISOString(), {
          repoRoot: root,
          sessionId: 'sess-symlink-read',
          eventId: 'sess-symlink-read-1',
        }),
      ) + '\n',
    );

    // Step 3: replace the marker file with a SYMLINK pointing at a fresh
    // outside file. A bare `stat()` would follow the link and report a
    // fresh mtime; an `lstat()` on the symlink itself rejects it.
    rmSync(paths.refreshRequest, { force: true });
    const outside = join(
      tmpdir(),
      `hf-refresh-marker-read-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    const originalContent = 'outside-marker-do-not-touch';
    writeFileSync(outside, originalContent, { encoding: 'utf8' });
    // Force the outside file's mtime to a known FRESH timestamp: 50ms before
    // the next refresh's `now`. A follow-symlinks `stat` would observe this
    // as "marker recently touched" and short-circuit.
    const freshMs = FIXED_NOW - 50;
    utimesSync(outside, new Date(freshMs), new Date(freshMs));
    symlinkSync(outside, paths.refreshRequest);

    // Step 4: second refresh WITHOUT `force`. Pre-fix: the symlinked
    // marker's apparent mtime is fresh -> cached snapshot returned ->
    // re-collect suppressed -> new session NOT in the result. Post-fix:
    // the lstat-based helper rejects the symlink -> full refresh runs ->
    // new session present.
    const second = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW + 100,
      // explicit force: false to exercise the debounce path.
      force: false,
    });

    // Primary assertion: a real re-collect happened, so `generatedAt`
    // bumped past the first refresh's value.
    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect(Date.parse(second.generatedAt)).toBe(FIXED_NOW + 100);
    // Secondary assertion: the new session appears in the re-collected
    // snapshot.
    const sessionIds = second.sessions?.current?.map((row) => row.sessionId) ?? [];
    expect(sessionIds).toContain('sess-symlink-read');

    // Tertiary assertion: the outside file's content is unchanged. The
    // read-side guard is a pure observer, but if a future regression
    // ever made it write through the marker symlink, this assertion
    // would catch it. The `originalContent` must survive the refresh.
    const after = readFileSync(outside, 'utf8');
    expect(after).toBe(originalContent);

    rmSync(outside, { force: true });
  });

  // -------------------------------------------------------------------------
  // Codex Phase 7 Finding 2 (MEDIUM): freshness uses wall-clock instead of
  // injected `nowMs`.
  //
  // The snapshot's `generatedAt` is derived from `opts.now`, but the
  // pre-fix `stateFromObserved` computed age via `Date.now()`. Under a
  // far-future injected clock, the context source's observedAt (= the
  // autopilot-state `lastCheck` we just wrote at real wall time) is
  // "now-ish" relative to `Date.now()` -> `fresh`, but is "an hour old"
  // relative to `opts.now` -> `stale`. The fix uses `nowMs`, so the test
  // expects `stale`.
  // -------------------------------------------------------------------------

  it('uses injected nowMs for context freshness state, not wall clock (Finding 2)', async () => {
    // Write autopilot-state with lastCheck = REAL wall time so the
    // collector reports observedAt = ~now (relative to Date.now()).
    const autopilotDir = join(root, '.hive-flow', 'data');
    mkdirSync(autopilotDir, { recursive: true });
    const wallNowIso = new Date().toISOString();
    writeFileSync(
      join(autopilotDir, 'autopilot-state.json'),
      JSON.stringify({
        lastPercentage: 55,
        lastTokenEstimate: 12_345,
        lastCheck: wallNowIso,
      }),
    );

    // Inject nowMs far in the future (1 hour ahead of wall clock). The
    // context source TTL is 5 minutes (DEFAULT_SOURCE_TTLS.context), so a
    // 1-hour gap from the injected clock must mark the source `stale`.
    const futureNowMs = Date.now() + 60 * 60_000;

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: futureNowMs,
    });

    expect(snapshot.context).toBeDefined();
    expect(snapshot.context?.observedAt).toBe(wallNowIso);
    // With the BUG: age = Date.now() - observedMs ~= 0 -> 'fresh'.
    // With the FIX: age = futureNowMs - observedMs ~= 1hr -> 'stale'.
    expect(snapshot.sources.context?.state).toBe('stale');
  });

  // -------------------------------------------------------------------------
  // Codex Phase 7 Finding 3 (MEDIUM): autopilot-state read is unbounded
  // under TOCTOU growth.
  //
  // Pre-fix: `readFile()` loaded the entire file into memory before the
  // post-read size check rejected it. A file that grew between the
  // `lstat` size probe and the read could push >cap bytes into memory.
  // Post-fix: a fixed `maxBytes + 1` buffer streams the read; the moment
  // total bytes exceed the cap, the loop returns `undefined`. We assert
  // that an oversized file collapses to "no context" (fallback-best-effort
  // semantics) and the snapshot reports `context.state === 'unavailable'`.
  // -------------------------------------------------------------------------

  it('bounds the autopilot-state read at the cap; oversize -> no context (Finding 3)', async () => {
    const autopilotDir = join(root, '.hive-flow', 'data');
    mkdirSync(autopilotDir, { recursive: true });
    // 1 MiB file (well above the 64 KiB cap). The content is valid JSON
    // padded with a large filler key so JSON.parse would otherwise succeed.
    const filler = 'x'.repeat(1024 * 1024);
    writeFileSync(
      join(autopilotDir, 'autopilot-state.json'),
      JSON.stringify({
        lastPercentage: 80,
        lastTokenEstimate: 50_000,
        lastCheck: new Date(FIXED_NOW - 1_000).toISOString(),
        filler,
      }),
    );

    // No stdin -> the only context source would be autopilot-state. With
    // the bounded read, the file is rejected as oversize and the merge
    // falls back to "no context".
    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: root,
      now: FIXED_NOW,
    });

    expect(snapshot.context).toBeUndefined();
    expect(snapshot.sources.context?.state).toBe('unavailable');
    expect(snapshot.sources.context?.reason).toBe('no stdin or autopilot context');
  });
});
