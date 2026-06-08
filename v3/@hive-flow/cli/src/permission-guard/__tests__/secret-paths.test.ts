import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { join } from 'node:path';
import {
  isProtectedWritePath,
  casefoldPath,
} from '../protected-paths.js';
import {
  isSecretPath,
  loadSecretPolicy,
} from '../secret-paths.js';

describe('secret-path classifier', () => {
  it('classifies secret directory components at any depth', () => {
    for (const target of [
      '~/.ssh/id_rsa',
      'proj/.aws/credentials',
      '/x/secrets/foo.txt',
      'a/.gnupg/b',
      'x/.config/gcloud/application_default_credentials.json',
      'x/.netrc-dir/token',
    ]) {
      expect(isSecretPath(target), target).toBe(true);
    }
  });

  it('classifies secret basenames and basename globs', () => {
    for (const target of [
      'id_rsa',
      'path/.env',
      '.env.production',
      'app/.env.local',
      'app/.env.staging.local',
      'credentials',
      '.netrc',
      'service-account-123.json',
      '.aws/credentials',
      '.terraform/terraform.tfstate',
    ]) {
      expect(isSecretPath(target), target).toBe(true);
    }
  });

  it('classifies secret extensions by suffix', () => {
    for (const target of [
      'deploy.pem',
      'tls.key',
      'store.pfx',
      'vault.kdbx',
    ]) {
      expect(isSecretPath(target), target).toBe(true);
    }
  });

  it('lets allow-exceptions win over secret basename and extension rules', () => {
    for (const target of [
      'id_rsa.pub',
      'keys/foo.pub',
      '.env.example',
      '.env.sample',
      '.env.template',
      '.env.dist',
    ]) {
      expect(isSecretPath(target), target).toBe(false);
    }
  });

  it('uses component equality and does not substring-match benign paths', () => {
    for (const target of [
      '.envrc',
      '.ssh_backup/x',
      'x.private',
      'my notes.txt',
      'src/index.ts',
      'README.md',
    ]) {
      expect(isSecretPath(target), target).toBe(false);
    }
  });

  it('does not classify repo credential source and guard tests as runtime secrets', () => {
    for (const target of [
      'v3/@hive-flow/cli/src/credential-store/vault.ts',
      'v3/@hive-flow/cli/src/credential-store/__tests__/vault.test.ts',
      'v3/@hive-flow/cli/src/permission-guard/__tests__/credential-vault-guard.test.ts',
    ]) {
      expect(isSecretPath(target), target).toBe(false);
    }
  });

  it('classifies home-anchored credential vault runtime paths as secrets', () => {
    for (const target of [
      '~/.hive-flow/credential-vault.json.gcm',
      '~/.hive-flow/credentials/openrouter.json',
      '~/.hive-flow/run/credential-agent.sock',
    ]) {
      expect(isSecretPath(target), target).toBe(true);
    }
  });

  it('normalizes C0 controls, unicode line separators, and backslashes as path separators', () => {
    for (const target of [
      '.ssh\nx/id_rsa',
      'proj/.aws\u2028creds/credentials',
      String.raw`x\.ssh\id_rsa`,
    ]) {
      expect(isSecretPath(target), target).toBe(true);
    }
  });

  it('documents that casefold-only normalization would miss the C0 obfuscation case', () => {
    const casefoldOnlyComponents = casefoldPath('.ssh\nx/id_rsa')
      .split('/')
      .filter(Boolean);
    expect(casefoldOnlyComponents).toContain('.ssh\nx');
    expect(casefoldOnlyComponents).not.toContain('.ssh');
  });

  it('fails closed for empty and unclassifiable paths', () => {
    expect(isSecretPath('')).toBe(true);
    expect(isSecretPath(null as unknown as string)).toBe(true);
  });

  it('falls back to the embedded default policy when json cannot be loaded', () => {
    const policy = loadSecretPolicy(join('/missing', 'secret-paths.policy.json'));
    expect(policy.secretDirComponents).toContain('.ssh');
    expect(policy.secretBasenameGlobs).toContain('.env.*');
    expect(policy.secretPathGlobs).toContain('${HOME}/.hive-flow/credential-vault*');
    expect(isSecretPath('x/.ssh/id_rsa', policy)).toBe(true);
    expect(isSecretPath('~/.hive-flow/credentials/openrouter.json', policy)).toBe(true);
  });

  it('keeps the policy file protected by the existing permission-guard source directory rule', () => {
    const projectRoot = process.cwd();
    expect(isProtectedWritePath(
      join(projectRoot, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'secret-paths.policy.json'),
      projectRoot,
    )).toBe(true);
  });

  it('preserves equality boundaries under generated benign sibling names', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/[a-z0-9_-]{1,16}/),
        fc.constantFrom('.ssh_backup', 'x.private', '.envrc', 'secretary', 'credentials-old'),
        (prefix, sibling) => {
          expect(isSecretPath(`src/${prefix}-${sibling}/notes.txt`)).toBe(false);
        },
      ),
    );
  });

  it('treats generated separator obfuscations as real path boundaries', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('.ssh', '.aws', 'secrets', '.private'),
        fc.constantFrom('\u0000', '\n', '\r', '\u2028', '\u2029', '\\'),
        (secretDir, separator) => {
          expect(isSecretPath(`src/${secretDir}${separator}child/plain.txt`)).toBe(true);
        },
      ),
    );
  });
});
