/**
 * E1 (run_command read-boundary) regression.
 *
 * `denyUnsafeReadOnlyCommand` is the read-only allowlist gate for the bridge
 * run_command tool. Before this fix it allowed git blob/patch readers
 * (`git show HEAD:.env`, `git cat-file -p`, `git log -p`, bare `git diff`),
 * git jail-escape options (`-C`, `--git-dir`, `--work-tree`, `-c...`), and
 * skipped path validation for numeric-named positionals (a file literally
 * named `100`). All of these leaked protected/out-of-jail file contents.
 *
 * Driven through `executeBridgeTool('run_command', ...)` in a child with
 * cwd=tmp-root, mirroring the provider-bridge-realpath-jail harness.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import {
  chmodSync,
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

function makeProjectRoot(prefix = 'e1-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(root);
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const real = realpathSync.native(root);
  const key = randomBytes(32).toString('hex');
  const keyPath = join(real, '.hive-flow', 'enforcement', '.hmac-key');
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
  const state = {
    level: 0, ts: '2026-06-06T00:00:00.000Z', violations: 0,
    restrictedGroups: [], history: [], integrityCompromised: false,
  };
  const envelope = { state, hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex') };
  writeFileSync(join(real, '.hive-flow', 'enforcement', 'state.json'), JSON.stringify(envelope, null, 2), 'utf8');
  return real;
}

function makeStore(root, agentId = 'a') {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents: { [agentId]: { agentId, agentType: 'coder', status: 'busy', provider: 'deepseek', model: 'sonnet', resolvedModel: 'deepseek-v4-flash', taskCount: 0, config: {} } },
  }, null, 2), 'utf8');
}

function makeOutsideDir(prefix = 'e1-outside-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return realpathSync.native(dir);
}

/** Run run_command through the registry in a child with cwd=root. */
function runCommand(root, command, { agentId = 'a' } = {}) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    const result = await bridge.executeBridgeTool('run_command', ${JSON.stringify({ command })}, { source: 'test' });
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
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8' });
  const parsed = JSON.parse(output);
  if (!Object.prototype.hasOwnProperty.call(parsed, '__string')) return parsed;
  const s = parsed.__string;
  if (typeof s === 'string' && s.trimStart().startsWith('{')) {
    try { return JSON.parse(s); } catch { /* keep string */ }
  }
  return s;
}

const isDenied = (r) => r && typeof r === 'object' && r.status === 'denied';
const isExecuted = (r) => r && typeof r === 'object' && r.status === 'executed';

