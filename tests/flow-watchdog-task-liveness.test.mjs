// hive-flow-8b69 (Option B, Slice 4): the task-liveness pass classifies active Hive Flow
// tasks with the shared source of truth and emits at most one deduped recovery/review
// nudge per stable actionable event, routed to the task owner (or the deadlock target if
// unresolved), suppressed under COMPLETE_NO_ACTION / BLOCKED_TRUE_HUMAN_GATE.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const WATCHDOG = join(here, '..', 'scripts', 'flow-watchdog.cjs');
const requireWatchdog = createRequire(pathToFileURL(WATCHDOG));
const {
  createWatchState,
  runTaskLivenessPass,
  taskPidLivenessSnapshot,
  runOnce,
  saveWatchState,
  loadWatchState,
} = requireWatchdog(WATCHDOG);

// A reliably-dead, reaped PID: spawnSync waits for exit and reaps, so process.kill(pid,0)
// yields ESRCH.
const DEAD_PID = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
const ALIVE_PID = process.pid;

const PANES = [{ name: 'claude', pane: '%2' }, { name: 'codex', pane: '%1' }];
const STATUSES = [{ agent: 'codex', pane: '%1', idle: true }, { agent: 'claude', pane: '%2', idle: true }];

let root;
let tasksDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flow-watchdog-task-'));
  tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeTask(taskId, tracking) {
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify(tracking));
}
function writeEvents(taskId, events) {
  writeFileSync(join(tasksDir, `${taskId}.events.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
function appendEvent(taskId, event) {
  appendFileSync(join(tasksDir, `${taskId}.events.jsonl`), JSON.stringify(event) + '\n');
}
function writeResult(taskId) {
  writeFileSync(join(tasksDir, `${taskId}.result.json`), JSON.stringify({ ok: true }));
}
function makeDispatch() {
  const calls = [];
  return {
    calls,
    dispatch: (paneSpec, event, text, targetAgent) => {
      calls.push({ paneSpec, event, text, targetAgent });
      return { ok: true };
    },
  };
}
function pass(state, dispatch, now = Date.now()) {
  runTaskLivenessPass({ state, now, root, tasksDir, paneSpecs: PANES, statuses: STATUSES, idleStallMs: 8 * 60_000, dispatch });
}

describe('taskPidLivenessSnapshot — PID is a weak signal (hive-flow-8b69 Slice 4)', () => {
  it('missing/invalid pid is unknown (null), never dead', () => {
    assert.equal(taskPidLivenessSnapshot(undefined), null);
    assert.equal(taskPidLivenessSnapshot(0), null);
    assert.equal(taskPidLivenessSnapshot(-1), null);
    assert.equal(taskPidLivenessSnapshot(NaN), null);
  });
  it('an alive pid is alive', () => {
    assert.deepEqual(taskPidLivenessSnapshot(ALIVE_PID), { alive: true });
  });
  it('a reaped/dead pid is dead (ESRCH)', () => {
    assert.deepEqual(taskPidLivenessSnapshot(DEAD_PID), { alive: false });
  });
  it('a live-but-unsignalable pid (e.g. init) is alive/unknown, not dead', () => {
    // pid 1 exists; a non-root process gets EPERM → treated as alive, never dead.
    assert.deepEqual(taskPidLivenessSnapshot(1), { alive: true });
  });
});

describe('runTaskLivenessPass — verdict → action (hive-flow-8b69 Slice 4)', () => {
  it('orphaned dispatches ONCE to the owner pane and does not spam duplicate observations', () => {
    writeTask('orph', { status: 'running', pid: DEAD_PID, ownerClientKind: 'claude' });
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();

    pass(state, dispatch);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event.kind, 'task_orphaned_recovery');
    assert.equal(calls[0].targetAgent, 'claude');
    assert.equal(calls[0].paneSpec.pane, '%2');
    assert.match(calls[0].text, /orphaned/i);
    assert.doesNotMatch(calls[0].text, /provider_request|stderr|secret/i);

    pass(state, dispatch); // duplicate stable observation
    assert.equal(calls.length, 1, 'no re-send on a duplicate stable observation');
  });

  it('unresolved owner falls back to the deadlock target with an owner-unresolved reason', () => {
    writeTask('orph2', { status: 'running', pid: DEAD_PID }); // no ownerClientKind/agentId
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();
    pass(state, dispatch);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].targetAgent, 'codex'); // chooseDeadlockTarget prefers codex
    assert.match(calls[0].event.reason, /owner-unresolved/);
    assert.match(calls[0].text, /owner could not be resolved/i);
  });

  it('an in-flight provider request stays quiet', () => {
    writeTask('inflight', { status: 'running', pid: ALIVE_PID, ownerClientKind: 'claude' });
    writeEvents('inflight', [{ event: 'provider_request_start', ts: new Date(0).toISOString() }]);
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();
    pass(state, dispatch);
    assert.equal(calls.length, 0);
  });

  it('a completed/result-present task prunes its prior and stays quiet', () => {
    writeTask('done', { status: 'running', pid: ALIVE_PID, ownerClientKind: 'claude' });
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();
    pass(state, dispatch); // active → observing, records a prior
    assert.equal(state.taskLiveness.has('done'), true);
    assert.equal(calls.length, 0);

    writeResult('done'); // now has a result → excluded from active
    pass(state, dispatch);
    assert.equal(state.taskLiveness.has('done'), false, 'prior pruned once the task has a result');
    assert.equal(calls.length, 0);
  });

  it('a vanished task prunes its prior', () => {
    writeTask('gone', { status: 'running', pid: ALIVE_PID, ownerClientKind: 'claude' });
    const state = createWatchState();
    const { dispatch } = makeDispatch();
    pass(state, dispatch);
    assert.equal(state.taskLiveness.has('gone'), true);
    rmSync(join(tasksDir, 'gone.json'));
    pass(state, dispatch);
    assert.equal(state.taskLiveness.has('gone'), false);
  });

  it('stalled_review dispatches once after the threshold, is idempotent, and RE-ARMS after progress', () => {
    const base = 1_700_000_000_000;
    writeTask('stall', { status: 'running', pid: ALIVE_PID, ownerClientKind: 'codex' });
    writeEvents('stall', [{ event: 'iteration', ts: new Date(base).toISOString() }]);
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();
    const runAt = (mins) => pass(state, dispatch, base + mins * 60_000);

    runAt(10); // observing (first, prior null)
    runAt(20); // count 1
    runAt(30); // count 2
    assert.equal(calls.length, 0, 'no dispatch before stable+threshold');
    runAt(40); // count 3, silent ~40min ≥ 8min → stalled_review
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event.kind, 'task_stalled_review');
    assert.equal(calls[0].targetAgent, 'codex');
    runAt(50); // duplicate stable observation → idempotent
    assert.equal(calls.length, 1);

    appendEvent('stall', { event: 'iteration', ts: new Date(base + 50 * 60_000).toISOString() }); // progress
    runAt(60); // progressing → resets, quiet
    assert.equal(calls.length, 1);
    runAt(70); // count 1
    runAt(80); // count 2
    runAt(90); // count 3, silent ~40min → stalled_review again (re-armed)
    assert.equal(calls.length, 2, 'a genuine later stall after progress re-arms');
  });

  it('bounds the taskLiveness store from a broken/oversized tasks directory', () => {
    for (let i = 0; i < 250; i += 1) {
      writeTask(`t${i}`, { status: 'running', pid: ALIVE_PID });
    }
    const state = createWatchState();
    const { dispatch } = makeDispatch();
    pass(state, dispatch);
    assert.ok(state.taskLiveness.size <= 200, `store bounded, got ${state.taskLiveness.size}`);
  });
});

describe('runOnce — task-liveness suppression (hive-flow-8b69 Slice 4)', () => {
  function idleTmux(sendCalls) {
    return {
      capturePane: () => 'user@host % \n',
      cursor: () => ({ cursorX: 0, cursorY: 0, paneWidth: 80, paneHeight: 24 }),
      paneMode: () => null,
      sendLine: (agent, text) => { sendCalls.push({ agent, text }); },
      clearPaneMode: () => {},
      sendEscape: () => {},
    };
  }
  function routerNote(status) {
    const routerDir = join(root, '.hive-flow', 'data', 'tmux-router');
    mkdirSync(routerDir, { recursive: true });
    writeFileSync(join(routerDir, 'note.md'), `Status: ${status}\n\nbody\n`);
    return routerDir;
  }
  function taskEvents(result) {
    return result.filter((r) => String(r?.event?.kind || '').startsWith('task_'));
  }

  it('dispatches the orphaned recovery when NOT suppressed (control)', () => {
    writeTask('orphc', { status: 'running', pid: DEAD_PID, ownerClientKind: 'claude' });
    const routerDir = join(root, '.hive-flow', 'data', 'tmux-router');
    mkdirSync(routerDir, { recursive: true }); // empty — no terminal/blocker note
    const sendCalls = [];
    const result = runOnce({ panes: PANES, tmux: idleTmux(sendCalls), state: createWatchState(), now: Date.now(), routerDir, tasksDir });
    assert.equal(taskEvents(result).length, 1, 'task recovery fires when not suppressed');
  });

  it('COMPLETE_NO_ACTION suppresses the task-liveness pass', () => {
    writeTask('orphn', { status: 'running', pid: DEAD_PID, ownerClientKind: 'claude' });
    const routerDir = routerNote('COMPLETE_NO_ACTION');
    const sendCalls = [];
    const result = runOnce({ panes: PANES, tmux: idleTmux(sendCalls), state: createWatchState(), now: Date.now(), routerDir, tasksDir });
    assert.equal(taskEvents(result).length, 0, 'no task dispatch under COMPLETE_NO_ACTION');
  });

  it('BLOCKED_TRUE_HUMAN_GATE suppresses the task-liveness pass locally', () => {
    writeTask('orphb', { status: 'running', pid: DEAD_PID, ownerClientKind: 'claude' });
    const routerDir = routerNote('BLOCKED_TRUE_HUMAN_GATE');
    const sendCalls = [];
    const result = runOnce({ panes: PANES, tmux: idleTmux(sendCalls), state: createWatchState(), now: Date.now(), routerDir, tasksDir });
    assert.equal(taskEvents(result).length, 0, 'no task dispatch under BLOCKED_TRUE_HUMAN_GATE');
  });
});

describe('runTaskLivenessPass — target-pane safety gate (hive-flow-8b69 Slice 4 bounce B1)', () => {
  function passWith(state, dispatch, statuses, now = Date.now()) {
    runTaskLivenessPass({ state, now, root, tasksDir, paneSpecs: PANES, statuses, idleStallMs: 8 * 60_000, dispatch });
  }

  it('does not dispatch to an ACTIVE owner pane, keeps no emitted marker, and delivers once on a later idle pass', () => {
    writeTask('ob1', { status: 'running', pid: DEAD_PID, ownerClientKind: 'claude' });
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();

    passWith(state, dispatch, [{ agent: 'codex', pane: '%1', idle: true }, { agent: 'claude', pane: '%2', active: true }]);
    assert.equal(calls.length, 0, 'no dispatch while the owner pane is active');
    assert.equal(state.taskLiveness.get('ob1').emitted.orphaned, undefined, 'no emitted marker while unable to deliver');

    passWith(state, dispatch, STATUSES); // owner idle now
    assert.equal(calls.length, 1, 'delivers once when the owner pane goes idle');
    assert.equal(calls[0].targetAgent, 'claude');

    passWith(state, dispatch, STATUSES);
    assert.equal(calls.length, 1, 'still once after delivery (idempotent)');
  });

  it('does not dispatch to an owner pane with pending input', () => {
    writeTask('ob2', { status: 'running', pid: DEAD_PID, ownerClientKind: 'claude' });
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();
    passWith(state, dispatch, [{ agent: 'codex', pane: '%1', idle: true }, { agent: 'claude', pane: '%2', pendingInput: true }]);
    assert.equal(calls.length, 0);
  });

  it('unresolved-owner fallback avoids an active pane and picks a safe idle one', () => {
    writeTask('ob3', { status: 'running', pid: DEAD_PID }); // no owner
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();
    passWith(state, dispatch, [{ agent: 'codex', pane: '%1', active: true }, { agent: 'claude', pane: '%2', idle: true }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].targetAgent, 'claude', 'fallback skips the active codex pane for the idle claude pane');
  });

  it('unresolved-owner with no safe target stays quiet and keeps observing', () => {
    writeTask('ob4', { status: 'running', pid: DEAD_PID }); // no owner
    const state = createWatchState();
    const { calls, dispatch } = makeDispatch();
    passWith(state, dispatch, [{ agent: 'codex', pane: '%1', active: true }, { agent: 'claude', pane: '%2', pendingInput: true }]);
    assert.equal(calls.length, 0, 'no dispatch when every pane is busy');
    assert.equal(state.taskLiveness.get('ob4').emitted.orphaned, undefined);
  });
});

describe('taskLiveness persistence — prune/cap survive saveWatchState(mergeExisting) (hive-flow-8b69 Slice 4 bounce B2)', () => {
  it('a pruned task does NOT resurrect from the old file under mergeExisting:true', () => {
    const stateFile = join(root, 'wd-state.json');
    const { dispatch } = makeDispatch();

    // 1. task active → observed → persisted.
    writeTask('gone', { status: 'running', pid: ALIVE_PID, ownerClientKind: 'claude' });
    const s1 = createWatchState();
    pass(s1, dispatch);
    saveWatchState(s1, stateFile);
    assert.equal(loadWatchState(stateFile).taskLiveness.has('gone'), true);

    // 2. task vanishes; a fresh instance loads the old file, prunes, saves with mergeExisting.
    rmSync(join(tasksDir, 'gone.json'));
    const s2 = loadWatchState(stateFile);
    assert.equal(s2.taskLiveness.has('gone'), true, 'loaded prior still present before the pass');
    pass(s2, dispatch); // prunes 'gone' (no longer active)
    saveWatchState(s2, stateFile, { mergeExisting: true });

    assert.equal(loadWatchState(stateFile).taskLiveness.has('gone'), false, 'pruned key must not come back from the old file');
  });

  it('keeps the cap effective through saveWatchState(mergeExisting:true)', () => {
    const stateFile = join(root, 'wd-state.json');
    const seed = { taskLiveness: Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`t${i}`, { observedAtMs: i }])) };
    saveWatchState(createWatchState(seed), stateFile); // old file (trimmed on save)
    saveWatchState(createWatchState(seed), stateFile, { mergeExisting: true });
    assert.ok(loadWatchState(stateFile).taskLiveness.size <= 200, 'store bounded through mergeExisting');
  });
});
