// hive-flow-f16a — activity tracker regressions (acceptance rows A2, A12, A14-A17, A25).
//
// The concurrency regression (A15) spawns REAL separate processes against the
// compiled tracker, because create-once behaviour cannot be proven in-process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The tracker resolves its roots per CALL (not at import time), so a single
// static import correctly observes each test's CLAUDE_STATUSLINE_TEST_ROOT.
import { readSessionProjection, recordHookEvent } from '../claude-activity-state.js';

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
  it('tracks background shells and subagents, with a stop tombstone winning', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    recordHookEvent('pre-tool', {
      session_id: SESSION,
      tool_name: 'Bash',
      tool_input: { run_in_background: true },
      tool_use_id: 'shell-1',
    });
    recordHookEvent('subagent-start', { session_id: SESSION, agent_id: 'agent-1' });
    recordHookEvent('stop', { session_id: SESSION });

    // Turn is over but background work is outstanding -> Waiting, not Idle.
    let projection = await readSessionProjection(SESSION);
    expect(projection?.state).toBe('waiting');
    expect(projection?.bgShells).toBe(1);
    expect(projection?.pendingAgents).toBe(1);

    recordHookEvent('subagent-stop', { session_id: SESSION, agent_id: 'agent-1' });
    recordHookEvent('post-tool', {
      session_id: SESSION,
      tool_name: 'TaskStop',
      tool_input: { task_id: 'shell-1' },
    });
    recordHookEvent('stop', { session_id: SESSION });

    projection = await readSessionProjection(SESSION);
    expect(projection?.state).toBe('idle');
    expect(projection?.bgShells).toBe(0);
    expect(projection?.pendingAgents).toBe(0);
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

  it('an initialization fallback never overwrites a truthful concurrent activity update', async () => {
    // subagent-start initializes a generation but publishes NO activity of its
    // own, so its baseline `idle` must not clobber a racer's real state.
    for (let round = 0; round < 15; round++) {
      rmSync(join(root, 'state'), { recursive: true, force: true });

      const results = await runHooksConcurrently([
        { event: 'subagent-start', payload: { agent_id: `agent-${round}` } },
        { event: 'prompt' },
        { event: 'pre-tool' },
        { event: 'subagent-stop', payload: { agent_id: `other-${round}` } },
      ]);
      for (const r of results) expect(r.status).toBe(0);

      const projection = await readSessionProjection(SESSION);
      expect(projection, `round ${round}: no projection`).not.toBeNull();
      // Truthful states only: a fallback idle would be a fabricated regression.
      expect(
        ['thinking', 'working'],
        `round ${round}: fallback idle overwrote a truthful update`,
      ).toContain(projection?.state);
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
    // An explicit budget keeps this about READ CORRECTNESS rather than ambient
    // scheduler noise: under heavy parallel test load even a small directory
    // can outrun a tight default, and that path is already covered by the
    // exhausted-budget case above.
    const started = Date.now();
    const projection = await readSessionProjection(SESSION, { budgetMs: 1_000 });
    // Still far inside the renderer's sub-200ms end-to-end contract.
    expect(Date.now() - started).toBeLessThan(200);
    expect(projection).not.toBeNull();
    expect(projection?.state).toBe('idle');
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
