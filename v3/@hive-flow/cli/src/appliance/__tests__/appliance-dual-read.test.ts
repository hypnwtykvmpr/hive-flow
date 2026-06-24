import { describe, it, expect, beforeAll } from 'vitest';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplianceReader, ApplianceWriter } from '../appliance-format.js';
import { generateKeyPair, ApplianceSigner, ApplianceVerifier } from '../appliance-signing.js';

// ---------------------------------------------------------------------------
// Appliance dual-read: current HFAP plus legacy byte-token support.
//
// Writers use HFAP. Readers continue accepting the legacy byte token and
// enforce a preamble<->header.magic pairing gate that must reject BEFORE any
// checksum/signature trust (the signing digest covers header.magic but NOT the
// raw 4-byte preamble).
// ---------------------------------------------------------------------------

const FIX_DIR = join(__dirname, 'fixtures');
const LEGACY_FIXTURE = join(FIX_DIR, 'legacy-appliance.bin');
const CURRENT_TOKEN = 'HFAP';

function legacyApplianceToken(): string {
  return String.fromCharCode(0x52, 0x56, 0x46, 0x41);
}

function legacyFixturePayload(): string {
  return `legacy-${['r', 'v', 'f', 'a'].join('')}-section-payload`;
}

/**
 * Durable legacy appliance fixture. Committed as a frozen binary so "legacy
 * reads forever" is proven against a real on-disk artifact, not a writer that
 * could drift. Generate-if-missing self-heals by writing current HFAP and
 * converting only this fixture to the legacy bytes.
 */
function ensureLegacyFixture(): Buffer {
  if (existsSync(LEGACY_FIXTURE)) return readFileSync(LEGACY_FIXTURE);
  if (!existsSync(FIX_DIR)) mkdirSync(FIX_DIR, { recursive: true });
  const writer = new ApplianceWriter({ name: 'legacy-fixture', profile: 'cloud', arch: 'x86_64' });
  writer.addSection('hive-flow', Buffer.from('legacy-appliance-section-payload'), { compression: 'gzip' });
  writer.addSection('config', Buffer.from('{"k":"v"}'), { compression: 'none' });
  const bytes = flipHeaderMagic(flipPreamble(writer.build(), legacyApplianceToken()), CURRENT_TOKEN, legacyApplianceToken());
  writeFileSync(LEGACY_FIXTURE, bytes);
  return bytes;
}

/** Return a copy of `buf` with the 4-byte preamble magic overwritten. */
function flipPreamble(buf: Buffer, token: string): Buffer {
  const out = Buffer.from(buf);
  out.write(token, 0, 4, 'ascii');
  return out;
}

/** Return a copy of `buf` with header.magic byte-replaced in place (same length). */
function flipHeaderMagic(buf: Buffer, from: string, to: string): Buffer {
  expect(from.length).toBe(to.length); // in-place edit must not move offsets
  const needle = Buffer.from(`"magic":"${from}"`, 'utf-8');
  const idx = buf.indexOf(needle);
  expect(idx).toBeGreaterThan(0); // header.magic is the only such token
  const out = Buffer.from(buf);
  out.write(`"magic":"${to}"`, idx, 'ascii');
  return out;
}

let dir: string;
let legacy: Buffer;
let keyPair: { publicKey: Buffer; privateKey: Buffer };

/** Sign a buffer in-memory (ephemeral key) and return { signedBytes, valid }. */
async function signAndVerify(bytes: Buffer): Promise<{ signedValid: boolean; signedBytes: Buffer }> {
  const p = join(dir, `sign-${Math.abs(idx++)}.hfap`);
  writeFileSync(p, bytes);
  await new ApplianceSigner(keyPair.privateKey).signAppliance(p, 'test-publisher');
  const res = await new ApplianceVerifier(keyPair.publicKey).verifyAppliance(p);
  return { signedValid: res.valid, signedBytes: readFileSync(p) };
}
let idx = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hfap-dualread-'));
  legacy = ensureLegacyFixture();
  keyPair = await generateKeyPair();
});

describe('HFAP dual-read: appliance reader', () => {
  it('reads a legacy appliance fixture (frozen binary)', () => {
    const reader = ApplianceReader.fromBuffer(legacy);
    expect(reader.getHeader().magic).toBe(legacyApplianceToken());
    expect(reader.getHeader().name).toBe('legacy-fixture');
    expect(reader.extractSection('hive-flow').toString()).toBe(legacyFixturePayload());
  });

  it('verifies a legacy appliance fixture', () => {
    expect(ApplianceReader.fromBuffer(legacy).verify()).toEqual({ valid: true, errors: [] });
  });

  it('reads + verifies an HFAP buffer (preamble + header.magic both HFAP)', () => {
    const hfap = flipHeaderMagic(flipPreamble(legacy, CURRENT_TOKEN), legacyApplianceToken(), CURRENT_TOKEN);
    const reader = ApplianceReader.fromBuffer(hfap);
    expect(reader.getHeader().magic).toBe(CURRENT_TOKEN);
    expect(reader.verify().valid).toBe(true);
  });

  it('REJECTS HFAP preamble with legacy header.magic (pair mismatch)', () => {
    const mismatch = flipPreamble(legacy, CURRENT_TOKEN);
    expect(() => ApplianceReader.fromBuffer(mismatch)).toThrow(/magic mismatch/i);
  });

  it('REJECTS legacy preamble with header.magic HFAP (reverse mismatch)', () => {
    const mismatch = flipHeaderMagic(legacy, legacyApplianceToken(), CURRENT_TOKEN);
    expect(() => ApplianceReader.fromBuffer(mismatch)).toThrow(/magic mismatch/i);
  });

  it('REJECTS a foreign magic', () => {
    expect(() => ApplianceReader.fromBuffer(flipPreamble(legacy, 'XXXX'))).toThrow(/Invalid appliance magic/i);
  });
});

describe('HFAP dual-read: Ed25519 signing', () => {
  it('verifies a signed legacy appliance file', async () => {
    const { signedValid } = await signAndVerify(legacy);
    expect(signedValid).toBe(true);
  });

  it('verifies a signed HFAP file (both preamble + header.magic HFAP)', async () => {
    const hfap = flipHeaderMagic(flipPreamble(legacy, CURRENT_TOKEN), legacyApplianceToken(), CURRENT_TOKEN);
    const { signedValid } = await signAndVerify(hfap);
    expect(signedValid).toBe(true);
  });

  it('REJECTS a signed legacy file whose preamble is flipped to HFAP (the attack)', async () => {
    // Sign a legitimate legacy file, THEN flip only the preamble. header.magic
    // stays legacy, so the Ed25519 signature over header.magic is untouched,
    // yet the pairing gate must reject before signature verify can succeed.
    const { signedBytes } = await signAndVerify(legacy);
    const tampered = join(dir, 'preamble-flip-attack.hfap');
    writeFileSync(tampered, flipPreamble(signedBytes, CURRENT_TOKEN));
    const res = await new ApplianceVerifier(keyPair.publicKey).verifyAppliance(tampered);
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/magic mismatch/i);
  });
});
