import { describe, it, expect, beforeAll } from 'vitest';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RvfaReader, RvfaWriter } from '../rvfa-format.js';
import { generateKeyPair, RvfaSigner, RvfaVerifier } from '../rvfa-signing.js';

// ---------------------------------------------------------------------------
// Phase-R dual-read: appliance reader + Ed25519 signing.
//
// Read-widen only — writers stay legacy 'RVFA'. We accept the new read-only
// 'HFAP' token AND enforce a preamble<->header.magic pairing gate that must
// reject BEFORE any checksum/signature trust (the signing digest covers
// header.magic but NOT the raw 4-byte preamble).
// ---------------------------------------------------------------------------

const FIX_DIR = join(__dirname, 'fixtures');
const LEGACY_FIXTURE = join(FIX_DIR, 'legacy-rvfa.bin');

/**
 * Durable legacy RVFA fixture. Committed as a frozen binary so "legacy reads
 * forever" is proven against a real on-disk artifact, not a writer that could
 * drift. Generate-if-missing only self-heals a deleted fixture; the committed
 * bytes are never overwritten on a normal run.
 */
function ensureLegacyFixture(): Buffer {
  if (existsSync(LEGACY_FIXTURE)) return readFileSync(LEGACY_FIXTURE);
  if (!existsSync(FIX_DIR)) mkdirSync(FIX_DIR, { recursive: true });
  const writer = new RvfaWriter({ name: 'legacy-fixture', profile: 'cloud', arch: 'x86_64' });
  writer.addSection('hive-flow', Buffer.from('legacy-rvfa-section-payload'), { compression: 'gzip' });
  writer.addSection('config', Buffer.from('{"k":"v"}'), { compression: 'none' });
  const bytes = writer.build();
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
  const p = join(dir, `sign-${Math.abs(idx++)}.rvf`);
  writeFileSync(p, bytes);
  await new RvfaSigner(keyPair.privateKey).signAppliance(p, 'test-publisher');
  const res = await new RvfaVerifier(keyPair.publicKey).verifyAppliance(p);
  return { signedValid: res.valid, signedBytes: readFileSync(p) };
}
let idx = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hf-rvfa-dualread-'));
  legacy = ensureLegacyFixture();
  keyPair = await generateKeyPair();
});

describe('RVFA Phase-R dual-read: appliance reader', () => {
  it('reads a legacy RVFA fixture (frozen binary)', () => {
    const reader = RvfaReader.fromBuffer(legacy);
    expect(reader.getHeader().magic).toBe('RVFA');
    expect(reader.getHeader().name).toBe('legacy-fixture');
    expect(reader.extractSection('hive-flow').toString()).toBe('legacy-rvfa-section-payload');
  });

  it('verifies a legacy RVFA fixture', () => {
    expect(RvfaReader.fromBuffer(legacy).verify()).toEqual({ valid: true, errors: [] });
  });

  it('reads + verifies an HFAP buffer (preamble + header.magic both HFAP)', () => {
    const hfap = flipHeaderMagic(flipPreamble(legacy, 'HFAP'), 'RVFA', 'HFAP');
    const reader = RvfaReader.fromBuffer(hfap);
    expect(reader.getHeader().magic).toBe('HFAP');
    expect(reader.verify().valid).toBe(true);
  });

  it('REJECTS HFAP preamble with header.magic still RVFA (pair mismatch)', () => {
    const mismatch = flipPreamble(legacy, 'HFAP'); // header.magic stays RVFA
    expect(() => RvfaReader.fromBuffer(mismatch)).toThrow(/magic mismatch/i);
  });

  it('REJECTS RVFA preamble with header.magic HFAP (reverse mismatch)', () => {
    const mismatch = flipHeaderMagic(legacy, 'RVFA', 'HFAP'); // preamble stays RVFA
    expect(() => RvfaReader.fromBuffer(mismatch)).toThrow(/magic mismatch/i);
  });

  it('REJECTS a foreign magic', () => {
    expect(() => RvfaReader.fromBuffer(flipPreamble(legacy, 'XXXX'))).toThrow(/Invalid RVFA magic/i);
  });
});

describe('RVFA Phase-R dual-read: Ed25519 signing', () => {
  it('verifies a signed legacy RVFA file', async () => {
    const { signedValid } = await signAndVerify(legacy);
    expect(signedValid).toBe(true);
  });

  it('verifies a signed HFAP file (both preamble + header.magic HFAP)', async () => {
    const hfap = flipHeaderMagic(flipPreamble(legacy, 'HFAP'), 'RVFA', 'HFAP');
    const { signedValid } = await signAndVerify(hfap);
    expect(signedValid).toBe(true);
  });

  it('REJECTS a signed legacy file whose preamble is flipped to HFAP (the attack)', async () => {
    // Sign a legitimate legacy file, THEN flip only the preamble. header.magic
    // stays RVFA, so the Ed25519 signature over header.magic is untouched —
    // yet the pairing gate must reject before signature verify can succeed.
    const { signedBytes } = await signAndVerify(legacy);
    const tampered = join(dir, 'preamble-flip-attack.rvf');
    writeFileSync(tampered, flipPreamble(signedBytes, 'HFAP'));
    const res = await new RvfaVerifier(keyPair.publicKey).verifyAppliance(tampered);
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/magic mismatch/i);
  });
});
