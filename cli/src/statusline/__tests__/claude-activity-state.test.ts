// hive-flow-f16a — activity tracker regressions (acceptance rows A2, A12, A14-A17, A25).
//
// The concurrency regression (A15) spawns REAL separate processes against the
// compiled tracker, because create-once behaviour cannot be proven in-process.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

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
    const activityPath = join(stateFor(), 'activity.json');
    const activity = readJson(activityPath)!;
    writeFileSync(activityPath, JSON.stringify({ ...activity, generation: 'someothergeneration' }));
    expect(await readSessionProjection(SESSION)).toBeNull();
  });

  it('returns null for malformed generation or activity records', async () => {
    recordHookEvent('session-start', { session_id: SESSION, source: 'startup' });
    writeFileSync(join(stateFor(), 'activity.json'), '{ this is not json');
    expect(await readSessionProjection(SESSION)).toBeNull();
    writeFileSync(join(stateFor(), 'generation.json'), '{ torn');
    expect(await readSessionProjection(SESSION)).toBeNull();
  });
});

describe('claim crash recovery (A25)', () => {
  it('boundary 1 — crash after staging, before publication: a later event initializes', async () => {
    // A crashed writer leaves an orphan staging file but NO canonical claim.
    const dir = stateFor();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.generation.claim.99999.deadbeefdeadbeef.stage'),
      JSON.stringify({ schema: 1, owner: 'a'.repeat(32), pid: 99999, ts: Date.now() }),
    );

    recordHookEvent('prompt', { session_id: SESSION });

    // No claim existed, so initialization proceeds normally.
    expect((await readSessionProjection(SESSION))?.state).toBe('thinking');
    expect(readJson(join(dir, 'generation.json'))?.source).toBe('late-attach');
  });

  it('boundary 2 — crash after claim, before publication: a later event reclaims', async () => {
    const dir = stateFor();
    mkdirSync(dir, { recursive: true });
    // A COMPLETE claim owned by a process that is definitively gone.
    writeFileSync(
      join(dir, 'generation.claim'),
      JSON.stringify({ schema: 1, owner: 'b'.repeat(32), pid: deadPid(), ts: Date.now() }),
    );
    expect(existsSync(join(dir, 'generation.json'))).toBe(false);

    recordHookEvent('prompt', { session_id: SESSION });

    const projection = await readSessionProjection(SESSION);
    expect(projection).not.toBeNull();
    expect(projection?.state).toBe('thinking');
    // Exactly one valid generation was published.
    expect(readJson(join(dir, 'generation.json'))?.source).toBe('late-attach');
  });

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

  it('fails closed on a malformed claim rather than guessing', async () => {
    const dir = stateFor();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'generation.claim'), '{ not valid json');
    recordHookEvent('prompt', { session_id: SESSION });
    expect(await readSessionProjection(SESSION)).toBeNull();
  });
});

describe('concurrent first events (A15)', () => {
  const distModule = resolve(__dirname, '..', '..', '..', 'dist', 'src', 'statusline', 'claude-activity-state.js');
  const runner = join(__dirname, 'fixtures', 'activity-hook-runner.mjs');

  it('create-once: N concurrent first events converge on ONE generation and one valid projection', async () => {
    // Requires the compiled tracker; the gate builds before running tests.
    expect(
      existsSync(distModule),
      `compiled tracker missing at ${distModule} — run "npm run build" first`,
    ).toBe(true);

    const events = ['prompt', 'pre-tool', 'permission-request', 'prompt', 'pre-tool', 'prompt', 'prompt', 'pre-tool'];
    const children = events.map((event) =>
      spawnSync(
        process.execPath,
        [runner, event, JSON.stringify({ session_id: SESSION, tool_name: 'Bash' })],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_ENV: 'test',
            CLAUDE_STATUSLINE_TEST_ROOT: root,
            HF_TRACKER_MODULE: pathToFileURL(distModule).href,
          },
        },
      ),
    );
    for (const child of children) expect(child.status).toBe(0);

    const projection = await readSessionProjection(SESSION);
    expect(projection).not.toBeNull();

    // Exactly ONE generation exists, and every published record agrees with it.
    const generation = readJson(join(stateFor(), 'generation.json'))?.generation;
    expect(typeof generation).toBe('string');
    expect(projection?.generation).toBe(generation);
    expect(readJson(join(stateFor(), 'activity.json'))?.generation).toBe(generation);
    // No losing writer left a competing generation behind.
    const stray = readdirSync(stateFor()).filter((n) => n.startsWith('generation.') && n !== 'generation.json');
    expect(stray).toHaveLength(0);
  }, 30_000);
});
