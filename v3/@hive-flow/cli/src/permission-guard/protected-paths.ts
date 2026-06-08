import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type ProtectedPathScope = 'global' | 'project';

export interface ProjectRootResolutionOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  fallbackRoot?: string;
}

export interface DevOverrideVerifyOptions {
  input?: Record<string, unknown> | null;
  projectRoot: string;
  nowMs?: number;
  env?: Record<string, string | undefined>;
  rootToken?: string | null;
  hasSubagentIdentity?: boolean;
  hmacKeyProvider?: () => string | null;
}

export interface ProtectedPathPolicy {
  protectedWrite: string[];
  protectedWriteGlobal: string[];
  protectedRead: string[];
  hmacKeyPath: string;
  signedStateNames: string[];
  devOverrideFloor: string[];
  guardedSettings: string[];
}

export interface ProtectedPathMatch {
  entry: string;
  absolutePath: string;
  scope: ProtectedPathScope;
}

const DEFAULT_POLICY: ProtectedPathPolicy = {
  protectedWrite: [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '${HOME}/.claude/settings.json',
    '${HOME}/.claude/settings.local.json',
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
    '${HOME}/.hive-flow/enforcement/bin/',
    '${HOME}/.hive-flow/credential-vault*',
    '${HOME}/.hive-flow/credentials*',
    '${HOME}/.hive-flow/run/credential-agent.sock',
    'scripts/permission-guard-setup.mjs',
    'scripts/install-enforcement.mjs',
  ],
  protectedWriteGlobal: [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '${HOME}/.claude/settings.json',
    '${HOME}/.claude/settings.local.json',
    '.claude/helpers/',
    '.env',
    '.git/',
    '.hive-flow/enforcement/',
    'v3/@hive-flow/cli/src/permission-guard/',
    'v3/@hive-flow/cli/dist/src/permission-guard/',
    'v3/@hive-flow/cli/dist/src/mcp-tools/',
    '${HOME}/.hive-flow/enforcement/bin/',
    '${HOME}/.hive-flow/credential-vault*',
    '${HOME}/.hive-flow/credentials*',
    '${HOME}/.hive-flow/run/credential-agent.sock',
    'scripts/permission-guard-setup.mjs',
    'scripts/install-enforcement.mjs',
  ],
  protectedRead: [
    '.hive-flow/enforcement/',
    '.env',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '${HOME}/.hive-flow/credential-vault*',
    '${HOME}/.hive-flow/credentials*',
    '${HOME}/.hive-flow/run/credential-agent.sock',
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
    '${HOME}/.claude/settings.json',
    '${HOME}/.claude/settings.local.json',
  ],
};

export const DEV_OVERRIDE_TOKEN_ENV = 'HIVE_FLOW_DEV_OVERRIDE_TOKEN';
export const DEV_OVERRIDE_TOKEN_KIND = 'hive-flow-dev-override-root';
export const DEV_OVERRIDE_TOKEN_VERSION = 1;
export const MAX_DEV_OVERRIDE_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

let cachedPolicy: ProtectedPathPolicy | null = null;

function policyCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, 'protected-paths.policy.json'),
    resolve(here, '..', '..', '..', 'src', 'permission-guard', 'protected-paths.policy.json'),
    resolve(process.cwd(), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.policy.json'),
  ];
}

function coerceStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? value
    : fallback;
}

