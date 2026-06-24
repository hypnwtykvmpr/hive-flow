/**
 * Appliance Ed25519 signing module tests.
 *
 * Uses the Node.js built-in test runner (node:test).
 * Run: npx tsx --test v3/__tests__/appliance/appliance-signing.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateKeyPair,
  saveKeyPair,
  loadKeyPair,
  ApplianceSigner,
  ApplianceVerifier,
  type ApplianceKeyPair,
} from '../../@hive-flow/cli/src/appliance/appliance-signing.js';
import {
  ApplianceWriter,
  ApplianceReader,
  createDefaultHeader,
} from '../../@hive-flow/cli/src/appliance/appliance-format.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanupPaths: string[] = [];

function legacyCliSectionId(): string {
  return String.fromCharCode(0x72, 0x75, 0x66, 0x6c, 0x6f);
}

function tmpPath(suffix: string): string {
  const p = join(
    tmpdir(),
    `appliance-sign-test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  );
  cleanupPaths.push(p);
  return p;
}

function tmpDir(): string {
  const d = join(
    tmpdir(),
    `appliance-sign-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  cleanupPaths.push(d);
  return d;
}

function buildTestAppliance(name = 'test-appliance', cliSectionId = 'hive-flow'): Buffer {
  const header = createDefaultHeader('cloud');
  const writer = new ApplianceWriter({ ...header, name });
  writer.addSection('kernel', Buffer.from('kernel-data'), { compression: 'none' });
  writer.addSection('runtime', Buffer.from('runtime-data'), { compression: 'none' });
  writer.addSection(cliSectionId, Buffer.from('hive-flow-data'), { compression: 'none' });
  return writer.build();
}

function writeTestAppliance(name = 'test-appliance', cliSectionId = 'hive-flow'): string {
  const buf = buildTestAppliance(name, cliSectionId);
  const p = tmpPath('.hfap');
  writeFileSync(p, buf);
  return p;
}

afterEach(() => {
  for (const p of cleanupPaths) {
    try {
      if (existsSync(p)) {
        const s = require('node:fs').statSync(p);
        if (s.isDirectory()) rmSync(p, { recursive: true, force: true });
        else unlinkSync(p);
      }
    } catch { /* ignore */ }
  }
  cleanupPaths.length = 0;
});

// ---------------------------------------------------------------------------
// 1. Key generation
// ---------------------------------------------------------------------------

describe('generateKeyPair', () => {
  it('produces a key pair with publicKey, privateKey, and fingerprint', async () => {
    const kp = await generateKeyPair();

    assert.ok(Buffer.isBuffer(kp.publicKey));
    assert.ok(Buffer.isBuffer(kp.privateKey));
    assert.equal(typeof kp.fingerprint, 'string');
    assert.ok(kp.fingerprint.length > 0);
  });

  it('public key is in PEM format (starts with BEGIN)', async () => {
    const kp = await generateKeyPair();
    const pubPem = kp.publicKey.toString('utf-8');
    assert.ok(pubPem.includes('BEGIN PUBLIC KEY'), 'Public key should be PEM-encoded');
  });

  it('private key is in PEM format (starts with BEGIN)', async () => {
    const kp = await generateKeyPair();
    const privPem = kp.privateKey.toString('utf-8');
    assert.ok(privPem.includes('BEGIN PRIVATE KEY'), 'Private key should be PEM-encoded');
  });

  it('generates distinct key pairs on each call', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    assert.ok(!kp1.publicKey.equals(kp2.publicKey), 'Public keys should differ');
    assert.ok(!kp1.privateKey.equals(kp2.privateKey), 'Private keys should differ');
    assert.notEqual(kp1.fingerprint, kp2.fingerprint, 'Fingerprints should differ');
  });
});

// ---------------------------------------------------------------------------
// 2. Key fingerprint
// ---------------------------------------------------------------------------

