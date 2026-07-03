// cli/src/statusline/__tests__/inline-collectors.test.ts
//
// Wave 8 regression suite for the inline-collector renderer mode.
//
// Bug-hunt coverage (mirroring the Wave 8 risk register in
// phase3-implementation-design-2026-05-21.md):
//   1. Happy path in real git repo — branch / dirty / ahead/behind populated.
//   2. Not in a git repo — git probe omitted, other probes continue.
//   3. Budget exhaustion — `deadlineMs: 1` returns ~immediately, partial.
//   4. ROUND-4 BUG ξ regression — first git call eats ~80ms of `deadlineMs:
//      100`; second spawn's timeout is recomputed against the fresh remaining,
//      not the stale 100ms. Function returns within ~100ms total (NOT ~180ms).
//   5. Symlinked `.hive-flow/agents/store.json` — Wave 2.5A guard rejects it,
//      other probes still complete.
//   6. `normalizeAgentStatus` integration — `busy` → executing count, `terminated`
//      dropped, legacy alias `running` mapped to busy.
//   7. `daemon-state.json` happy path, absent, corrupt — all graceful.
//   8. Source file contains no `shell: true` (static-audit grep).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  collectInlineSnapshot,
  DEFAULT_INLINE_DEADLINE_MS,
} from '../inline-collectors.js';
import { collectSwarm } from '../collectors/swarm.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  projectRoot: string;
  storePath: string;
  daemonStatePath: string;
}

function setupFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-inline-'));
  mkdirSync(join(projectRoot, '.hive-flow', 'agents'), { recursive: true });
  mkdirSync(join(projectRoot, '.hive-flow', 'data'), { recursive: true });
  mkdirSync(join(projectRoot, '.hive-flow', 'state'), { recursive: true });
  return {
    projectRoot,
    storePath: join(projectRoot, '.hive-flow', 'agents', 'store.json'),
    // Must match the worker daemon's actual write path
    // (`services/worker-daemon.ts` `saveState()` →
    // `<projectRoot>/.hive-flow/daemon-state.json`). A `data/` subdir here would
    // codify the producer/probe path mismatch the footer silently hides.
    daemonStatePath: join(projectRoot, '.hive-flow', 'daemon-state.json'),
  };
}

function cleanup(fix: Fixture): void {
  try {
    rmSync(fix.projectRoot, { recursive: true, force: true });
  } catch {
    // tmp cleanup is best-effort.
  }
}

function writeStoreDict(
  storePath: string,
  agents: Record<string, Record<string, unknown>>,
): void {
  writeFileSync(storePath, JSON.stringify({ version: '1.0', agents }), { mode: 0o600 });
}

