#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeClientKind,
  operatorSessionEnvKeys,
  clientKindFromEnv,
  OPERATOR_CLIENT_KINDS,
} = require('./client-kind.cjs');
const { loadProtectedPathPolicyModule } = require('./layout-paths.cjs');

const MCP_ATTESTATION_VERSION = 1;
const MCP_ATTESTATION_PATH_ENV = 'HIVE_FLOW_MCP_ATTESTATION_PATH';
const MCP_ATTESTATION_TOKEN_ENV = 'HIVE_FLOW_MCP_ATTESTATION_TOKEN';
const MCP_ATTESTATION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const EPOCH_FILE = 'epoch.json';
const LOCK_STALE_MS = 30000;
const CODEX_PARENT_TEAM_ID = '2DC432GLL2';
const CODEX_PARENT_IDENTIFIER = 'codex';
const CODEX_PARENT_AUTHORITY = `Developer ID Application: OpenAI OpCo, LLC (${CODEX_PARENT_TEAM_ID})`;
const CODEX_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_ROLLOUT_HEAD_BYTES = 512 * 1024;
const CODEX_PARENT_RESOLUTION_TIMEOUT_MS = 5000;

// Codex intentionally scrubs the environment of MCP children. On Darwin, the
// managed launcher can still authenticate its direct parent by combining the
// parent process lifetime, OpenAI code signature, open executable descriptor,
// and exactly one project-bound root rollout descriptor. The evidence is read
// from the parent or filesystem rather than MCP arguments. Same-uid processes
// remain inside the local trust boundary, as they do for other attestation data.

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sleepSync(ms) {
  const array = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(array, 0, 0, ms);
}

function normalizePath(filePath) {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isGeneratedMcpSessionId(value) {
  return /^mcp-\d+-[a-z0-9]+$/i.test(String(value || '').trim());
}

function isRecognizedClientKind(kind) {
  return typeof kind === 'string' && OPERATOR_CLIENT_KINDS.includes(kind);
}

function protectedPathPolicy(options = {}) {
  return loadProtectedPathPolicyModule({
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
    helperDir: options.helperDir || __dirname,
  });
}

function resolveProjectRootForMCPAttestation(options = {}) {
  return normalizePath(protectedPathPolicy(options).resolveProjectRoot({
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
    fallbackRoot: options.projectRoot,
  }));
}

function findOperatorIdentity(env = process.env, options = {}) {
  const kind = clientKindFromEnv(env);
  if (!isRecognizedClientKind(kind)) return null;
  const explicitKind = normalizeClientKind(env.HIVE_FLOW_CLIENT_KIND);
  const keys = [
    ...operatorSessionEnvKeys(kind),
    ...(explicitKind === kind ? ['HIVE_FLOW_SESSION_ID'] : []),
  ];
  const sanitizeSessionId = protectedPathPolicy(options).sanitizeScopeId;
  for (const key of keys) {
    const raw = nonEmpty(env[key]);
    if (!raw || isGeneratedMcpSessionId(raw)) continue;
    const sanitized = sanitizeSessionId(raw, '', 64);
    if (sanitized) {
      return {
        ownerClientKind: kind,
        ownerSessionId: sanitized,
        sessionEnvKey: key,
        ownerSessionProvenance: 'environment',
      };
    }
  }
  return null;
}

function failure(code, error) {
  return { success: false, code, error };
}

function parseLsofRecords(raw) {
  if (typeof raw !== 'string') throw new Error('lsof output must be text');
  const records = [];
  let current = null;
  let currentFields = null;
  let sawProcess = false;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      if (sawProcess || current || !/^\d+$/.test(value)) {
        throw new Error('lsof process id is malformed or ambiguous');
      }
      sawProcess = true;
      continue;
    }
    if (field === 'f') {
      if (current) records.push(current);
      if (!/^(?:\d+|cwd|L\d+|err|jld|ltx|M[0-9a-f]{2}|m86|mem|mmap|pd|rtd|tr|txt|v86)$/i.test(value)) {
        throw new Error('lsof descriptor is malformed');
      }
      current = { fd: value };
      currentFields = new Set();
      continue;
    }
    if (!current) throw new Error('lsof field appeared before a descriptor');
    if (currentFields.has(field)) {
      throw new Error(`lsof field '${field}' is duplicated`);
    }
    currentFields.add(field);
    if (field === 'a') {
      if (!/^(?:r|w|u| )$/.test(value)) throw new Error('lsof access mode is malformed');
      current.access = value.trim() || null;
    } else if (field === 't') {
      if (!/^[A-Za-z0-9.]+$/.test(value)) throw new Error('lsof file type is malformed');
      current.type = value;
    } else if (field === 'D') {
      if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(value)) throw new Error('lsof device is malformed');
      current.device = value;
    } else if (field === 'i') {
      if (!/^\d+$/.test(value)) throw new Error('lsof inode is malformed');
      current.inode = value;
    } else if (field === 'n') {
      if (value.includes('\0')) throw new Error('lsof path is malformed');
      current.name = value;
    } else {
      throw new Error(`lsof field '${field}' is not accepted`);
    }
  }
  if (current) records.push(current);
  if (!sawProcess) throw new Error('lsof process id is missing');
  return records;
}

