/**
 * HF-1 (tracked-source write authority) + HF-5 (control-plane store writable) regression.
 *
 * A provider agent must NOT be able to overwrite git-tracked source files or
 * control-plane state via the bridge write_file/edit_file tools, UNLESS its
 * persisted AgentRecord holds a top-level `writeAuthority: 'source'` grant.
 * Control-plane paths are ALWAYS denied, even with the grant.
 *
 * Harness mirrors provider-bridge-gated-write.e2e.test.mjs: the exported
 * `executeBridgeFilesystemTool` runs in a child with cwd=tmp-root, so the
 * bridge's PROJECT_ROOT and persisted store both resolve under the fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

function makeProjectRoot(prefix = 'hfwa-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return realpathSync.native(root);
}

function writeKey(root, key = randomBytes(32).toString('hex')) {
  const keyPath = join(root, '.hive-flow', 'enforcement', '.hmac-key');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
  return key;
}

function writeEnvelope(root, key, level = 0) {
  const state = {
    level,
    ts: '2026-06-06T00:00:00.000Z',
    violations: 0,
    restrictedGroups: [],
    history: [],
    integrityCompromised: false,
  };
  const envelope = { state, hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex') };
  const statePath = join(root, '.hive-flow', 'enforcement', 'state.json');
  writeFileSync(statePath, JSON.stringify(envelope, null, 2), 'utf8');
}

/** Persist an AgentRecord; `extra` is spread top-level (e.g. { writeAuthority: 'source' }). */
function makeStore(root, agentId, extra = {}) {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents: {
      [agentId]: {
        agentId,
        agentType: 'coder',
        status: 'busy',
        provider: 'deepseek',
        model: 'sonnet',
        resolvedModel: 'deepseek-v4-flash',
        taskCount: 0,
        config: {},
        ...extra,
      },
    },
  }, null, 2), 'utf8');
  return storeDir;
}

function gitInit(root) {
  const opts = { cwd: root, stdio: 'ignore' };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'a@b.c'], opts);
  execFileSync('git', ['config', 'user.name', 'test'], opts);
}

function gitAddCommit(root) {
  const opts = { cwd: root, stdio: 'ignore' };
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], opts);
}

