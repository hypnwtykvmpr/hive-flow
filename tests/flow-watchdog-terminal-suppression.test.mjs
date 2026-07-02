// hive-flow-8b69 (Option B, Slice 5, P2-SL4): a newest BLOCKED_TRUE_HUMAN_GATE router note
// GLOBALLY suppresses the watchdog's nag/dispatch paths (not just the all-idle deadlock
// guard), symmetric to COMPLETE_NO_ACTION, while newest-note semantics still let a NEWER
// non-terminal handoff override an older blocker.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const WATCHDOG = join(here, '..', 'scripts', 'flow-watchdog.cjs');
const requireWatchdog = createRequire(pathToFileURL(WATCHDOG));
const { createWatchState, runOnce, activeRouterHumanBlocker } = requireWatchdog(WATCHDOG);

const PANES = [{ name: 'claude', pane: '%2' }, { name: 'codex', pane: '%1' }];

let root;
let routerDir;
let tasksDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flow-watchdog-term-'));
  routerDir = join(root, '.hive-flow', 'data', 'tmux-router');
  tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(routerDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Write a router note with an explicit mtime (seconds) so newest-note ordering is deterministic.
function writeNote(name, body, mtimeSec) {
  const fp = join(routerDir, name);
  writeFileSync(fp, body);
  utimesSync(fp, mtimeSec, mtimeSec);
  return fp;
}
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
function run(sendCalls) {
  return runOnce({ panes: PANES, tmux: idleTmux(sendCalls), state: createWatchState(), now: Date.now(), routerDir, tasksDir });
}

describe('activeRouterHumanBlocker — newest-note semantics (hive-flow-8b69 Slice 5)', () => {
  it('returns the note when the newest router note is a human-gate blocker', () => {
    writeNote('note-to-claude.md', '# handoff\nread this\n', 1000);
    writeNote('zzz-blocker.md', 'Status: BLOCKED_TRUE_HUMAN_GATE\n\nawait human\n', 2000);
    const blocker = activeRouterHumanBlocker(routerDir);
    assert.ok(blocker, 'blocker note is the newest → detected');
    assert.match(blocker.filePath, /zzz-blocker\.md$/);
  });
  it('returns null when a newer non-terminal note supersedes the blocker', () => {
    writeNote('zzz-blocker.md', 'Status: BLOCKED_TRUE_HUMAN_GATE\n\nawait human\n', 1000);
    writeNote('note-to-claude.md', '# handoff\nread this\n', 2000);
    assert.equal(activeRouterHumanBlocker(routerDir), null, 'newer handoff wins the newest-note check');
  });
  it('returns null for a COMPLETE_NO_ACTION terminal note (not a blocker)', () => {
    writeNote('done.md', 'Status: COMPLETE_NO_ACTION\n\nquiet\n', 1000);
    assert.equal(activeRouterHumanBlocker(routerDir), null);
  });
});

describe('runOnce — global BLOCKED_TRUE_HUMAN_GATE suppression (hive-flow-8b69 Slice 5)', () => {
  it('suppresses an OLDER router handoff under a newest blocker (the nag path that leaked before)', () => {
    writeNote('aaa-to-claude.md', '# handoff\nplease read and act\n', 1000);
    writeNote('zzz-blocker.md', 'Status: BLOCKED_TRUE_HUMAN_GATE\n\nawait human\n', 2000);
    const sendCalls = [];
    run(sendCalls);
    assert.equal(sendCalls.length, 0, 'no pane nudge/handoff delivery under a newest human-gate blocker');
  });

  it('still delivers a NEWER handoff that supersedes an older blocker (newest-note override)', () => {
    writeNote('zzz-blocker.md', 'Status: BLOCKED_TRUE_HUMAN_GATE\n\nawait human\n', 1000);
    writeNote('aaa-to-claude.md', '# handoff\nplease read and act\n', 2000);
    const sendCalls = [];
    run(sendCalls);
    assert.ok(sendCalls.some((c) => c.agent === 'claude'), 'a newer handoff overrides the older blocker');
  });

  it('COMPLETE_NO_ACTION stays quiet and suppresses an older handoff (regression symmetry)', () => {
    writeNote('aaa-to-claude.md', '# handoff\nplease read and act\n', 1000);
    writeNote('zzz-done.md', 'Status: COMPLETE_NO_ACTION\n\nqueue complete\n', 2000);
    const sendCalls = [];
    run(sendCalls);
    assert.equal(sendCalls.length, 0, 'COMPLETE_NO_ACTION remains a global quiet marker');
  });
});
