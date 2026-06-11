import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { casefoldPath } from './protected-paths.js';

export interface SecretPathPolicy {
  secretDirComponents: string[];
  secretBasenames: string[];
  secretBasenameGlobs: string[];
  secretPathGlobs: string[];
  secretExtensions: string[];
  allowExceptions: string[];
}

export const DEFAULT_SECRET_POLICY: SecretPathPolicy = {
  secretDirComponents: [
    '.ssh',
    '.aws',
    '.gnupg',
    '.gpg',
    'gcloud',
    '.config/gcloud',
    '.kube',
    '.docker',
    '.netrc-dir',
    'secrets',
    'secret',
    'credentials',
    '.credentials',
    'private-keys',
    '.private',
    '.age',
  ],
  secretBasenames: [
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    '.env',
    '.env.local',
    '.env.production',
    'credentials',
    '.netrc',
    '.pgpass',
    '.my.cnf',
    '.npmrc',
    '.pypirc',
    '.dockercfg',
    '.htpasswd',
    'shadow',
    '.git-credentials',
    '.aws/credentials',
    '.terraform/terraform.tfstate',
    'terraform.tfvars',
  ],
  secretBasenameGlobs: [
    '.env.*',
    '.env.*.local',
    'service-account*.json',
  ],
  secretPathGlobs: [
    '${HOME}/.hive-flow/credential-vault*',
    '${HOME}/.hive-flow/credentials*',
    '${HOME}/.hive-flow/run/credential-holder.sock',
  ],
  secretExtensions: [
    '.pem',
    '.key',
    '.pfx',
    '.p12',
    '.keystore',
    '.jks',
    '.asc',
    '.gpg',
    '.kdbx',
    '.ovpn',
    '.ppk',
  ],
  allowExceptions: [
    '*.pub',
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist',
  ],
};

let cachedSecretPolicy: SecretPathPolicy | null = null;
const HOME_HIVE_FLOW_POLICY_PREFIX = '${HOME}/.hive-flow';

function policyCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, 'secret-paths.policy.json'),
    resolve(here, '..', '..', '..', 'src', 'permission-guard', 'secret-paths.policy.json'),
    resolve(process.cwd(), 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'secret-paths.policy.json'),
  ];
}

function coerceStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
    ? value
    : fallback;
}

export function loadSecretPolicy(policyPath?: string): SecretPathPolicy {
  if (!policyPath && cachedSecretPolicy) return cachedSecretPolicy;
  const candidates = policyPath ? [policyPath] : policyCandidates();
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as Partial<SecretPathPolicy>;
      const policy: SecretPathPolicy = {
        secretDirComponents: coerceStringArray(raw.secretDirComponents, DEFAULT_SECRET_POLICY.secretDirComponents),
        secretBasenames: coerceStringArray(raw.secretBasenames, DEFAULT_SECRET_POLICY.secretBasenames),
        secretBasenameGlobs: coerceStringArray(raw.secretBasenameGlobs, DEFAULT_SECRET_POLICY.secretBasenameGlobs),
        secretPathGlobs: coerceStringArray(raw.secretPathGlobs, DEFAULT_SECRET_POLICY.secretPathGlobs),
        secretExtensions: coerceStringArray(raw.secretExtensions, DEFAULT_SECRET_POLICY.secretExtensions),
        allowExceptions: coerceStringArray(raw.allowExceptions, DEFAULT_SECRET_POLICY.allowExceptions),
      };
      if (!policyPath) cachedSecretPolicy = policy;
      return policy;
    } catch {
      // Try the next candidate, then fall back to the embedded secret policy.
    }
  }
  return DEFAULT_SECRET_POLICY;
}

function normalizeSecretPath(filePath: string): string {
  // casefoldPath handles lowercasing and backslash separators. JA-1 additionally
  // treats C0 controls and Unicode line/paragraph separators as path separators.
  const expanded = filePath
    .replace(/\$\{HOME\}/g, homedir())
    .replace(/^~(?=\/|\\|$)/, homedir());
  return casefoldPath(expanded).replace(/[\u0000-\u001F\u2028\u2029]/g, '/');
}