export function loadPolicy(policyPath?: string): ProtectedPathPolicy {
  if (!policyPath && cachedPolicy) return cachedPolicy;
  const candidates = policyPath ? [policyPath] : policyCandidates();
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as Partial<ProtectedPathPolicy>;
      const policy: ProtectedPathPolicy = {
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

export function expandPolicyPath(entry: string, projectRoot: string): string {
  const expanded = entry
    .replace(/\$\{HOME\}/g, homedir())
    .replace(/\$\{PROJECT_ROOT\}/g, projectRoot)
    .replace(/\$\{CWD\}/g, projectRoot);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(projectRoot, expanded);
}

export function casefoldPath(filePath: string): string {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

export function resolveRealPathForPolicy(filePath: string, projectRoot: string): string {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(projectRoot, filePath);
  try {
    return realpathSync.native(absolute);
  } catch {
    const missingSegments: string[] = [];
    let current = absolute;

    while (true) {
      try {
        const linkTarget = readlinkSync(current);
        const targetAbsolute = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(current), linkTarget);
        return resolve(targetAbsolute, ...missingSegments.reverse());
      } catch {
        // Not a symlink at this segment; continue toward an existing ancestor.
      }

      try {
        return resolve(realpathSync.native(current), ...missingSegments.reverse());
      } catch {
        const parent = dirname(current);
        if (parent === current) return absolute;
        missingSegments.push(basename(current));
        current = parent;
      }
    }
  }
}

function normalizeProjectRootCandidate(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const absolute = resolve(candidate);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function resolveProjectRoot(options: ProjectRootResolutionOptions = {}): string {
  const env = options.env ?? process.env;
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

  return resolve(process.cwd());
}

export function normalizeForPolicy(filePath: string, projectRoot: string): string {
  return casefoldPath(resolveRealPathForPolicy(filePath, projectRoot));
}

function matchNormalized(target: string, pattern: string, entry: string): boolean {
  if (entry.endsWith('/')) {
    const rel = relative(pattern, target);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
  }
  if (entry.includes('*')) {
    return globPatternToRegExp(pattern).test(target);
  }
  return target === pattern;
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

function targetCandidates(filePath: string, projectRoot: string): string[] {
  const lexical = isAbsolute(filePath) ? resolve(filePath) : resolve(projectRoot, filePath);
  const real = resolveRealPathForPolicy(filePath, projectRoot);
  return [...new Set([casefoldPath(lexical), casefoldPath(real)])];
}

function patternCandidates(entry: string, projectRoot: string): string[] {
  const lexical = expandPolicyPath(entry, projectRoot);
  const real = resolveRealPathForPolicy(lexical, projectRoot);
  return [...new Set([casefoldPath(lexical), casefoldPath(real)])];
}

function findPolicyMatch(entries: string[], filePath: string, projectRoot: string, globalEntries: Set<string>): ProtectedPathMatch | null {
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

export function getProtectedWritePaths(projectRoot: string, policy = loadPolicy()): ProtectedPathMatch[] {
  const globalEntries = new Set(policy.protectedWriteGlobal);
  return policy.protectedWrite.map(entry => ({
    entry,
    absolutePath: expandPolicyPath(entry, projectRoot),
    scope: globalEntries.has(entry) ? 'global' as const : 'project' as const,
  }));
}

export function findProtectedWritePath(filePath: string, projectRoot: string, policy = loadPolicy()): ProtectedPathMatch | null {
  return findPolicyMatch(policy.protectedWrite, filePath, projectRoot, new Set(policy.protectedWriteGlobal));
}

export function isProtectedWritePath(filePath: string, projectRoot: string, policy = loadPolicy()): boolean {
  return findProtectedWritePath(filePath, projectRoot, policy) !== null;
}

export function getProtectedWriteScope(filePath: string, projectRoot: string, policy = loadPolicy()): ProtectedPathScope | null {
  return findProtectedWritePath(filePath, projectRoot, policy)?.scope ?? null;
}

export function getProtectedReadPaths(projectRoot: string, policy = loadPolicy()): ProtectedPathMatch[] {
  return policy.protectedRead.map(entry => ({
    entry,
    absolutePath: expandPolicyPath(entry, projectRoot),
    scope: 'global' as const,
  }));
}

export function findProtectedReadPath(filePath: string, projectRoot: string, policy = loadPolicy()): ProtectedPathMatch | null {
  return findPolicyMatch(policy.protectedRead, filePath, projectRoot, new Set(policy.protectedRead));
}

export function isProtectedReadPath(filePath: string, projectRoot: string, policy = loadPolicy()): boolean {
  return findProtectedReadPath(filePath, projectRoot, policy) !== null;
}

export function isHmacKeyPath(filePath: string, projectRoot: string, policy = loadPolicy()): boolean {
  if (!filePath) return false;
  const target = targetCandidates(filePath, projectRoot);
  const hmacPath = patternCandidates(policy.hmacKeyPath, projectRoot);
  return target.some(candidate => hmacPath.includes(candidate));
}

export function isSignedStatePath(filePath: string, projectRoot: string, policy = loadPolicy()): boolean {
  if (!filePath) return false;
  if (!isProtectedReadPath(filePath, projectRoot, policy) && !isProtectedWritePath(filePath, projectRoot, policy)) {
    return false;
  }
  return policy.signedStateNames.includes(basename(filePath));
}

export function isDevOverrideFloorPath(filePath: string, projectRoot: string, policy = loadPolicy()): boolean {
  return findPolicyMatch(policy.devOverrideFloor, filePath, projectRoot, new Set(policy.devOverrideFloor)) !== null;
}

export function isGuardedSettingsPath(filePath: string, projectRoot: string, policy = loadPolicy()): boolean {
  return findPolicyMatch(policy.guardedSettings, filePath, projectRoot, new Set(policy.guardedSettings)) !== null;
}

export function readDevOverrideConfig(projectRoot: string): string | null {
  try {
    const overridePath = resolve(projectRoot, '.hive-flow', 'enforcement', 'dev-override.conf');
    if (!existsSync(overridePath)) return null;
    return readFileSync(overridePath, 'utf8');
  } catch {
    return null;
  }
}

export function isDevOverrideActive(projectRoot: string): boolean {
  const raw = readDevOverrideConfig(projectRoot);
  if (!raw) return false;
  return raw.split(/\r?\n/).some(line => line.trim() === 'HIVE_FLOW_DEV_OVERRIDE=on');
}

export function readDevOverrideConfigToken(projectRoot: string): string | null {
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

export function hasSubagentIdentity(input: Record<string, unknown> | null = null, env: Record<string, string | undefined> = process.env): boolean {
  if (env.CLAUDE_PARENT_AGENT_ID) return true;
  if (env.AGENTIC_FLOW_AGENT_ID || env.CLAUDE_AGENT_ID) return true;
  const hookAgentId = input?.agent_id ?? input?.agentId;
  return typeof hookAgentId === 'string' && hookAgentId.trim().length > 0;
}

function readHmacKey(projectRoot: string): string | null {
  try {
    const key = readFileSync(resolve(projectRoot, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

export function devOverrideKeyIdForHmacKey(hmacKey: string | null | undefined): string | null {
  if (!hmacKey || typeof hmacKey !== 'string') return null;
  return createHash('sha256')
    .update('hive-flow-dev-override-key-id\0')
    .update(hmacKey)
    .digest('hex')
    .slice(0, 16);
}

function verifyDevOverrideTokenHmac(body: string, signature: string, hmacKeyProvider: () => string | null): boolean {
  if (!body || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const key = hmacKeyProvider();
  if (!key) return false;
  const expected = createHmac('sha256', key).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

export function parseDevOverrideRootToken(token: string | null | undefined, hmacKeyProvider: () => string | null): Record<string, unknown> | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  if (!verifyDevOverrideTokenHmac(body, signature, hmacKeyProvider)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function verifyDevOverrideRootToken(options: DevOverrideVerifyOptions): boolean {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  if (options.hasSubagentIdentity === true || hasSubagentIdentity(options.input ?? null, env)) return false;

  const hmacKeyProvider = options.hmacKeyProvider ?? (() => readHmacKey(options.projectRoot));
  const hmacKey = hmacKeyProvider();
  if (!hmacKey) return false;
  const token = options.rootToken
    ?? env[DEV_OVERRIDE_TOKEN_ENV]
    ?? readDevOverrideConfigToken(options.projectRoot)
    ?? null;
  const payload = parseDevOverrideRootToken(token, () => hmacKey);
  if (!payload) return false;

  if (payload.kind !== DEV_OVERRIDE_TOKEN_KIND) return false;
  if (payload.version !== DEV_OVERRIDE_TOKEN_VERSION) return false;
  if (payload.keyId !== devOverrideKeyIdForHmacKey(hmacKey)) return false;
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

export function sanitizeScopeId(id: unknown, fallback = '', maxLen = 64): string {
  if (typeof id !== 'string' || !id.trim()) return fallback;
  const sanitized = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, maxLen);
  return sanitized || fallback;
}
