import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  findProtectedReadPath,
  getProtectedWriteScope,
  isProtectedReadPath,
  isProtectedWritePath,
  loadPolicy,
} from '../protected-paths.js';
import {
  isSecretPath,
  loadSecretPolicy,
} from '../secret-paths.js';
import { evaluateSafety } from '../jury-evaluator.js';
import { evaluate } from '../gate.js';
import { mergeWithDefaults } from '../default-config.js';
import type { HookInput } from '../types.js';

const require = createRequire(import.meta.url);
const cjsPolicy = require('../protected-paths.cjs') as typeof import('../protected-paths.js');
const protectedPolicyJson = require('../protected-paths.policy.json') as ReturnType<typeof loadPolicy>;
const secretPolicyJson = require('../secret-paths.policy.json') as ReturnType<typeof loadSecretPolicy>;
const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..', '..');

const credentialProtectedEntries = [
  '${HOME}/.hive-flow/credential-vault*',
  '${HOME}/.hive-flow/credentials*',
  '${HOME}/.hive-flow/run/credential-holder.sock',
];

function bashInput(command: string): HookInput {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '/project',
  };
}

async function evalBash(command: string) {
  return evaluate(bashInput(command), mergeWithDefaults({
    log_file: join(tmpdir(), `hf-credential-vault-guard-${process.pid}-${Math.random()}.jsonl`),
  }));
}

describe('credential vault protected path parity', () => {
  it('registers home credential vault paths in TS, CJS, and policy JSON', () => {
    const policy = loadPolicy();
    for (const entry of credentialProtectedEntries) {
      expect(policy.protectedWrite).toContain(entry);
      expect(policy.protectedWriteGlobal).toContain(entry);
      expect(policy.protectedRead).toContain(entry);
      expect(protectedPolicyJson.protectedWrite).toContain(entry);
      expect(protectedPolicyJson.protectedWriteGlobal).toContain(entry);
      expect(protectedPolicyJson.protectedRead).toContain(entry);
    }
  });

  it('blocks home vault and socket paths for write and read in both TS and CJS matchers', () => {
    for (const target of [
      join(homedir(), '.hive-flow', 'credential-vault.json.gcm'),
      join(homedir(), '.hive-flow', 'credentials', 'providers.json'),
      join(homedir(), '.hive-flow', 'run', 'credential-holder.sock'),
    ]) {
      expect(isProtectedWritePath(target, repoRoot), target).toBe(true);
      expect(cjsPolicy.isProtectedWritePath(target, repoRoot), target).toBe(true);
      expect(isProtectedReadPath(target, repoRoot), target).toBe(true);
      expect(cjsPolicy.isProtectedReadPath(target, repoRoot), target).toBe(true);
      expect(getProtectedWriteScope(target, repoRoot), target).toBe('global');
      expect(cjsPolicy.getProtectedWriteScope(target, repoRoot), target).toBe('global');
      expect(findProtectedReadPath(target, repoRoot), target).not.toBeNull();
    }
  });
});

describe('credential vault secret path parity', () => {
  it('classifies credential vault files and sockets as secret paths', () => {
    for (const target of [
      '~/.hive-flow/credential-vault.json.gcm',
      '~/.hive-flow/credentials/openrouter.json',
      '~/.hive-flow/run/credential-holder.sock',
    ]) {
      expect(isSecretPath(target), target).toBe(true);
    }
    expect(secretPolicyJson.secretPathGlobs).toContain('${HOME}/.hive-flow/credential-vault*');
    expect(secretPolicyJson.secretPathGlobs).toContain('${HOME}/.hive-flow/credentials*');
    expect(secretPolicyJson.secretPathGlobs).toContain('${HOME}/.hive-flow/run/credential-holder.sock');
  });

  it('does not classify repo credential source or guard test filenames as secret paths', () => {
    for (const target of [
      'v3/@hive-flow/cli/src/credential-store/vault.ts',
      'v3/@hive-flow/cli/src/credential-store/__tests__/vault.test.ts',
      'v3/@hive-flow/cli/src/permission-guard/__tests__/credential-vault-guard.test.ts',
    ]) {
      expect(isSecretPath(target), target).toBe(false);
    }
  });
});

describe('credential vault command denials', () => {
  it.each([
    'cat ~/.hive-flow/credential-vault.json.gcm',
    'cat ~/.hive-flow/run/credential-holder.sock',
    'cat /proc/123/environ',
    'ps eww 123',
    'ps -E -p 123',
    'security find-generic-password -w -s hive-flow-vault-kek:v1',
    'secret-tool lookup service hive-flow-provider-key:openrouter',
    'cmdkey /list',
    'powershell -Command Get-StoredCredential hive-flow-provider-key',
    'printenv OPENROUTER_API_KEY',
  ])('denies credential secret exposure command: %s', async (command) => {
    const result = await evalBash(command);

    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/credential|secret|environment|keychain|proc|ps/i);
  });

  it('denies HIVE_FLOW_HOME override vault exposure without unprotecting defaults', async () => {
    const previousHiveHome = process.env.HIVE_FLOW_HOME;
    const hiveHome = join(tmpdir(), `hf-vault-override-${process.pid}-${Math.random()}`);
    process.env.HIVE_FLOW_HOME = hiveHome;
    try {
      for (const command of [
        `cat ${join(hiveHome, 'credential-vault.json.gcm')}`,
        `cat ${join(hiveHome, 'credentials', 'openrouter.json')}`,
        `cat ${join(hiveHome, 'run', 'credential-holder.sock')}`,
        'cat ~/.hive-flow/credential-vault.json.gcm',
      ]) {
        const result = await evalBash(command);
        expect(result.decision, command).toBe('deny');
        expect(result.reason, command).toMatch(/credential|secret|socket/i);
      }
    } finally {
      if (previousHiveHome === undefined) {
        delete process.env.HIVE_FLOW_HOME;
      } else {
        process.env.HIVE_FLOW_HOME = previousHiveHome;
      }
    }
  });

  it('keeps the planted bypass non-vacuous by allowing the same vault read with credential secret policy removed', () => {
    const stripped = loadSecretPolicy();
    stripped.secretPathGlobs = stripped.secretPathGlobs.filter(entry => !entry.includes('.hive-flow/credential'));

    expect(isSecretPath('~/.hive-flow/credential-vault.json.gcm', stripped)).toBe(false);
  });
});

describe('credential vault jury and bridge coverage', () => {
  it.each([
    'cat ~/.hive-flow/credential-vault.json.gcm',
    'cat /proc/123/environ',
    'ps eww 123',
    'security find-generic-password -w -s hive-flow-vault-kek:v1',
  ])('jury safety veto denies credential vault exposure: %s', (command) => {
    expect(evaluateSafety({
      toolName: 'Bash',
      toolInput: { command },
      cwd: repoRoot,
    })).toMatchObject({ vote: 'deny' });
  });

  it('provider bridge run_shell deny-list names credential exposure primitives', () => {
    const bridge = readFileSync(
      join(repoRoot, 'v3', '@hive-flow', 'providers', 'scripts', 'provider-agent-bridge.mjs'),
      'utf8',
    );

    for (const token of [
      '/proc/',
      'environ',
      'ps',
      'printenv',
      'security',
      'secret-tool',
      'cmdkey',
    ]) {
      expect(bridge).toContain(token);
    }
  });
});