function resolveHiveFlowHomeOverride(): string | null {
  const raw = process.env.HIVE_FLOW_HOME;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return resolve(trimmed);
}

function isHomeHiveFlowPolicyEntry(entry: string): boolean {
  return entry === HOME_HIVE_FLOW_POLICY_PREFIX
    || entry.startsWith(`${HOME_HIVE_FLOW_POLICY_PREFIX}/`)
    || entry.startsWith(`${HOME_HIVE_FLOW_POLICY_PREFIX}\\`);
}

function expandSecretPolicyEntry(entry: string): string[] {
  const expanded = [entry];
  const hiveHome = resolveHiveFlowHomeOverride();
  if (hiveHome && isHomeHiveFlowPolicyEntry(entry)) {
    const suffix = entry.slice(HOME_HIVE_FLOW_POLICY_PREFIX.length).replace(/^[/\\]+/, '');
    expanded.push(suffix ? resolve(hiveHome, suffix) : hiveHome);
  }
  return [...new Set(expanded)];
}

function pathComponents(normalizedPath: string): string[] {
  return normalizedPath.split('/').filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globMatches(value: string, glob: string): boolean {
  const pattern = `^${escapeRegExp(glob).replace(/\\\*/g, '.*')}$`;
  return new RegExp(pattern).test(value);
}

function normalizedPolicyList(entries: string[]): string[] {
  return entries.flatMap(entry => expandSecretPolicyEntry(entry).map(expanded => normalizeSecretPath(expanded)));
}

function componentSequenceMatches(components: string[], policyEntry: string): boolean {
  const wanted = pathComponents(policyEntry);
  if (wanted.length === 0 || wanted.length > components.length) return false;
  for (let start = 0; start <= components.length - wanted.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (components[start + offset] !== wanted[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function trailingSequenceMatches(components: string[], policyEntry: string): boolean {
  const wanted = pathComponents(policyEntry);
  if (wanted.length === 0 || wanted.length > components.length) return false;
  const start = components.length - wanted.length;
  return wanted.every((entry, index) => components[start + index] === entry);
}

function isAllowedException(basename: string, policy: SecretPathPolicy): boolean {
  for (const exception of normalizedPolicyList(policy.allowExceptions)) {
    if (exception.includes('*')) {
      if (globMatches(basename, exception)) return true;
    } else if (basename === exception) {
      return true;
    }
  }
  return false;
}

export function isSecretPath(filePath: string, policy = loadSecretPolicy()): boolean {
  try {
    if (typeof filePath !== 'string' || filePath.length === 0) return true;
    const normalizedPath = normalizeSecretPath(filePath);
    const components = pathComponents(normalizedPath);
    if (components.length === 0) return true;
    const basename = components[components.length - 1];

    if (isAllowedException(basename, policy)) return false;

    for (const dirComponent of normalizedPolicyList(policy.secretDirComponents)) {
      if (componentSequenceMatches(components, dirComponent)) return true;
    }

    for (const secretBasename of normalizedPolicyList(policy.secretBasenames)) {
      if (secretBasename.includes('/')) {
        if (trailingSequenceMatches(components, secretBasename)) return true;
      } else if (basename === secretBasename) {
        return true;
      }
    }

    for (const secretGlob of normalizedPolicyList(policy.secretBasenameGlobs)) {
      if (globMatches(basename, secretGlob)) return true;
    }

    for (const secretPathGlob of normalizedPolicyList(policy.secretPathGlobs)) {
      if (globMatches(normalizedPath, secretPathGlob)) return true;
    }

    for (const extension of normalizedPolicyList(policy.secretExtensions)) {
      if (basename.endsWith(extension)) return true;
    }

    return false;
  } catch {
    return true;
  }
}