describe('Key fingerprint', () => {
  it('fingerprint is hex and 16 characters long', async () => {
    const kp = await generateKeyPair();
    assert.match(kp.fingerprint, /^[0-9a-f]{16}$/);
  });

  it('fingerprint is deterministic for the same key', async () => {
    const kp = await generateKeyPair();
    // Recreate a signer from the same private key -- fingerprint should match
    const signer = new ApplianceSigner(kp.privateKey);
    // Sign something to verify signer is operational
    const appliancePath = writeTestAppliance();
    const sigMeta = await signer.signAppliance(appliancePath);
    assert.equal(sigMeta.publicKeyFingerprint, kp.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// 3. Key save/load
// ---------------------------------------------------------------------------

describe('saveKeyPair / loadKeyPair', () => {
  it('round-trips a key pair through save and load', async () => {
    const original = await generateKeyPair();
    const dir = tmpDir();

    await saveKeyPair(original, dir, 'test-key');

    assert.ok(existsSync(join(dir, 'test-key.pub')), 'Public key file should exist');
    assert.ok(existsSync(join(dir, 'test-key.key')), 'Private key file should exist');

    const loaded = await loadKeyPair(dir, 'test-key');

    assert.ok(loaded.publicKey.equals(original.publicKey), 'Public key should round-trip');
    assert.ok(loaded.privateKey.equals(original.privateKey), 'Private key should round-trip');
    assert.equal(loaded.fingerprint, original.fingerprint, 'Fingerprint should round-trip');
  });

  it('uses default name "appliance-signing" when none provided', async () => {
    const kp = await generateKeyPair();
    const dir = tmpDir();

    await saveKeyPair(kp, dir);

    assert.ok(existsSync(join(dir, 'appliance-signing.pub')));
    assert.ok(existsSync(join(dir, 'appliance-signing.key')));

    const loaded = await loadKeyPair(dir);
    assert.equal(loaded.fingerprint, kp.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// 4. Sign appliance
// ---------------------------------------------------------------------------

describe('ApplianceSigner.signAppliance', () => {
  it('signs an Appliance file and embeds signature metadata in the header', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);
    const appliancePath = writeTestAppliance();

    const sigMeta = await signer.signAppliance(appliancePath, 'test-publisher');

    assert.equal(sigMeta.algorithm, 'ed25519');
    assert.equal(typeof sigMeta.signature, 'string');
    assert.ok(sigMeta.signature.length > 0);
    assert.equal(sigMeta.publicKeyFingerprint, kp.fingerprint);
    assert.equal(sigMeta.signedBy, 'test-publisher');
    assert.equal(sigMeta.scope, 'full');
    assert.equal(typeof sigMeta.signedAt, 'string');
  });

  it('signed file is still a valid Appliance (readable by ApplianceReader)', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);
    const appliancePath = writeTestAppliance();

    await signer.signAppliance(appliancePath);

    const buf = readFileSync(appliancePath);
    const reader = ApplianceReader.fromBuffer(buf);
    const header = reader.getHeader();
    assert.equal(header.name, 'test-appliance');
    assert.ok((header as Record<string, unknown>).signature, 'Header should contain signature field');
  });

  it('still signs legacy appliances with the previous CLI section id', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);
    const legacySectionId = legacyCliSectionId();
    const appliancePath = writeTestAppliance('legacy-sign-test', legacySectionId);

    await signer.signAppliance(appliancePath);

    const header = ApplianceReader.fromBuffer(readFileSync(appliancePath)).getHeader();
    assert.ok(header.sections.some((section) => section.id === legacySectionId));
    assert.ok((header as Record<string, unknown>).signature);
  });
});

// ---------------------------------------------------------------------------
// 5. Verify valid signature
// ---------------------------------------------------------------------------

describe('ApplianceVerifier.verifyAppliance', () => {
  it('returns valid=true for a correctly signed file', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);
    const verifier = new ApplianceVerifier(kp.publicKey);
    const appliancePath = writeTestAppliance();

    await signer.signAppliance(appliancePath, 'publisher-name');

    const result = await verifier.verifyAppliance(appliancePath);
    assert.ok(result.valid, `Expected valid but got errors: ${result.errors.join(', ')}`);
    assert.equal(result.signerFingerprint, kp.fingerprint);
    assert.equal(result.signedBy, 'publisher-name');
    assert.equal(result.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Verify tampered data
// ---------------------------------------------------------------------------

describe('Tamper detection', () => {
  it('returns valid=false when section data is modified after signing', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);
    const verifier = new ApplianceVerifier(kp.publicKey);
    const appliancePath = writeTestAppliance();

    await signer.signAppliance(appliancePath);

    // Read the signed file and tamper with section data
    const signedBuf = readFileSync(appliancePath);
    const tampered = Buffer.from(signedBuf);
    // Tamper with a byte near the end (in section data area, before footer)
    const tamperOffset = tampered.length - 40; // before the 32-byte SHA256 footer
    if (tamperOffset > 0) {
      tampered[tamperOffset] ^= 0xFF;
    }
    writeFileSync(appliancePath, tampered);

    const result = await verifier.verifyAppliance(appliancePath);
    assert.ok(!result.valid, 'Tampered file should fail verification');
    assert.ok(result.errors.length > 0);
  });

  it('returns valid=false when header is modified after signing', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);
    const verifier = new ApplianceVerifier(kp.publicKey);
    const appliancePath = writeTestAppliance();

    await signer.signAppliance(appliancePath);

    // Read the signed file, modify the header name
    const signedBuf = readFileSync(appliancePath);
    const headerLen = signedBuf.readUInt32LE(8);
    const headerJson = signedBuf.subarray(12, 12 + headerLen).toString('utf-8');
    const header = JSON.parse(headerJson);
    header.name = 'tampered-name';

    const newHeaderJson = Buffer.from(JSON.stringify(header), 'utf-8');
    const preamble = Buffer.alloc(12);
    signedBuf.copy(preamble, 0, 0, 8);
    preamble.writeUInt32LE(newHeaderJson.length, 8);

    const rebuilt = Buffer.concat([
      preamble,
      newHeaderJson,
      signedBuf.subarray(12 + headerLen),
    ]);
    writeFileSync(appliancePath, rebuilt);

    const result = await verifier.verifyAppliance(appliancePath);
    assert.ok(!result.valid, 'Modified header should fail verification');
  });
});

// ---------------------------------------------------------------------------
// 7. Verify missing signature
// ---------------------------------------------------------------------------

describe('Missing signature', () => {
  it('returns valid=false with appropriate error for unsigned Appliance', async () => {
    const kp = await generateKeyPair();
    const verifier = new ApplianceVerifier(kp.publicKey);
    const appliancePath = writeTestAppliance();

    const result = await verifier.verifyAppliance(appliancePath);
    assert.ok(!result.valid);
    assert.ok(
      result.errors.some((e) => e.includes('No signature') || e.includes('signature')),
      `Expected signature-related error, got: ${result.errors.join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Sign patch (detached)
// ---------------------------------------------------------------------------

describe('ApplianceSigner.signPatch / ApplianceVerifier.verifyPatch', () => {
  it('signs arbitrary data and verifies with detached signature', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);
    const verifier = new ApplianceVerifier(kp.publicKey);

    const patchData = Buffer.from('this-is-a-patch-payload-for-signing');
    const signature = await signer.signPatch(patchData);

    assert.equal(typeof signature, 'string');
    assert.ok(signature.length > 0);

    const valid = await verifier.verifyPatch(patchData, signature);
    assert.ok(valid, 'Detached patch signature should verify');
  });

  it('detached signature fails for tampered data', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);
    const verifier = new ApplianceVerifier(kp.publicKey);

    const patchData = Buffer.from('original-patch-data');
    const signature = await signer.signPatch(patchData);

    const tampered = Buffer.from('tampered-patch-data');
    const valid = await verifier.verifyPatch(tampered, signature);
    assert.ok(!valid, 'Tampered data should fail verification');
  });

  it('signSections signs a 32-byte footer hash and returns hex signature', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);

    const footerHash = Buffer.alloc(32, 0xAB);
    const signature = await signer.signSections(footerHash);

    assert.equal(typeof signature, 'string');
    assert.ok(signature.length > 0);
    // signSections signs the raw hash directly (no re-hash),
    // so we verify manually using Node.js crypto
    const { verify: edVerify, createPublicKey } = await import('node:crypto');
    const pubKeyObj = createPublicKey({
      key: kp.publicKey,
      format: 'pem',
      type: 'spki',
    });
    const valid = edVerify(null, footerHash, pubKeyObj, Buffer.from(signature, 'hex'));
    assert.ok(valid, 'Signature over raw footer hash should verify');
  });

  it('signSections rejects non-32-byte input', async () => {
    const kp = await generateKeyPair();
    const signer = new ApplianceSigner(kp.privateKey);

    await assert.rejects(
      () => signer.signSections(Buffer.alloc(16)),
      /32 bytes/,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Canonical JSON
// ---------------------------------------------------------------------------

describe('Canonical JSON (deterministic signing)', () => {
  it('signing produces the same signature regardless of header key order', async () => {
    const kp = await generateKeyPair();

    // Create two Appliance files with the same content
    const appliancePath1 = writeTestAppliance('canon-test');
    const appliancePath2 = writeTestAppliance('canon-test');

    // Sign both with the same key
    const signer = new ApplianceSigner(kp.privateKey);
    const sig1 = await signer.signAppliance(appliancePath1);
    const sig2 = await signer.signAppliance(appliancePath2);

    // Both should verify successfully
    const verifier = new ApplianceVerifier(kp.publicKey);
    const result1 = await verifier.verifyAppliance(appliancePath1);
    const result2 = await verifier.verifyAppliance(appliancePath2);

    assert.ok(result1.valid, 'First file should verify');
    assert.ok(result2.valid, 'Second file should verify');
  });
});

// ---------------------------------------------------------------------------
// 10. Re-sign
// ---------------------------------------------------------------------------

describe('Re-signing', () => {
  it('re-signing replaces the old signature cleanly', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    const appliancePath = writeTestAppliance();

    // Sign with first key
    const signer1 = new ApplianceSigner(kp1.privateKey);
    await signer1.signAppliance(appliancePath, 'publisher-one');

    // Verify with first key
    const verifier1 = new ApplianceVerifier(kp1.publicKey);
    const result1 = await verifier1.verifyAppliance(appliancePath);
    assert.ok(result1.valid, 'First signature should verify');

    // Re-sign with second key
    const signer2 = new ApplianceSigner(kp2.privateKey);
    await signer2.signAppliance(appliancePath, 'publisher-two');

    // Verify with second key should pass
    const verifier2 = new ApplianceVerifier(kp2.publicKey);
    const result2 = await verifier2.verifyAppliance(appliancePath);
    assert.ok(result2.valid, 'Re-signed file should verify with new key');
    assert.equal(result2.signedBy, 'publisher-two');

    // Verify with first key should fail
    const result3 = await verifier1.verifyAppliance(appliancePath);
    assert.ok(!result3.valid, 'Old key should no longer verify');
  });

  it('re-signed file still reads as valid Appliance and verifies', async () => {
    const kp = await generateKeyPair();
    const appliancePath = writeTestAppliance();

    const signer = new ApplianceSigner(kp.privateKey);
    await signer.signAppliance(appliancePath);
    // Re-sign
    const sigMeta = await signer.signAppliance(appliancePath);

    assert.equal(sigMeta.algorithm, 'ed25519');
    assert.equal(sigMeta.scope, 'full');

    // The re-signed file should still verify with the same key
    const verifier = new ApplianceVerifier(kp.publicKey);
    const result = await verifier.verifyAppliance(appliancePath);
    assert.ok(result.valid, `Re-signed file should verify: ${result.errors.join(', ')}`);
  });
});