function runTool(root, toolName, toolArgs, { agentId = 'hfwa-agent', extraEnv = {} } = {}) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    const result = await bridge.executeBridgeFilesystemTool(${JSON.stringify(toolName)}, ${JSON.stringify(toolArgs)});
    process.stdout.write(JSON.stringify(result));
  `;
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    HIVE_FLOW_HOME: join(root, '.hive-flow'),
    HIVE_FLOW_PROJECT_ROOT: root,
    CLAUDE_PROJECT_DIR: root,
    HIVE_FLOW_AGENT_ID: agentId,
    CLAUDE_AGENT_ID: agentId,
    HIVE_FLOW_HIVE_ID: '',
    CLAUDE_SESSION_ID: '',
    HIVE_FLOW_SESSION_ID: '',
    ...extraEnv,
  };
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

const read = (p) => readFileSync(p, 'utf8');

describe('HF-1/HF-5 provider bridge write authority', () => {
  let root;

  beforeAll(() => {
    root = makeProjectRoot();
    const key = writeKey(root);
    writeEnvelope(root, key, 0);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // ── HF-1: default-deny tracked-source writes ──────────────────────────────
  describe('HF-1 default-deny tracked source', () => {
    it('blocks write_file/edit_file to an existing git-tracked file for an ungranted agent; content unchanged', () => {
      const r = makeProjectRoot('hfwa-h1-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'a'); // no writeAuthority
        const tracked = join(r, 'src', 'tracked.ts');
        writeFileSync(tracked, 'export const original = 1;\n', 'utf8');
        gitInit(r); gitAddCommit(r);

        const wf = runTool(r, 'write_file', { path: tracked, content: 'export const hacked = 1;\n' }, { agentId: 'a' });
        expect(wf).toMatchObject({ status: 'error' });
        expect(wf.error).toMatch(/tracked|write authority/i);
        expect(read(tracked)).toBe('export const original = 1;\n');

        const ef = runTool(r, 'edit_file', { path: tracked, old_string: 'original', new_string: 'hacked' }, { agentId: 'a' });
        expect(ef).toMatchObject({ status: 'error' });
        expect(ef.error).toMatch(/tracked|write authority/i);
        expect(read(tracked)).toBe('export const original = 1;\n');
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });

    it('legacy record (no writeAuthority field) denies tracked writes', () => {
      const r = makeProjectRoot('hfwa-legacy-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        // legacy record: makeStore default has no writeAuthority key at all
        makeStore(r, 'legacy');
        const tracked = join(r, 'src', 'legacy.ts');
        writeFileSync(tracked, 'legacy\n', 'utf8');
        gitInit(r); gitAddCommit(r);
        const wf = runTool(r, 'write_file', { path: tracked, content: 'mutated\n' }, { agentId: 'legacy' });
        expect(wf).toMatchObject({ status: 'error' });
        expect(read(tracked)).toBe('legacy\n');
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });

    it.each([
      ['boolean true', { writeAuthority: true }],
      ["string 'all'", { writeAuthority: 'all' }],
      ['nested config grant', { config: { writeAuthority: 'source' } }],
    ])('malformed/forged grant (%s) denies tracked writes', (_label, extra) => {
      const r = makeProjectRoot('hfwa-bad-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'a', extra);
        const tracked = join(r, 'src', 'bad.ts');
        writeFileSync(tracked, 'safe\n', 'utf8');
        gitInit(r); gitAddCommit(r);
        const wf = runTool(r, 'write_file', { path: tracked, content: 'mutated\n' }, { agentId: 'a' });
        expect(wf).toMatchObject({ status: 'error' });
        expect(read(tracked)).toBe('safe\n');
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });
  });

  // ── Explicit grant ────────────────────────────────────────────────────────
  describe('explicit top-level writeAuthority:source grant', () => {
    it('allows write_file and edit_file to git-tracked files; result still grounds (string success)', () => {
      const r = makeProjectRoot('hfwa-grant-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'granted', { writeAuthority: 'source' });
        const tracked = join(r, 'src', 'granted.ts');
        writeFileSync(tracked, 'export const v = 1;\n', 'utf8');
        gitInit(r); gitAddCommit(r);

        const wf = runTool(r, 'write_file', { path: tracked, content: 'export const v = 2;\n' }, { agentId: 'granted' });
        expect(typeof wf).toBe('string');
        expect(wf).toMatch(/File written/);
        expect(read(tracked)).toBe('export const v = 2;\n');

        const ef = runTool(r, 'edit_file', { path: tracked, old_string: 'v = 2', new_string: 'v = 3' }, { agentId: 'granted' });
        expect(typeof ef).toBe('string');
        expect(ef).toMatch(/File edited/);
        expect(read(tracked)).toBe('export const v = 3;\n');
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });

    it('granted agent STILL cannot write control-plane paths', () => {
      const r = makeProjectRoot('hfwa-grant-cp-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'granted', { writeAuthority: 'source' });
        gitInit(r);
        const storeJson = join(r, '.hive-flow', 'agents', 'store.json');
        const before = read(storeJson);
        const wf = runTool(r, 'write_file', { path: storeJson, content: '{"agents":{}}' }, { agentId: 'granted' });
        expect(wf).toMatchObject({ status: 'error' });
        expect(wf.error).toMatch(/protected path/);
        expect(read(storeJson)).toBe(before);
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });
  });

  // ── HF-5: control-plane store always denied ───────────────────────────────
  describe('HF-5 control-plane deny (no grant)', () => {
    const cpTargets = (r) => ({
      'agents/store.json': join(r, '.hive-flow', 'agents', 'store.json'),
      'hives/h.json': join(r, '.hive-flow', 'hives', 'h.json'),
      'tasks/t.json': join(r, '.hive-flow', 'tasks', 't.json'),
      'terminals/term.json': join(r, '.hive-flow', 'terminals', 'term.json'),
    });

    it.each(['agents/store.json', 'hives/h.json', 'tasks/t.json', 'terminals/term.json'])(
      'write_file to %s is blocked as protected path',
      (relLabel) => {
        const r = makeProjectRoot('hfwa-cp-');
        try {
          writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
          makeStore(r, 'a');
          const target = cpTargets(r)[relLabel];
          mkdirSync(dirname(target), { recursive: true });
          const before = existsSync(target) ? read(target) : null;
          const wf = runTool(r, 'write_file', { path: target, content: 'mutated' }, { agentId: 'a' });
          expect(wf).toMatchObject({ status: 'error' });
          expect(wf.error).toMatch(/protected path/);
          if (before === null) expect(existsSync(target)).toBe(false);
          else expect(read(target)).toBe(before);
        } finally {
          rmSync(r, { recursive: true, force: true });
        }
      },
    );

    it('edit_file to an existing control-plane file is blocked', () => {
      const r = makeProjectRoot('hfwa-cp-edit-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'a');
        const hive = join(r, '.hive-flow', 'hives', 'h.json');
        mkdirSync(dirname(hive), { recursive: true });
        writeFileSync(hive, '{"queen":"real"}', 'utf8');
        const ef = runTool(r, 'edit_file', { path: hive, old_string: 'real', new_string: 'evil' }, { agentId: 'a' });
        expect(ef).toMatchObject({ status: 'error' });
        expect(ef.error).toMatch(/protected path/);
        expect(read(hive)).toBe('{"queen":"real"}');
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });
  });

  // ── Untracked artifacts still allowed (preserve audit/result workflows) ────
  describe('untracked scratch writes preserved', () => {
    it('default agent can create & edit untracked files under .tmp-audit/', () => {
      const r = makeProjectRoot('hfwa-scratch-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'a');
        gitInit(r); // git worktree present, but the target is untracked
        const scratch = join(r, '.tmp-audit', 'finding.md');
        const wf = runTool(r, 'write_file', { path: scratch, content: '# finding\n' }, { agentId: 'a' });
        expect(typeof wf).toBe('string');
        expect(wf).toMatch(/File written/);
        expect(read(scratch)).toBe('# finding\n');

        const ef = runTool(r, 'edit_file', { path: scratch, old_string: 'finding', new_string: 'updated' }, { agentId: 'a' });
        expect(typeof ef).toBe('string');
        expect(read(scratch)).toBe('# updated\n');
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });

    it('non-git root does NOT falsely block ordinary writes (but control-plane still blocks)', () => {
      const r = makeProjectRoot('hfwa-nogit-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'a');
        // No git init — not a worktree.
        const file = join(r, 'src', 'plain.ts');
        const wf = runTool(r, 'write_file', { path: file, content: 'ok\n' }, { agentId: 'a' });
        expect(typeof wf).toBe('string');
        expect(read(file)).toBe('ok\n');

        const cp = join(r, '.hive-flow', 'tasks', 't.json');
        mkdirSync(dirname(cp), { recursive: true });
        const cpRes = runTool(r, 'write_file', { path: cp, content: 'x' }, { agentId: 'a' });
        expect(cpRes).toMatchObject({ status: 'error' });
        expect(cpRes.error).toMatch(/protected path/);
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });
  });

  // ── Git detection hardening: spaces + dash-prefixed filenames ─────────────
  describe('git tracked detection hardening', () => {
    it('correctly denies tracked files whose names contain spaces and begin with "-"', () => {
      const r = makeProjectRoot('hfwa-hard-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'a'); // ungranted
        const spaced = join(r, 'src', 'has space.ts');
        const dashed = join(r, 'src', '-leading-dash.ts');
        writeFileSync(spaced, 'spaced\n', 'utf8');
        writeFileSync(dashed, 'dashed\n', 'utf8');
        gitInit(r); gitAddCommit(r);

        const a = runTool(r, 'write_file', { path: spaced, content: 'x' }, { agentId: 'a' });
        expect(a).toMatchObject({ status: 'error' });
        expect(read(spaced)).toBe('spaced\n');

        const b = runTool(r, 'write_file', { path: dashed, content: 'x' }, { agentId: 'a' });
        expect(b).toMatchObject({ status: 'error' });
        expect(read(dashed)).toBe('dashed\n');
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });

    it('fails closed when git tracking detection hits an unexpected git error', () => {
      const r = makeProjectRoot('hfwa-gitfail-');
      try {
        writeKey(r); writeEnvelope(r, readFileSync(join(r, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
        makeStore(r, 'a');
        const fakeBin = join(r, 'fake-bin');
        mkdirSync(fakeBin, { recursive: true });
        const fakeGit = join(fakeBin, 'git');
        writeFileSync(fakeGit, '#!/bin/sh\necho "fatal: corrupt index" >&2\nexit 128\n', 'utf8');
        chmodSync(fakeGit, 0o755);

        const target = join(r, 'src', 'ordinary.ts');
        const wf = runTool(
          r,
          'write_file',
          { path: target, content: 'should-not-write\n' },
          { agentId: 'a', extraEnv: { PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` } },
        );
        expect(wf).toMatchObject({ status: 'error' });
        expect(wf.error).toMatch(/git-tracked source file|write authority/i);
        expect(existsSync(target)).toBe(false);
      } finally {
        rmSync(r, { recursive: true, force: true });
      }
    });
  });
});
