import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { assertValidKek } from './kek.js';

export const VAULT_ALG = 'AES-256-GCM';
export const VAULT_VERSION = 1;
export const VAULT_NONCE_BYTES = 12;
export const VAULT_TAG_BYTES = 16;

export interface VaultAad {
  version: number;
  alg: typeof VAULT_ALG;
  kekVersion: number;
}

export interface VaultEnvelope {
  version: number;
  alg: typeof VAULT_ALG;
  nonce: string;
  tag: string;
  ciphertext: string;
  aad: VaultAad;
}

export interface VaultEncryptOptions {
  version?: number;
  kekVersion?: number;
  randomBytes?: (size: number) => Buffer;
}

function asBuffer(value: Uint8Array | string): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

function aadBuffer(aad: VaultAad): Buffer {
  return Buffer.from(JSON.stringify(aad), 'utf8');
}

function decodeBase64Url(value: string, label: string): Buffer {
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    throw new Error(`credential vault ${label} is not valid base64url`);
  }
}

export function encryptVault(
  plaintext: Uint8Array | string,
  kek: Uint8Array,
  options: VaultEncryptOptions = {},
): VaultEnvelope {
  assertValidKek(kek);
  const version = options.version ?? VAULT_VERSION;
  const kekVersion = options.kekVersion ?? 1;
  const random = options.randomBytes ?? randomBytes;
  const nonce = random(VAULT_NONCE_BYTES);
  if (nonce.byteLength !== VAULT_NONCE_BYTES) {
    throw new Error(`credential vault nonce must be ${VAULT_NONCE_BYTES} bytes`);
  }
  const aad: VaultAad = { version, alg: VAULT_ALG, kekVersion };
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(kek), nonce, { authTagLength: VAULT_TAG_BYTES });
  cipher.setAAD(aadBuffer(aad));
  const ciphertext = Buffer.concat([cipher.update(asBuffer(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.byteLength !== VAULT_TAG_BYTES) {
    throw new Error(`credential vault tag must be ${VAULT_TAG_BYTES} bytes`);
  }
  return {
    version,
    alg: VAULT_ALG,
    nonce: nonce.toString('base64url'),
    tag: tag.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    aad,
  };
}

export function decryptVault(envelope: VaultEnvelope, kek: Uint8Array): Buffer {
  assertValidKek(kek);
  if (!envelope || envelope.alg !== VAULT_ALG) {
    throw new Error('credential vault envelope uses an unsupported algorithm');
  }
  if (!envelope.aad ||
      envelope.aad.version !== envelope.version ||
      envelope.aad.alg !== envelope.alg ||
      !Number.isInteger(envelope.aad.kekVersion) ||
      envelope.aad.kekVersion < 1) {
    throw new Error('credential vault envelope metadata does not match authenticated AAD');
  }
  const nonce = decodeBase64Url(envelope.nonce, 'nonce');
  const tag = decodeBase64Url(envelope.tag, 'tag');
  const ciphertext = decodeBase64Url(envelope.ciphertext, 'ciphertext');
  if (nonce.byteLength !== VAULT_NONCE_BYTES) throw new Error('credential vault nonce has invalid length');
  if (tag.byteLength !== VAULT_TAG_BYTES) throw new Error('credential vault tag has invalid length');

  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(kek), nonce, { authTagLength: VAULT_TAG_BYTES });
    decipher.setAAD(aadBuffer(envelope.aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new Error(`credential vault authentication/decrypt failed: ${(error as Error).message}`);
  }
}

function noFollowReadFlag(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

function noFollowWriteFlag(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
}

function assertSafeVaultStat(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`credential vault path is a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`credential vault path is not a regular file: ${path}`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`credential vault path is not owned by the current user: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`credential vault path permissions must be 0600: ${path}`);
  }
}

export function writeVaultAtomic(path: string, envelope: VaultEnvelope): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, noFollowWriteFlag(), 0o600);
    writeFileSync(fd, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    fchmodSync(fd, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('credential vault temporary path is not a regular file');
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    assertSafeVaultStat(path);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
    throw error;
  }
}

export function readVaultEnvelope(path: string): VaultEnvelope {
  assertSafeVaultStat(path);
  const fd = openSync(path, noFollowReadFlag());
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`credential vault path is not a regular file: ${path}`);
    const raw = readFileSync(fd, 'utf8');
    return JSON.parse(raw) as VaultEnvelope;
  } finally {
    closeSync(fd);
  }
}