function parseCodesignDetails(raw) {
  if (typeof raw !== 'string') throw new Error('codesign output must be text');
  const identifiers = [];
  const teams = [];
  const authorities = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('Identifier=')) identifiers.push(line.slice('Identifier='.length));
    else if (line.startsWith('TeamIdentifier=')) teams.push(line.slice('TeamIdentifier='.length));
    else if (line.startsWith('Authority=')) authorities.push(line.slice('Authority='.length));
  }
  if (identifiers.length !== 1 || teams.length !== 1 || authorities.length < 1) {
    throw new Error('codesign identity fields are missing or ambiguous');
  }
  return {
    identifier: identifiers[0],
    teamIdentifier: teams[0],
    authorities,
  };
}

function sameProcessIdentity(before, after) {
  return before
    && after
    && before.pid === after.pid
    && before.uid === after.uid
    && before.startedAt === after.startedAt;
}

function trustedCodexSignature(signature) {
  return Boolean(
    signature
    && signature.valid === true
    && signature.identifier === CODEX_PARENT_IDENTIFIER
    && signature.teamIdentifier === CODEX_PARENT_TEAM_ID
    && Array.isArray(signature.authorities)
    && signature.authorities.includes(CODEX_PARENT_AUTHORITY)
  );
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function numericIdentity(value) {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function descriptorMatchesFile(descriptor, stat) {
  const device = numericIdentity(descriptor.device);
  const inode = numericIdentity(descriptor.inode);
  return device !== null
    && inode !== null
    && device === BigInt(stat.dev)
    && inode === BigInt(stat.ino);
}

function descriptorKey(descriptor) {
  return [
    descriptor.fd ?? '', descriptor.access ?? '', descriptor.type ?? '',
    descriptor.device ?? '', descriptor.inode ?? '', descriptor.name ?? '',
  ].join('\0');
}

function relevantDescriptorKeys(records, sessionsRoot) {
  return (records || [])
    .filter((record) => record && typeof record === 'object')
    .filter((record) => (
      record.fd === 'txt' && typeof record.name === 'string' && path.basename(record.name) === 'codex'
    ) || (
      typeof record.name === 'string'
      && isPathInside(record.name, sessionsRoot)
      && Boolean(rolloutIdFromFilename(record.name))
    ))
    .map(descriptorKey)
    .sort();
}

function sameDescriptors(before, after, sessionsRoot) {
  const left = relevantDescriptorKeys(before, sessionsRoot);
  const right = relevantDescriptorKeys(after, sessionsRoot);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function trustedDescriptorFile(descriptor, currentUid, requireExecutable = false, allowRootOwner = false) {
  if (!descriptor || descriptor.type !== 'REG' || typeof descriptor.name !== 'string') return null;
  let stat;
  let real;
  try {
    stat = fs.lstatSync(descriptor.name, { bigint: true });
    real = fs.realpathSync.native(descriptor.name);
  } catch {
    return null;
  }
  const trustedOwner = stat.uid === BigInt(currentUid) || (allowRootOwner && stat.uid === 0n);
  if (!stat.isFile() || stat.isSymbolicLink() || !trustedOwner || (stat.mode & 0o022n) !== 0n) return null;
  if (requireExecutable && (stat.mode & 0o111n) === 0n) return null;
  if (real !== descriptor.name || !descriptorMatchesFile(descriptor, stat)) return null;
  return stat;
}

function rolloutIdFromFilename(filePath) {
  const match = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path.basename(filePath));
  return match ? match[1] : null;
}

function parseRootCodexSession(raw, filePath, projectRoot) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_ROLLOUT_HEAD_BYTES) return null;
  const newline = raw.indexOf('\n');
  const firstLine = newline >= 0 ? raw.slice(0, newline) : raw;
  let record;
  try {
    record = JSON.parse(firstLine);
  } catch {
    return null;
  }
  const payload = record && record.type === 'session_meta' && record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const id = nonEmpty(payload.id);
  if (!id || !CODEX_SESSION_UUID.test(id) || rolloutIdFromFilename(filePath) !== id) return null;
  if (payload.originator !== 'codex-tui' || payload.thread_source !== 'user') return null;
  if (payload.source !== 'cli' || payload.model_provider !== 'openai') return null;
  if (nonEmpty(payload.parent_thread_id) || nonEmpty(payload.session_id)) return null;
  const cwd = nonEmpty(payload.cwd);
  if (!cwd || normalizePath(cwd) !== projectRoot) return null;
  return id;
}

