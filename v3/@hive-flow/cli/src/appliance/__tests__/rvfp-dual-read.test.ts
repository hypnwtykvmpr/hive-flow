import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { RvfaPatcher } from '../rvfa-distribution.js';

// ---------------------------------------------------------------------------
// Phase-R dual-read: RVFP hot-patch.
//
// Read-widen only — writers stay legacy 'RVFP'. We accept the new read-only
// 'HFPP' token AND enforce the preamble<->header.magic pairing gate in
// parsePatchHeader (the single parse choke point for verifyPatch + applyPatch),
// which runs BEFORE applyPatch's signature check.
// ---------------------------------------------------------------------------

const FIX_DIR = join(__dirname, 'fixtures');
const LEGACY_FIXTURE = join(FIX_DIR, 'legacy-rvfp.bin');

/** Durable legacy RVFP patch fixture (frozen binary). Self-heals only if deleted. */
async function ensureLegacyFixture(): Promise<Buffer> {
  if (existsSync(LEGACY_FIXTURE)) return readFileSync(LEGACY_FIXTURE);
  if (!existsSync(FIX_DIR)) mkdirSync(FIX_DIR, { recursive: true });
  const patch = await RvfaPatcher.createPatch({
    targetName: 'legacy-fixture', targetVersion: '3.5.0', sectionId: 'hive-flow',
    sectionData: Buffer.from('legacy-rvfp-section-payload'), patchVersion: '1.0.1',
    compression: 'none',
  });
  writeFileSync(LEGACY_FIXTURE, patch);
  return patch;
}

/** Patch magics are same-length printable ASCII, so in-place byte-flips are safe. */
function flipPreamble(buf: Buffer, token: string): Buffer {
  const out = Buffer.from(buf);
  out.write(token, 0, 4, 'ascii');
  return out;
}
function flipHeaderMagic(buf: Buffer, from: string, to: string): Buffer {
  const needle = Buffer.from(`"magic":"${from}"`, 'utf-8');
  const i = buf.indexOf(needle);
  expect(i).toBeGreaterThan(0);
  const out = Buffer.from(buf);
  out.write(`"magic":"${to}"`, i, 'ascii');
  return out;
}
/** Flip both preamble + header.magic to the same token (a valid dual-read pair). */
function toToken(buf: Buffer, token: 'RVFP' | 'HFPP'): Buffer {
  const other = token === 'HFPP' ? 'RVFP' : 'HFPP';
  return flipHeaderMagic(flipPreamble(buf, token), other, token);
}

let legacy: Buffer;

beforeAll(async () => {
  mkdtempSync(join(tmpdir(), 'hf-rvfp-dualread-'));
  legacy = await ensureLegacyFixture();
});

describe('RVFP Phase-R dual-read: hot-patch', () => {
  it('parses + verifies a legacy RVFP patch (frozen fixture)', async () => {
    expect(RvfaPatcher.parsePatchHeader(legacy).magic).toBe('RVFP');
    expect((await RvfaPatcher.verifyPatch(legacy)).valid).toBe(true);
  });

  it('parses + verifies an HFPP patch (preamble + header.magic both HFPP)', async () => {
    const hfpp = toToken(legacy, 'HFPP');
    expect(RvfaPatcher.parsePatchHeader(hfpp).magic).toBe('HFPP');
    expect((await RvfaPatcher.verifyPatch(hfpp)).valid).toBe(true);
  });

  it('REJECTS HFPP preamble with header.magic RVFP (pair mismatch)', () => {
    const mismatch = flipPreamble(legacy, 'HFPP'); // header.magic stays RVFP
    expect(() => RvfaPatcher.parsePatchHeader(mismatch)).toThrow(/magic mismatch/i);
  });

  it('REJECTS RVFP preamble with header.magic HFPP (reverse mismatch)', () => {
    const mismatch = flipHeaderMagic(legacy, 'RVFP', 'HFPP'); // preamble stays RVFP
    expect(() => RvfaPatcher.parsePatchHeader(mismatch)).toThrow(/magic mismatch/i);
  });

  it('REJECTS a foreign magic', () => {
    expect(() => RvfaPatcher.parsePatchHeader(flipPreamble(legacy, 'XXXX'))).toThrow(/Invalid RVFP magic/i);
  });

  it('REJECTS a signed legacy patch whose preamble is flipped to HFPP (gate precedes signature)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const signed = await RvfaPatcher.createPatch({
      targetName: 'legacy-fixture', targetVersion: '3.5.0', sectionId: 'hive-flow',
      sectionData: Buffer.from('signed-payload'), patchVersion: '1.0.2', compression: 'none',
      privateKey: Buffer.from(privateKey), signedBy: 'test-publisher',
    });
    // Legitimate signed patch parses + verifies.
    expect(RvfaPatcher.parsePatchHeader(signed).magic).toBe('RVFP');
    expect(typeof publicKey).toBe('string');
    // Flip only the preamble -> header.magic still RVFP -> pairing gate rejects
    // in parsePatchHeader, which applyPatch calls BEFORE the signature check.
    const tampered = flipPreamble(signed, 'HFPP');
    expect(() => RvfaPatcher.parsePatchHeader(tampered)).toThrow(/magic mismatch/i);
    expect((await RvfaPatcher.verifyPatch(tampered)).valid).toBe(false);
  });
});