describe('E1 run_command git read-boundary', () => {
  // Fix 1 — blob readers removed from the allowlist.
  describe('Fix 1: git blob readers denied (BE-1 secret exfil)', () => {
    it('denies git show HEAD:.env', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git show HEAD:.env'))).toBe(true);
    });
    it('denies git cat-file -p HEAD:.env', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git cat-file -p HEAD:.env'))).toBe(true);
    });
  });

  // Fix 2 — jail-escape options blocked in every form (BE-2).
  describe('Fix 2: git jail-escape options denied (BE-2)', () => {
    it('denies git -C /tmp status', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git -C /tmp status'))).toBe(true);
    });
    it('denies git --git-dir=/tmp/.git log', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git --git-dir=/tmp/.git log'))).toBe(true);
    });
    it('denies git --work-tree=/etc status', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git --work-tree=/etc status'))).toBe(true);
    });
    it('denies git -ccore.fsmonitor=/bin/sh status (bundled -c)', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git -ccore.fsmonitor=/bin/sh status'))).toBe(true);
    });
    it('denies git -c x=y log (bare -c)', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git -c x=y log'))).toBe(true);
    });
  });

  // Fix 3 — content-producing diff/log denied (BE-1 cont'd).
  describe('Fix 3: content diff/log denied, metadata-only allowed', () => {
    it('denies git log -p', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git log -p'))).toBe(true);
    });
    it('denies git log -p -- src/x', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git log -p -- src/x'))).toBe(true);
    });
    it('denies bare git diff (defaults to patch)', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git diff'))).toBe(true);
    });
    it('denies git diff -G secret', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git diff -G secret'))).toBe(true);
    });
    // BR-1/BR-2: merge/combined-diff family emits full patches; log has no
    // metadata-flag requirement so these must be denied explicitly.
    it('denies git log --cc (BR-1)', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git log --cc'))).toBe(true);
    });
    it('denies git log --remerge-diff (BR-2)', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git log --remerge-diff'))).toBe(true);
    });
    it('denies git log -m -p', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git log -m -p'))).toBe(true);
    });
    it('denies git log -m --combined', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git log -m --combined'))).toBe(true);
    });
    // BR-4: bundled pickaxe -G<re> caught for parity with bare -G.
    it('denies git log -Gx -p (BR-4 bundled pickaxe + patch)', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git log -Gx -p'))).toBe(true);
    });
    // content-before-metadata ordering: a content flag denies even with --stat.
    it('denies git diff --stat -p (content beats metadata)', () => {
      const root = makeProjectRoot(); makeStore(root);
      expect(isDenied(runCommand(root, 'git diff --stat -p'))).toBe(true);
    });
    // Fix 3 FAIL-CLOSED: any non-allowlisted -flag denies even alongside --stat.
    // --binary/--ext-diff/--textconv/--submodule=diff/--check/--text/-a all leak.
    for (const flag of ['--binary', '--ext-diff', '--textconv', '--submodule=diff', '--check', '--text', '-a', '--totally-new-flag-xyz']) {
      it(`denies git diff --stat ${flag} (fail-closed allowlist)`, () => {
        const root = makeProjectRoot(); makeStore(root);
        expect(isDenied(runCommand(root, `git diff --stat ${flag}`))).toBe(true);
      });
    }
    // Rename-DETECTION flags modify but do not suppress the patch — they leak.
    for (const cmd of ['git diff -M', 'git diff --find-renames', 'git diff -M50%']) {
      it(`denies ${cmd} (rename detection still emits patch)`, () => {
        const root = makeProjectRoot(); makeStore(root);
        expect(isDenied(runCommand(root, cmd))).toBe(true);
      });
    }
  });

  // Positive controls — legit read-only git still works.
  describe('legit read-only git still works', () => {
    function gitFixture() {
      const root = makeProjectRoot(); makeStore(root);
      const opts = { cwd: root, stdio: 'ignore' };
      execFileSync('git', ['init', '-q'], opts);
      execFileSync('git', ['config', 'user.email', 'a@b.c'], opts);
      execFileSync('git', ['config', 'user.name', 'test'], opts);
      writeFileSync(join(root, 'src', 'a.txt'), 'one\n', 'utf8');
      execFileSync('git', ['add', '-A'], opts);
      execFileSync('git', ['commit', '-q', '-m', 'init'], opts);
      return root;
    }
    it('allows git status', () => expect(isExecuted(runCommand(gitFixture(), 'git status'))).toBe(true));
    it('allows git rev-parse HEAD', () => expect(isExecuted(runCommand(gitFixture(), 'git rev-parse HEAD'))).toBe(true));
    it('allows git ls-files', () => expect(isExecuted(runCommand(gitFixture(), 'git ls-files'))).toBe(true));
    it('allows git describe', () => expect(isExecuted(runCommand(gitFixture(), 'git describe --always'))).toBe(true));
    it('allows git log --oneline', () => expect(isExecuted(runCommand(gitFixture(), 'git log --oneline'))).toBe(true));
    it('allows git log --stat', () => expect(isExecuted(runCommand(gitFixture(), 'git log --stat'))).toBe(true));
    it('allows git diff --stat', () => expect(isExecuted(runCommand(gitFixture(), 'git diff --stat'))).toBe(true));
    it('allows git diff --name-only', () => expect(isExecuted(runCommand(gitFixture(), 'git diff --name-only'))).toBe(true));
    // BR-3 regression guards: --c* LONG options must NOT be denied as `-c` config injection.
    it('allows git diff --compact-summary (BR-3 regression guard)', () => expect(isExecuted(runCommand(gitFixture(), 'git diff --compact-summary'))).toBe(true));
    it('allows git diff --cumulative (BR-3 regression guard)', () => expect(isExecuted(runCommand(gitFixture(), 'git diff --cumulative'))).toBe(true));
    // Fail-closed allowlist positive controls (must not regress).
    it('allows git diff --numstat', () => expect(isExecuted(runCommand(gitFixture(), 'git diff --numstat'))).toBe(true));
    it('allows git diff --name-status', () => expect(isExecuted(runCommand(gitFixture(), 'git diff --name-status'))).toBe(true));
    it('allows git log --format=%H', () => expect(isExecuted(runCommand(gitFixture(), 'git log --format=%H'))).toBe(true));
    it('allows git log --graph', () => expect(isExecuted(runCommand(gitFixture(), 'git log --graph'))).toBe(true));
    it('allows git log --oneline HEAD~3..HEAD (revision arg)', () => expect(isExecuted(runCommand(gitFixture(), 'git log --oneline HEAD~3..HEAD'))).toBe(true));
    it('allows git diff --stat -- somepath (pathspec)', () => expect(isExecuted(runCommand(gitFixture(), 'git diff --stat -- src'))).toBe(true));
    it('allows git log -5 (count shorthand)', () => expect(isExecuted(runCommand(gitFixture(), 'git log -5'))).toBe(true));
  });

  // Fix 4 — numeric/size-named path positional read-jail (BE-7).
  describe('Fix 4: numeric-named path positional validated (BE-7)', () => {
    it('cat <file named 100> resolving to OUTSIDE the jail is denied', () => {
      const root = makeProjectRoot(); makeStore(root);
      const outside = makeOutsideDir();
      writeFileSync(join(outside, 'secret.txt'), 'SECRET\n', 'utf8');
      // a file literally named "100" inside the jail that symlinks outside
      symlinkSync(join(outside, 'secret.txt'), join(root, '100'));
      const r = runCommand(root, 'cat 100');
      expect(isDenied(r)).toBe(true);
      expect(r.stdout || '').not.toMatch(/SECRET/);
    });
    it('cat <in-jail file named 100> is allowed', () => {
      const root = makeProjectRoot(); makeStore(root);
      writeFileSync(join(root, '100'), 'inside\n', 'utf8');
      const r = runCommand(root, 'cat 100');
      expect(isExecuted(r)).toBe(true);
      expect(r.stdout).toMatch(/inside/);
    });
    it('head -c 100 file.txt treats 100 as a count and validates file.txt', () => {
      const root = makeProjectRoot(); makeStore(root);
      writeFileSync(join(root, 'src', 'file.txt'), 'headme\n', 'utf8');
      const r = runCommand(root, `head -c 100 ${join(root, 'src', 'file.txt')}`);
      expect(isExecuted(r)).toBe(true);
      expect(r.stdout).toMatch(/headme/);
    });
    it('head -c 100 <count, then a numeric-named file resolving outside> is denied', () => {
      const root = makeProjectRoot(); makeStore(root);
      const outside = makeOutsideDir();
      writeFileSync(join(outside, 'secret.txt'), 'SECRET\n', 'utf8');
      symlinkSync(join(outside, 'secret.txt'), join(root, '200'));
      const r = runCommand(root, 'head -c 100 200');
      expect(isDenied(r)).toBe(true);
      expect(r.stdout || '').not.toMatch(/SECRET/);
    });
  });
});
