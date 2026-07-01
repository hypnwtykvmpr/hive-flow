import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
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
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  __sandboxRunnerTestHooks,
  buildSandboxEnv,
  probeSandboxBackend,
  sandboxExec,
} from '../scripts/sandbox-runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const providersRoot = resolve(here, '..');
const failClosedGoldenPath = join(here, 'fixtures', 'sandbox-unavailable-diagnostics.golden.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function makeProjectRoot(prefix = 'hf-sandbox-runner-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  return root;
}

function commandExists(command) {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function hasLocalSandboxBackend() {
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    try {
      execFileSync('/usr/bin/sandbox-exec', [
        '-p',
        '(version 1)\n(allow default)\n',
        '/usr/bin/true',
      ], { stdio: 'ignore', timeout: 1000 });
      return true;
    } catch {
      return false;
    }
  }
  return (process.platform === 'linux' && commandExists('bwrap'))
    || commandExists('docker');
}

async function withTcpServer(fn) {
  const server = createServer((socket) => {
    socket.end('connected\n');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    const { port } = server.address();
    return await fn(port);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

describe('provider sandbox runner', () => {
  it('scrubs ambient credentials and remaps HOME/TMPDIR to a throwaway temp', () => {
    const projectRoot = makeProjectRoot();
    const tempDir = join(projectRoot, '.sandbox-tmp');
    const env = buildSandboxEnv({
      HOME: '/Users/human',
      TMPDIR: '/private/tmp/real',
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
      AWS_SECRET_ACCESS_KEY: 'secret',
      HIVE_FLOW_DEV_OVERRIDE_TOKEN: 'token',
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      SAFE_CUSTOM: 'not-allowed',
    }, { projectRoot, tempDir });

    expect(env.HOME).toBe(tempDir);
    expect(env.TMPDIR).toBe(tempDir);
    expect(env.TEMP).toBe(tempDir);
    expect(env.TMP).toBe(tempDir);
    expect(env.PWD).toBe(projectRoot);
    expect(env.PATH).toContain('/usr/bin');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('HIVE_FLOW_DEV_OVERRIDE_TOKEN');
    expect(env).not.toHaveProperty('SAFE_CUSTOM');

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('scrubs arbitrary non-allowlisted environment variables without leaking generated secrets', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,24}$/),
          fc.string({ minLength: 1, maxLength: 40 }),
          { maxKeys: 30 },
        ),
        (generatedEnv) => {
          const projectRoot = makeProjectRoot();
          const tempDir = join(projectRoot, '.sandbox-tmp');
          const env = buildSandboxEnv({
            ...generatedEnv,
            HOME: generatedEnv.HOME || '/Users/human',
            TMPDIR: generatedEnv.TMPDIR || '/private/tmp/real',
            HIVE_FLOW_DEV_OVERRIDE_TOKEN: 'must-not-leak',
            SSH_AUTH_SOCK: 'must-not-leak',
          }, { projectRoot, tempDir });

          expect(env.HOME).toBe(tempDir);
          expect(env.TMPDIR).toBe(tempDir);
          expect(env.PWD).toBe(projectRoot);
          for (const key of Object.keys(env)) {
            expect([
              'PATH',
              'LANG',
              'LC_ALL',
              'LC_CTYPE',
              'TERM',
              'TZ',
              'HOME',
              'TMPDIR',
              'TEMP',
              'TMP',
              'PWD',
              'SHELL',
            ]).toContain(key);
          }
          expect(Object.values(env)).not.toContain('must-not-leak');

          rmSync(projectRoot, { recursive: true, force: true });
        },
      ),
      { numRuns: 80, seed: 260608 },
    );
  });

  it('fails closed with a machine-readable reason when no backend verifies', async () => {
    const projectRoot = makeProjectRoot();
    const result = await sandboxExec([process.execPath, '--version'], {
      projectRoot,
      backendOrder: [],
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.denyReason).toBe('sandbox-unavailable:no-verified-backend');
    expect(result.diagnostics).toMatchObject({
      reason: 'sandbox-unavailable:no-verified-backend',
      verifiedBackend: null,
    });
    expect({
      status: result.status,
      denyReason: result.denyReason,
      diagnostics: {
        reason: result.diagnostics.reason,
        verifiedBackend: result.diagnostics.verifiedBackend,
        availability: result.diagnostics.availability,
      },
    }).toEqual(readJson(failClosedGoldenPath));

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('retries a transiently failed behavioral probe before declaring the sandbox unavailable', async () => {
    const projectRoot = makeProjectRoot();
    const calls = [];
    const candidate = {
      name: 'fake-transient',
      available: true,
      unavailableReason: null,
    };

    const selected = await __sandboxRunnerTestHooks.findVerifiedBackend({
      projectRoot,
      tempDir: join(projectRoot, '.sandbox-tmp'),
      env: buildSandboxEnv({}, { projectRoot, tempDir: join(projectRoot, '.sandbox-tmp') }),
      backendOrder: ['fake-transient'],
      probeAttempts: 2,
      __testCandidates: [candidate],
      __testProbeCandidate: async (probeCandidate) => {
        calls.push(probeCandidate.name);
        return calls.length === 1
          ? { verified: false, backend: probeCandidate.name, reason: 'probe-execution-failed' }
          : { verified: true, backend: probeCandidate.name, reason: null, probes: { insideWriteAllowed: true } };
      },
    });

    expect(selected.candidate).toBe(candidate);
    expect(calls).toEqual(['fake-transient', 'fake-transient']);
    expect(selected.diagnostics.verifiedBackend).toBe('fake-transient');
    expect(selected.diagnostics.probeAttempts).toBe(2);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it.runIf(hasLocalSandboxBackend())('verifies a backend with behavioral isolation probes, not binary presence', async () => {
    const projectRoot = makeProjectRoot();
    const result = await probeSandboxBackend({ projectRoot, timeoutMs: 2500 });

    expect(result.verified).toBe(true);
    expect(result.backend).toMatch(/^(sandbox-exec|bwrap|container)$/);
    expect(result.probes).toMatchObject({
      writeOutsideBlocked: true,
      protectedReadBlocked: true,
      protectedWriteBlocked: true,
      networkBlocked: true,
    });

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it.runIf(hasLocalSandboxBackend())('cleans up protected probe sentinels after behavioral probing', async () => {
    const projectRoot = makeProjectRoot();

    await probeSandboxBackend({ projectRoot, timeoutMs: 2500 });

    expect(readdirSync(join(projectRoot, '.claude')).filter((name) => name.startsWith('sandbox-probe-'))).toEqual([]);
    expect(readdirSync(join(projectRoot, '.hive-flow', 'enforcement')).filter((name) => name.startsWith('sandbox-probe-'))).toEqual([]);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it.runIf(hasLocalSandboxBackend())('blocks outside writes, outside reads, protected reads/writes, and network egress', async () => {
    const projectRoot = makeProjectRoot();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'hf-sandbox-outside-'));
    const outsideWrite = join(outsideRoot, 'write-attempt.txt');
    const outsideRead = join(outsideRoot, 'secret.txt');
    const protectedRead = join(projectRoot, '.claude', 'settings.json');
    const protectedWrite = join(projectRoot, '.hive-flow', 'enforcement', 'state.json');
    const insideWrite = join(projectRoot, 'src', 'inside-write.txt');
    const scriptPath = join(projectRoot, 'src', 'probe.mjs');

    writeFileSync(outsideRead, 'outside secret\n', 'utf8');
    writeFileSync(protectedRead, '{"secret":true}\n', 'utf8');
    writeFileSync(protectedWrite, '{"state":"protected"}\n', 'utf8');
    writeFileSync(scriptPath, `
      import { readFileSync, writeFileSync } from 'node:fs';
      import net from 'node:net';

      const [outsideWrite, outsideRead, protectedRead, protectedWrite, insideWrite, port] = process.argv.slice(2);
      const result = {};
      const mark = (key, fn) => {
        try { fn(); result[key] = 'allowed'; } catch (err) { result[key] = 'blocked:' + (err.code || err.name || 'error'); }
      };

      mark('outsideWrite', () => writeFileSync(outsideWrite, 'bad', 'utf8'));
      mark('outsideRead', () => readFileSync(outsideRead, 'utf8'));
      mark('protectedRead', () => readFileSync(protectedRead, 'utf8'));
      mark('protectedWrite', () => writeFileSync(protectedWrite, 'bad', 'utf8'));
      mark('insideWrite', () => writeFileSync(insideWrite, 'ok', 'utf8'));

      await new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
        const done = (value) => {
          if (!result.network) result.network = value;
          socket.destroy();
          resolve();
        };
        socket.once('connect', () => done('allowed'));
        socket.once('error', (err) => done('blocked:' + (err.code || err.name || 'error')));
        socket.setTimeout(400, () => done('blocked:timeout'));
      });

      console.log(JSON.stringify(result));
    `, 'utf8');

    await withTcpServer(async (port) => {
      const result = await sandboxExec([
        process.execPath,
        scriptPath,
        outsideWrite,
        outsideRead,
        protectedRead,
        protectedWrite,
        insideWrite,
        String(port),
      ], {
        projectRoot,
        timeoutMs: 3000,
      });

      expect(result.ok).toBe(true);
      const probes = JSON.parse(result.stdout);
      expect(probes.outsideWrite).toMatch(/^blocked:/);
      expect(probes.outsideRead).toMatch(/^blocked:/);
      expect(probes.protectedRead).toMatch(/^blocked:/);
      expect(probes.protectedWrite).toMatch(/^blocked:/);
      expect(probes.insideWrite).toBe('allowed');
      expect(probes.network).toMatch(/^blocked:/);
      expect(existsSync(outsideWrite)).toBe(false);
      expect(readFileSync(insideWrite, 'utf8')).toBe('ok');
    });

    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  it.runIf(hasLocalSandboxBackend())('caps stdout and stderr byte output', async () => {
    const projectRoot = makeProjectRoot();
    const scriptPath = join(projectRoot, 'src', 'output-cap.mjs');
    writeFileSync(scriptPath, `
      process.stdout.write('o'.repeat(4096));
      process.stderr.write('e'.repeat(4096));
    `, 'utf8');

    const result = await sandboxExec([process.execPath, scriptPath], {
      projectRoot,
      timeoutMs: 2000,
      stdoutLimitBytes: 64,
      stderrLimitBytes: 32,
    });

    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(result.stderr.length).toBeLessThanOrEqual(32);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it.runIf(hasLocalSandboxBackend())('kills the timed-out sandbox process before delayed file effects', async () => {
    const projectRoot = makeProjectRoot();
    const marker = join(projectRoot, 'src', 'late-marker.txt');
    const parentPath = join(projectRoot, 'src', 'timeout-parent.mjs');

    writeFileSync(parentPath, `
      import { writeFileSync } from 'node:fs';
      const marker = process.argv[2];
      setTimeout(() => {
        writeFileSync(marker, 'late', 'utf8');
      }, 700);
      setTimeout(() => {}, 5000);
    `, 'utf8');

    const result = await sandboxExec([process.execPath, parentPath, marker], {
      projectRoot,
      timeoutMs: 150,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('timeout');
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
    expect(existsSync(marker)).toBe(false);

    rmSync(projectRoot, { recursive: true, force: true });
  });
});
