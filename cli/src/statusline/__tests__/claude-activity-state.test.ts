// hive-flow-f16a — activity tracker regressions (acceptance rows A2, A12, A14-A17, A25).
//
// The concurrency regression (A15) spawns REAL separate processes against the
// compiled tracker, because create-once behaviour cannot be proven in-process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';

// The tracker resolves its roots per CALL (not at import time), so a single
// static import correctly observes each test's CLAUDE_STATUSLINE_TEST_ROOT.
import { readSessionProjection, recordHookEvent } from '../claude-activity-state.js';

/** Property run count, overridable for deeper local/CI sweeps. */
const PROPERTY_RUNS = Number(process.env.HIVE_FLOW_PROPERTY_RUNS || process.env.HF_PROPERTY_RUNS || 50);

let root: string;
const SESSION = 'sess-f16a-abc123';

const stateFor = (session = SESSION): string => join(root, 'state', session);
/** Current generation for a session, read from the authoritative marker. */
const currentGeneration = (session = SESSION): string =>
  String(readJson(join(stateFor(session), 'generation.json'))?.generation);
/** Generation-scoped record path (records are no longer at shared pathnames). */
const genFile = (...parts: string[]): string =>
  join(stateFor(), 'g', currentGeneration(), ...parts);
const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const DIST_MODULE = resolve(
  __dirname, '..', '..', '..', 'dist', 'src', 'statusline', 'claude-activity-state.js',
);
const RUNNER = join(__dirname, 'fixtures', 'activity-hook-runner.mjs');

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  expect(
    existsSync(DIST_MODULE),
    `compiled tracker missing at ${DIST_MODULE} — run "npm run build" first`,
  ).toBe(true);
  return {
    ...process.env,
    NODE_ENV: 'test',
    CLAUDE_STATUSLINE_TEST_ROOT: root,
    HF_TRACKER_MODULE: pathToFileURL(DIST_MODULE).href,
    ...extra,
  };
}

/** Run the REAL hook in its own process, optionally crashing at a fault point. */
function runHook(
  event: string,
  opts: { fault?: string; payload?: Record<string, unknown> } = {},
): { status: number | null } {
  const r = spawnSync(
    process.execPath,
    [RUNNER, event, JSON.stringify({ session_id: SESSION, tool_name: 'Bash', ...opts.payload })],
    {
      encoding: 'utf8',
      env: childEnv(opts.fault ? { CLAUDE_STATUSLINE_TEST_FAULT: opts.fault } : {}),
    },
  );
  return { status: r.status };
}

/**
 * Spawn every hook ASYNCHRONOUSLY, wait until all of them are parked on the
 * barrier, then release them so they genuinely contend.
 */
async function runHooksConcurrently(
  specs: Array<{ event: string; payload?: Record<string, unknown> }>,
): Promise<Array<{ status: number | null }>> {
  const barrier = join(root, `barrier-${Math.random().toString(36).slice(2)}`);
  const readyFiles = specs.map((_, i) => join(root, `ready-${i}-${Math.random().toString(36).slice(2)}`));

  const children = specs.map((spec, i) =>
    spawn(
      process.execPath,
      [RUNNER, spec.event, JSON.stringify({ session_id: SESSION, tool_name: 'Bash', ...spec.payload })],
      { env: childEnv({ HF_BARRIER: barrier, HF_READY: readyFiles[i]! }), stdio: 'ignore' },
    ),
  );

  let exited = 0;
  const exits = children.map(
    (child) =>
      new Promise<number | null>((res) =>
        child.once('exit', (code) => {
          exited++;
          res(code);
        }),
      ),
  );

  // Wait for real readiness rather than sleeping.
  const deadline = Date.now() + 30_000;
  while (readyFiles.some((f) => !existsSync(f))) {
    if (Date.now() > deadline) throw new Error('children never reached the barrier');
    await new Promise((res) => setTimeout(res, 5));
  }

  // SELF-VERIFYING CONTENTION: every child must still be alive, parked on the
  // barrier. If any had already exited, they were not contending and this
  // regression would be proving nothing (the defect Codex bounced).
  expect(exited, 'a child exited before the barrier was released — not concurrent').toBe(0);

  writeFileSync(barrier, 'go'); // release them all at once
  return (await Promise.all(exits)).map((status) => ({ status }));
}