function readFirstLineFromFd(fd) {
  const buffer = Buffer.alloc(MAX_ROLLOUT_HEAD_BYTES + 1);
  const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
  const newline = buffer.indexOf(0x0a, 0);
  if (newline < 0 || newline >= bytes || newline >= MAX_ROLLOUT_HEAD_BYTES) {
    throw new Error('rollout session metadata exceeds the read bound');
  }
  return buffer.subarray(0, newline + 1).toString('utf8');
}

function readTrustedRollout(descriptor, currentUid) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(descriptor.name, flags);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(currentUid) || (before.mode & 0o022n) !== 0n) {
      throw new Error('rollout descriptor owner or mode is untrusted');
    }
    if (!descriptorMatchesFile(descriptor, before)) throw new Error('rollout descriptor identity changed');
    const raw = readFirstLineFromFd(fd);
    const repeated = readFirstLineFromFd(fd);
    if (raw !== repeated) throw new Error('rollout session metadata changed while reading');
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('rollout descriptor changed while reading');
    }
    const pathStat = trustedDescriptorFile(descriptor, currentUid, false);
    if (!pathStat || pathStat.dev !== after.dev || pathStat.ino !== after.ino) {
      throw new Error('rollout path no longer names the open descriptor');
    }
    return raw;
  } finally {
    fs.closeSync(fd);
  }
}

