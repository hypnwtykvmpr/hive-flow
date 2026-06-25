/**
 * HF-2 (symlink TOCTOU / path-jail integrity) regression.
 *
 * `validateFilePath` is the single jail chokepoint for ALL bridge filesystem
 * tools (read_file, write_file, edit_file, list_directory, grep, find_file) and
 * for run_command path args. Before this fix it resolved paths textually
 * (`resolve()` + `startsWith(PROJECT_ROOT)`) WITHOUT following symlinks, so an
 * in-root symlink whose target is OUTSIDE the root passed the jail and the fs
 * op then followed the link out of the sandbox.
 *
 * The fix makes the jail realpath-aware (existing-ancestor realpath + missing
 * tail, both sides realpathed). These tests exercise the chokepoint via the
 * exported tool runners running in a child with cwd=tmp-root, mirroring
 * provider-bridge-write-authority.e2e harness.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

const cleanups = [];
afterEach(() => {
  while (cleanups.length) {
    const p = cleanups.pop();
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** Realpathed project root with the standard enforcement + src skeleton. */
function makeProjectRoot(prefix = 'hf2-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(root);
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const real = realpathSync.native(root);
  writeKey(real);
  writeEnvelope(real, readFileSync(join(real, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8'), 0);
  return real;
}

/** A directory OUTSIDE any project root that symlink targets can point at. */
function makeOutsideDir(prefix = 'hf2-outside-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return realpathSync.native(dir);
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
    level, ts: '2026-06-06T00:00:00.000Z', violations: 0,
    restrictedGroups: [], history: [], integrityCompromised: false,
  };
  const envelope = { state, hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex') };
  writeFileSync(join(root, '.hive-flow', 'enforcement', 'state.json'), JSON.stringify(envelope, null, 2), 'utf8');
}

function makeStore(root, agentId, extra = {}) {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents: { [agentId]: { agentId, agentType: 'coder', status: 'busy', provider: 'deepseek', model: 'sonnet', resolvedModel: 'deepseek-v4-flash', taskCount: 0, config: {}, ...extra } },
  }, null, 2), 'utf8');
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

/**
 * Run any bridge tool through the registry in a child with cwd=root so the
 * bridge PROJECT_ROOT and store resolve under the fixture. `cwd` overrides the
 * working dir (used for the symlinked-PROJECT_ROOT criterion).
 */
function runTool(root, toolName, toolArgs, { agentId = 'hf2-agent', cwd = root } = {}) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    const result = await bridge.executeBridgeTool(${JSON.stringify(toolName)}, ${JSON.stringify(toolArgs)}, { source: 'test' });
    process.stdout.write(typeof result === 'string' ? JSON.stringify({ __string: result }) : JSON.stringify(result));
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
  };
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env, encoding: 'utf8' });
  const parsed = JSON.parse(output);
  if (!Object.prototype.hasOwnProperty.call(parsed, '__string')) return parsed;
  // run_command (and other structured tools) return their result as a JSON
  // *string* from executeBridgeTool; re-parse object-shaped strings so callers
  // see the structured result. Plain content/"File written" strings stay strings.
  const s = parsed.__string;
  if (typeof s === 'string' && s.trimStart().startsWith('{')) {
    try { return JSON.parse(s); } catch { /* not JSON → keep as string */ }
  }
  return s;
}

const read = (p) => readFileSync(p, 'utf8');
const isErr = (r) => r && typeof r === 'object' && (r.status === 'error' || r.status === 'denied');