function writeHive(
  projectRoot: string,
  hiveId: string,
  workers: Array<Record<string, unknown>>,
  queenId?: string,
  ownerSessionId?: string,
): void {
  const hiveRoot = join(projectRoot, '.hive-flow', 'hives', hiveId);
  mkdirSync(hiveRoot, { recursive: true });
  writeFileSync(
    join(hiveRoot, 'hive.json'),
    JSON.stringify({
      hiveId,
      status: 'active',
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

function writeTaskMetadata(
  projectRoot: string,
  taskId: string,
  metadata: Record<string, unknown>,
): void {
  const tasksRoot = join(projectRoot, '.hive-flow', 'tasks');
  mkdirSync(tasksRoot, { recursive: true });
  writeFileSync(join(tasksRoot, `${taskId}.json`), JSON.stringify(metadata), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Real-git helper: detect whether a `git` binary exists on PATH. Tests that
// require a real repo are SKIPPED (not failed) on hosts without git so the
// suite still passes in sandboxed CI runners.
// ---------------------------------------------------------------------------

const HAS_GIT: boolean = (() => {
  try {
    const probe = childProcess.spawnSync('git', ['--version'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return probe.status === 0;
  } catch {
    return false;
  }
})();

function gitInit(cwd: string): void {
  // Use `-c init.defaultBranch=main` so the assertion against branch="main"
  // does not depend on the host git's default.
  const r = childProcess.spawnSync(
    'git',
    ['-c', 'init.defaultBranch=main', 'init', '--quiet'],
    { cwd, timeout: 5000 },
  );
  if (r.status !== 0) throw new Error('git init failed');
  childProcess.spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  childProcess.spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  childProcess.spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd });
  writeFileSync(join(cwd, 'README.md'), '# test\n');
  childProcess.spawnSync('git', ['add', 'README.md'], { cwd });
  childProcess.spawnSync('git', ['commit', '--quiet', '-m', 'init'], { cwd });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('collectInlineSnapshot (Wave 8 inline-collector mode)', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = setupFixture();
  });

  afterEach(() => {
    cleanup(fix);
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Happy path in a real git repo.
  // -------------------------------------------------------------------------
  it.skipIf(!HAS_GIT)(
    'populates branch / staged / modified / untracked in a real git repo',
    async () => {
      gitInit(fix.projectRoot);
      // Create modifications: one staged, one modified, one untracked.
      writeFileSync(join(fix.projectRoot, 'staged.txt'), 'staged\n');
      childProcess.spawnSync('git', ['add', 'staged.txt'], { cwd: fix.projectRoot });
      writeFileSync(join(fix.projectRoot, 'README.md'), '# modified\n');
      writeFileSync(join(fix.projectRoot, 'untracked.txt'), 'untracked\n');

      const snap = await collectInlineSnapshot({
        projectRoot: fix.projectRoot,
        deadlineMs: 2000, // plenty of room for the real git
      });

      expect(snap.git).toBeDefined();
      expect(snap.git?.branch).toBe('main');
      // staged.txt → staged column; README.md → modified column; untracked.txt → untracked.
      expect(snap.git?.staged).toBeGreaterThanOrEqual(1);
      expect(snap.git?.modified).toBeGreaterThanOrEqual(1);
      expect(snap.git?.untracked).toBeGreaterThanOrEqual(1);
      // No upstream configured → ahead/behind remain undefined.
      expect(snap.git?.ahead).toBeUndefined();
      expect(snap.git?.behind).toBeUndefined();

      // Identity is always present.
      expect(snap.projectRoot).toBe(fix.projectRoot);
      expect(snap.worktreeRoot).toBe(fix.projectRoot);
      expect(snap.generatedAt).toBeTypeOf('string');
    },
  );

  // -------------------------------------------------------------------------
  // 2. Not in a git repo — git probe returns `undefined` but other probes
  // continue. We supply agent + daemon data so we can assert the non-git
  // probes still resolve.
  // -------------------------------------------------------------------------
  it('omits the git summary outside a git repo but resolves other probes', async () => {
    writeStoreDict(fix.storePath, {
      'agent-1': {
        agentId: 'agent-1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
    });
    writeFileSync(
      fix.daemonStatePath,
      JSON.stringify({ running: true, pid: process.pid }),
      { mode: 0o600 },
    );

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 1000,
    });

    expect(snap.git).toBeUndefined();
    expect(snap.swarm).toBeDefined();
    expect(snap.swarm?.activeAgents).toBe(1);
    expect(snap.daemon).toBeDefined();
    expect(snap.daemon?.running).toBe(true);
  });

  it('scopes inline swarm counts to current-session rows with live process evidence', async () => {
    writeStoreDict(fix.storePath, {
      mineBusy: {
        agentId: 'mine-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      otherBusy: {
        agentId: 'other-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-b',
        currentTaskPid: process.pid,
      },
      unownedIdle: {
        agentId: 'unowned-idle',
        agentType: 'tester',
        status: 'idle',
      },
    });

    const scoped = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      sessionId: 'session-a',
      deadlineMs: 1000,
    });
    expect(scoped.swarm?.activeAgents).toBe(1);
    expect(scoped.swarm?.idleAgents).toBe(0);
    expect(scoped.swarm?.agents?.map((agent) => agent.id)).toEqual(['mine-busy']);

    const unscoped = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 1000,
    });
    expect(unscoped.swarm?.activeAgents).toBe(2);
    expect(unscoped.swarm?.idleAgents).toBe(0);
    expect(unscoped.swarm?.agents?.map((agent) => agent.id)).toEqual(['mine-busy', 'other-busy']);
  });

  it('excludes only inline busy agents whose currentTaskPid is proven dead', async () => {
    const deadPid = 525252;
    const epermPid = 525253;
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

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 1000,
    });

    expect(killSpy).toHaveBeenCalledWith(deadPid, 0);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 0);
    expect(killSpy).toHaveBeenCalledWith(epermPid, 0);
    // `dead` is excluded (ESRCH). `live` and `eperm` have valid pids => executing.
    // `legacy` has no pid => not live.
    expect(snap.swarm?.activeAgents).toBe(2);
    expect(snap.swarm?.agents?.map((agent) => agent.id)).toEqual(['live', 'eperm']);
  });

  it('does not surface completed hives or their stale idle worker records', async () => {
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
      {
        agentId: 'active-agent',
        workerId: 'active-agent',
        status: 'idle',
        taskId: 'task-open',
        currentTaskPid: process.pid,
      },
    ], 'queen-active', 'session-a');

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 1000,
    });

    expect(snap.swarm?.agents?.map((agent) => agent.id)).toEqual([
      'queen-active',
      'active-agent',
      'standalone-agent',
    ]);
    expect(snap.swarm?.idleAgents).toBe(2);
    expect(snap.swarm?.activeQueens).toBe(1);
    expect(snap.swarm?.activeHives).toEqual({
      active: 1,
      unknownOwner: 0,
      byOwnerSessionId: { 'session-a': 1 },
    });
  });

  it('counts an idle queen without process evidence as alive but not executing', async () => {
    writeStoreDict(fix.storePath, {
      queen1: {
        agentId: 'queen1',
        agentType: 'queen',
        status: 'idle',
        ownerSessionId: 'session-a',
      },
      worker1: {
        agentId: 'worker1',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-a',
      },
    });

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });

    expect(snap.swarm?.activeQueens).toBe(1);
    expect(snap.swarm?.executingQueens).toBe(0);
    expect(snap.swarm?.activeAgents).toBe(0);
    expect(snap.swarm?.agents?.map((agent) => agent.id)).toEqual(['queen1']);
  });

  it('does not count queued or stale queens without process evidence as alive', async () => {
    writeStoreDict(fix.storePath, {
      queuedQueen: {
        agentId: 'queen-queued',
        agentType: 'queen',
        status: 'spawning',
        ownerSessionId: 'session-a',
      },
      staleQueen: {
        agentId: 'queen-stale',
        agentType: 'queen',
        status: 'zorp',
        ownerSessionId: 'session-a',
      },
    });

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });

    expect(snap.swarm?.activeQueens ?? 0).toBe(0);
    expect(snap.swarm?.executingQueens ?? 0).toBe(0);
    expect(snap.swarm?.agents ?? []).toEqual([]);
  });

  it('does not double-count a hive-associated stale store queen with no queen config hiveId', async () => {
    writeStoreDict(fix.storePath, {
      staleStoreQueen: {
        agentId: 'queen-old',
        agentType: 'queen',
        status: 'idle',
        ownerSessionId: 'session-a',
      },
    });
    writeHive(fix.projectRoot, 'old-hive', [], 'queen-old', 'session-a', 'failed');
    writeHive(fix.projectRoot, 'active-hive', [
      { agentId: 'live-worker', workerId: 'live-worker', status: 'busy', currentTaskPid: process.pid },
    ], 'queen-active', 'session-a');

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });

    expect(snap.swarm?.activeQueens).toBe(1);
    expect(snap.swarm?.activeAgents).toBe(1);
    expect(snap.swarm?.agents?.map((agent) => agent.id)).toEqual(['live-worker', 'queen-active']);
  });

  it('counts an unlinked same-session idle queen as distinct from an active hive queen', async () => {
    writeStoreDict(fix.storePath, {
      unlinkedQueen: {
        agentId: 'queen-unlinked',
        agentType: 'queen',
        status: 'idle',
        ownerSessionId: 'session-a',
      },
    });
    writeHive(fix.projectRoot, 'active-hive', [
      { agentId: 'live-worker', workerId: 'live-worker', status: 'busy', currentTaskPid: process.pid },
    ], 'queen-active', 'session-a');

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });

    // Known cosmetic identity boundary: without a hive record or config.hiveId,
    // this row is indistinguishable from a legitimate unmissioned queen.
    expect(snap.swarm?.activeQueens).toBe(2);
    expect(snap.swarm?.activeAgents).toBe(1);
    expect(snap.swarm?.agents?.map((agent) => agent.id)).toEqual([
      'queen-unlinked',
      'live-worker',
      'queen-active',
    ]);
  });

  it('preserves a distinct same-session idle queen when another hive queen is active', async () => {
    writeStoreDict(fix.storePath, {
      standaloneQueen: {
        agentId: 'queen-standalone',
        agentType: 'queen',
        status: 'idle',
        ownerSessionId: 'session-a',
      },
    });
    writeHive(fix.projectRoot, 'active-hive', [
      { agentId: 'live-worker', workerId: 'live-worker', status: 'busy', currentTaskPid: process.pid },
    ], 'queen-active', 'session-a');

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });

    expect(snap.swarm?.activeQueens).toBe(2);
    expect(snap.swarm?.executingQueens).toBe(0);
    expect(snap.swarm?.activeAgents).toBe(1);
    expect(snap.swarm?.agents?.map((agent) => agent.id)).toEqual([
      'queen-standalone',
      'live-worker',
      'queen-active',
    ]);
  });

  it('omits completed direct provider agents with no live task process', async () => {
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

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 1000,
    });

    expect(snap.swarm?.agents?.map((agent) => agent.id)).toEqual(['executing-direct']);
    expect(snap.swarm?.activeAgents).toBe(1);
    expect(snap.swarm?.idleAgents).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. Budget exhaustion — `deadlineMs: 1` returns essentially immediately,
  // with no successful spawns. Other probes (which don't spawn) may still
  // run within the slice.
  // -------------------------------------------------------------------------
  it('returns within ~deadlineMs with a partial result when budget is tiny', async () => {
    const t0 = Date.now();
    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 1,
    });
    const elapsed = Date.now() - t0;
    // Allow some slack for I/O on the empty `.hive-flow/` and Node bookkeeping.
    expect(elapsed).toBeLessThan(500);
    // The git probe is skipped (budget < MIN_BUDGET_FOR_SPAWN_MS).
    expect(snap.git).toBeUndefined();
    // Identity is always emitted so the renderer has labels to render.
    expect(snap.projectRoot).toBe(fix.projectRoot);
  });

  // -------------------------------------------------------------------------
  // 4. ROUND-4 BUG ξ REGRESSION TEST.
  //
  // The bug: the original sketch reused a stale `remaining` across spawnSync
  // calls. If the first call consumed ~80ms of a 100ms budget, the second
  // call would re-use the original 100ms as its timeout — letting the
  // total exceed the deadline by an entire spawn cycle.
  //
  // The fix: `remainingBudget()` closure recomputes the budget against the
  // captured `startTime`/`now()` BEFORE each `spawnSync`.
  //
  // We use `vi.doMock` to swap `node:child_process` before importing the
  // module under test so the spy is established at module-load time
  // (ESM modules are immutable post-load, so `vi.spyOn` doesn't work on
  // them — see https://vitest.dev/guide/browser/#limitations).
  // -------------------------------------------------------------------------
  it(
    'ROUND-4 BUG ξ REGRESSION: recomputes remaining budget between multiple spawnSync git calls',
    async () => {
      // Inject a virtual clock so the test is deterministic. `nowMs()` ticks
      // forward by the time each `spawnSync` "consumed" — that way we can
      // simulate the first call eating 80ms of a 100ms budget.
      let virtualNow = 1_000_000;
      const consumedByCalls: number[] = [];

      // Reset module state so the doMock takes effect for the next import.
      vi.resetModules();
      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
        return {
          ...actual,
          spawnSync: ((
            _cmd: string,
            _args: ReadonlyArray<string>,
            options: import('node:child_process').SpawnSyncOptions = {},
          ) => {
            // Record the timeout the collector actually passed. THIS is the
            // load-bearing assertion: if ξ regressed, the second call's
            // timeout would still be near the full 100ms.
            consumedByCalls.push(Number(options.timeout ?? -1));
            // First spawn "consumes" 70ms; subsequent ones a small amount.
            // With deadline=100 the post-first-call remaining is ~30ms, above
            // the MIN_BUDGET_FOR_SPAWN_MS=25 threshold, so a second spawn
            // proceeds and the ξ regression assertion can be made.
            const consumed = consumedByCalls.length === 1 ? 70 : 1;
            virtualNow += consumed;
            // Return a benign non-empty stdout so the inline collector treats
            // each probe as successful and moves to the next one. (Empty
            // stdout would short-circuit the chain.)
            return {
              pid: 1,
              output: ['', 'mocked\n', ''],
              stdout: 'mocked\n',
              stderr: '',
              status: 0,
              signal: null,
              error: undefined,
            } as ReturnType<typeof actual.spawnSync>;
          }) as typeof actual.spawnSync,
        };
      });

      try {
        // Re-import the module under test so it picks up the mocked
        // `node:child_process`. Type via `typeof` to keep strict-null happy.
        const mod = await import('../inline-collectors.js');
        await mod.collectInlineSnapshot({
          projectRoot: fix.projectRoot,
          deadlineMs: 100,
          nowMs: () => virtualNow,
        });
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }

      // We must have made at least two git spawnSync calls (branch + status).
      expect(consumedByCalls.length).toBeGreaterThanOrEqual(2);

      // ASSERTION 1: the first call was passed a timeout based on the FULL
      // available budget (≤ PER_SPAWN_CAP_MS of 90ms). It is NOT 100ms because
      // the per-spawn cap kicks in first.
      expect(consumedByCalls[0]).toBeLessThanOrEqual(90);

      // ASSERTION 2 (THE CORE BUG ξ ASSERTION): the SECOND call's timeout was
      // recomputed against the FRESH remaining budget. After the first call
      // ate 70ms of 100ms, only 30ms remained. So the second timeout MUST be
      // <= 30ms. If the bug regressed and a stale 100ms was reused, the
      // second timeout would be in the 70–90ms range instead (full cap).
      expect(consumedByCalls[1]).toBeLessThanOrEqual(30);
      expect(consumedByCalls[1]).toBeGreaterThanOrEqual(0);

      // ASSERTION 3: total virtual elapsed is within a single spawn cap of
      // the deadline. With the fix, virtualNow advanced 70 + 1*N = small.
      // With the bug, every call would have used a 70–90ms timeout, the
      // total elapsed would exceed 100ms substantially.
      const elapsed = virtualNow - 1_000_000;
      expect(elapsed).toBeLessThanOrEqual(100);
    },
  );

  // -------------------------------------------------------------------------
  // 5. Symlinked `.hive-flow/agents/store.json` is rejected via Wave 2.5A
  // guard; other probes still complete (no crash, swarm omitted).
  // -------------------------------------------------------------------------
  it(
    'rejects a symlinked agents/store.json via Wave 2.5A guard without crashing other probes',
    async () => {
      // Create the symlink target outside `.hive-flow/`.
      const decoyTarget = join(fix.projectRoot, 'decoy-store.json');
      writeFileSync(
        decoyTarget,
        JSON.stringify({
          version: '1.0',
          agents: { 'a1': { agentId: 'a1', agentType: 'coder', status: 'busy' } },
        }),
        { mode: 0o600 },
      );
      try {
        symlinkSync(decoyTarget, fix.storePath);
      } catch {
        // Symlinks may be denied on some sandboxed runners. Skip rather than fail.
        return;
      }

      // Daemon state is healthy and not symlinked.
      writeFileSync(
        fix.daemonStatePath,
        JSON.stringify({ running: true }),
        { mode: 0o600 },
      );

      const snap = await collectInlineSnapshot({
        projectRoot: fix.projectRoot,
        deadlineMs: 500,
      });

      // Swarm dropped because storage.ts refuses to follow the symlink.
      expect(snap.swarm).toBeUndefined();
      // Daemon still emitted.
      expect(snap.daemon).toBeDefined();
      expect(snap.daemon?.running).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // 6. normalizeAgentStatus integration — busy → executing, terminated dropped,
  // legacy 'running' alias still mapped to busy.
  // -------------------------------------------------------------------------
  it('integrates normalizeAgentStatus: busy executes, terminated drops, legacy running maps to busy', async () => {
    writeStoreDict(fix.storePath, {
      busy1: {
        agentId: 'busy1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      idle1: {
        agentId: 'idle1',
        agentType: 'tester',
        status: 'idle',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      term1: { agentId: 'term1', agentType: 'coder', status: 'terminated', ownerSessionId: 'session-a' },
      legacy1: {
        agentId: 'legacy1',
        agentType: 'coder',
        status: 'running',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      }, // legacy alias
      queen1: {
        agentId: 'queen1',
        agentType: 'queen',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      spawning1: {
        agentId: 'spawning1',
        agentType: 'coder',
        status: 'spawning',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
    });

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });

    expect(snap.swarm).toBeDefined();
    // workers: busy1 + legacy1 (running→busy) have live pids => active.
    expect(snap.swarm?.activeAgents).toBe(2);
    expect(snap.swarm?.idleAgents).toBe(1);
    // queued workers: spawning1 (normalizer maps 'spawning' → 'queued')
    expect(snap.swarm?.queuedAgents).toBe(1);
    // queens: 1 alive and executing.
    expect(snap.swarm?.activeQueens).toBe(1);
    expect(snap.swarm?.executingQueens).toBe(1);
    // term1 is dropped (terminal status).
    expect(snap.swarm?.agents?.some((a) => a.id === 'term1')).toBe(false);
    // 5 live rows total (6 - 1 terminated).
    expect(snap.swarm?.agents?.length).toBe(5);
  });

  // -------------------------------------------------------------------------
  // 7. daemon-state.json — happy / absent / corrupt all graceful.
  // -------------------------------------------------------------------------
  it('handles daemon-state.json happy path, absent, and corrupt without crashing', async () => {
    // 7a. Happy path: running=true with pid.
    writeFileSync(
      fix.daemonStatePath,
      JSON.stringify({ running: true, pid: process.pid }),
      { mode: 0o600 },
    );
    const happy = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });
    expect(happy.daemon).toBeDefined();
    expect(happy.daemon?.running).toBe(true);
    expect(happy.daemon?.pid).toBe(process.pid);
    expect(happy.daemon?.health).toBe('healthy');

    // 7b. Absent: delete and re-collect.
    rmSync(fix.daemonStatePath, { force: true });
    const absent = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });
    expect(absent.daemon).toBeDefined();
    expect(absent.daemon?.running).toBe(false);
    expect(absent.daemon?.health).toBe('unknown');

    // 7c. Corrupt: invalid JSON.
    writeFileSync(fix.daemonStatePath, '{ not json', { mode: 0o600 });
    const corrupt = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });
    // readJsonFile returns undefined on corrupt → daemon summary still emitted
    // with running:false / health:'unknown' (NOT a crash).
    expect(corrupt.daemon).toBeDefined();
    expect(corrupt.daemon?.running).toBe(false);
    expect(corrupt.daemon?.health).toBe('unknown');
  });

  it('does not report daemon on when daemon-state.json has a dead pid', async () => {
    const deadPid = 424242;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0 && pid === deadPid) {
        const err = new Error('dead process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);

    writeFileSync(
      fix.daemonStatePath,
      JSON.stringify({ running: true, pid: deadPid }),
      { mode: 0o600 },
    );

    const snap = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });

    expect(killSpy).toHaveBeenCalledWith(deadPid, 0);
    expect(snap.daemon).toBeDefined();
    expect(snap.daemon?.running).toBe(false);
    expect(snap.daemon?.pid).toBe(deadPid);
    expect(snap.daemon?.health).toBe('stopped');
  });

  // -------------------------------------------------------------------------
  // 7d. Producer-path wiring: the probe MUST read the worker daemon's actual
  // write path (`.hive-flow/daemon-state.json`), NOT a `data/` subdir. A file
  // placed only in `.hive-flow/data/` must NOT populate the daemon row — that
  // would silently report `daemon unknown` while a running daemon exists.
  // -------------------------------------------------------------------------
  it('reads daemon state from the producer path, not .hive-flow/data/', async () => {
    // Write a running daemon ONLY at the legacy/wrong `data/` path.
    const wrongPath = join(fix.projectRoot, '.hive-flow', 'data', 'daemon-state.json');
    writeFileSync(wrongPath, JSON.stringify({ running: true, pid: 9999 }), { mode: 0o600 });
    const fromWrong = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });
    // The probe ignores `data/daemon-state.json`, so the daemon does not read
    // as running.
    expect(fromWrong.daemon?.running).toBe(false);

    // Now write at the producer's real path; the daemon must read as running.
    writeFileSync(
      fix.daemonStatePath,
      JSON.stringify({ running: true, pid: process.pid }),
      { mode: 0o600 },
    );
    const fromRight = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      deadlineMs: 500,
    });
    expect(fromRight.daemon?.running).toBe(true);
    expect(fromRight.daemon?.health).toBe('healthy');
  });

  // -------------------------------------------------------------------------
  // 8. Static-audit: source must NOT contain `shell: true` (Phase 5 binding).
  // -------------------------------------------------------------------------
  it('source file contains no `shell: true` (static-audit grep)', () => {
    // Read the inline-collectors.ts source and grep for the forbidden pattern.
    // We resolve via a path relative to this test file's directory so the
    // test is portable regardless of working directory.
    const sourcePath = join(
      __dirname,
      '..',
      'inline-collectors.ts',
    );
    const source = readFileSync(sourcePath, 'utf8');
    // Strip block comments and line comments so the audit only checks actual
    // executable code — the file itself documents the rule, which would
    // otherwise self-trip the grep.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/^\s*\/\/.*$/gm, ''); // line comments
    expect(codeOnly).not.toMatch(/shell\s*:\s*true/);
  });

  // -------------------------------------------------------------------------
  // 9. (bonus) DEFAULT_INLINE_DEADLINE_MS is exported and sane.
  // -------------------------------------------------------------------------
  it('exports a sane default deadline (~150ms)', () => {
    expect(DEFAULT_INLINE_DEADLINE_MS).toBe(150);
  });

  // -------------------------------------------------------------------------
  // 10. No `.hive-flow/` → empty partial (header-only mode owned by renderer).
  // -------------------------------------------------------------------------
  it('returns an empty partial when `.hive-flow/` does not exist', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'hf-inline-empty-'));
    try {
      const snap = await collectInlineSnapshot({
        projectRoot: emptyDir,
        deadlineMs: 200,
      });
      expect(snap).toEqual({});
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Materialized-summary probes (scoreboard / memory / tests / attention / mcp)
//
// The inline collector reads the SMALL atomic roll-up files the recorders
// maintain WITHOUT a running daemon so the scoreboard / memory / tests /
// attention / MCP rows populate even when no fresh `state/cache.json` exists.
// These tests lock that behaviour + the OMIT > FAKE gating per probe.
// ---------------------------------------------------------------------------

describe('collectInlineSnapshot — materialized-summary probes', () => {
  function setupRoot(): string {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-inline-mat-'));
    mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
    return projectRoot;
  }
  function writeSummary(projectRoot: string, area: string, file: string, value: unknown): void {
    mkdirSync(join(projectRoot, '.hive-flow', area), { recursive: true });
    writeFileSync(join(projectRoot, '.hive-flow', area, file), JSON.stringify(value), {
      mode: 0o600,
    });
  }

  it('populates scoreboard from scoreboard/current.json', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'scoreboard', 'current.json', {
        agentsByProvider: { claude: { activeAgents: 1, idleAgents: 0, staleAgents: 5, models: { sonnet: 6 } } },
        callsByProvider: { codex: { calls: 1, models: { opus: 1 } } },
        stale: true,
        lastUpdatedAt: '2026-06-01T22:29:26.662Z',
      });
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.scoreboard).toBeDefined();
      expect(snap.scoreboard?.agentsByProvider.claude?.activeAgents).toBe(1);
      expect(snap.scoreboard?.callsByProvider.codex?.calls).toBe(1);
      expect(snap.scoreboard?.stale).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits scoreboard when no provider has presence or calls (OMIT > FAKE)', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'scoreboard', 'current.json', {
        agentsByProvider: {},
        callsByProvider: {},
        stale: false,
      });
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.scoreboard).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('populates memory from memory/stats.json', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'memory', 'stats.json', {
        embeddings: { count: 290, source: 'hivememory', observedAt: '2026-06-01T00:00:00Z' },
        memories: { count: 41_100, source: 'hivememory', observedAt: '2026-06-01T00:00:00Z' },
        dbSizeBytes: 340_000,
        sourceDescription: 'hivememory',
      });
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.memory?.embeddings?.count).toBe(290);
      expect(snap.memory?.memories?.count).toBe(41_100);
      expect(snap.memory?.dbSizeBytes).toBe(340_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits memory when all counters are absent (OMIT > FAKE)', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'memory', 'stats.json', { sourceDescription: 'hivememory' });
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.memory).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('populates tests suite from tests/current.json', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'tests', 'current.json', {
        suite: {
          version: 1, eventId: 'e1', ts: '2026-06-01T00:00:00Z', repoRoot: root,
          projectKey: 'k', runner: 'vitest', kind: 'suite',
          passed: 142, failed: 0, skipped: 0, total: 142,
          producerKind: 'wrapper', producerId: 'p',
        },
      });
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.tests?.suite?.total).toBe(142);
      expect(snap.tests?.suite?.passed).toBe(142);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits tests when there is no canonical suite record (OMIT > FAKE)', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'tests', 'current.json', {});
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.tests).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('populates attention from attention/current.json', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'attention', 'current.json', {
        unresolved: [
          { id: 'a1', ts: '2026-06-01T00:00:00Z', severity: 'critical', source: 'gate', message: 'permission required', redacted: false, ageSeconds: 3 },
        ],
      });
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.attention?.unresolved.length).toBe(1);
      expect(snap.attention?.unresolved[0].message).toBe('permission required');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits attention when there are no unresolved entries (OMIT > FAKE)', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'attention', 'current.json', { unresolved: [] });
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.attention).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('populates mcp from mcp/health.json and omits when total is zero', async () => {
    const root = setupRoot();
    try {
      writeSummary(root, 'mcp', 'health.json', {
        version: 1, observedAt: '2026-06-01T00:00:00Z', probeVersion: 1,
        source: 'setup-verify-json-rpc', total: 7, configured: 7, runtimeUp: 5, state: 'config-present',
      });
      let snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.mcp?.total).toBe(7);
      expect(snap.mcp?.runtimeUp).toBe(5);

      writeSummary(root, 'mcp', 'health.json', {
        version: 1, observedAt: '2026-06-01T00:00:00Z', probeVersion: 1,
        source: 'setup-verify-json-rpc', total: 0, configured: 0, runtimeUp: 0, state: 'not-configured',
      });
      snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.mcp).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a single corrupt summary file never aborts the other probes', async () => {
    const root = setupRoot();
    try {
      // Corrupt scoreboard, valid memory — memory must still populate.
      mkdirSync(join(root, '.hive-flow', 'scoreboard'), { recursive: true });
      writeFileSync(join(root, '.hive-flow', 'scoreboard', 'current.json'), '{not json', { mode: 0o600 });
      writeSummary(root, 'memory', 'stats.json', {
        embeddings: { count: 5, source: 's', observedAt: '2026-06-01T00:00:00Z' },
        sourceDescription: 's',
      });
      const snap = await collectInlineSnapshot({ projectRoot: root, deadlineMs: 500 });
      expect(snap.scoreboard).toBeUndefined();
      expect(snap.memory?.embeddings?.count).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Statusboard audit Slice A — inline/canonical parity for the hive-worker
// counting fixes (SB-4 entries shape, F2 completed hive worker, F3 queen
// prefix). These guarantee the inline renderer agrees with collectSwarm.
// ---------------------------------------------------------------------------

describe('collectInlineSnapshot (Slice A parity with collectSwarm)', () => {
  let fix: Fixture;
  beforeEach(() => {
    fix = setupFixture();
  });
  afterEach(() => {
    cleanup(fix);
    vi.restoreAllMocks();
  });

  // SB-4 — an `entries`-only legacy store must produce the SAME swarm count in
  // both the canonical collector and the inline probe. Before the fix, inline
  // probeSwarm read only `.agents` and omitted the swarm row entirely.
  it("honors the legacy 'entries' store shape for parity with collectSwarm", async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    // Note: an `entries`-shaped store (no `agents` key).
    writeFileSync(
      fix.storePath,
      JSON.stringify({
        version: '1.0',
        entries: {
          w1: {
            agentId: 'w1',
            agentType: 'coder',
            status: 'busy',
            ownerSessionId: 'session-a',
            currentTaskPid: process.pid,
          },
          w2: {
            agentId: 'w2',
            agentType: 'tester',
            status: 'busy',
            ownerSessionId: 'session-a',
            currentTaskPid: process.pid,
          },
        },
      }),
      { mode: 0o600 },
    );

    const canonical = await collectSwarm({ projectRoot: fix.projectRoot });
    const inline = await collectInlineSnapshot({ projectRoot: fix.projectRoot, deadlineMs: 500 });

    // Canonical already honored `entries`; inline now matches.
    expect(canonical.workersAlive).toBe(2);
    expect(inline.swarm).toBeDefined();
    expect(inline.swarm?.activeAgents).toBe(2);
    expect(inline.swarm?.agents?.map((a) => a.id)).toEqual(['w1', 'w2']);
  });

  // F2 mirror — inline path must also drop a completed hive worker with a
  // lingering live pid.
  it('does NOT count a completed hive worker with a live pid (inline F2 mirror)', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      done: {
        agentId: 'done-worker',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        config: { hiveId: 'h1' },
        lastResult: { completedAt: '2026-06-20T19:38:09.227Z' },
      },
      live: {
        agentId: 'live-worker',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
        config: { hiveId: 'h1' },
      },
    });
    writeHive(fix.projectRoot, 'h1', [
      { agentId: 'done-worker', workerId: 'done-worker', status: 'busy', currentTaskPid: process.pid },
      { agentId: 'live-worker', workerId: 'live-worker', status: 'busy', currentTaskPid: process.pid },
    ], 'queen-h1', 'session-a');

    const snap = await collectInlineSnapshot({ projectRoot: fix.projectRoot, deadlineMs: 500 });
    expect(snap.swarm?.agents?.map((a) => a.id)).toEqual(['live-worker', 'queen-h1']);
    expect(snap.swarm?.activeQueens).toBe(1);
    expect(snap.swarm?.executingQueens).toBe(0);
  });

  // F3 mirror — inline path must classify a 'queen-*' record with agentType
  // worker as a WORKER, not a queen.
  it("classifies 'queen-*' agentType worker as a worker (inline F3 mirror)", async () => {
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

    const snap = await collectInlineSnapshot({ projectRoot: fix.projectRoot, deadlineMs: 500 });
    expect(snap.swarm?.activeQueens).toBe(0);
    expect(snap.swarm?.activeAgents).toBe(1);
    expect(snap.swarm?.agents?.map((a) => a.id)).toEqual(['queen-bee']);
  });

  it('counts a hive-only live worker from task pid evidence (inline mirror)', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeHive(fix.projectRoot, 'h-live', [
      {
        agentId: 'worker-live',
        workerId: 'worker-live',
        status: 'idle',
        taskId: 'task-live',
        provider: 'deepseek',
        resolvedModel: 'deepseek-v4-pro',
      },
    ], 'queen-live', 'session-a');
    writeTaskMetadata(fix.projectRoot, 'task-live', {
      status: 'running',
      pid: process.pid,
      provider: 'deepseek',
      resolvedModel: 'deepseek-v4-pro',
    });

    const canonical = await collectSwarm({ projectRoot: fix.projectRoot });
    const inline = await collectInlineSnapshot({ projectRoot: fix.projectRoot, deadlineMs: 500 });

    expect(canonical.workersAlive).toBe(1);
    expect(inline.swarm?.activeAgents).toBe(1);
    expect(inline.swarm?.agents).toEqual([
      expect.objectContaining({
        id: 'worker-live',
        role: 'worker',
        ownerSessionId: 'session-a',
        status: 'busy',
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      }),
      expect.objectContaining({
        id: 'queen-live',
        role: 'queen',
        ownerSessionId: 'session-a',
        status: 'idle',
      }),
    ]);
    expect(inline.swarm?.activeQueens).toBe(1);
    expect(inline.swarm?.executingQueens).toBe(0);
  });

  it('session-scopes hive-only live workers (inline mirror)', async () => {
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeHive(fix.projectRoot, 'h-live', [
      { agentId: 'worker-live', workerId: 'worker-live', status: 'idle', taskId: 'task-live' },
    ], 'queen-live', 'session-a');
    writeTaskMetadata(fix.projectRoot, 'task-live', {
      status: 'running',
      pid: process.pid,
    });

    const sameSession = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      sessionId: 'session-a',
      deadlineMs: 500,
    });
    const otherSession = await collectInlineSnapshot({
      projectRoot: fix.projectRoot,
      sessionId: 'session-b',
      deadlineMs: 500,
    });

    expect(sameSession.swarm?.activeAgents).toBe(1);
    expect(otherSession.swarm).toBeUndefined();
  });
});