function unsafeResolveCodexParentIdentityForTests(options = {}) {
  if (options.platform !== 'darwin') {
    return failure('codex-parent-platform-unsupported', 'Codex parent attestation is supported only on Darwin.');
  }
  if (!Number.isInteger(options.parentPid) || options.parentPid <= 1) {
    return failure('codex-parent-process-untrusted', 'The direct parent pid is invalid.');
  }
  if (!options.parentBefore
    || options.parentBefore.pid !== options.parentPid
    || options.parentBefore.uid !== options.currentUid) {
    return failure('codex-parent-process-untrusted', 'The direct parent process owner did not match the launcher.');
  }

  const executableDescriptors = Array.isArray(options.executableDescriptors)
    ? options.executableDescriptors.filter((record) => record
      && record.fd === 'txt'
      && typeof record.name === 'string'
      && path.basename(record.name) === 'codex')
    : [];
  const trustedExecutables = executableDescriptors.filter((descriptor) => (
    trustedDescriptorFile(descriptor, options.currentUid, true, true)
    && trustedCodexSignature(options.signatures.get(descriptor.name))
  ));
  if (trustedExecutables.length !== 1) {
    const code = executableDescriptors.length === 1
      && trustedCodexSignature(options.signatures.get(executableDescriptors[0].name))
      ? 'codex-parent-executable-untrusted'
      : 'codex-parent-signature-untrusted';
    return failure(code, 'The direct parent did not expose exactly one trusted Codex executable.');
  }

  const projectRoot = normalizePath(options.projectRoot);
  const sessionsRoot = normalizePath(options.sessionsRoot);
  const candidates = [];
  let untrustedDescriptors = 0;
  for (const descriptor of options.rolloutDescriptors || []) {
    if (!descriptor || typeof descriptor !== 'object') continue;
    if (typeof descriptor.name !== 'string' || !isPathInside(descriptor.name, sessionsRoot)) continue;
    if (!rolloutIdFromFilename(descriptor.name)) continue;
    if (descriptor.type !== 'REG' || descriptor.access !== 'u' || !/^\d+$/.test(String(descriptor.fd || ''))) {
      untrustedDescriptors += 1;
      continue;
    }
    let raw;
    try {
      raw = readTrustedRollout(descriptor, options.currentUid);
    } catch {
      untrustedDescriptors += 1;
      continue;
    }
    const id = parseRootCodexSession(raw, descriptor.name, projectRoot);
    if (id) candidates.push(id);
  }
  if (untrustedDescriptors > 0) {
    return failure('codex-parent-rollout-untrusted', 'An open Codex rollout descriptor did not match its path or file identity.');
  }
  if (candidates.length === 0) {
    return failure('codex-parent-session-missing', 'No open root Codex TUI session matched this project.');
  }
  if (candidates.length !== 1 || new Set(candidates).size !== 1) {
    return failure('codex-parent-session-ambiguous', 'More than one open root Codex TUI session matched this project.');
  }
  const signaturesAfter = options.readSignaturesAfter();
  if (!trustedCodexSignature(signaturesAfter.get(trustedExecutables[0].name))) {
    return failure('codex-parent-signature-changed', 'The Codex parent signature changed during attestation.');
  }
  const descriptorsBefore = [...executableDescriptors, ...(options.rolloutDescriptors || [])];
  const descriptorsAfter = options.readDescriptorsAfter();
  if (!sameDescriptors(descriptorsBefore, descriptorsAfter, sessionsRoot)) {
    return failure('codex-parent-descriptors-changed', 'The Codex parent descriptors changed during attestation.');
  }
  if (!trustedDescriptorFile(trustedExecutables[0], options.currentUid, true, true)) {
    return failure('codex-parent-executable-changed', 'The Codex parent executable path changed during attestation.');
  }
  const parentAfter = options.readParentAfter();
  if (!sameProcessIdentity(options.parentBefore, parentAfter)) {
    return failure('codex-parent-changed', 'The Codex parent identity changed during attestation.');
  }
  return {
    success: true,
    identity: {
      ownerClientKind: 'codex',
      ownerSessionId: candidates[0],
      sessionEnvKey: 'CODEX_THREAD_ID',
      ownerSessionProvenance: 'codex-parent-rollout',
    },
  };
}

function commandTimeout(deadline) {
  return Math.max(1, deadline - Date.now());
}

function runProcessIdentity(pid, deadline) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=', '-o', 'uid=', '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: commandTimeout(deadline),
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || result.signal || result.error) return null;
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(result.stdout || '');
  if (!match) return null;
  return { pid: Number(match[1]), uid: Number(match[2]), startedAt: match[3] };
}

