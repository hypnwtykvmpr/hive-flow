// v3/@hive-flow/cli/src/statusline/collectors/__tests__/swarm.test.ts
//
// C1 BLOCKER regression suite for the canonical swarm collector.
//
// The legacy `swarm-collector.ts` filtered `AgentRecord.status` against
// `'working' | 'running' | 'queued'`, but no MCP code path ever wrote those
// values: the canonical enum is `'spawning' | 'idle' | 'busy' | 'terminated'`.
// As a result the swarm row showed 0/0/false even when the hive was actively
// dispatching workers. Each test below pins one slice of the canonical shape
// so the regression cannot recur.
//
// Tests intentionally exercise the dict shape, the legacy array shape, the
// terminal-status drop, the freshness ladder, and the corrupt/missing
// branches.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectSwarm, DEFAULT_CAP, DEGRADED_MS, FRESH_MS } from '../swarm.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  projectRoot: string;
  storePath: string;
  advocatePath: string;
}

function setupFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-swarm-'));
  mkdirSync(join(projectRoot, '.hive-flow', 'agents'), { recursive: true });
  mkdirSync(join(projectRoot, '.hive-flow', 'data'), { recursive: true });
  return {
    projectRoot,
    storePath: join(projectRoot, '.hive-flow', 'agents', 'store.json'),
    advocatePath: join(projectRoot, '.hive-flow', 'data', 'advocate-state.json'),
  };
}

interface AgentLike {
  agentId?: string;
  agentType?: string;
  status?: string;
  provider?: string;
  resolvedModel?: string;
  model?: string;
  ownerSessionId?: unknown;
  currentTaskPid?: number;
  config?: Record<string, unknown>;
  lastResult?: Record<string, unknown>;
}

function writeStoreDict(storePath: string, agents: Record<string, AgentLike>): void {
  writeFileSync(storePath, JSON.stringify({ version: '1.0', agents }), { mode: 0o600 });
}

function writeStoreArray(storePath: string, agents: AgentLike[]): void {
  writeFileSync(storePath, JSON.stringify({ version: '1.0', agents }), { mode: 0o600 });
}

function writeHive(
  projectRoot: string,
  hiveId: string,
  workers: Array<Record<string, unknown>>,
  queenId?: string,
  ownerSessionId?: string,
  status: string = 'active',
): void {
  const hiveRoot = join(projectRoot, '.hive-flow', 'hives', hiveId);
  mkdirSync(hiveRoot, { recursive: true });
  writeFileSync(
    join(hiveRoot, 'hive.json'),
    JSON.stringify({
      hiveId,
      status,
      queenId,
      ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
      workers,
    }),
    { mode: 0o600 },
  );
}

function writeTaskResult(projectRoot: string, taskId: string): void {
  const tasksRoot = join(projectRoot, '.hive-flow', 'tasks');
  mkdirSync(tasksRoot, { recursive: true });
  writeFileSync(
    join(tasksRoot, `${taskId}.result.json`),
    JSON.stringify({ status: 'completed' }),
    { mode: 0o600 },
  );
}

function makeStoreFresh(storePath: string): void {
  // mtime = now; lstat will report ageMs ~0 -> 'fresh'.
  const now = Date.now() / 1000;
  utimesSync(storePath, now, now);
}

