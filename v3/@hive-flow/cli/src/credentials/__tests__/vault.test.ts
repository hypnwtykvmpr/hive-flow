import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptVault,
  encryptVault,
  readVaultEnvelope,
  writeVaultAtomic,
} from '../vault.js';
import {
  generateKek,
  isValidKek,
} from '../kek.js';

describe('credential vault crypto', () => {
  it('round-trips AES-256-GCM envelopes with explicit AAD', () => {
    const kek = generateKek(() => Buffer.alloc(32, 7));
    const plaintext = Buffer.from(JSON.stringify({ openrouter: 'or-test-key' }), 'utf8');

    const envelope = encryptVault(plaintext, kek, {
      version: 3,
      kekVersion: 9,
      randomBytes: (size) => Buffer.alloc(size, 5),
    });

    expect(envelope.alg).toBe('AES-256-GCM');
    expect(Buffer.from(envelope.nonce, 'base64url')).toHaveLength(12);
    expect(Buffer.from(envelope.tag, 'base64url')).toHaveLength(16);
    expect(envelope.aad).toEqual({ version: 3, alg: 'AES-256-GCM', kekVersion: 9 });
    expect(decryptVault(envelope, kek).toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('fails closed when the authentication tag is tampered', () => {
    const kek = generateKek(() => Buffer.alloc(32, 2));
    const envelope = encryptVault(Buffer.from('secret'), kek, {
      randomBytes: (size) => Buffer.alloc(size, 1),
    });

    const tag = Buffer.from(envelope.tag, 'base64url');
    tag[0] ^= 0xff;

    expect(() => decryptVault({ ...envelope, tag: tag.toString('base64url') }, kek))
      .toThrow(/authentication|decrypt|tag/i);
  });

  it('fails closed when unauthenticated envelope metadata diverges from AAD', () => {
    const kek = generateKek(() => Buffer.alloc(32, 8));
    const envelope = encryptVault(Buffer.from('secret'), kek, {
      version: 2,
      randomBytes: (size) => Buffer.alloc(size, 3),
    });

    expect(() => decryptVault({ ...envelope, version: 99 }, kek))
      .toThrow(/aad|metadata|version/i);
  });

  it('rejects invalid KEK lengths', () => {
    expect(isValidKek(Buffer.alloc(32))).toBe(true);
    expect(isValidKek(Buffer.alloc(31))).toBe(false);
    expect(() => encryptVault(Buffer.from('x'), Buffer.alloc(31))).toThrow(/kek/i);
  });
});

describe('credential vault storage', () => {
  it('writes atomically as a 0600 regular file and reads it back', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-credential-vault-'));
    try {
      const target = join(root, 'credential-vault.json.gcm');
      const kek = generateKek(() => Buffer.alloc(32, 4));
      const envelope = encryptVault(Buffer.from('payload'), kek, {
        randomBytes: (size) => Buffer.alloc(size, 6),
      });

      writeVaultAtomic(target, envelope);

      readFileSync(target);
      const mode = statSync(target).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(readVaultEnvelope(target)).toEqual(envelope);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to read a symlinked vault file', () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-credential-vault-link-'));
    try {
      const real = join(root, 'real.json.gcm');
      const link = join(root, 'credential-vault.json.gcm');
      writeFileSync(real, '{}', { mode: 0o600 });
      symlinkSync(real, link);

      expect(() => readVaultEnvelope(link)).toThrow(/symlink|regular|vault/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
