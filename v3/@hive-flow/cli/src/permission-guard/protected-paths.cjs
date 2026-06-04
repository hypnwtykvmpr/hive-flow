const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_POLICY = {
  protectedWrite: [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/helpers/',
    '.env',
    '.git/',
    '.git/info/exclude',
    '.hive-flow/enforcement/',
    '.hive-flow/workflows/',
    'v3/@hive-flow/cli/src/permission-guard/',
    'v3/@hive-flow/cli/dist/src/permission-guard/',
    'v3/@hive-flow/cli/dist/src/mcp-tools/',
    '${HOME}/.hive-flow/permission-guard/',
    'scripts/permission-guard-setup.mjs',
  ],
  protectedWriteGlobal: [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/helpers/',
    '.env',
    '.git/',
    '.hive-flow/enforcement/',
    'v3/@hive-flow/cli/src/permission-guard/',
    'v3/@hive-flow/cli/dist/src/permission-guard/',
    'v3/@hive-flow/cli/dist/src/mcp-tools/',
    'scripts/permission-guard-setup.mjs',
  ],
  protectedRead: [
    '.hive-flow/enforcement/',
    '.env',
    '.claude/settings.json',
    '.claude/settings.local.json',
  ],
  hmacKeyPath: '.hive-flow/enforcement/.hmac-key',
  signedStateNames: [
    'state.json',
    'role.json',
    'pipeline-state.json',
    'verification-gate.json',
    'dev-override.conf',
  ],
  devOverrideFloor: [
    '.hive-flow/enforcement/',
    '.claude/helpers/enforcement.cjs',
    '.claude/helpers/role-enforcement.cjs',
    '.claude/helpers/hook-handler.cjs',
  ],
  guardedSettings: [
    '.claude/settings.json',
    '.claude/settings.local.json',
  ],
};

const DEV_OVERRIDE_TOKEN_ENV = 'HIVE_FLOW_DEV_OVERRIDE_TOKEN';
const DEV_OVERRIDE_TOKEN_KIND = 'hive-flow-dev-override-root';
const MAX_DEV_OVERRIDE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

let cachedPolicy = null;

function policyCandidates() {
  return [
    path.resolve(__dirname, 'protected-paths.policy.json'),
    path.resolve(__dirname, '..', '..', '..', 'src', 'permission-guard', 'protected-paths.policy.json'),
    path.resolve(process.cwd(), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.policy.json'),
  ];
}

function coerceStringArray(value, fallback) {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? value
    : fallback;
}

function loadPolicy(policyPath) {
  if (!policyPath && cachedPolicy) return cachedPolicy;
  const candidates = policyPath ? [policyPath] : policyCandidates();
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const policy = {
        protectedWrite: coerceStringArray(raw.protectedWrite, DEFAULT_POLICY.protectedWrite),
        protectedWriteGlobal: coerceStringArray(raw.protectedWriteGlobal, DEFAULT_POLICY.protectedWriteGlobal),
        protectedRead: coerceStringArray(raw.protectedRead, DEFAULT_POLICY.protectedRead),
        hmacKeyPath: typeof raw.hmacKeyPath === 'string' ? raw.hmacKeyPath : DEFAULT_POLICY.hmacKeyPath,
        signedStateNames: coerceStringArray(raw.signedStateNames, DEFAULT_POLICY.signedStateNames),
        devOverrideFloor: coerceStringArray(raw.devOverrideFloor, DEFAULT_POLICY.devOverrideFloor),
        guardedSettings: coerceStringArray(raw.guardedSettings, DEFAULT_POLICY.guardedSettings),
      };
      if (!policyPath) cachedPolicy = policy;
      return policy;
    } catch {
      // Try the next candidate, then fall back to the embedded policy.
    }
  }
  return DEFAULT_POLICY;
}

function expandPolicyPath(entry, projectRoot) {
  const expanded = entry
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$\{PROJECT_ROOT\}/g, projectRoot)
    .replace(/\$\{CWD\}/g, projectRoot);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(projectRoot, expanded);
}

function casefoldPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

function resolveRealPathForPolicy(filePath, projectRoot) {
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const missingSegments = [];
    let current = absolute;

    while (true) {
      try {
        const linkTarget = fs.readlinkSync(current);
        const targetAbsolute = path.isAbsolute(linkTarget) ? linkTarget : path.resolve(path.dirname(current), linkTarget);
        return path.resolve(targetAbsolute, ...missingSegments.reverse());
      } catch {
        // Not a symlink at this segment; continue toward an existing ancestor.
      }

      try {
        return path.resolve(fs.realpathSync.native(current), ...missingSegments.reverse());
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return absolute;
        missingSegments.push(path.basename(current));
        current = parent;
      }
    }
  }
}

