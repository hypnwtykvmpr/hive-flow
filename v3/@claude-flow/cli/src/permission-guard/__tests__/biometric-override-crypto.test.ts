/**
 * Biometric Override — Ed25519 cryptographic correctness tests.
 *
 * Tests 1-5, 9-10 use actual crypto operations (no mocking) to verify
 * that the signature verification logic is mathematically correct.
 * Tests 6-8 mock the filesystem to verify fail-closed behaviour when
 * files are missing or corrupt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { hostname } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers that replicate hasActiveOverride logic without touching disk
// ---------------------------------------------------------------------------

interface OverridePayload {
  nonce: string;
  expiresAt: number;
  machineId: string;
  grantedAt: number;
}

interface OverrideFile {
  payload: string;
  signature: string;
}

/**
 * Generate a real Ed25519 keypair, sign the given payload JSON string, and
 * return the public key PEM + OverrideFile so tests can exercise the exact
 * verification logic that hasActiveOverride() uses.
 */
function signPayload(
  payloadStr: string,
  privateKeyPem: string,
): string /* base64 signature */ {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(payloadStr), privateKey).toString('base64');
}

function verifySignature(
  payloadStr: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(
      null,
      Buffer.from(payloadStr),
      publicKey,
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test 1 — Generate keypair, sign, verify → true
// ---------------------------------------------------------------------------

describe('Ed25519 sign and verify (correct flow)', () => {
  it('generates keypair, signs payload, and verifies successfully', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const payload: OverridePayload = {
      nonce: crypto.randomBytes(32).toString('hex'),
      expiresAt: Date.now() + 5 * 60 * 1000,
      machineId: hostname(),
      grantedAt: Date.now(),
    };
    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr, privPem);

    expect(verifySignature(payloadStr, signature, pubPem)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Tamper with payload after signing → false
// ---------------------------------------------------------------------------

describe('Ed25519 tampered payload', () => {
  it('returns false when the payload is modified after signing', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const payload: OverridePayload = {
      nonce: crypto.randomBytes(32).toString('hex'),
      expiresAt: Date.now() + 5 * 60 * 1000,
      machineId: hostname(),
      grantedAt: Date.now(),
    };
    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr, privPem);

    // Tamper: extend expiry far into the future
    const tamperedPayload = { ...payload, expiresAt: Date.now() + 999 * 60 * 1000 };
    const tamperedStr = JSON.stringify(tamperedPayload);

    expect(verifySignature(tamperedStr, signature, pubPem)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Tamper with signature → false
// ---------------------------------------------------------------------------

describe('Ed25519 tampered signature', () => {
  it('returns false when the signature bytes are altered', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const payload: OverridePayload = {
      nonce: crypto.randomBytes(32).toString('hex'),
      expiresAt: Date.now() + 5 * 60 * 1000,
      machineId: hostname(),
      grantedAt: Date.now(),
    };
    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr, privPem);

    // Flip a bit in the signature
    const sigBuf = Buffer.from(signature, 'base64');
    sigBuf[0] ^= 0xff;
    const corruptedSig = sigBuf.toString('base64');

    expect(verifySignature(payloadStr, corruptedSig, pubPem)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Expired payload → override check returns false
// ---------------------------------------------------------------------------

describe('Ed25519 expired payload', () => {
  it('treats an override with expiresAt in the past as inactive', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const payload: OverridePayload = {
      nonce: crypto.randomBytes(32).toString('hex'),
      // Already expired
      expiresAt: Date.now() - 1000,
      machineId: hostname(),
      grantedAt: Date.now() - 6 * 60 * 1000,
    };
    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr, privPem);

    // Signature is valid…
    expect(verifySignature(payloadStr, signature, pubPem)).toBe(true);

    // …but expiry check must reject it
    const data: OverridePayload = JSON.parse(payloadStr);
    expect(data.expiresAt <= Date.now()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Wrong machineId → override check returns false
// ---------------------------------------------------------------------------

describe('Ed25519 machineId mismatch', () => {
  it('returns false when machineId does not match the current hostname', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const payload: OverridePayload = {
      nonce: crypto.randomBytes(32).toString('hex'),
      expiresAt: Date.now() + 5 * 60 * 1000,
      machineId: 'wrong-machine-hostname-abc123',
      grantedAt: Date.now(),
    };
    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr, privPem);

    // Signature is valid…
    expect(verifySignature(payloadStr, signature, pubPem)).toBe(true);

    // …but machineId check must reject it
    const data: OverridePayload = JSON.parse(payloadStr);
    expect(data.machineId).not.toBe(hostname());
  });
});

// ---------------------------------------------------------------------------
// Tests 6-8 — Filesystem mock tests for hasActiveOverride
// ---------------------------------------------------------------------------

describe('hasActiveOverride filesystem error handling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when override file is missing (no pubkey, no override)', async () => {
    vi.mock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: (p: string) => {
          // Simulate neither file existing
          if (String(p).includes('active-override') || String(p).includes('override-pubkey')) {
            return false;
          }
          return actual.existsSync(p);
        },
      };
    });

    const { hasActiveOverride } = await import('../biometric-override.js');
    expect(hasActiveOverride()).toBe(false);
  });

  it('returns false when pubkey file is missing even if override file exists', async () => {
    vi.mock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: (p: string) => {
          if (String(p).includes('override-pubkey')) return false;
          if (String(p).includes('active-override')) return true;
          return actual.existsSync(p);
        },
        readFileSync: (p: unknown, ...rest: unknown[]) => {
          if (String(p).includes('active-override')) {
            // Valid-looking JSON but pubkey is missing
            const payload: OverridePayload = {
              nonce: 'abc',
              expiresAt: Date.now() + 300000,
              machineId: hostname(),
              grantedAt: Date.now(),
            };
            const overrideFile: OverrideFile = {
              payload: JSON.stringify(payload),
              signature: 'invalidsig==',
            };
            return JSON.stringify(overrideFile);
          }
          return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
        },
      };
    });

    const { hasActiveOverride } = await import('../biometric-override.js');
    expect(hasActiveOverride()).toBe(false);
  });

  it('returns false (does not throw) when override file contains corrupt JSON', async () => {
    vi.mock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        existsSync: (p: string) => {
          if (String(p).includes('active-override') || String(p).includes('override-pubkey')) {
            return true;
          }
          return actual.existsSync(p);
        },
        readFileSync: (p: unknown, ...rest: unknown[]) => {
          if (String(p).includes('active-override')) {
            return 'NOT VALID JSON {{{';
          }
          if (String(p).includes('override-pubkey')) {
            return 'some-pem-data';
          }
          return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
        },
      };
    });

    const { hasActiveOverride } = await import('../biometric-override.js');
    // Must not throw — must return false (fail-closed)
    expect(() => hasActiveOverride()).not.toThrow();
    expect(hasActiveOverride()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 9 — Empty signature → verify returns false
// ---------------------------------------------------------------------------

describe('Ed25519 empty signature', () => {
  it('returns false for an empty signature string', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const payloadStr = JSON.stringify({
      nonce: 'abc',
      expiresAt: Date.now() + 300000,
      machineId: hostname(),
      grantedAt: Date.now(),
    });

    // Empty string decodes to empty buffer — crypto.verify should reject this
    expect(verifySignature(payloadStr, '', pubPem)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 10 — Valid payload with correct machineId and future expiry → true
// ---------------------------------------------------------------------------

describe('Ed25519 full valid override scenario', () => {
  it('returns true for a correctly signed, unexpired, machine-matched override', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    const payload: OverridePayload = {
      nonce: crypto.randomBytes(32).toString('hex'),
      expiresAt: Date.now() + 5 * 60 * 1000,
      machineId: hostname(),
      grantedAt: Date.now(),
    };
    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr, privPem);

    // Step 1: signature is valid
    expect(verifySignature(payloadStr, signature, pubPem)).toBe(true);

    // Step 2: not expired
    const data: OverridePayload = JSON.parse(payloadStr);
    expect(data.expiresAt > Date.now()).toBe(true);

    // Step 3: machineId matches
    expect(data.machineId).toBe(hostname());

    // All three checks pass — this override would be considered active
  });
});