function runLsof(pid, deadline) {
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-FfDiant'], {
    encoding: 'utf8',
    timeout: commandTimeout(deadline),
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (result.status !== 0 || result.signal || result.error) return null;
  try {
    return parseLsofRecords(result.stdout || '');
  } catch {
    return null;
  }
}

function readSignature(executable, deadline) {
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', executable], {
    encoding: 'utf8',
    timeout: commandTimeout(deadline),
    maxBuffer: 256 * 1024,
  });
  if (verified.status !== 0 || verified.signal || verified.error) return { valid: false };
  const described = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', executable], {
    encoding: 'utf8',
    timeout: commandTimeout(deadline),
    maxBuffer: 256 * 1024,
  });
  if (described.status !== 0 || described.signal || described.error) return { valid: false };
  try {
    return { valid: true, ...parseCodesignDetails(described.stderr || described.stdout || '') };
  } catch {
    return { valid: false };
  }
}

function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    return readFirstLineFromFd(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveCodexParentIdentity(projectRoot) {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    return failure('codex-parent-platform-unsupported', 'Codex parent attestation is supported only on Darwin.');
  }
  const deadline = Date.now() + CODEX_PARENT_RESOLUTION_TIMEOUT_MS;
  const parentPid = process.ppid;
  const parentBefore = runProcessIdentity(parentPid, deadline);
  const records = parentBefore ? runLsof(parentPid, deadline) : null;
  if (!parentBefore || !records) {
    return failure('codex-parent-process-untrusted', 'The direct parent process could not be inspected.');
  }
  const executableCandidates = records
    .filter((record) => record.fd === 'txt' && record.type === 'REG' && typeof record.name === 'string');
  const signatures = new Map();
  for (const executable of new Set(executableCandidates.map((record) => record.name).filter((value) => path.basename(value) === 'codex'))) {
    signatures.set(executable, readSignature(executable, deadline));
  }
  const sessionsRoot = normalizePath(path.join(os.homedir(), '.codex', 'sessions'));
  const rolloutDescriptors = records.filter((record) => (
    typeof record.name === 'string'
    && isPathInside(record.name, sessionsRoot)
    && Boolean(rolloutIdFromFilename(record.name))
  ));
  return unsafeResolveCodexParentIdentityForTests({
    platform: process.platform,
    parentPid,
    currentUid: process.getuid(),
    projectRoot,
    sessionsRoot,
    parentBefore,
    executableDescriptors: executableCandidates,
    signatures,
    rolloutDescriptors,
    readSignaturesAfter: () => {
      const after = new Map();
      for (const executable of signatures.keys()) after.set(executable, readSignature(executable, deadline));
      return after;
    },
    readDescriptorsAfter: () => runLsof(parentPid, deadline) || [],
    readParentAfter: () => runProcessIdentity(parentPid, deadline),
  });
}

function attestationDir(projectRoot) {
  return path.join(projectRoot, '.hive-flow', 'data', 'mcp-attestations');
}

function epochKeyFor(projectRoot, entrypoint, identity) {
  return sha256([
    normalizePath(projectRoot),
    entrypoint,
    identity.ownerClientKind,
    identity.ownerSessionId,
  ].join('\0')).slice(0, 32);
}

function readEpochState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { keys: {} };
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function withLock(dir, fn) {
  const lockDir = path.join(dir, '.epoch.lock');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      try {
        return fn();
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {}
      sleepSync(10);
    }
  }
  throw new Error(`Timed out waiting for MCP attestation epoch lock at ${lockDir}`);
}

function incrementEpoch(dir, key) {
  fs.mkdirSync(dir, { recursive: true });
  return withLock(dir, () => {
    const filePath = path.join(dir, EPOCH_FILE);
    const state = readEpochState(filePath);
    const keys = state.keys || {};
    const current = Number.isFinite(keys[key]) ? Math.trunc(keys[key]) : 0;
    const next = current + 1;
    keys[key] = next;
    writeJsonAtomic(filePath, { keys });
    return next;
  });
}

