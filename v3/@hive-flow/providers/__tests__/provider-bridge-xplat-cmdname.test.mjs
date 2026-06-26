/**
 * E2 cross-platform (Windows) command-name hardening.
 *
 * `commandName()` is the single chokepoint that both `denyUnsafeRunShellCommand`
 * (run_shell denylist) and `denyUnsafeReadOnlyCommand` (run_command allowlist)
 * key their NAME-POLICY decisions off of. On POSIX a Windows executable token
 * like `python.exe` / `git.exe` slipped both gates two ways:
 *
 *   - HF-20 UNDER-BLOCK: `python.exe -c` did not match the `/^python.../` family
 *     regex (the `.exe` suffix has letters+dot), so the inline-eval denylist
 *     never fired — arbitrary code execution.
 *   - E1 OVER-BLOCK: `git.exe status` / `cat.exe f` failed `executable === 'git'`
 *     and the read allowlist set membership, so legit read-only commands were
 *     wrongly denied.
 *
 * The fix normalizes the basename cross-platform (backslash→slash, basename,
 * lowercase, trim trailing Windows dots/spaces, strip ONE trailing known exec
 * extension) so `python.exe`→`python` and `git.exe`→`git`. This repairs BOTH
 * the denylist under-block and the allowlist over-block through one change.
 *
 * run_shell cases call the exported pure `denyUnsafeRunShellCommand(rendered, argv)`
 * directly (non-null = denied; null = allowed), mirroring
 * provider-bridge-run-shell-inline-eval.test.mjs. run_command cases drive
 * `executeBridgeTool('run_command', ...)` in a child, mirroring
 * provider-bridge-git-readjail.test.mjs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');
const bridge = await import(pathToFileURL(bridgePath).href);
const { denyUnsafeRunShellCommand } = bridge;

const deny = (argv, rendered = argv.join(' ')) => denyUnsafeRunShellCommand(rendered, argv);

describe('E2 run_shell: Windows .exe executable tokens denied (HF-20 under-block fix)', () => {
  it('python interpreter .exe/.cmd/.bat forms with -c are denied', () => {
    expect(deny(['python.exe', '-c', 'print(1)'])).toBeTruthy();
    expect(deny(['python3.11.exe', '-c', 'x'])).toBeTruthy();
    expect(deny(['python.cmd', '-c', 'x'])).toBeTruthy();
    expect(deny(['python.bat', '-c', 'x'])).toBeTruthy();
    expect(deny(['PYTHON.EXE', '-c', 'x'])).toBeTruthy();              // capital token + ext
    expect(deny(['python.exe.', '-c', 'x'])).toBeTruthy();             // trailing dot (Windows trims)
    expect(deny(['python.exe ', '-c', 'x'], 'python.exe -c x')).toBeTruthy(); // trailing space on exe token
  });

  it('node/ruby/perl/php .exe interpreters with eval flags denied', () => {
    expect(deny(['node.exe', '-e', '1'])).toBeTruthy();
    expect(deny(['node.cmd', '-e', '1'])).toBeTruthy();
    expect(deny(['node.exe', '-p', '1+1'])).toBeTruthy();
    expect(deny(['ruby.exe', '-e', 'puts 1'])).toBeTruthy();
    expect(deny(['perl.exe', '-nE', 'code'])).toBeTruthy();
    expect(deny(['php.exe', '-r', 'echo 1;'])).toBeTruthy();
  });

  it('non-interpreter wholesale-denied tools in .exe form denied', () => {
    expect(deny(['sed.exe', 's/x/y/', 'file'])).toBeTruthy();
    expect(deny(['awk.exe', 'BEGIN{print 1}'])).toBeTruthy();
    expect(deny(['xargs.exe', 'id'])).toBeTruthy();
    expect(deny(['find.exe', '-execdir', 'x', ';'])).toBeTruthy();
  });

  it('bun/deno .exe eval forms denied', () => {
    expect(deny(['bun.exe', 'eval', '1'])).toBeTruthy();
    expect(deny(['deno.exe', 'eval', 'console.log(1)'])).toBeTruthy();
  });

  it('shell wrapper + launcher + credential .exe tokens denied', () => {
    expect(deny(['bash.exe', '-c', 'id'])).toBeTruthy();
    expect(deny(['sh.exe', '-c', 'id'])).toBeTruthy();
    // powershell is only denied for credential retrieval (not wholesale), so
    // normalization must keep that targeted gate firing on the .exe token.
    expect(deny(['powershell.exe', '-Command', 'Get-StoredCredential'])).toBeTruthy();
    expect(deny(['env.exe', 'X=1', 'sh'])).toBeTruthy();
    expect(deny(['printenv.exe'])).toBeTruthy();
    expect(deny(['git.exe', 'push'])).toBeTruthy();
  });

  it('Windows path-prefixed interpreter tokens denied', () => {
    expect(deny(['C:\\path\\python.exe', '-c', 'x'], 'C:\\path\\python.exe -c x')).toBeTruthy(); // backslash path
    expect(deny(['..\\python.exe', '-c', 'x'], '..\\python.exe -c x')).toBeTruthy();             // relative backslash
  });

  it('negative controls: legit .exe script runs ALLOWED (no eval flag)', () => {
    expect(deny(['node', 'script.js'])).toBeNull();
    expect(deny(['python.exe', 'script.py'])).toBeNull(); // suffix .py, NO -c → legit
    expect(deny(['ls', '-la'])).toBeNull();
  });
});

// ---- run_command path: E1 over-block repair + E1 exfil regression ----

const cleanups = [];
afterEach(() => {
  while (cleanups.length) {
    const p = cleanups.pop();
    try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeProjectRoot(prefix = 'e2-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(root);
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const real = realpathSync.native(root);
  const key = randomBytes(32).toString('hex');
  const keyPath = join(real, '.hive-flow', 'enforcement', '.hmac-key');
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
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

describe('E2 run_command: Windows .exe tokens route through allowlist (E1 over-block repair)', () => {
  it('git.exe status is allowed (over-block repaired)', () => {
    expect(isExecuted(runCommand(gitFixture(), 'git.exe status'))).toBe(true);
  });
  // cat.exe/head.exe are not real binaries on POSIX CI, so we assert the POLICY
  // decision (status 'executed' = passed the read allowlist + spawned) rather
  // than stdout. The over-block is what the normalizer repairs.
  it('cat.exe file.txt passes the read allowlist (status executed)', () => {
    const root = gitFixture();
    writeFileSync(join(root, 'src', 'f.txt'), 'hi\n', 'utf8');
    const r = runCommand(root, `cat.exe ${join(root, 'src', 'f.txt')}`);
    expect(isExecuted(r)).toBe(true);
  });
  it('head.exe file.txt passes the read allowlist (status executed)', () => {
    const root = gitFixture();
    writeFileSync(join(root, 'src', 'h.txt'), 'headme\n', 'utf8');
    const r = runCommand(root, `head.exe ${join(root, 'src', 'h.txt')}`);
    expect(isExecuted(r)).toBe(true);
  });

  // E1 exfil + content gate must STILL deny after normalization.
  it('git.exe show HEAD:.env stays denied (E1 secret exfil)', () => {
    expect(isDenied(runCommand(gitFixture(), 'git.exe show HEAD:.env'))).toBe(true);
  });
  it('git.exe log -p stays denied (content gate via flag)', () => {
    expect(isDenied(runCommand(gitFixture(), 'git.exe log -p'))).toBe(true);
  });
});
