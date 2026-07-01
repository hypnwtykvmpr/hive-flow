#!/usr/bin/env node
/**
 * Fail-closed provider sandbox runner.
 *
 * This module intentionally exposes a narrow argv-array API. It does not add a
 * provider bridge tool yet; future shell/web tools can depend on this primitive.
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  statSync,
  appendFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  dirname,
  join,
  resolve,
} from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 256 * 1024;
const SANDBOX_UNAVAILABLE_REASON = 'sandbox-unavailable:no-verified-backend';
const SAFE_ENV_KEYS = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
]);

const DEFAULT_PATH = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
].filter((path) => existsSync(path)).join(':');

function realpathMaybe(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function existingPaths(paths) {
  const seen = new Set();
  const result = [];
  for (const path of paths) {
    if (!path || seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function shellCommandExists(command) {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function appendCapped(current, chunk, limit) {
  const text = chunk.toString('utf8');
  if (byteLength(current.data) >= limit) {
    current.truncated = current.truncated || text.length > 0;
    return;
  }
  const remaining = limit - byteLength(current.data);
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= remaining) {
    current.data += text;
    return;
  }
  current.data += buffer.subarray(0, remaining).toString('utf8');
  current.truncated = true;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function assertProjectRoot(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('sandboxExec requires opts.projectRoot');
  }
  const resolved = realpathMaybe(projectRoot);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`sandboxExec projectRoot does not exist: ${projectRoot}`);
  }
  return resolved;
}

function defaultTempDir(projectRoot) {
  return mkdtempSync(join(tmpdir(), 'hf-provider-sandbox-'));
}

export function buildSandboxEnv(inputEnv = process.env, opts = {}) {
  const projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : process.cwd();
  const tempDir = opts.tempDir || defaultTempDir(projectRoot);
  const env = {};

  for (const key of SAFE_ENV_KEYS) {
    const value = inputEnv[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }

  env.PATH = env.PATH || DEFAULT_PATH;
  env.LANG = env.LANG || 'C.UTF-8';
  env.HOME = tempDir;
  env.TMPDIR = tempDir;
  env.TEMP = tempDir;
  env.TMP = tempDir;
  env.PWD = projectRoot;
  env.SHELL = '/bin/sh';

  return env;
}

function protectedProjectPaths(projectRoot) {
  return [
    join(projectRoot, '.claude'),
    join(projectRoot, '.hive-flow', 'enforcement'),
  ];
}

function deniedSecretPaths(projectRoot, extraDeniedPaths = []) {
  const home = homedir();
  return existingPaths([
    home,
    join(home, '.ssh'),
    join(home, '.config'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    ...protectedProjectPaths(projectRoot),
    ...extraDeniedPaths,
  ]);
}

function executableReadAllowlist(argv, extraReadPaths = []) {
  const executable = argv[0];
  const executableReal = executable ? realpathMaybe(executable) : '';
  return existingPaths([
    executable,
    executableReal,
    executable ? dirname(executable) : '',
    executableReal ? dirname(executableReal) : '',
    ...extraReadPaths,
  ]);
}

function defaultReadAllowlist(argv, opts) {
  return existingPaths([
    '/bin',
    '/sbin',
    '/usr/bin',
    '/usr/sbin',
    '/usr/lib',
    '/System',
    '/Library',
    '/etc',
    '/dev',
    '/opt/homebrew/Cellar',
    '/opt/homebrew/opt',
    '/opt/homebrew/lib',
    '/opt/homebrew/bin',
    '/opt/homebrew/etc',
    '/opt/homebrew/share',
    opts.projectRoot,
    opts.tempDir,
    ...executableReadAllowlist(argv, opts.extraReadPaths || []),
  ]);
}

function seatbeltString(value) {
  return JSON.stringify(realpathMaybe(value));
}

function seatbeltLiteralString(value) {
  return JSON.stringify(resolve(value));
}

function parentLiteralPaths(paths) {
  const literals = new Set(['/']);
  for (const path of paths) {
    let current = resolve(path);
    while (current && current !== dirname(current)) {
      current = dirname(current);
      literals.add(current);
      if (current === '/') break;
    }
  }
  return [...literals].filter((path) => existsSync(path));
}

function macSeatbeltProfile(argv, opts) {
  const readPaths = defaultReadAllowlist(argv, opts);
  const parentLiterals = parentLiteralPaths(readPaths);
  const writePaths = existingPaths([opts.projectRoot, opts.tempDir]);
  const deniedPaths = deniedSecretPaths(opts.projectRoot, opts.extraDeniedPaths);
  const readRules = [
    ...parentLiterals.map((path) => `  (literal ${seatbeltLiteralString(path)})`),
    ...readPaths.map((path) => `  (subpath ${seatbeltString(path)})`),
  ].join('\n');
  const writeRules = writePaths.map((path) => `  (subpath ${seatbeltString(path)})`).join('\n');
  const denyReadRules = deniedPaths.map((path) => `  (subpath ${seatbeltString(path)})`).join('\n');
  const denyWriteRules = deniedPaths.map((path) => `  (subpath ${seatbeltString(path)})`).join('\n');

  return `(version 1)
(deny default)
(deny network*)
(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read*
${readRules}
)
(allow file-write*
${writeRules}
)
(deny file-read*
${denyReadRules}
)
(deny file-write*
${denyWriteRules}
)
`;
}

function sandboxExecCandidate() {
  return {
    name: 'sandbox-exec',
    available: process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'),
    unavailableReason: process.platform === 'darwin'
      ? 'sandbox-exec-not-found'
      : 'sandbox-exec-not-darwin',
    wrap(argv, opts) {
      const profilePath = join(opts.tempDir, 'sandbox.sb');
      writeFileSync(profilePath, macSeatbeltProfile(argv, opts), 'utf8');
      return {
        command: '/usr/bin/sandbox-exec',
        args: ['-f', profilePath, ...argv],
      };
    },
  };
}

function bwrapCandidate() {
  return {
    name: 'bwrap',
    available: process.platform === 'linux' && shellCommandExists('bwrap'),
    unavailableReason: process.platform === 'linux' ? 'bwrap-not-found' : 'bwrap-not-linux',
    wrap(argv, opts) {
      const readPaths = defaultReadAllowlist(argv, opts)
        .filter((path) => path !== opts.projectRoot && path !== opts.tempDir);
      const args = [
        '--die-with-parent',
        '--unshare-net',
        '--new-session',
        '--proc', '/proc',
        '--dev', '/dev',
        '--tmpfs', '/tmp',
        '--bind', opts.projectRoot, opts.projectRoot,
        '--bind', opts.tempDir, opts.tempDir,
        '--chdir', opts.projectRoot,
        '--setenv', 'HOME', opts.tempDir,
        '--setenv', 'TMPDIR', opts.tempDir,
        '--setenv', 'TEMP', opts.tempDir,
        '--setenv', 'TMP', opts.tempDir,
        '--setenv', 'PATH', opts.env.PATH || DEFAULT_PATH,
      ];
      for (const path of readPaths) {
        args.push('--ro-bind', path, path);
      }
      args.push(...argv);
      return { command: 'bwrap', args };
    },
  };
}

function dockerRootlessAvailable() {
  if (!shellCommandExists('docker')) return false;
  try {
    const info = execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    return /rootless/i.test(info);
  } catch {
    return false;
  }
}

function containerCandidate(opts = {}) {
  const rootless = dockerRootlessAvailable();
  return {
    name: 'container',
    available: Boolean(opts.containerImage && rootless),
    unavailableReason: opts.containerImage
      ? 'container-unavailable:rootless-docker-required'
      : 'container-unavailable:image-required',
    wrap(argv, runOpts) {
      const image = runOpts.containerImage || opts.containerImage;
      return {
        command: 'docker',
        args: [
          'run',
          '--rm',
          '--network', 'none',
          '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges',
          '--read-only',
          '--pids-limit', '128',
          '--user', '65534:65534',
          '--volume', `${runOpts.projectRoot}:${runOpts.projectRoot}`,
          '--volume', `${runOpts.tempDir}:${runOpts.tempDir}`,
          '--workdir', runOpts.projectRoot,
          '--env', `HOME=${runOpts.tempDir}`,
          '--env', `TMPDIR=${runOpts.tempDir}`,
          image,
          ...argv,
        ],
      };
    },
  };
}

function defaultCandidates(opts = {}) {
  return [
    sandboxExecCandidate(),
    bwrapCandidate(),
    containerCandidate(opts),
  ];
}

function candidatesForOrder(backendOrder, opts) {
  const candidates = Array.isArray(opts.__testCandidates)
    ? opts.__testCandidates
    : defaultCandidates(opts);
  if (backendOrder === undefined || backendOrder === null) return candidates;
  const names = Array.isArray(backendOrder) ? backendOrder : [backendOrder];
  return names.flatMap((name) => candidates.filter((candidate) => candidate.name === name));
}

function normalizeArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('sandboxExec requires a non-empty argv array');
  }
  return argv.map((arg) => String(arg));
}

async function runWrapped(candidate, argv, opts) {
  const wrapped = candidate.wrap(argv, opts);
  return runCommand(wrapped.command, wrapped.args, opts);
}

function runCommand(command, args, opts) {
  return new Promise((resolveRun) => {
    const stdout = { data: '', truncated: false };
    const stderr = { data: '', truncated: false };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let child;
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveRun(result);
    };

    try {
      child = spawn(command, args, {
        cwd: opts.projectRoot,
        env: opts.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        ok: false,
        status: 'error',
        error: err.message || String(err),
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => appendCapped(stdout, chunk, opts.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES));
    child.stderr.on('data', (chunk) => appendCapped(stderr, chunk, opts.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES));
    child.once('error', (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        status: 'error',
        error: err.message || String(err),
        stdout: stdout.data,
        stderr: stderr.data,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      finish({
        ok: !timedOut && code === 0,
        status: timedOut ? 'timeout' : (code === 0 ? 'success' : 'error'),
        code,
        signal,
        stdout: stdout.data,
        stderr: stderr.data,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

function parseProbeOutput(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const last = lines[lines.length - 1] || '{}';
  return JSON.parse(last);
}

async function probeCandidate(candidate, opts) {
  const probeRoot = opts.projectRoot;
  const outsideRoot = mkdtempSync(join(tmpdir(), 'hf-provider-sandbox-probe-outside-'));
  const outsideWrite = join(outsideRoot, 'outside-write.txt');
  const probeId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const protectedRead = join(probeRoot, '.claude', `sandbox-probe-secret-${probeId}.txt`);
  const protectedWrite = join(probeRoot, '.hive-flow', 'enforcement', `sandbox-probe-state-${probeId}.json`);
  const probeScript = join(probeRoot, 'sandbox-probe.mjs');
  const insideWrite = join(probeRoot, 'sandbox-probe-inside.txt');

  ensureDir(dirname(protectedRead));
  ensureDir(dirname(protectedWrite));
  writeFileSync(protectedRead, 'secret\n', 'utf8');
  writeFileSync(protectedWrite, '{"protected":true}\n', 'utf8');
  writeFileSync(probeScript, `
    import { readFileSync, writeFileSync } from 'node:fs';
    import net from 'node:net';
    const [outsideWrite, protectedRead, protectedWrite, insideWrite] = process.argv.slice(2);
    const result = {};
    const mark = (key, fn) => {
      try { fn(); result[key] = 'allowed'; } catch (err) { result[key] = 'blocked:' + (err.code || err.name || 'error'); }
    };
    mark('outsideWrite', () => writeFileSync(outsideWrite, 'bad', 'utf8'));
    mark('protectedRead', () => readFileSync(protectedRead, 'utf8'));
    mark('protectedWrite', () => writeFileSync(protectedWrite, 'bad', 'utf8'));
    mark('insideWrite', () => writeFileSync(insideWrite, 'ok', 'utf8'));
    await new Promise((resolve) => {
      const socket = net.connect({ host: '198.51.100.1', port: 9 });
      const done = (value) => {
        if (!result.network) result.network = value;
        socket.destroy();
        resolve();
      };
      socket.once('connect', () => done('allowed'));
      socket.once('error', (err) => done('blocked:' + (err.code || err.name || 'error')));
      socket.setTimeout(350, () => done('blocked:timeout'));
    });
    console.log(JSON.stringify(result));
  `, 'utf8');

  try {
    const result = await runWrapped(candidate, [
      process.execPath,
      probeScript,
      outsideWrite,
      protectedRead,
      protectedWrite,
      insideWrite,
    ], {
      ...opts,
      timeoutMs: opts.timeoutMs ?? 2500,
      stdoutLimitBytes: 8192,
      stderrLimitBytes: 8192,
    });

    if (!result.ok) {
      return {
        verified: false,
        backend: candidate.name,
        reason: 'probe-execution-failed',
        result,
      };
    }

    const probes = parseProbeOutput(result.stdout);
    const normalized = {
      writeOutsideBlocked: String(probes.outsideWrite || '').startsWith('blocked:') && !existsSync(outsideWrite),
      protectedReadBlocked: String(probes.protectedRead || '').startsWith('blocked:'),
      protectedWriteBlocked: String(probes.protectedWrite || '').startsWith('blocked:'),
      networkBlocked: String(probes.network || '').startsWith('blocked:'),
      insideWriteAllowed: probes.insideWrite === 'allowed' && existsSync(insideWrite),
    };
    const verified = normalized.writeOutsideBlocked
      && normalized.protectedReadBlocked
      && normalized.protectedWriteBlocked
      && normalized.networkBlocked
      && normalized.insideWriteAllowed;

    return {
      verified,
      backend: candidate.name,
      reason: verified ? null : 'probe-isolation-failed',
      probes: normalized,
      rawProbes: probes,
    };
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(protectedRead, { force: true });
    rmSync(protectedWrite, { force: true });
    rmSync(probeScript, { force: true });
    rmSync(insideWrite, { force: true });
  }
}

function availabilityRecord(candidate) {
  return {
    backend: candidate.name,
    available: Boolean(candidate.available),
    unavailableReason: candidate.available ? null : candidate.unavailableReason,
  };
}

async function findVerifiedBackend(opts) {
  const candidates = candidatesForOrder(opts.backendOrder, opts);
  const availability = candidates.map(availabilityRecord);
  const probeResults = [];
  const probeFn = typeof opts.__testProbeCandidate === 'function'
    ? opts.__testProbeCandidate
    : probeCandidate;
  const maxProbeAttempts = Math.max(1, Math.min(3, Number.parseInt(String(opts.probeAttempts ?? '3'), 10) || 1));

  for (const candidate of candidates) {
    if (!candidate.available) continue;
    for (let attempt = 1; attempt <= maxProbeAttempts; attempt += 1) {
      const probe = await probeFn(candidate, opts);
      probeResults.push({ attempt, ...probe });
      if (probe.verified) {
        return {
          candidate,
          diagnostics: {
            reason: null,
            verifiedBackend: candidate.name,
            availability,
            probes: probe,
            probeAttempts: attempt,
            probeHistory: probeResults,
          },
        };
      }
    }
  }

  return {
    candidate: null,
    diagnostics: {
      reason: SANDBOX_UNAVAILABLE_REASON,
      verifiedBackend: null,
      availability,
      probes: probeResults,
      probeAttempts: maxProbeAttempts,
    },
  };
}

export const __sandboxRunnerTestHooks = {
  findVerifiedBackend,
};

export async function probeSandboxBackend(options = {}) {
  const projectRoot = assertProjectRoot(options.projectRoot || process.cwd());
  const tempDir = ensureDir(options.tempDir || defaultTempDir(projectRoot));
  const env = buildSandboxEnv(process.env, { projectRoot, tempDir });

  try {
    const selected = await findVerifiedBackend({
      ...options,
      projectRoot,
      tempDir,
      env,
    });
    if (!selected.candidate) {
      return {
        verified: false,
        backend: null,
        reason: SANDBOX_UNAVAILABLE_REASON,
        diagnostics: selected.diagnostics,
      };
    }
    return {
      verified: true,
      backend: selected.candidate.name,
      probes: selected.diagnostics.probes.probes,
      diagnostics: selected.diagnostics,
    };
  } finally {
    if (!options.tempDir && !options.keepTemp) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function logSandboxResult(projectRoot, record) {
  try {
    const logDir = join(projectRoot, '.hive-flow', 'logs');
    ensureDir(logDir);
    appendFileSync(
      join(logDir, 'provider-sandbox.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`,
      'utf8',
    );
  } catch {
    // Diagnostics are returned to callers; logging is best-effort.
  }
}

export async function sandboxExec(argv, options = {}) {
  const normalizedArgv = normalizeArgv(argv);
  const projectRoot = assertProjectRoot(options.projectRoot || process.cwd());
  const tempDir = ensureDir(options.tempDir || defaultTempDir(projectRoot));
  const env = buildSandboxEnv({ ...process.env, ...(options.env || {}) }, { projectRoot, tempDir });

  try {
    const selected = await findVerifiedBackend({
      ...options,
      projectRoot,
      tempDir,
      env,
      stdoutLimitBytes: 8192,
      stderrLimitBytes: 8192,
    });

    if (!selected.candidate) {
      const denied = {
        ok: false,
        status: 'denied',
        denyReason: SANDBOX_UNAVAILABLE_REASON,
        backend: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        diagnostics: selected.diagnostics,
      };
      logSandboxResult(projectRoot, {
        status: denied.status,
        denyReason: denied.denyReason,
        diagnostics: denied.diagnostics,
      });
      return denied;
    }

    const result = await runWrapped(selected.candidate, normalizedArgv, {
      ...options,
      projectRoot,
      tempDir,
      env,
    });
    const enriched = {
      ...result,
      backend: selected.candidate.name,
      diagnostics: selected.diagnostics,
    };
    logSandboxResult(projectRoot, {
      status: enriched.status,
      backend: enriched.backend,
      code: enriched.code,
      signal: enriched.signal,
      diagnostics: enriched.diagnostics,
    });
    return enriched;
  } finally {
    if (!options.tempDir && !options.keepTemp) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