function normalizeProjectRootCandidate(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const absolute = path.resolve(candidate);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function resolveProjectRoot(options = {}) {
  const env = options.env || process.env;
  const candidates = [
    env.HIVE_FLOW_PROJECT_ROOT,
    env.CLAUDE_PROJECT_DIR,
    options.cwd,
    options.fallbackRoot,
  ];

  for (const candidate of candidates) {
    const resolved = normalizeProjectRootCandidate(candidate);
    if (resolved) return resolved;
  }

  return path.resolve(process.cwd());
}

function normalizeForPolicy(filePath, projectRoot) {
  return casefoldPath(resolveRealPathForPolicy(filePath, projectRoot));
}

function matchNormalized(target, pattern, entry) {
  if (entry.endsWith('/')) {
    const rel = path.relative(pattern, target);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(path.sep));
  }
  return target === pattern;
}

function targetCandidates(filePath, projectRoot) {
  const lexical = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
  const real = resolveRealPathForPolicy(filePath, projectRoot);
  return [...new Set([casefoldPath(lexical), casefoldPath(real)])];
}

function patternCandidates(entry, projectRoot) {
  const lexical = expandPolicyPath(entry, projectRoot);
  const real = resolveRealPathForPolicy(lexical, projectRoot);
  return [...new Set([casefoldPath(lexical), casefoldPath(real)])];
}

function findPolicyMatch(entries, filePath, projectRoot, globalEntries) {
  if (!filePath) return null;
  const targets = targetCandidates(filePath, projectRoot);
  for (const entry of entries) {
    const patterns = patternCandidates(entry, projectRoot);
    for (const target of targets) {
      for (const pattern of patterns) {
        if (matchNormalized(target, pattern, entry)) {
          return {
            entry,
            absolutePath: expandPolicyPath(entry, projectRoot),
            scope: globalEntries.has(entry) ? 'global' : 'project',
          };
        }
      }
    }
  }
  return null;
}

function getProtectedWritePaths(projectRoot, policy = loadPolicy()) {
  const globalEntries = new Set(policy.protectedWriteGlobal);
  return policy.protectedWrite.map(entry => ({
    entry,
    absolutePath: expandPolicyPath(entry, projectRoot),
    scope: globalEntries.has(entry) ? 'global' : 'project',
  }));
}

function findProtectedWritePath(filePath, projectRoot, policy = loadPolicy()) {
  return findPolicyMatch(policy.protectedWrite, filePath, projectRoot, new Set(policy.protectedWriteGlobal));
}

function isProtectedWritePath(filePath, projectRoot, policy = loadPolicy()) {
  return findProtectedWritePath(filePath, projectRoot, policy) !== null;
}

function getProtectedWriteScope(filePath, projectRoot, policy = loadPolicy()) {
  const match = findProtectedWritePath(filePath, projectRoot, policy);
  return match ? match.scope : null;
}

function getProtectedReadPaths(projectRoot, policy = loadPolicy()) {
  return policy.protectedRead.map(entry => ({
    entry,
    absolutePath: expandPolicyPath(entry, projectRoot),
    scope: 'global',
  }));
}

function findProtectedReadPath(filePath, projectRoot, policy = loadPolicy()) {
  return findPolicyMatch(policy.protectedRead, filePath, projectRoot, new Set(policy.protectedRead));
}

function isProtectedReadPath(filePath, projectRoot, policy = loadPolicy()) {
  return findProtectedReadPath(filePath, projectRoot, policy) !== null;
}

function isHmacKeyPath(filePath, projectRoot, policy = loadPolicy()) {
  if (!filePath) return false;
  const target = targetCandidates(filePath, projectRoot);
  const hmacPath = patternCandidates(policy.hmacKeyPath, projectRoot);
  return target.some(candidate => hmacPath.includes(candidate));
}

function isSignedStatePath(filePath, projectRoot, policy = loadPolicy()) {
  if (!filePath) return false;
  if (!isProtectedReadPath(filePath, projectRoot, policy) && !isProtectedWritePath(filePath, projectRoot, policy)) {
    return false;
  }
  return policy.signedStateNames.includes(path.basename(filePath));
}

function isDevOverrideFloorPath(filePath, projectRoot, policy = loadPolicy()) {
  return findPolicyMatch(policy.devOverrideFloor, filePath, projectRoot, new Set(policy.devOverrideFloor)) !== null;
}

