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
  currentTaskPid?: number;
}

function writeStoreDict(storePath: string, agents: Record<string, AgentLike>): void {
  writeFileSync(storePath, JSON.stringify({ version: '1.0', agents }), { mode: 0o600 });
}

function writeStoreArray(storePath: string, agents: AgentLike[]): void {
  writeFileSync(storePath, JSON.stringify({ version: '1.0', agents }), { mode: 0o600 });
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
  // C1 #1 — single 'busy' worker counts as 1 alive + 1 executing.
  // Original bug: legacy collector saw 0 because it filtered for 'working'.
  // -------------------------------------------------------------------------
  it('counts a busy worker as workersAlive=1 and workersExecuting=1 (closes original 0/0 bug)', async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': { agentId: 'agent-1', agentType: 'coder', status: 'busy' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
    expect(result.queensAlive).toBe(0);
    expect(result.queensExecuting).toBe(0);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.status).toBe('busy');
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
      dead: { agentId: 'dead', agentType: 'coder', status: 'busy', currentTaskPid: deadPid },
      live: { agentId: 'live', agentType: 'coder', status: 'busy', currentTaskPid: process.pid },
      eperm: { agentId: 'eperm', agentType: 'coder', status: 'busy', currentTaskPid: epermPid },
      legacy: { agentId: 'legacy', agentType: 'coder', status: 'busy' },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(killSpy).toHaveBeenCalledWith(deadPid, 0);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
    expect(killSpy).toHaveBeenCalledWith(epermPid, 0);
    expect(result.workersAlive).toBe(3);
    expect(result.workersExecuting).toBe(3);
    expect(result.agents.map((agent) => agent.id)).toEqual(['live', 'eperm', 'legacy']);
  });

  // -------------------------------------------------------------------------
  // C1 #2 — idle worker counts as alive but not executing.
  // -------------------------------------------------------------------------
  it('counts an idle worker as alive but not executing', async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': { agentId: 'agent-1', agentType: 'coder', status: 'idle' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(0);
    expect(result.agents[0]?.status).toBe('idle');
  });

  // -------------------------------------------------------------------------
  // C1 #3 — spawning maps to 'queued' (per normalizer) and counts as alive.
  // -------------------------------------------------------------------------
  it("counts a spawning worker as alive (status 'queued' per normalizer) but not executing", async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': { agentId: 'agent-1', agentType: 'coder', status: 'spawning' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(0);
    expect(result.agents[0]?.status).toBe('queued');
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
  // C1 #6 — mixed statuses aggregate correctly.
  // 3 busy + 2 idle + 1 spawning + 1 terminated -> alive=6, executing=3.
  // -------------------------------------------------------------------------
  it('aggregates mixed statuses (3 busy + 2 idle + 1 spawning + 1 terminated)', async () => {
    writeStoreDict(fix.storePath, {
      b1: { agentId: 'b1', agentType: 'coder', status: 'busy' },
      b2: { agentId: 'b2', agentType: 'tester', status: 'busy' },
      b3: { agentId: 'b3', agentType: 'reviewer', status: 'busy' },
      i1: { agentId: 'i1', agentType: 'coder', status: 'idle' },
      i2: { agentId: 'i2', agentType: 'researcher', status: 'idle' },
      sp1: { agentId: 'sp1', agentType: 'coder', status: 'spawning' },
      t1: { agentId: 't1', agentType: 'coder', status: 'terminated' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(6);
    expect(result.workersExecuting).toBe(3);
    expect(result.agents).toHaveLength(6);
  });

  // -------------------------------------------------------------------------
  // C1 #7 — legacy array shape is still recognized.
  // -------------------------------------------------------------------------
  it('handles the legacy array shape of store.agents', async () => {
    writeStoreArray(fix.storePath, [
      { agentId: 'a1', agentType: 'coder', status: 'busy' },
      { agentId: 'a2', agentType: 'coder', status: 'idle' },
      { agentId: 'a3', agentType: 'coder', status: 'terminated' },
    ]);
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(2);
    expect(result.workersExecuting).toBe(1);
  });

  // -------------------------------------------------------------------------
  // C1 #8 — queens count separately and queue executing counts.
  // -------------------------------------------------------------------------
  it('counts a busy queen as queensExecuting=1 and queensAlive=1', async () => {
    writeStoreDict(fix.storePath, {
      queen1: { agentId: 'queen1', agentType: 'queen', status: 'busy' },
      worker1: { agentId: 'worker1', agentType: 'coder', status: 'idle' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.queensAlive).toBe(1);
    expect(result.queensExecuting).toBe(1);
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(0);
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
      a1: { agentId: 'a1', agentType: 'coder', status: 'busy' },
    });
    makeStoreStale(fix.storePath, DEGRADED_MS + 60_000);
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.freshness.state).toBe('stale');
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
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
      a1: { agentId: 'a1', agentType: 'coder', status: 'idle' },
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
  // C1 #16 — cap defaults to 50 and accepts an override.
  // -------------------------------------------------------------------------
  it('uses DEFAULT_CAP=50 by default and honors a cap override', async () => {
    writeStoreDict(fix.storePath, {});
    const def = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(def.cap).toBe(50);
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
        'good-1': { agentId: 'good-1', agentType: 'coder', status: 'busy' },
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
  it("treats legacy status aliases 'running' and 'working' as busy", async () => {
    writeStoreDict(fix.storePath, {
      r1: { agentId: 'r1', agentType: 'coder', status: 'running' },
      w1: { agentId: 'w1', agentType: 'coder', status: 'working' },
    });
    const result = await collectSwarm({ projectRoot: fix.projectRoot });
    expect(result.workersAlive).toBe(2);
    expect(result.workersExecuting).toBe(2);
  });
});
