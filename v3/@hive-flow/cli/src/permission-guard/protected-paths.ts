import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export type ProtectedPathScope = 'global' | 'project';

export interface ProjectRootResolutionOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  fallbackRoot?: string;
}

export interface ProtectedPathPolicy {
  protectedWrite: string[];
  protectedWriteGlobal: string[];
  protectedRead: string[];
  hmacKeyPath: string;
  signedStateNames: string[];
  devOverrideFloor: string[];
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
    '.claude/helpers/',
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
};

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
  return target === pattern;
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

export function sanitizeScopeId(id: unknown, fallback = '', maxLen = 64): string {
  if (typeof id !== 'string' || !id.trim()) return fallback;
  const sanitized = id.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, maxLen);
  return sanitized || fallback;
}