function makeStoreStale(storePath: string, ageMs: number): void {
  const target = (Date.now() - ageMs) / 1000;
  utimesSync(storePath, target, target);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('collectSwarm (C1 BLOCKER regression suite)', () => {
  let fix: Fixture;
  beforeEach(() => {
    fix = setupFixture();
  });
  afterEach(() => {
    rmSync(fix.projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
// C1 #1 — single 'busy' worker without a pid is not live.
// Original bug: legacy collector saw 0 because it filtered for 'working'.
// Live-count invariant: a non-terminal row needs live process evidence.
// -------------------------------------------------------------------------
  it('does not count a busy worker without live process evidence', async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': {
        agentId: 'agent-1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
      },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
    expect(result.queensAlive).toBe(0);
    expect(result.queensExecuting).toBe(0);
    expect(result.agents).toHaveLength(0);
  });

  it('excludes only busy workers whose currentTaskPid is proven dead', async () => {
    const deadPid = 424242;
    const epermPid = 424243;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0 && pid === deadPid) {
        const err = new Error('dead process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      if (signal === 0 && pid === epermPid) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    }) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      dead: {
        agentId: 'dead',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: deadPid,
      },
      live: {
        agentId: 'live',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      eperm: {
        agentId: 'eperm',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: epermPid,
      },
      legacy: {
        agentId: 'legacy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(killSpy).toHaveBeenCalledWith(deadPid, 0);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
    expect(killSpy).toHaveBeenCalledWith(epermPid, 0);
    // `dead` is excluded (ESRCH). `live` and `eperm` have valid pids => executing.
    // `legacy` has no pid => not live.
    expect(result.workersAlive).toBe(2);
    expect(result.workersExecuting).toBe(2);
    expect(result.agents.map((agent) => agent.id)).toEqual(['live', 'eperm']);
  });

  // -------------------------------------------------------------------------
  // C1 #2 — idle worker with no live process evidence does not count as live.
  // -------------------------------------------------------------------------
  it('does not count an idle worker without live process evidence', async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': {
        agentId: 'agent-1',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-a',
      },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
    expect(result.agents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // C1 #3 — spawning maps to 'queued' but still needs live process evidence.
  // -------------------------------------------------------------------------
  it("does not count a spawning worker without live process evidence", async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': {
        agentId: 'agent-1',
        agentType: 'coder',
        status: 'spawning',
        ownerSessionId: 'session-a',
      },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
    expect(result.agents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // C1 #4 — terminated workers are dropped from live counts.
  // -------------------------------------------------------------------------
  it('drops terminated workers from live counts', async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': { agentId: 'agent-1', agentType: 'coder', status: 'terminated' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
    expect(result.agents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // C1 #5 — 'failed' is also terminal and dropped.
  // -------------------------------------------------------------------------
  it('drops failed workers from live counts', async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': { agentId: 'agent-1', agentType: 'coder', status: 'failed' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
    expect(result.agents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // C1 #6 — mixed statuses aggregate only rows with live process evidence.
  // -------------------------------------------------------------------------
  it('aggregates mixed statuses using live process evidence only', async () => {
    writeStoreDict(fix.storePath, {
      b1: { agentId: 'b1', agentType: 'coder', status: 'busy', ownerSessionId: 'session-a', currentTaskPid: process.pid },
      b2: { agentId: 'b2', agentType: 'tester', status: 'busy', ownerSessionId: 'session-a' },
      i1: { agentId: 'i1', agentType: 'coder', status: 'idle', ownerSessionId: 'session-a' },
      sp1: { agentId: 'sp1', agentType: 'coder', status: 'spawning', ownerSessionId: 'session-a' },
      t1: { agentId: 't1', agentType: 'coder', status: 'terminated', ownerSessionId: 'session-a' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
    expect(result.agents.map((agent) => agent.id)).toEqual(['b1']);
  });

  // -------------------------------------------------------------------------
  // C1 #7 — legacy array shape is still recognized.
  // -------------------------------------------------------------------------
  it('handles the legacy array shape of store.agents', async () => {
    writeStoreArray(fix.storePath, [
      {
        agentId: 'a1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      { agentId: 'a2', agentType: 'coder', status: 'idle', ownerSessionId: 'session-a' },
      { agentId: 'a3', agentType: 'coder', status: 'terminated', ownerSessionId: 'session-a' },
    ]);
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
  });

  // -------------------------------------------------------------------------
  // C1 #8 — queens count separately when they have live process evidence.
  // -------------------------------------------------------------------------
  it('does not count a busy queen without live process evidence', async () => {
    writeStoreDict(fix.storePath, {
      queen1: { agentId: 'queen1', agentType: 'queen', status: 'busy', ownerSessionId: 'session-a' },
      worker1: { agentId: 'worker1', agentType: 'coder', status: 'idle', ownerSessionId: 'session-a' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.queensAlive).toBe(0);
    expect(result.queensExecuting).toBe(0);
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
  });

  it('drops ownerless rows even when they have a live pid', async () => {
    writeStoreDict(fix.storePath, {
      owned: {
        agentId: 'owned',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      ownerless: {
        agentId: 'ownerless',
        agentType: 'coder',
        status: 'busy',
        currentTaskPid: process.pid,
      },
      blankOwner: {
        agentId: 'blank-owner',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: '',
        currentTaskPid: process.pid,
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
    expect(result.agents.map((agent) => agent.id)).toEqual(['owned']);
  });

  it('drops hived agent records whose worker tasks already have result files', async () => {
    writeStoreDict(fix.storePath, {
      doneQueen: {
        agentId: 'queen-done',
        agentType: 'coordinator',
        status: 'idle',
      },
      done: {
        agentId: 'done-agent',
        agentType: 'investigator',
        status: 'idle',
        config: { hiveId: 'done-hive' },
      },
      activeQueen: {
        agentId: 'queen-active',
        agentType: 'coordinator',
        status: 'idle',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      active: {
        agentId: 'active-agent',
        agentType: 'investigator',
        status: 'idle',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        config: { hiveId: 'active-hive' },
      },
      standalone: {
        agentId: 'standalone-agent',
        agentType: 'researcher',
        status: 'idle',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
    });
    writeHive(fix.projectRoot, 'done-hive', [
      { agentId: 'done-agent', workerId: 'done-agent', status: 'idle', taskId: 'task-done' },
    ], 'queen-done');
    writeTaskResult(fix.projectRoot, 'task-done');
    writeHive(fix.projectRoot, 'active-hive', [
      { agentId: 'active-agent', workerId: 'active-agent', status: 'idle', taskId: 'task-open', currentTaskPid: process.pid },
    ], 'queen-active', 'session-a');

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.agents.map((agent) => agent.id)).toEqual([
      'queen-active',
      'active-agent',
      'standalone-agent',
    ]);
    expect(result.workersAlive).toBe(2);
    expect(result.queensAlive).toBe(1);
    expect(result.activeHives).toEqual({
      active: 1,
      unknownOwner: 0,
      byOwnerSessionId: { 'session-a': 1 },
    });
  });

  it('drops completed direct provider agents that have no live task process', async () => {
    writeStoreDict(fix.storePath, {
      completeDirect: {
        agentId: 'complete-direct',
        agentType: 'investigator',
        status: 'idle',
        lastResult: { completedAt: '2026-06-20T19:38:09.227Z' },
      },
      pendingDirect: {
        agentId: 'pending-direct',
        agentType: 'investigator',
        status: 'idle',
        ownerSessionId: 'session-a',
      },
      executingDirect: {
        agentId: 'executing-direct',
        agentType: 'investigator',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        lastResult: { completedAt: '2026-06-20T19:00:00.000Z' },
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.agents.map((agent) => agent.id)).toEqual(['executing-direct']);
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
  });

  // -------------------------------------------------------------------------
  // C1 #9 — missing store.json -> empty summary with freshness 'absent'.
  // -------------------------------------------------------------------------
  it("returns an empty summary with freshness.state='absent' when store.json is missing", async () => {
    // Do NOT write the store; the parent dir exists but the file does not.
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
    expect(result.queensAlive).toBe(0);
    expect(result.queensExecuting).toBe(0);
    expect(result.freshness.state).toBe('absent');
    expect(result.agents).toHaveLength(0);
    expect(result.cap).toBe(DEFAULT_CAP);
  });

  // -------------------------------------------------------------------------
  // C1 #10 — stale store.json (mtime > DEGRADED_MS) -> freshness 'stale' but
  // counts are still rendered.
  // -------------------------------------------------------------------------
  it("classifies an old store.json as freshness.state='stale' while still rendering counts", async () => {
    writeStoreDict(fix.storePath, {
      a1: {
        agentId: 'a1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
      },
    });
    makeStoreStale(fix.storePath, DEGRADED_MS + 60_000);
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.freshness.state).toBe('stale');
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
  });

  // -------------------------------------------------------------------------
  // C1 #11 — corrupt store.json -> empty summary with diagnostic, not crash.
  // -------------------------------------------------------------------------
  it('returns an empty summary with a diagnostic when store.json is unparseable (no crash)', async () => {
    writeFileSync(fix.storePath, '{ this is not json', { mode: 0o600 });
    // No throw allowed from collectSwarm.
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(0);
    expect(result.workersExecuting).toBe(0);
    expect(result.freshness.state).toBe('error');
    expect(result.freshness.reason).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // C1 #12 — fresh classification ladder.
  // -------------------------------------------------------------------------
  it("classifies a recently-written store.json as freshness.state='fresh'", async () => {
    writeStoreDict(fix.storePath, {
      a1: { agentId: 'a1', agentType: 'coder', status: 'busy' },
    });
    makeStoreFresh(fix.storePath);
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.freshness.state).toBe('fresh');
    expect(result.freshness.ageMs).toBeGreaterThanOrEqual(0);
    expect(result.freshness.ageMs).toBeLessThan(FRESH_MS);
  });

  // -------------------------------------------------------------------------
  // C1 #13 — degraded classification (mtime between FRESH_MS and DEGRADED_MS).
  // -------------------------------------------------------------------------
  it("classifies a moderately-old store.json as freshness.state='degraded'", async () => {
    writeStoreDict(fix.storePath, {
      a1: {
        agentId: 'a1',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
    });
    // Target ~90s old -> between FRESH_MS (60s) and DEGRADED_MS (300s).
    makeStoreStale(fix.storePath, FRESH_MS + 30_000);
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.freshness.state).toBe('degraded');
    expect(result.workersAlive).toBe(1);
  });

  // -------------------------------------------------------------------------
  // C1 #14 — advocate-state.json is read and surfaced.
  // -------------------------------------------------------------------------
  it("reads .hive-flow/data/advocate-state.json and surfaces advocateState", async () => {
    writeStoreDict(fix.storePath, {});
    writeFileSync(
      fix.advocatePath,
      JSON.stringify({
        state: 'waiting-for-hive',
        updatedAt: new Date().toISOString(),
        description: 'test',
        history: [],
      }),
      { mode: 0o600 },
    );
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.advocateState).toBe('waiting-for-hive');
  });

  // -------------------------------------------------------------------------
  // C1 #15 — missing advocate-state -> 'unknown'.
  // -------------------------------------------------------------------------
  it("falls back to advocateState='unknown' when the advocate-state file is missing", async () => {
    writeStoreDict(fix.storePath, {});
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.advocateState).toBe('unknown');
  });

  // -------------------------------------------------------------------------
  // C1 #16 — cap defaults to the canonical swarm max and accepts an override.
  // -------------------------------------------------------------------------
  it('uses DEFAULT_CAP=150 by default and honors a cap override', async () => {
    writeStoreDict(fix.storePath, {});
    const def = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(def.cap).toBe(150);
    const override = await collectSwarm({ projectRoot: fix.projectRoot, cap: 12 });
    expect(override.cap).toBe(12);
  });

  // -------------------------------------------------------------------------
  // C1 #17 — null / non-object members of store.agents are dropped safely.
  // -------------------------------------------------------------------------
  it('drops null/non-object members of store.agents without crashing', async () => {
    // We bypass the typed helper here to inject malformed entries on purpose.
    const corruptShape = {
      version: '1.0',
      agents: {
        'good-1': {
          agentId: 'good-1',
          agentType: 'coder',
          status: 'busy',
          ownerSessionId: 'session-a',
          currentTaskPid: process.pid,
        },
        'bad-null': null,
        'bad-string': 'not-an-object',
        'bad-array': [1, 2, 3],
      },
    };
    writeFileSync(fix.storePath, JSON.stringify(corruptShape), { mode: 0o600 });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
  });

  // -------------------------------------------------------------------------
  // C1 #18 — legacy aliases ('running', 'working') still classify as busy
  // (back-compat with stores written by older code paths).
  // -------------------------------------------------------------------------
  it("treats legacy status aliases 'running' and 'working' as busy with live process evidence", async () => {
    writeStoreDict(fix.storePath, {
      r1: {
        agentId: 'r1',
        agentType: 'coder',
        status: 'running',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      w1: {
        agentId: 'w1',
        agentType: 'coder',
        status: 'working',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(2);
    expect(result.workersExecuting).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Statusboard audit Slice A — hive-worker over-count regression suite.
// Covers F1/F4 (terminated-hive worker), F2 (completed hive worker), and
// F3 (queen-prefix misclassification).
// ---------------------------------------------------------------------------

describe('collectSwarm (Slice A hive-worker counting fixes)', () => {
  let fix: Fixture;
  beforeEach(() => {
    fix = setupFixture();
  });
  afterEach(() => {
    rmSync(fix.projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // F1/F4 — a worker whose store record has an empty/absent config.hiveId,
  // belonging to a now-TERMINATED hive, with a live pid, must NOT be counted
  // once at least one OTHER hive is active. Before the fix, hiveAgentIds was
  // populated only from active hives, so the terminated hive's orphan worker
  // fell through the empty-hiveId branch and was kept.
  it('does NOT count a terminated-hive worker (empty config.hiveId, live pid)', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      orphan: {
        agentId: 'orphan-worker',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        // NOTE: no config.hiveId on the store record.
      },
      liveWorker: {
        agentId: 'live-worker',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        config: { hiveId: 'active-hive' },
      },
    });
    // The orphan belongs to a now-FAILED hive (status !== active).
    writeHive(
      fix.projectRoot,
      'term-hive',
      [{ agentId: 'orphan-worker', workerId: 'orphan-worker', status: 'idle' }],
      'queen-term',
      'session-a',
      'failed',
    );
    // A second hive is active so `inspected > 0` and the empty-hiveId branch engages.
    writeHive(
      fix.projectRoot,
      'active-hive',
      [{ agentId: 'live-worker', workerId: 'live-worker', status: 'busy', currentTaskPid: process.pid }],
      'queen-active',
      'session-a',
      'active',
    );

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.agents.map((a) => a.id)).toEqual(['live-worker']);
    expect(result.workersAlive).toBe(1);
  });

  // F1/F4 control — the SAME orphan with config.hiveId present is already
  // excluded by the existing active-hive branch; this pins that the fix did
  // not regress that path.
  it('control: terminated-hive worker WITH config.hiveId is also excluded', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      orphan: {
        agentId: 'orphan-worker',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        config: { hiveId: 'term-hive' },
      },
      liveWorker: {
        agentId: 'live-worker',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        config: { hiveId: 'active-hive' },
      },
    });
    writeHive(fix.projectRoot, 'term-hive', [
      { agentId: 'orphan-worker', workerId: 'orphan-worker', status: 'idle' },
    ], 'queen-term', 'session-a', 'failed');
    writeHive(fix.projectRoot, 'active-hive', [
      { agentId: 'live-worker', workerId: 'live-worker', status: 'busy', currentTaskPid: process.pid },
    ], 'queen-active', 'session-a', 'active');

    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.agents.map((a) => a.id)).toEqual(['live-worker']);
    expect(result.workersAlive).toBe(1);
  });

  // F2 — a completed (terminal lastResult) hive worker with a lingering live
  // pid must NOT be counted. Before the fix isCompletedDirectAgent exempted
  // hive agents (rawAgentHiveId !== '').
  it('does NOT count a completed hive worker with a lingering live pid', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      completedHiveWorker: {
        agentId: 'done-worker',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        config: { hiveId: 'h1' },
        lastResult: { completedAt: '2026-06-20T19:38:09.227Z' },
      },
      liveHiveWorker: {
        agentId: 'live-worker',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        config: { hiveId: 'h1' },
      },
    });
    // Hive h1 is active and lists BOTH workers as live so the active-hive
    // branch keeps them; only the completed-lastResult filter should drop one.
    writeHive(fix.projectRoot, 'h1', [
      { agentId: 'done-worker', workerId: 'done-worker', status: 'busy', currentTaskPid: process.pid },
      { agentId: 'live-worker', workerId: 'live-worker', status: 'busy', currentTaskPid: process.pid },
    ], 'queen-h1', 'session-a', 'active');

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.agents.map((a) => a.id)).toEqual(['live-worker']);
    expect(result.workersAlive).toBe(1);
  });

  // F3 — a record with agentId 'queen-*' but agentType 'worker' must count as
  // a WORKER, not a queen (type field is authoritative; prefix is fallback).
  it("classifies agentId 'queen-*' with agentType worker as a WORKER not a queen", async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      tricky: {
        agentId: 'queen-bee',
        agentType: 'worker',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.queensAlive).toBe(0);
    expect(result.workersAlive).toBe(1);
    expect(result.agents.map((a) => a.id)).toEqual(['queen-bee']);
  });

  // F3 fallback — a 'queen-*' record with NO type field still counts as a queen.
  it("classifies agentId 'queen-*' with no type field as a queen (prefix fallback)", async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      q: {
        agentId: 'queen-root',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.queensAlive).toBe(1);
    expect(result.workersAlive).toBe(0);
  });
});