function isGuardedSettingsPath(filePath, projectRoot, policy = loadPolicy()) {
  return findPolicyMatch(policy.guardedSettings, filePath, projectRoot, new Set(policy.guardedSettings)) !== null;
}

function readDevOverrideConfig(projectRoot) {
  try {
    const overridePath = path.resolve(projectRoot, '.hive-flow', 'enforcement', 'dev-override.conf');
    if (!fs.existsSync(overridePath)) return null;
    return fs.readFileSync(overridePath, 'utf8');
  } catch {
    return null;
  }
}

function isDevOverrideActive(projectRoot) {
  const raw = readDevOverrideConfig(projectRoot);
  if (!raw) return false;
  return raw.split(/\r?\n/).some(line => line.trim() === 'HIVE_FLOW_DEV_OVERRIDE=on');
}

function readDevOverrideConfigToken(projectRoot) {
  const raw = readDevOverrideConfig(projectRoot);
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${DEV_OVERRIDE_TOKEN_ENV}=`)) {
      const token = trimmed.slice(DEV_OVERRIDE_TOKEN_ENV.length + 1).trim();
      return token || null;
    }
  }
  return null;
}

function hasSubagentIdentity(input = null, env = process.env) {
  if (env.CLAUDE_PARENT_AGENT_ID) return true;
  if (env.AGENTIC_FLOW_AGENT_ID || env.CLAUDE_AGENT_ID) return true;
  const hookAgentId = (input && (input.agent_id || input.agentId)) || '';
  return typeof hookAgentId === 'string' && hookAgentId.trim().length > 0;
}

function readHmacKey(projectRoot) {
  try {
    const key = fs.readFileSync(path.resolve(projectRoot, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

function verifyDevOverrideTokenHmac(body, signature, hmacKeyProvider) {
  if (!body || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const key = hmacKeyProvider();
  if (!key) return false;
  const expected = crypto.createHmac('sha256', key).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function parseDevOverrideRootToken(token, hmacKeyProvider) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  if (!verifyDevOverrideTokenHmac(body, signature, hmacKeyProvider)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function verifyDevOverrideRootToken(options) {
  const env = options.env || process.env;
  const nowMs = options.nowMs == null ? Date.now() : options.nowMs;
  if (options.hasSubagentIdentity === true || hasSubagentIdentity(options.input || null, env)) return false;

  const hmacKeyProvider = options.hmacKeyProvider || (() => readHmacKey(options.projectRoot));
  const token = options.rootToken
    || env[DEV_OVERRIDE_TOKEN_ENV]
    || readDevOverrideConfigToken(options.projectRoot)
    || null;
  const payload = parseDevOverrideRootToken(token, hmacKeyProvider);
  if (!payload) return false;

  if (payload.kind !== DEV_OVERRIDE_TOKEN_KIND) return false;
  if (typeof payload.projectDir !== 'string') return false;
  if (casefoldPath(resolveRealPathForPolicy(payload.projectDir, payload.projectDir)) !== casefoldPath(resolveRealPathForPolicy(options.projectRoot, options.projectRoot))) {
    return false;
  }

  const issuedAt = Number(payload.issuedAt);
  const expiresAt = Number(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return false;
  if (issuedAt > nowMs + 5 * 60 * 1000) return false;
  if (expiresAt <= nowMs) return false;
  if (expiresAt - issuedAt > MAX_DEV_OVERRIDE_TOKEN_TTL_MS) return false;

  if (typeof payload.nonce !== 'string' || payload.nonce.length < 8 || payload.nonce.length > 128) return false;
  return true;
}

function sanitizeScopeId(id, fallback = '', maxLen = 64) {
  if (typeof id !== 'string' || !id.trim()) return fallback;
  const sanitized = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, maxLen);
  return sanitized || fallback;
}

module.exports = {
  loadPolicy,
  expandPolicyPath,
  casefoldPath,
  resolveRealPathForPolicy,
  resolveProjectRoot,
  normalizeForPolicy,
  getProtectedWritePaths,
  findProtectedWritePath,
  isProtectedWritePath,
  getProtectedWriteScope,
  getProtectedReadPaths,
  findProtectedReadPath,
  isProtectedReadPath,
  isHmacKeyPath,
  isSignedStatePath,
  isDevOverrideFloorPath,
  isGuardedSettingsPath,
  readDevOverrideConfig,
  isDevOverrideActive,
  readDevOverrideConfigToken,
  hasSubagentIdentity,
  parseDevOverrideRootToken,
  verifyDevOverrideRootToken,
  sanitizeScopeId,
};
