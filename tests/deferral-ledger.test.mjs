/**
 * Deferral Ledger Tests — scripts/deferral-ledger.cjs
 *
 * All record/digest paths run against a stub `kno` binary prepended to PATH in
 * spawned children, so the real Knots ledger is never written. Children are
 * spawned via process.execPath so PATH overrides only affect the script's own
 * `kno` resolution.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'deferral-ledger.cjs');
const require = createRequire(import.meta.url);
const { checkNoteText } = require(SCRIPT);

let workDir;
let stubBin;
let stubStateDir;
let emptyBin;

const STUB_KNO = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const stubDir = process.env.KNO_STUB_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(stubDir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
let rest = args;
if (rest[0] === '-C') rest = rest.slice(2);
const cmd = rest[0];
if (cmd === 'new') {
  if (process.env.KNO_STUB_FAIL_NEW === '1') { process.stderr.write('stub new failure'); process.exit(3); }
  process.stdout.write(JSON.stringify({ id: 'hive-flow-test1' }));
  process.exit(0);
}
if (cmd === 'update') {
  if (process.env.KNO_STUB_FAIL_UPDATE === '1') { process.stderr.write('stub update failure'); process.exit(4); }
  process.exit(0);
}
if (cmd === 'ls') {
  const wantsDeferred = rest.includes('--state') && rest[rest.indexOf('--state') + 1] === 'deferred';
  const file = wantsDeferred ? 'deferred.json' : 'open.json';
  const p = path.join(stubDir, file);
  process.stdout.write(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '[]');
  process.exit(0);
}
process.exit(0);
`;

function runLedger(args, { env = {}, stdin } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      PATH: `${stubBin}:${process.env.PATH}`,
      KNO_STUB_DIR: stubStateDir,
      KNO_STUB_FAIL_NEW: '',
      KNO_STUB_FAIL_UPDATE: '',
      ...env,
    },
  });
}

function stubCalls() {
  const callsFile = join(stubStateDir, 'calls.jsonl');
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function resetStubState() {
  rmSync(stubStateDir, { recursive: true, force: true });
  mkdirSync(stubStateDir, { recursive: true });
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'deferral-ledger-test-'));
  stubBin = join(workDir, 'stub-bin');
  stubStateDir = join(workDir, 'stub-state');
  emptyBin = join(workDir, 'empty-bin');
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(stubStateDir, { recursive: true });
  mkdirSync(emptyBin, { recursive: true });
  const stubPath = join(stubBin, 'kno');
  writeFileSync(stubPath, STUB_KNO);
  chmodSync(stubPath, 0o755);
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const VALID_RECORD_ARGS = [
  'record',
  '--title', 'Test deferral',
  '--owner', 'claude',
  '--reason', 'blocked on upstream',
  '--unblock', 'upstream release ships',
  '--priority', '2',
  '--source', 'tmux-router note 20260702T050216Z',
];

describe('record — field validation', () => {
  it('refuses when a required field is missing and names it', () => {
    const args = VALID_RECORD_ARGS.filter((a, i) => !(a === '--owner' || VALID_RECORD_ARGS[i - 1] === '--owner'));
    const res = runLedger(args);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /record refused/);
    assert.match(res.stderr, /--owner/);
  });

  it('refuses when several fields are missing and lists them all', () => {
    const res = runLedger(['record', '--title', 'x']);
    assert.equal(res.status, 1);
    for (const field of ['--owner', '--reason', '--unblock', '--priority', '--source']) {
      assert.match(res.stderr, new RegExp(field));
    }
  });

  it('refuses an out-of-range priority', () => {
    const args = VALID_RECORD_ARGS.map((a, i) => (VALID_RECORD_ARGS[i - 1] === '--priority' ? '7' : a));
    const res = runLedger(args);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /priority must be an integer 0-4/);
  });

  it('refuses a non-integer priority', () => {
    const args = VALID_RECORD_ARGS.map((a, i) => (VALID_RECORD_ARGS[i - 1] === '--priority' ? 'high' : a));
    const res = runLedger(args);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /priority must be an integer 0-4/);
  });
});

describe('record — stub kno interaction', () => {
  it('creates the knot, sets deferred state, and attaches the six-field note', () => {
    resetStubState();
    const res = runLedger(VALID_RECORD_ARGS);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /recorded hive-flow-test1 \(deferred, P2\): Test deferral/);
    const calls = stubCalls();
    assert.equal(calls.length, 2);
    const [newCall, updateCall] = calls;
    assert.equal(newCall[0], '-C');
    assert.ok(newCall.includes('new'));
    assert.ok(newCall.includes('Test deferral'));
    assert.ok(newCall.includes('--fast'));
    assert.ok(newCall.includes('deferral'));
    assert.ok(newCall.includes('--json'));
    assert.ok(updateCall.includes('update'));
    assert.ok(updateCall.includes('hive-flow-test1'));
    assert.ok(updateCall.includes('--status'));
    assert.ok(updateCall.includes('deferred'));
    const note = updateCall[updateCall.indexOf('--add-note') + 1];
    assert.match(note, /DEFERRAL RECORD/);
    assert.match(note, /Owner: claude/);
    assert.match(note, /Reason: blocked on upstream/);
    assert.match(note, /Unblock: upstream release ships/);
    assert.match(note, /Priority: 2/);
    assert.match(note, /Source: tmux-router note 20260702T050216Z/);
    assert.match(note, /Review: next session-start digest/);
  });

  it('fails loudly when kno new fails', () => {
    resetStubState();
    const res = runLedger(VALID_RECORD_ARGS, { env: { KNO_STUB_FAIL_NEW: '1' } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /kno new exited 3/);
  });

  it('reports an incomplete record when the deferred-state update fails', () => {
    resetStubState();
    const res = runLedger(VALID_RECORD_ARGS, { env: { KNO_STUB_FAIL_UPDATE: '1' } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /record INCOMPLETE/);
    assert.match(res.stderr, /hive-flow-test1/);
  });

  it('fails loudly (exit 1) when the kno binary is missing — record must not fail open', () => {
    const res = runLedger(VALID_RECORD_ARGS, { env: { PATH: emptyBin } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /cannot be recorded without the ledger/);
  });
});

describe('digest', () => {
  it('lists deferred knots and deferral-tagged open knots with record fields', () => {
    resetStubState();
    writeFileSync(join(stubStateDir, 'deferred.json'), JSON.stringify([
      {
        id: 'hive-flow-aaaa', title: 'Deferred thing', state: 'deferred', priority: 2, tags: ['deferral'],
        notes: [{ content: 'DEFERRAL RECORD\nOwner: codex\nReason: r\nUnblock: upstream fix\nPriority: 2\nSource: s\nReview: weekly' }],
      },
    ]));
    writeFileSync(join(stubStateDir, 'open.json'), JSON.stringify([
      { id: 'hive-flow-bbbb', title: 'Tagged open', state: 'ready_for_implementation', priority: 1, tags: ['deferral'], notes: [] },
      { id: 'hive-flow-cccc', title: 'Untagged open', state: 'planning', priority: 0, tags: [], notes: [] },
    ]));
    const res = runLedger(['digest']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /2 open deferral\(s\)/);
    assert.match(res.stdout, /hive-flow-aaaa P2 \[deferred\] Deferred thing \| owner=codex \| unblock=upstream fix \| review=weekly/);
    assert.match(res.stdout, /hive-flow-bbbb P1 \[ready_for_implementation\] Tagged open \| owner=\? \| unblock=\? \| review=\?/);
    assert.doesNotMatch(res.stdout, /hive-flow-cccc/);
  });

  it('deduplicates knots that appear in both queries', () => {
    resetStubState();
    const knot = { id: 'hive-flow-aaaa', title: 'Both', state: 'deferred', priority: 3, tags: ['deferral'], notes: [] };
    writeFileSync(join(stubStateDir, 'deferred.json'), JSON.stringify([knot]));
    writeFileSync(join(stubStateDir, 'open.json'), JSON.stringify([knot]));
    const res = runLedger(['digest']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /1 open deferral\(s\)/);
  });

  it('prints nothing and exits 0 when the ledger is empty', () => {
    resetStubState();
    const res = runLedger(['digest']);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  it('emits JSON with --json', () => {
    resetStubState();
    writeFileSync(join(stubStateDir, 'deferred.json'), JSON.stringify([
      {
        id: 'hive-flow-aaaa', title: 'Deferred thing', state: 'deferred', priority: 2, tags: ['deferral'],
        notes: [{ content: 'DEFERRAL RECORD\nOwner: codex\nReason: r\nUnblock: u\nPriority: 2\nSource: s\nReview: weekly' }],
      },
    ]));
    const res = runLedger(['digest', '--json']);
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, 'hive-flow-aaaa');
    assert.equal(parsed[0].owner, 'codex');
    assert.equal(parsed[0].review, 'weekly');
  });

  it('fails open (exit 0, warning) when the kno binary is missing', () => {
    const res = runLedger(['digest'], { env: { PATH: emptyBin } });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /digest skipped: kno binary not found/);
  });
});

describe('check-note', () => {
  it('warns on deferral prose lacking a knot reference', () => {
    const note = join(workDir, 'offending.md');
    writeFileSync(note, 'Status: COMPLETE_NO_ACTION\n\nThe leftover dirs are a residual item we will handle later.\n');
    const res = runLedger(['check-note', note]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /WARNING: offending\.md contains deferral language/);
    assert.match(res.stdout, /line 3:/);
  });

  it('stays silent when the deferral line cites a knot id', () => {
    const note = join(workDir, 'cited.md');
    writeFileSync(note, 'Deferred: leftover-dir hygiene is recorded as hive-flow-abcd.\n');
    const res = runLedger(['check-note', note]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  it('stays silent on clean notes', () => {
    const note = join(workDir, 'clean.md');
    writeFileSync(note, 'Status: COMPLETE_NO_ACTION\n\nAll work landed at the confirmed SHA.\n');
    const res = runLedger(['check-note', note]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  it('fails open on a missing file', () => {
    const res = runLedger(['check-note', join(workDir, 'nope.md')]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  it('truncates the offender list past 10 lines', () => {
    const note = join(workDir, 'many.md');
    writeFileSync(note, Array.from({ length: 12 }, (_, i) => `residual item number ${i + 1}`).join('\n'));
    const res = runLedger(['check-note', note]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /12 line\(s\)/);
    assert.match(res.stdout, /and 2 more line\(s\)/);
  });
});

describe('checkNoteText unit behavior', () => {
  it('respects word boundaries (no match inside larger words)', () => {
    assert.equal(checkNoteText('the undeferred work continues').length, 0);
    assert.equal(checkNoteText('deferred until upstream ships').length, 1);
  });

  it('matches the documented trigger vocabulary', () => {
    for (const phrase of ['defer', 'deferral', 'residual', 'standing-deferred', 'leftover', 'backlog', 'when convenient', 'future slice', 'no rush']) {
      assert.equal(checkNoteText(`this is ${phrase} work`).length, 1, phrase);
    }
  });
});

describe('hook-check-note (PostToolUse adapter)', () => {
  function fakeRepo() {
    const root = mkdtempSync(join(tmpdir(), 'deferral-hook-root-'));
    const routerDir = join(root, '.hive-flow', 'data', 'tmux-router');
    mkdirSync(routerDir, { recursive: true });
    return { root, routerDir };
  }

  it('warns for router-note writes containing unrecorded deferral prose', () => {
    const { root, routerDir } = fakeRepo();
    const note = join(routerDir, 'note.md');
    writeFileSync(note, 'This slice defers the cleanup to a future slice.\n');
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: note } });
    const res = runLedger(['hook-check-note'], { stdin: payload, env: { CLAUDE_PROJECT_DIR: root } });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /WARNING/);
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores writes outside the tmux-router directory', () => {
    const { root } = fakeRepo();
    const elsewhere = join(root, 'somefile.md');
    writeFileSync(elsewhere, 'This defers everything with no record.\n');
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: elsewhere } });
    const res = runLedger(['hook-check-note'], { stdin: payload, env: { CLAUDE_PROJECT_DIR: root } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores non-markdown router writes', () => {
    const { root, routerDir } = fakeRepo();
    const jsonFile = join(routerDir, 'watcher.json');
    writeFileSync(jsonFile, '{"note":"residual"}');
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: jsonFile } });
    const res = runLedger(['hook-check-note'], { stdin: payload, env: { CLAUDE_PROJECT_DIR: root } });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    rmSync(root, { recursive: true, force: true });
  });

  it('fails open on malformed stdin payloads', () => {
    const res = runLedger(['hook-check-note'], { stdin: 'not json' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  it('fails open on payloads without a file path', () => {
    const res = runLedger(['hook-check-note'], { stdin: JSON.stringify({ tool_name: 'Write', tool_input: {} }) });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });
});

describe('usage', () => {
  it('prints usage and exits 1 for unknown subcommands', () => {
    const res = runLedger(['bogus']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /usage: deferral-ledger\.cjs/);
  });
});