function contextFromRecord(record) {
  return {
    sessionId: record.ownerSessionId,
    clientKind: record.ownerClientKind,
    attested: true,
    attestationEntryPoint: record.entrypoint,
  };
}

function mintMCPAttestation(options = {}) {
  const env = options.env || process.env;
  const projectRoot = resolveProjectRootForMCPAttestation(options);
  const identity = findOperatorIdentity(env, options);
  if (!identity) {
    return {
      success: false,
      code: 'missing-operator',
      error: 'No non-generated operator session id and client kind were present in the MCP server environment.',
    };
  }

  return mintMCPAttestationForIdentity(options, projectRoot, identity);
}

function mintMCPAttestationForIdentity(options, projectRoot, identity) {
  const now = typeof options.now === 'function' ? options.now() : new Date();
  const ttlMs = Math.max(1, Math.min(options.ttlMs || MCP_ATTESTATION_MAX_TTL_MS, MCP_ATTESTATION_MAX_TTL_MS));
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const dir = attestationDir(projectRoot);
  const epochKey = epochKeyFor(projectRoot, options.entrypoint || 'bin/mcp-server.js', identity);
  const epoch = incrementEpoch(dir, epochKey);
  const record = {
    version: MCP_ATTESTATION_VERSION,
    projectRoot,
    entrypoint: options.entrypoint || 'bin/mcp-server.js',
    pidMode: options.pidMode || 'spawned-child',
    ownerClientKind: identity.ownerClientKind,
    ownerSessionId: identity.ownerSessionId,
    sessionEnvKey: identity.sessionEnvKey,
    ownerSessionProvenance: identity.ownerSessionProvenance || 'environment',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    epoch,
    tokenSha256: sha256(token),
  };

  if (record.pidMode === 'spawned-child') {
    record.launcherPid = options.launcherPid || process.pid;
    record.entrypointPath = normalizePath(options.entrypointPath);
  } else {
    record.mcpPid = options.mcpPid || process.pid;
  }

  const attestationPath = path.join(dir, `${epochKey}.${epoch}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.json`);
  writeJsonAtomic(attestationPath, record);

  const cleanup = () => {
    try {
      fs.rmSync(attestationPath, { force: true });
    } catch {}
  };
  return {
    success: true,
    record,
    context: contextFromRecord(record),
    attestationPath,
    token,
    envPatch: {
      [MCP_ATTESTATION_PATH_ENV]: attestationPath,
      [MCP_ATTESTATION_TOKEN_ENV]: token,
    },
    cleanup,
  };
}

function mintRuntimeMCPAttestation(entrypointPath) {
  const options = {
    entrypoint: 'bin/mcp-server.js',
    pidMode: 'spawned-child',
    launcherPid: process.pid,
    entrypointPath,
    env: process.env,
    cwd: process.cwd(),
    helperDir: __dirname,
  };
  const projectRoot = resolveProjectRootForMCPAttestation(options);
  const direct = findOperatorIdentity(process.env, options);
  if (direct) return mintMCPAttestationForIdentity(options, projectRoot, direct);
  const parent = resolveCodexParentIdentity(projectRoot);
  if (!parent.success) {
    return failure(
      'missing-operator',
      `No authenticated operator session was available (${parent.code}).`,
    );
  }
  return mintMCPAttestationForIdentity(options, projectRoot, parent.identity);
}

module.exports = {
  MCP_ATTESTATION_PATH_ENV,
  MCP_ATTESTATION_TOKEN_ENV,
  mintMCPAttestation,
  mintRuntimeMCPAttestation,
  parseCodesignDetails,
  parseLsofRecords,
  resolveProjectRootForMCPAttestation,
  unsafeReadRolloutHeadForTests: readHead,
  unsafeResolveCodexParentIdentityForTests,
  unsafeTrustedDescriptorFileForTests: trustedDescriptorFile,
};
