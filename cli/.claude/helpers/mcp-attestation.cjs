#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
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
      };
    }
  }
  return null;
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

module.exports = {
  MCP_ATTESTATION_PATH_ENV,
  MCP_ATTESTATION_TOKEN_ENV,
  mintMCPAttestation,
  resolveProjectRootForMCPAttestation,
};