describe('HF-2 realpath-aware path jail (symlink TOCTOU)', () => {
  // Criterion 1: in-root symlink → OUTSIDE → ALL read/list/grep/find tools denied.
  describe('in-root symlink targeting OUTSIDE the root is denied by every tool', () => {
    it('read_file follows the symlink to a real path outside the root and is denied', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const outside = makeOutsideDir();
      writeFileSync(join(outside, 'secret.txt'), 'SECRET\n', 'utf8');
      const link = join(root, 'src', 'leak.txt');
      symlinkSync(join(outside, 'secret.txt'), link);

      const r = runTool(root, 'read_file', { path: link }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
      expect(typeof r === 'string' ? r : r.error).not.toMatch(/SECRET/);
    });

    it('write_file through an in-root symlink pointing outside is denied; outside target unchanged', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const outside = makeOutsideDir();
      const target = join(outside, 'victim.txt');
      writeFileSync(target, 'original\n', 'utf8');
      const link = join(root, 'src', 'evil.txt');
      symlinkSync(target, link);

      const r = runTool(root, 'write_file', { path: link, content: 'pwned\n' }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
      expect(read(target)).toBe('original\n');
    });

    it('edit_file through an in-root symlink pointing outside is denied; outside target unchanged', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const outside = makeOutsideDir();
      const target = join(outside, 'victim2.txt');
      writeFileSync(target, 'keepme\n', 'utf8');
      const link = join(root, 'src', 'evil2.txt');
      symlinkSync(target, link);

      const r = runTool(root, 'edit_file', { path: link, old_string: 'keepme', new_string: 'pwned' }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
      expect(read(target)).toBe('keepme\n');
    });

    it('list_directory through an in-root dir symlink pointing outside is denied', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const outside = makeOutsideDir();
      writeFileSync(join(outside, 'a.txt'), 'x', 'utf8');
      const link = join(root, 'src', 'leakdir');
      symlinkSync(outside, link);

      const r = runTool(root, 'list_directory', { path: link }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
    });

    it('grep through an in-root dir symlink pointing outside is denied', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const outside = makeOutsideDir();
      writeFileSync(join(outside, 'a.txt'), 'NEEDLE here\n', 'utf8');
      const link = join(root, 'src', 'leakgrep');
      symlinkSync(outside, link);

      const r = runTool(root, 'grep', { pattern: 'NEEDLE', path: link }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
      expect(typeof r === 'string' ? r : r.error).not.toMatch(/NEEDLE/);
    });

    it('find_file through an in-root dir symlink pointing outside is denied', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const outside = makeOutsideDir();
      writeFileSync(join(outside, 'found.txt'), 'x', 'utf8');
      const link = join(root, 'src', 'leakfind');
      symlinkSync(outside, link);

      const r = runTool(root, 'find_file', { pattern: '*.txt', path: link }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
    });
  });

  // Criterion 2: in-root symlink → another IN-root real path → ALLOWED.
  it('in-root symlink pointing to another in-root real path operates on the real path (allowed)', () => {
    const root = makeProjectRoot(); makeStore(root, 'a');
    const realFile = join(root, 'src', 'real.txt');
    writeFileSync(realFile, 'inside\n', 'utf8');
    const link = join(root, 'src', 'alias.txt');
    symlinkSync(realFile, link);

    const r = runTool(root, 'read_file', { path: link }, { agentId: 'a' });
    expect(r).toBe('inside\n');
  });

  // Criterion 3: new (non-existent) path inside an existing in-root dir → SUCCEEDS.
  it('write_file to a NEW path inside an existing in-root dir still succeeds (non-existent tail)', () => {
    const root = makeProjectRoot(); makeStore(root, 'a');
    const newFile = join(root, 'src', 'brand-new.txt');
    const r = runTool(root, 'write_file', { path: newFile, content: 'fresh\n' }, { agentId: 'a' });
    expect(typeof r).toBe('string');
    expect(r).toMatch(/File written/);
    expect(read(newFile)).toBe('fresh\n');
  });

  // Criterion 4: new file under .tmp-audit/ → SUCCEEDS.
  it('write_file to a new file under .tmp-audit/ succeeds', () => {
    const root = makeProjectRoot(); makeStore(root, 'a');
    const scratch = join(root, '.tmp-audit', 'finding.md');
    const r = runTool(root, 'write_file', { path: scratch, content: '# f\n' }, { agentId: 'a' });
    expect(typeof r).toBe('string');
    expect(read(scratch)).toBe('# f\n');
  });

  // Criterion 5 (BYPASS-3): untracked in-root symlink → TRACKED in-root file.
  describe('BYPASS-3: untracked symlink pointing at a tracked file', () => {
    it('denies a no-authority agent (tracked detection sees the real tracked path)', () => {
      const root = makeProjectRoot(); makeStore(root, 'a'); // ungranted
      const tracked = join(root, 'src', 'tracked.ts');
      writeFileSync(tracked, 'export const original = 1;\n', 'utf8');
      gitInit(root); gitAddCommit(root); // commits tracked.ts; symlink added AFTER → untracked
      const link = join(root, 'src', 'alias.ts');
      symlinkSync(tracked, link);

      const r = runTool(root, 'write_file', { path: link, content: 'export const hacked = 1;\n' }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
      expect(r.error).toMatch(/tracked|write authority/i);
      expect(read(tracked)).toBe('export const original = 1;\n');
    });

    it('allows a writeAuthority:source agent (real tracked path, but granted)', () => {
      const root = makeProjectRoot(); makeStore(root, 'g', { writeAuthority: 'source' });
      const tracked = join(root, 'src', 'tracked.ts');
      writeFileSync(tracked, 'export const v = 1;\n', 'utf8');
      gitInit(root); gitAddCommit(root);
      const link = join(root, 'src', 'alias.ts');
      symlinkSync(tracked, link);

      const r = runTool(root, 'write_file', { path: link, content: 'export const v = 2;\n' }, { agentId: 'g' });
      expect(typeof r).toBe('string');
      expect(r).toMatch(/File written/);
      expect(read(tracked)).toBe('export const v = 2;\n');
    });
  });

  // Criterion 6: PROJECT_ROOT itself reached via a symlink component → still jails.
  describe('PROJECT_ROOT reached via a symlink component', () => {
    it('allows a legitimate in-root write when cwd is a symlink to the real root', () => {
      const realRoot = makeProjectRoot('hf2-symroot-'); makeStore(realRoot, 'a');
      const linkRoot = join(makeOutsideDir('hf2-symlink-parent-'), 'rootlink');
      symlinkSync(realRoot, linkRoot);
      // PROJECT_ROOT = cwd = linkRoot (contains a symlink component). The file
      // path is given relative to that symlinked root.
      const r = runTool(realRoot, 'write_file', { path: join(linkRoot, 'src', 'viaSymRoot.txt'), content: 'ok\n' }, { agentId: 'a', cwd: linkRoot });
      expect(typeof r).toBe('string');
      expect(read(join(realRoot, 'src', 'viaSymRoot.txt'))).toBe('ok\n');
    });

    it('still denies an outside symlink even when cwd is a symlinked root', () => {
      const realRoot = makeProjectRoot('hf2-symroot2-'); makeStore(realRoot, 'a');
      const linkRoot = join(makeOutsideDir('hf2-symlink-parent2-'), 'rootlink');
      symlinkSync(realRoot, linkRoot);
      const outside = makeOutsideDir();
      writeFileSync(join(outside, 's.txt'), 'SECRET\n', 'utf8');
      const link = join(realRoot, 'src', 'leak.txt');
      symlinkSync(join(outside, 's.txt'), link);

      const r = runTool(realRoot, 'read_file', { path: join(linkRoot, 'src', 'leak.txt') }, { agentId: 'a', cwd: linkRoot });
      expect(isErr(r)).toBe(true);
    });
  });

  // Criterion 7: traversal blocked; positive controls; run_command symlink behavior.
  describe('traversal + positive controls + run_command', () => {
    it('blocks ../outside traversal', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const r = runTool(root, 'read_file', { path: join(root, '..', 'outside-escape.txt') }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
    });

    it('normal in-root read/write/edit positive controls still work', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const f = join(root, 'src', 'plain.txt');
      const w = runTool(root, 'write_file', { path: f, content: 'hello\n' }, { agentId: 'a' });
      expect(typeof w).toBe('string');
      const rd = runTool(root, 'read_file', { path: f }, { agentId: 'a' });
      expect(rd).toBe('hello\n');
      const e = runTool(root, 'edit_file', { path: f, old_string: 'hello', new_string: 'world' }, { agentId: 'a' });
      expect(typeof e).toBe('string');
      expect(read(f)).toBe('world\n');
    });

    it('run_command cat on an in-root path still works', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const f = join(root, 'src', 'cat.txt');
      writeFileSync(f, 'catme\n', 'utf8');
      const r = runTool(root, 'run_command', { command: `cat ${f}` }, { agentId: 'a' });
      expect(r).toMatchObject({ status: 'executed', exitCode: 0 });
      expect(r.stdout).toMatch(/catme/);
    });

    it('run_command cat via an in-root symlink to outside is denied', () => {
      const root = makeProjectRoot(); makeStore(root, 'a');
      const outside = makeOutsideDir();
      writeFileSync(join(outside, 'secret.txt'), 'SECRET\n', 'utf8');
      const link = join(root, 'src', 'catleak.txt');
      symlinkSync(join(outside, 'secret.txt'), link);
      const r = runTool(root, 'run_command', { command: `cat ${link}` }, { agentId: 'a' });
      expect(isErr(r)).toBe(true);
      expect(r.stdout || '').not.toMatch(/SECRET/);
    });
  });
});