/** A PID that is guaranteed dead: spawn a short-lived process and reuse its id. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
  if (typeof r.pid !== 'number') throw new Error('could not obtain a pid');
  return r.pid;
}

beforeEach(() => {
  // realpath: macOS /var is a symlink to /private/var, and path equality matters.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-f16a-tracker-')));
  process.env.NODE_ENV = 'test';
  process.env.CLAUDE_STATUSLINE_TEST_ROOT = root;
  delete process.env.CLAUDE_STATUSLINE_TEST_FAULT;
});

afterEach(() => {
  delete process.env.CLAUDE_STATUSLINE_TEST_ROOT;
  delete process.env.CLAUDE_STATUSLINE_TEST_FAULT;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('session validation (A16)', () => {
  it('writes NOTHING for a malformed or untrusted session id', async () => {
    for (const bad of ['', '../escape', 'a'.repeat(65), 'has space', null, 42, undefined]) {
      recordHookEvent('prompt', { session_id: bad });
      expect(await readSessionProjection(bad)).toBeNull();
    }
    // No session directories were created at all.
    expect(existsSync(join(root, 'state')) ? readdirSync(join(root, 'state')) : []).toHaveLength(0);
  });
});

describe('late-attach (A14)', () => {
  it('initializes from the first post-install event and reports the TRUTHFUL state', async () => {
    // No SessionStart ever fired — this is the already-running-session case.
    expect(await readSessionProjection(SESSION)).toBeNull();

    recordHookEvent('prompt', { session_id: SESSION });

    const projection = await readSessionProjection(SESSION);
    expect(projection).not.toBeNull();
    // The event that caused initialization produces the current state, not idle.
    expect(projection?.state).toBe('thinking');

    const generation = readJson(join(stateFor(), 'generation.json'));
    expect(generation?.source).toBe('late-attach'); // distinct, auditable token
  });

  it('reports Working with the tool for a pre-tool first event', async () => {
    recordHookEvent('pre-tool', { session_id: SESSION, tool_name: 'Bash' });
    const projection = await readSessionProjection(SESSION);
    expect(projection?.state).toBe('working');
    expect(projection?.tool).toBe('Bash');
  });

  it('reports Needs you for a permission-request first event', async () => {
    recordHookEvent('permission-request', { session_id: SESSION });
    expect((await readSessionProjection(SESSION))?.state).toBe('needs-human');
  });

  it('fabricates NO history: no tools, identities, tasks, or permission state', async () => {
    // Pre-existing tasks this session never observed must not be resurrected.
    const taskDir = join(root, 'tasks', SESSION);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 't1.json'), JSON.stringify({ status: 'pending' }));
    writeFileSync(join(taskDir, 't2.json'), JSON.stringify({ status: 'completed' }));

    recordHookEvent('prompt', { session_id: SESSION });

    const projection = await readSessionProjection(SESSION);
    expect(projection?.tool).toBeNull();
    expect(projection?.pendingAgents).toBe(0);
    expect(projection?.bgShells).toBe(0);
    // Acknowledged, never replayed as newly-discovered work.
    expect(projection?.tasks).toBeNull();
  });
});

describe('SessionStart authority (A17)', () => {
  it('a real fresh-source SessionStart resets and outranks late-attach state', async () => {
    recordHookEvent('pre-tool', { session_id: SESSION, tool_name: 'Bash' });
    const lateGen = readJson(join(stateFor(), 'generation.json'))?.generation;
    expect((await readSessionProjection(SESSION))?.state).toBe('working');

    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });

    const marker = readJson(join(stateFor(), 'generation.json'));
    expect(marker?.source).toBe('startup');
    expect(marker?.generation).not.toBe(lateGen); // a genuinely new generation
    expect((await readSessionProjection(SESSION))?.state).toBe('idle');
  });

  it('compact is a preservation boundary and does not rewrite state', async () => {
    recordHookEvent('pre-tool', { session_id: SESSION, tool_name: 'Read' });
    const before = readJson(join(stateFor(), 'generation.json'));
    recordHookEvent('session-start', { session_id: SESSION, source: 'compact' });
    expect(readJson(join(stateFor(), 'generation.json'))).toEqual(before);
    expect((await readSessionProjection(SESSION))?.state).toBe('working');
  });
});

describe('event handling (A12)', () => {
  it('tracks background shells from the Stop inventory, and subagents by identity', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('pre-tool', {
      session_id: SESSION,
      tool_name: 'Bash',
      tool_input: { run_in_background: true },
      // A REAL tool_use_id. Note it is NOT the background task id; the previous
      // design keyed a start on this value and could never cancel it.
      tool_use_id: 'toolu_01Atqvh4TgA4MxXzVfFiCemn',
    });
    recordHookEvent('subagent-start', { session_id: SESSION, agent_id: 'agent-1' });
    recordHookEvent('stop', {
      session_id: SESSION,
      background_tasks: [{ id: 'b7tcpuznr', type: 'shell', status: 'running' }],
    });

    // Turn is over but background work is outstanding -> Waiting, not Idle.
    let projection = await readSessionProjection(SESSION);
    expect(projection?.state).toBe('waiting');
    expect(projection?.bgShells).toBe(1);
    expect(projection?.pendingAgents).toBe(1);

    recordHookEvent('subagent-stop', { session_id: SESSION, agent_id: 'agent-1' });
    // Natural completion: the next turn's inventory is empty.
    recordHookEvent('stop', { session_id: SESSION, background_tasks: [] });

    projection = await readSessionProjection(SESSION);
    expect(projection?.state).toBe('idle');
    expect(projection?.bgShells).toBe(0);
    expect(projection?.pendingAgents).toBe(0);
  });

  // The defect that produced a live `Waiting · 14 shells` while all fourteen
  // tasks had completed. The old test reused `shell-1` for BOTH fields, so the
  // namespaces appeared to match and the leak was invisible.
  it('does not leak a shell when tool_use_id and the background task id differ', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    for (let i = 0; i < 14; i++) {
      recordHookEvent('pre-tool', {
        session_id: SESSION,
        tool_name: 'Bash',
        tool_input: { run_in_background: true },
        tool_use_id: `toolu_${i}aBcDeFgHiJkLmNoPqRsT`,
      });
      // The real completion path reports a DIFFERENT id namespace.
      recordHookEvent('post-tool', {
        session_id: SESSION,
        tool_name: 'TaskStop',
        tool_input: { task_id: `b${i}xyzabcd` },
      });
    }
    // Assert the leak is gone AT SOURCE, before any inventory can mask it. The
    // final projection alone is not sufficient evidence: an authoritative empty
    // inventory overrides legacy records, so this would read zero even if all
    // fourteen stale `shells/start` files were still being written.
    const startDir = genFile('shells', 'start');
    expect(existsSync(startDir) ? readdirSync(startDir) : []).toEqual([]);

    recordHookEvent('stop', { session_id: SESSION, background_tasks: [] });

    const projection = await readSessionProjection(SESSION);
    expect(projection?.bgShells).toBe(0);
    expect(projection?.state).toBe('idle');
  });

  it('refuses an inventory whose serialization would exceed the read bound', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('stop', {
      session_id: SESSION,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }],
    });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(1);

    // Structurally valid: 200 unique ids, each well under the 1024-byte identity
    // limit, and under the 256-entry cap — but together they serialize past the
    // 64 KiB record bound the reader enforces.
    const huge = Array.from({ length: 200 }, (_, i) => ({
      id: `b${String(i).padStart(4, '0')}${'x'.repeat(400)}`,
      type: 'shell',
      status: 'running',
    }));
    expect(JSON.stringify(huge).length).toBeGreaterThan(64 * 1024);

    recordHookEvent('stop', { session_id: SESSION, background_tasks: huge });

    // The unreadable record is never published — but the previous inventory is
    // not left standing in for it either, because we positively know it is now
    // wrong. The truthful answer is "unknown", so the projection is omitted.
    expect(await readSessionProjection(SESSION)).toBeNull();

    // Assert the WRITER bound at the file level, not just the projection. The
    // reader's own size check would also yield null if a giant record were
    // written, so projection alone cannot tell "refused to write it" from
    // "wrote it and rejected it on read". What must not happen is a >64 KiB
    // blob being rewritten on every Stop.
    const persisted = readFileSync(genFile('shells', 'inventory.json'), 'utf8');
    expect(Buffer.byteLength(persisted, 'utf8')).toBeLessThan(1024);
    expect(JSON.parse(persisted).overflow).toBe(true);
  });

  // Raised by the read-only verifier as HIGH. Preserving the previous inventory
  // is only correct while it is still plausibly true. When the previous record
  // was a valid EMPTY one, silently keeping it reports zero shells while
  // hundreds are in flight — a confident lie, which is worse than the stale
  // over-count this knot set out to fix.
  it('an over-byte inventory does not leave a stale EMPTY inventory asserting zero', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('stop', { session_id: SESSION, background_tasks: [] });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(0);

    const huge = Array.from({ length: 200 }, (_, i) => ({
      id: `b${String(i).padStart(4, '0')}${'x'.repeat(400)}`,
      type: 'shell',
      status: 'running',
    }));
    recordHookEvent('stop', { session_id: SESSION, background_tasks: huge });

    // Truthful outcome is "unknown", not "zero": fail closed and omit.
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('does not count prototype-inherited type/id as a shell entry', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    // No OWN `type`/`id`: reading through the prototype chain would inflate the
    // count from an entry carrying no real data.
    const ghost = Object.create({ type: 'shell', id: 'b-ghost' }) as Record<string, unknown>;
    recordHookEvent('stop', { session_id: SESSION, background_tasks: [ghost] });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(0);
  });

  it('a momentarily absent inventory does not resurrect legacy starts', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const gen = currentGeneration(SESSION);

    // Stale legacy starts, as the live session carries.
    const startDir = genFile('shells', 'start');
    mkdirSync(startDir, { recursive: true });
    for (let i = 0; i < 14; i++) {
      const id = `toolu_stale_${i}`;
      writeFileSync(
        join(startDir, `${createHash('sha256').update(id).digest('hex')}.json`),
        JSON.stringify({ schema: 1, generation: gen, id, ts: Date.now() }),
      );
    }
    // An inventory HAS been established and healed them.
    recordHookEvent('stop', { session_id: SESSION, background_tasks: [] });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(0);

    // Simulate the atomicWrite replacement window: the record is briefly gone.
    const invFile = genFile('shells', 'inventory.json');
    const saved = readFileSync(invFile, 'utf8');
    rmSync(invFile);
    // Authority was already established, so absence is UNKNOWN, never a licence
    // to resurrect the fourteen. An earlier version of this test asserted 14
    // here, which documented the defect as if it were the contract.
    expect(await readSessionProjection(SESSION)).toBeNull();
    // Once the replacement lands, the inventory is authoritative again.
    writeFileSync(invFile, saved);
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(0);
  });

  it('a writer that dies after establishing authority never falls back to legacy', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const gen = currentGeneration(SESSION);
    const startDir = genFile('shells', 'start');
    mkdirSync(startDir, { recursive: true });
    const id = 'toolu_stale_crash';
    writeFileSync(
      join(startDir, `${createHash('sha256').update(id).digest('hex')}.json`),
      JSON.stringify({ schema: 1, generation: gen, id, ts: Date.now() }),
    );
    // Sentinel published, inventory never written — the crash window.
    const authority = genFile('shells', 'authority.json');
    mkdirSync(dirname(authority), { recursive: true });
    writeFileSync(authority, JSON.stringify({ schema: 1, generation: gen, ts: Date.now() }));

    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('legacy fallback applies only when BOTH inventory and authority are absent', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const gen = currentGeneration(SESSION);
    const startDir = genFile('shells', 'start');
    mkdirSync(startDir, { recursive: true });
    const id = 'toolu_compat_only';
    writeFileSync(
      join(startDir, `${createHash('sha256').update(id).digest('hex')}.json`),
      JSON.stringify({ schema: 1, generation: gen, id, ts: Date.now() }),
    );
    expect(existsSync(genFile('shells', 'authority.json'))).toBe(false);
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(1);
  });

  it('a valid empty inventory heals stale legacy start records', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    // Simulate the live session: legacy starts written by the old design.
    const gen = currentGeneration(SESSION);
    const startDir = genFile('shells', 'start');
    mkdirSync(startDir, { recursive: true });
    for (let i = 0; i < 14; i++) {
      const id = `toolu_stale_${i}`;
      writeFileSync(
        join(startDir, `${createHash('sha256').update(id).digest('hex')}.json`),
        JSON.stringify({ schema: 1, generation: gen, id, ts: Date.now() }),
      );
    }
    // Legacy records alone still project the stale count.
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(14);

    recordHookEvent('stop', { session_id: SESSION, background_tasks: [] });
    const healed = await readSessionProjection(SESSION);
    expect(healed?.bgShells).toBe(0);
    expect(healed?.state).toBe('idle');
    // Self-heals by overriding, NOT by deleting unrelated session state.
    expect(readdirSync(startDir).length).toBe(14);
  });

  it('counts only shell entries and deduplicates them', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('stop', {
      session_id: SESSION,
      background_tasks: [
        { id: 'b1', type: 'shell', status: 'running' },
        { id: 'b1', type: 'shell', status: 'running' },
        { id: 'b2', type: 'shell', status: 'running' },
        { id: 'a1', type: 'subagent', status: 'running' },
        { id: 'm1', type: 'monitor', status: 'running' },
        { id: 'w1', type: 'workflow', status: 'running' },
      ],
    });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(2);
  });

  // PRESENT but unrepresentable. Preserving the prior record would assert a
  // number we positively know is no longer the answer — and had the prior record
  // been empty, that is a confident `Idle` while shells are running. The
  // truthful outcome is "unknown", so the projection is omitted.
  it.each([
    ['present undefined', undefined],
    ['null', null],
    ['non-array', { id: 'b1', type: 'shell' }],
    ['non-object entry', ['b1']],
    ['shell entry without an id', [{ type: 'shell', status: 'running' }]],
    ['shell entry with a non-string id', [{ id: 7, type: 'shell' }]],
    ['over the entry cap', Array.from({ length: 257 }, (_, i) => ({ id: `b${i}`, type: 'shell' }))],
  ])('a present-but-invalid inventory (%s) poisons the record and omits the projection', async (_label, tasks) => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('stop', {
      session_id: SESSION,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }],
    });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(1);

    recordHookEvent('stop', { session_id: SESSION, background_tasks: tasks });
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  // The ONLY preserve path: the registry gave no answer at all. `StopFailure`
  // naturally takes this route and must not poison a good inventory.
  it('a truly absent background_tasks field preserves the last valid inventory', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('stop', {
      session_id: SESSION,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }],
    });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(1);

    // No `background_tasks` key at all — not present-and-undefined.
    recordHookEvent('stop', { session_id: SESSION });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(1);
    recordHookEvent('stop-failed', { session_id: SESSION });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(1);
  });

  // Absence and corruption are different answers. If they collapsed into one,
  // a corrupt inventory would silently fall back to the legacy starts the
  // inventory exists to supersede — resurrecting the stale count.
  it.each([
    ['unparseable json', () => 'not json at all'],
    ['wrong schema', () => JSON.stringify({ schema: 99, generation: 'x', ids: [], ts: 1 })],
    ['ids not an array', (gen: string) => JSON.stringify({ schema: 1, generation: gen, ids: 'b1', ts: 1 })],
    ['a non-string id', (gen: string) => JSON.stringify({ schema: 1, generation: gen, ids: [7], ts: 1 })],
    ['missing ts', (gen: string) => JSON.stringify({ schema: 1, generation: gen, ids: [] })],
  ])('a persisted %s inventory fails closed and does NOT fall back to legacy starts', async (_label, body) => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const gen = currentGeneration(SESSION);

    // Legacy starts exist and would be resurrected by an incorrect fallback.
    const startDir = genFile('shells', 'start');
    mkdirSync(startDir, { recursive: true });
    const id = 'toolu_stale_legacy';
    writeFileSync(
      join(startDir, `${createHash('sha256').update(id).digest('hex')}.json`),
      JSON.stringify({ schema: 1, generation: gen, id, ts: Date.now() }),
    );
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(1);

    // Corrupt the authoritative inventory.
    const invFile = genFile('shells', 'inventory.json');
    mkdirSync(dirname(invFile), { recursive: true });
    writeFileSync(invFile, body(gen));

    // Fail closed: omit the projection entirely rather than fall back.
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('a non-regular inventory path fails closed rather than falling back', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    // A directory where the record belongs is corruption, not absence.
    mkdirSync(genFile('shells', 'inventory.json'), { recursive: true });
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('a symlinked inventory fails closed even when its target is valid', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const gen = currentGeneration(SESSION);
    const invFile = genFile('shells', 'inventory.json');
    mkdirSync(dirname(invFile), { recursive: true });
    // A perfectly valid record, reached through a symlink. `stat` would follow
    // it and report a regular file; only `lstat` sees the link itself.
    const target = join(dirname(invFile), 'real-inventory.json');
    writeFileSync(target, JSON.stringify({ schema: 1, generation: gen, ids: ['b1'], ts: Date.now() }));
    symlinkSync(target, invFile);
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('an unreadable inventory directory fails closed rather than reading as absent', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const invFile = genFile('shells', 'inventory.json');
    mkdirSync(dirname(invFile), { recursive: true });
    writeFileSync(invFile, JSON.stringify({ schema: 1, generation: currentGeneration(SESSION), ids: [], ts: Date.now() }));
    // Deny traversal so lstat fails with EACCES, not ENOENT. Skipped when
    // running as root, where mode bits do not deny.
    if (process.getuid?.() === 0) return;
    const shellsDir = dirname(invFile);
    chmodSync(shellsDir, 0o000);
    try {
      expect(await readSessionProjection(SESSION)).toBeNull();
    } finally {
      chmodSync(shellsDir, 0o700);
    }
  });

  it('a truly absent inventory still permits the legacy fallback', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const gen = currentGeneration(SESSION);
    const startDir = genFile('shells', 'start');
    mkdirSync(startDir, { recursive: true });
    const id = 'toolu_legacy_only';
    writeFileSync(
      join(startDir, `${createHash('sha256').update(id).digest('hex')}.json`),
      JSON.stringify({ schema: 1, generation: gen, id, ts: Date.now() }),
    );
    // No inventory file was ever written, so the bounded legacy read applies.
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(1);
  });

  it('an over-bound inventory poisons the record rather than preserving a stale count', async () => {
    // Retained separately from the table for the empty-prior case, which is the
    // dangerous one: preserving an empty prior reports Idle while shells run.
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('stop', { session_id: SESSION, background_tasks: [] });
    expect((await readSessionProjection(SESSION))?.bgShells).toBe(0);

    const huge = Array.from({ length: 257 }, (_, i) => ({ id: `b${i}`, type: 'shell' }));
    recordHookEvent('stop', { session_id: SESSION, background_tasks: huge });
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Properties over arbitrary bounded inventories (hive-flow-ae28).
  //
  // The table cases above pin known shapes; these prove the invariants hold
  // across generated inventories rather than only the shapes I thought to write.
  // -------------------------------------------------------------------------
  const shellId = fc.string({ minLength: 1, maxLength: 24 })
    .filter((s) => s.length > 0 && s.length <= 1024);
  const shellEntry = fc.record({ id: shellId, type: fc.constant('shell') });
  const otherEntry = fc.record({
    id: shellId,
    type: fc.constantFrom('subagent', 'monitor', 'workflow', 'task', ''),
  });

  it('property: bgShells equals the unique validated shell ids of the last valid inventory', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.oneof(shellEntry, otherEntry), { maxLength: 40 }), async (tasks) => {
        recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
        recordHookEvent('stop', { session_id: SESSION, background_tasks: tasks });
        const expected = new Set(
          tasks.filter((t) => t.type === 'shell').map((t) => t.id),
        ).size;
        expect((await readSessionProjection(SESSION))?.bgShells).toBe(expected);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('property: non-shell entries never increase bgShells', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(otherEntry, { maxLength: 40 }), async (tasks) => {
        recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
        recordHookEvent('stop', { session_id: SESSION, background_tasks: tasks });
        expect((await readSessionProjection(SESSION))?.bgShells).toBe(0);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('property: a present-but-invalid inventory never reports a stale count', async () => {
    const invalid = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant('not-an-array'),
      fc.integer(),
      fc.array(fc.integer(), { minLength: 1, maxLength: 5 }),
      fc.array(fc.record({ type: fc.constant('shell') }), { minLength: 1, maxLength: 5 }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(shellEntry, { minLength: 1, maxLength: 10 }), invalid, async (good, bad) => {
        recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
        recordHookEvent('stop', { session_id: SESSION, background_tasks: good });
        expect((await readSessionProjection(SESSION))?.bgShells)
          .toBe(new Set(good.map((t) => t.id)).size);
        // The field is PRESENT and unrepresentable, so the prior count is known
        // to be stale: report unknown rather than a number we know is wrong.
        recordHookEvent('stop', { session_id: SESSION, background_tasks: bad });
        expect(await readSessionProjection(SESSION)).toBeNull();
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('property: a valid empty inventory always defeats arbitrary legacy starts', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(shellId, { maxLength: 30 }), async (legacyIds) => {
        recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
        const gen = currentGeneration(SESSION);
        const startDir = genFile('shells', 'start');
        mkdirSync(startDir, { recursive: true });
        for (const id of legacyIds) {
          writeFileSync(
            join(startDir, `${createHash('sha256').update(id).digest('hex')}.json`),
            JSON.stringify({ schema: 1, generation: gen, id, ts: Date.now() }),
          );
        }
        recordHookEvent('stop', { session_id: SESSION, background_tasks: [] });
        expect((await readSessionProjection(SESSION))?.bgShells).toBe(0);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  // The in-process tests above call `recordHookEvent` directly, and the
  // concurrency runner imports the compiled module. Neither proves that the
  // PRODUCTION entrypoint's stdin parsing carries `background_tasks` through to
  // the inventory — so this drives the real bin, on stdin, end to end.
  //
  // The entrypoint is fail-open and exits 0 unconditionally, so exit status
  // alone cannot prove the wiring worked; the projection assertions are the real
  // evidence, and exit 0 only proves it never broke the turn.
  it('the real claude-activity-hook entrypoint carries Stop.background_tasks into the inventory', async () => {
    const ENTRYPOINT = resolve(__dirname, '..', '..', '..', 'bin', 'claude-activity-hook.js');
    expect(
      existsSync(ENTRYPOINT),
      `production entrypoint missing at ${ENTRYPOINT}`,
    ).toBe(true);

    const runEntrypoint = (event: string, payload: Record<string, unknown>) => {
      const r = spawnSync(process.execPath, [ENTRYPOINT, event], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        // childEnv asserts the compiled tracker exists and scopes all writes to
        // this test's temp root.
        env: childEnv(),
      });
      expect(r.status, `entrypoint ${event} failed: ${r.stderr}`).toBe(0);
      return r;
    };

    runEntrypoint('session-start', { session_id: SESSION, source: 'startup' });

    // Negative control FIRST, so the positive assertion below cannot pass for
    // some reason other than the wiring under test: a Stop carrying no
    // inventory must not produce a waiting shell.
    runEntrypoint('stop', { session_id: SESSION });
    const noInventory = await readSessionProjection(SESSION);
    expect(noInventory?.bgShells).toBe(0);
    expect(noInventory?.state).toBe('idle');

    // One in-flight background shell.
    runEntrypoint('stop', {
      session_id: SESSION,
      background_tasks: [{ id: 'b7tcpuznr', type: 'shell', status: 'running' }],
    });
    const waiting = await readSessionProjection(SESSION);
    expect(waiting?.bgShells).toBe(1);
    expect(waiting?.state).toBe('waiting');

    // Natural completion reported by the next turn's inventory.
    runEntrypoint('stop', { session_id: SESSION, background_tasks: [] });
    const idle = await readSessionProjection(SESSION);
    expect(idle?.bgShells).toBe(0);
    expect(idle?.state).toBe('idle');
  });

  it('only human-required notifications reach Needs you', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('notify', { session_id: SESSION, notification_type: 'auth_success' });
    expect((await readSessionProjection(SESSION))?.state).toBe('idle');
    recordHookEvent('notify', { session_id: SESSION, notification_type: 'permission_prompt' });
    expect((await readSessionProjection(SESSION))?.state).toBe('needs-human');
  });

  it('session-end removes the session state entirely', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    expect(existsSync(stateFor())).toBe(true);
    recordHookEvent('session-end', { session_id: SESSION });
    expect(existsSync(stateFor())).toBe(false);
    expect(await readSessionProjection(SESSION)).toBeNull();
  });
});

describe('untrusted state is omitted, never fabricated as Idle (A2)', () => {
  it('returns null for a generation mismatch', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const activityPath = genFile('activity.json');
    const activity = readJson(activityPath)!;
    writeFileSync(activityPath, JSON.stringify({ ...activity, generation: 'someothergeneration' }));
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('returns null for malformed generation or activity records', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    writeFileSync(genFile('activity.json'), '{ this is not json');
    expect(await readSessionProjection(SESSION)).toBeNull();
    writeFileSync(join(stateFor(), 'generation.json'), '{ torn');
    expect(await readSessionProjection(SESSION)).toBeNull();
  });
});

describe('claim crash recovery (A25)', () => {
  it('boundary 1 — REAL crash after staging (fault=after-stage) leaves no claim; a later event initializes', () => {
    // Drive the ACTUAL hook and kill it at the real fault point rather than
    // hand-forging on-disk state.
    const crashed = runHook('prompt', { fault: 'after-stage' });
    expect(crashed.status).toBe(91); // the fault point fired

    const dir = stateFor();
    // A crash before publication must leave NO canonical claim behind.
    expect(existsSync(join(dir, 'generation.claim'))).toBe(false);
    expect(existsSync(join(dir, 'generation.json'))).toBe(false);

    // Recovery: a later event initializes normally.
    const recovered = runHook('prompt');
    expect(recovered.status).toBe(0);
    expect(readJson(join(dir, 'generation.json'))?.source).toBe('late-attach');
  }, 30_000);

  it('boundary 2 — REAL crash after claim (fault=after-claim) leaves a dead claim; a later event recovers', () => {
    const crashed = runHook('prompt', { fault: 'after-claim' });
    expect(crashed.status).toBe(91);

    const dir = stateFor();
    // A COMPLETE claim exists, owned by a now-dead process, with no generation.
    const claim = readJson(join(dir, 'generation.claim'));
    expect(claim?.schema).toBe(1);
    expect(typeof claim?.owner).toBe('string');
    expect(existsSync(join(dir, 'generation.json'))).toBe(false);

    const recovered = runHook('prompt');
    expect(recovered.status).toBe(0);

    const marker = readJson(join(dir, 'generation.json'));
    expect(marker?.source).toBe('late-attach');
    // The recoverer republishes the DEAD claim's deterministic generation
    // instead of deleting or renaming the claim (which was a pathname TOCTOU).
    expect(readJson(join(dir, 'generation.claim'))?.owner).toBe(claim?.owner);
  }, 30_000);

  it('two concurrent dead-claim recoverers converge on one generation', async () => {
    // The exact race the previous rename-CAS design lost: a recoverer must not
    // be able to disturb a claim another process publishes in the meantime.
    const crashed = runHook('prompt', { fault: 'after-claim' });
    expect(crashed.status).toBe(91);
    const deadClaimOwner = readJson(join(stateFor(), 'generation.claim'))?.owner;

    // Two processes now contend over the same dead claim, released together.
    const results = await runHooksConcurrently([
      { event: 'prompt' },
      { event: 'pre-tool' },
    ]);
    for (const r of results) expect(r.status).toBe(0);

    const dir = stateFor();
    const marker = readJson(join(dir, 'generation.json'));
    expect(typeof marker?.generation).toBe('string');
    // One authoritative generation, and the original claim is untouched.
    expect(readJson(join(dir, 'generation.claim'))?.owner).toBe(deadClaimOwner);
    const projection = await readSessionProjection(SESSION);
    expect(projection?.generation).toBe(marker?.generation);
  }, 45_000);

  it('SessionStart is authoritative over generation-bound state across repeated real races', async () => {
    // Codex reproduced a 2/500 failure here: a late writer could adopt
    // generation A, SessionStart could then publish B, and the late writer
    // could still replace the SHARED activity.json with an A record — the
    // renderer then rejected the mismatch and the activity cell vanished.
    // Records are now generation-SCOPED, so a stale writer physically cannot
    // reach the current generation's state.
    for (let round = 0; round < 25; round++) {
      rmSync(join(root, 'state'), { recursive: true, force: true });

      const results = await runHooksConcurrently([
        { event: 'session-start', payload: { source: 'startup' } },
        { event: 'prompt' },
        { event: 'pre-tool' },
      ]);
      for (const r of results) expect(r.status).toBe(0);

      const marker = readJson(join(stateFor(), 'generation.json'));
      // The authoritative SessionStart marker must survive — not late-attach.
      expect(marker?.source, `round ${round}: SessionStart did not win`).toBe('startup');

      const generation = String(marker?.generation);
      const projection = await readSessionProjection(SESSION);
      // The projection must exist (no vanished activity cell) and every record
      // it used must belong to the authoritative generation.
      expect(projection, `round ${round}: activity vanished`).not.toBeNull();
      expect(projection?.generation).toBe(generation);
      expect(readJson(join(stateFor(), 'g', generation, 'activity.json'))?.generation).toBe(generation);
    }
  }, 120_000);

  it('an initialization fallback never REPLACES an existing truthful activity record', async () => {
    // Deterministic form of the invariant. The generation already exists, so no
    // racer can fail closed on the claim; the only question is whether an event
    // that publishes no activity of its own (subagent-start/stop) can clobber a
    // real state with its initialization fallback `idle`. It must not.
    for (let round = 0; round < 15; round++) {
      rmSync(join(root, 'state'), { recursive: true, force: true });
      // Establish the generation AND a truthful state first.
      recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
      recordHookEvent('prompt', { session_id: SESSION });
      expect((await readSessionProjection(SESSION))?.state).toBe('thinking');

      const results = await runHooksConcurrently([
        { event: 'subagent-start', payload: { agent_id: `agent-${round}` } },
        { event: 'subagent-stop', payload: { agent_id: `other-${round}` } },
      ]);
      for (const r of results) expect(r.status).toBe(0);

      // `thinking` must survive. (A fallback idle would surface as idle, or as
      // `waiting` once the live agent is counted — both are regressions here.)
      const projection = await readSessionProjection(SESSION);
      expect(projection?.state, `round ${round}: fallback overwrote a truthful record`).toBe(
        'thinking',
      );
    }
  }, 120_000);

  it('concurrent cold-start events never produce a FABRICATED state', async () => {
    // From-scratch contention. Under severe host starvation a racer may fail
    // closed and simply not write — that is the designed behaviour, so this
    // asserts the invariant that actually holds: whatever survives is a state
    // some event genuinely produced, and it is internally consistent. It never
    // invents activity that no event reported.
    for (let round = 0; round < 10; round++) {
      rmSync(join(root, 'state'), { recursive: true, force: true });

      const results = await runHooksConcurrently([
        { event: 'subagent-start', payload: { agent_id: `agent-${round}` } },
        { event: 'prompt' },
        { event: 'pre-tool' },
      ]);
      for (const r of results) expect(r.status).toBe(0);

      const projection = await readSessionProjection(SESSION);
      if (projection === null) continue; // every racer failed closed: safe, no claim made
      const generation = currentGeneration();
      expect(projection.generation).toBe(generation);
      expect(readJson(join(stateFor(), 'g', generation, 'activity.json'))?.generation).toBe(
        generation,
      );
      // `waiting` is idle + a live agent, which subagent-start genuinely reported.
      expect(
        ['thinking', 'working', 'waiting', 'idle'],
        `round ${round}: fabricated state`,
      ).toContain(projection.state);
    }
  }, 120_000);

  it('never reclaims a claim held by a LIVE owner — fails closed instead', async () => {
    const dir = stateFor();
    mkdirSync(dir, { recursive: true });
    const liveClaim = JSON.stringify({
      schema: 1,
      owner: 'c'.repeat(32),
      pid: process.pid, // this very process: definitively alive
      ts: Date.now(),
    });
    writeFileSync(join(dir, 'generation.claim'), liveClaim);

    recordHookEvent('prompt', { session_id: SESSION });

    // Fail closed: no generation, no projection, and the live claim survives.
    expect(existsSync(join(dir, 'generation.json'))).toBe(false);
    expect(await readSessionProjection(SESSION)).toBeNull();
    expect(readFileSync(join(dir, 'generation.claim'), 'utf8')).toBe(liveClaim);
  });

  it('an old claimant racing SessionEnd cannot destroy a newer claim (B2)', async () => {
    // Previously releaseClaim() read the claim, checked the owner, then removed
    // the PATHNAME — so an old writer could delete a newer claimant's record
    // after a SessionEnd/new-event race. No writer removes the claim now.
    for (let round = 0; round < 10; round++) {
      rmSync(join(root, 'state'), { recursive: true, force: true });

      // An old claimant is mid-flight (claim published, generation not yet).
      expect(runHook('prompt', { fault: 'after-claim' }).status).toBe(91);
      const oldClaim = readFileSync(join(stateFor(), 'generation.claim'), 'utf8');

      // SessionEnd wipes the session while a new late-attach event arrives.
      const results = await runHooksConcurrently([
        { event: 'session-end' },
        { event: 'prompt' },
      ]);
      for (const r of results) expect(r.status).toBe(0);

      // Whatever the interleaving, the outcome must be self-consistent: either
      // the session was torn down, or a valid generation exists with matching
      // activity. A newer claim must never be silently destroyed leaving
      // unusable state behind.
      const marker = readJson(join(stateFor(), 'generation.json'));
      if (marker) {
        const generation = String(marker.generation);
        const activity = readJson(join(stateFor(), 'g', generation, 'activity.json'));
        expect(activity?.generation, `round ${round}: state not self-consistent`).toBe(generation);
      }
      // The old claim was never removed by a peer writer.
      const claimNow = existsSync(join(stateFor(), 'generation.claim'))
        ? readFileSync(join(stateFor(), 'generation.claim'), 'utf8')
        : null;
      if (claimNow !== null) expect([oldClaim, claimNow]).toContain(claimNow);
    }
  }, 120_000);

  it('fails closed on a malformed claim rather than guessing', async () => {
    const dir = stateFor();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'generation.claim'), '{ not valid json');
    recordHookEvent('prompt', { session_id: SESSION });
    expect(await readSessionProjection(SESSION)).toBeNull();
  });
});

describe('upgrade from the pre-generation-directory layout (B4)', () => {
  // An earlier f16a build wrote activity.json at the SESSION ROOT. Once records
  // moved under g/<generation>/, those sessions were permanently stuck: every
  // event's loadActivity() guard found nothing scoped and returned without
  // writing, so the activity cell stayed blank forever.
  const writeLegacyLayout = (activity: Record<string, unknown>, generation = 'a'.repeat(32)) => {
    const dir = stateFor();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'generation.json'),
      JSON.stringify({ schema: 1, generation, source: 'late-attach', createdAt: Date.now() }),
    );
    writeFileSync(join(dir, 'activity.json'), JSON.stringify(activity));
    return generation;
  };

  it('recovers: a real event yields a scoped projection from a valid legacy record', async () => {
    const generation = writeLegacyLayout({
      schema: 1,
      generation: 'a'.repeat(32),
      state: 'working',
      tool: 'Bash',
      ts: Date.now(),
    });
    // Pre-condition: the stuck state — valid marker, NO scoped activity.
    expect(existsSync(join(stateFor(), 'g', generation, 'activity.json'))).toBe(false);
    expect(await readSessionProjection(SESSION)).toBeNull();

    recordHookEvent('stop', { session_id: SESSION });

    const projection = await readSessionProjection(SESSION);
    expect(projection).not.toBeNull();
    expect(projection?.generation).toBe(generation);
    // The triggering event applied normally on top of the migrated record.
    expect(projection?.state).toBe('idle');
    expect(readJson(join(stateFor(), 'g', generation, 'activity.json'))?.generation).toBe(generation);
  });

  it('an existing scoped record WINS; the legacy record cannot overwrite it', async () => {
    const generation = writeLegacyLayout({
      schema: 1,
      generation: 'a'.repeat(32),
      state: 'working',
      tool: 'LegacyTool',
      ts: Date.now() - 10_000,
    });
    // A scoped record already exists and is authoritative.
    mkdirSync(join(stateFor(), 'g', generation), { recursive: true });
    writeFileSync(
      join(stateFor(), 'g', generation, 'activity.json'),
      JSON.stringify({
        schema: 1,
        generation,
        state: 'needs-human',
        tool: null,
        ts: Date.now(),
      }),
    );

    recordHookEvent('subagent-start', { session_id: SESSION, agent_id: 'a1' });

    // subagent-start writes no activity of its own, so the scoped record stands.
    const projection = await readSessionProjection(SESSION);
    expect(projection?.state).toBe('needs-human');
    expect(readJson(join(stateFor(), 'g', generation, 'activity.json'))?.tool).toBeNull();
  });

  it('does NOT migrate a malformed or generation-mismatched legacy record', async () => {
    // Mismatched generation.
    const generation = writeLegacyLayout({
      schema: 1,
      generation: 'b'.repeat(32), // != marker
      state: 'working',
      tool: 'Bash',
      ts: Date.now(),
    });
    recordHookEvent('subagent-start', { session_id: SESSION, agent_id: 'a1' });
    expect(existsSync(join(stateFor(), 'g', generation, 'activity.json'))).toBe(false);
    expect(await readSessionProjection(SESSION)).toBeNull();

    // Malformed legacy record.
    rmSync(join(root, 'state'), { recursive: true, force: true });
    const gen2 = 'c'.repeat(32);
    mkdirSync(stateFor(), { recursive: true });
    writeFileSync(
      join(stateFor(), 'generation.json'),
      JSON.stringify({ schema: 1, generation: gen2, source: 'late-attach', createdAt: Date.now() }),
    );
    writeFileSync(join(stateFor(), 'activity.json'), '{ not json');
    recordHookEvent('subagent-start', { session_id: SESSION, agent_id: 'a1' });
    expect(existsSync(join(stateFor(), 'g', gen2, 'activity.json'))).toBe(false);
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('leaves unrelated files in the session directory untouched', async () => {
    const generation = writeLegacyLayout({
      schema: 1,
      generation: 'a'.repeat(32),
      state: 'thinking',
      tool: null,
      ts: Date.now(),
    });
    writeFileSync(join(stateFor(), 'unrelated.json'), '{"keep":true}');

    recordHookEvent('prompt', { session_id: SESSION });

    expect(readJson(join(stateFor(), 'unrelated.json'))?.keep).toBe(true);
    // The legacy root record is left in place (migration is a copy, not a move).
    expect(readJson(join(stateFor(), 'activity.json'))?.generation).toBe(generation);
  });
});

describe('render read path is bounded (A26)', () => {
  // The renderer has a sub-200ms end-to-end contract. Pathological state must
  // fail closed (activity omitted) instead of being read to completion.
  it('fails closed on an over-count task directory instead of reading it all', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const taskDir = join(root, 'tasks', SESSION);
    mkdirSync(taskDir, { recursive: true });
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(taskDir, `t${i}.json`), JSON.stringify({ status: 'pending' }));
    }

    const started = Date.now();
    const projection = await readSessionProjection(SESSION);
    const elapsed = Date.now() - started;

    expect(projection).toBeNull(); // omitted, never a slow partial truth
    expect(elapsed).toBeLessThan(200);
  });

  it('fails closed on an over-count identity directory', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const agentDir = genFile('agents', 'start');
    mkdirSync(agentDir, { recursive: true });
    // Unique 64-hex names so all 300 files really exist (> MAX_IDENTITY_FILES).
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(agentDir, `${i.toString(16).padStart(64, '0')}.json`), JSON.stringify({ schema: 1 }));
    }
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('refuses an oversized record rather than loading it', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    // A 1MB activity record blows the per-record cap.
    writeFileSync(
      genFile('activity.json'),
      JSON.stringify({ schema: 1, state: 'idle', tool: 'x'.repeat(1_000_000), ts: Date.now() }),
    );
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('honours an exhausted budget by omitting activity', async () => {
    recordHookEvent('prompt', { session_id: SESSION });
    expect(await readSessionProjection(SESSION)).not.toBeNull();
    // Zero budget: nothing may be read.
    expect(await readSessionProjection(SESSION, { budgetMs: 0 })).toBeNull();
  });

  it('stays fast on a realistic state directory', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    const taskDir = join(root, 'tasks', SESSION);
    mkdirSync(taskDir, { recursive: true });
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(taskDir, `t${i}.json`), JSON.stringify({ status: i % 3 === 0 ? 'completed' : 'pending' }));
    }
    // This asserts READ CORRECTNESS on a realistic directory. It deliberately
    // makes no wall-clock assertion: under heavy parallel test load the host
    // scheduler, not the reader, dominates elapsed time, and enforcement of the
    // deadline itself is already covered by the exhausted-budget and
    // over-count cases above.
    const projection = await readSessionProjection(SESSION, { budgetMs: 1_000 });
    expect(projection).not.toBeNull();
    expect(projection?.state).toBe('idle');
    expect(projection?.tasks?.total).toBe(50);
  });
});

describe('concurrent first events (A15)', () => {
  it('create-once: 8 TRULY concurrent first events converge on ONE generation', async () => {
    // All children are spawned asynchronously and park on a barrier; releasing
    // the barrier makes them contend for real. (spawnSync would serialise them
    // and prove nothing about concurrency.)
    const results = await runHooksConcurrently([
      { event: 'prompt' },
      { event: 'pre-tool' },
      { event: 'permission-request' },
      { event: 'prompt' },
      { event: 'pre-tool' },
      { event: 'prompt' },
      { event: 'prompt' },
      { event: 'pre-tool' },
    ]);
    for (const r of results) expect(r.status).toBe(0);

    const projection = await readSessionProjection(SESSION);
    expect(projection).not.toBeNull();

    // Exactly ONE generation exists, and every published record agrees with it.
    const generation = readJson(join(stateFor(), 'generation.json'))?.generation;
    expect(typeof generation).toBe('string');
    expect(projection?.generation).toBe(generation);
    expect(readJson(join(stateFor(), 'g', String(generation), 'activity.json'))?.generation).toBe(generation);
    // The final projection is truthful — one of the states the racers wrote.
    expect(['thinking', 'working', 'needs-human']).toContain(projection?.state);
    // No losing writer left a competing generation behind.
    const stray = readdirSync(stateFor()).filter(
      (n) => n.startsWith('generation.') && n !== 'generation.json' && n !== 'generation.claim',
    );
    expect(stray).toHaveLength(0);
  }, 60_000);
});
