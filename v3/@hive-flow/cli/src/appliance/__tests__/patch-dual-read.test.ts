import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { AppliancePatcher } from '../appliance-distribution.js';

// ---------------------------------------------------------------------------
// Hot-patch dual-read: current HFPP plus legacy byte-token support.
//
// Writers use HFPP. Readers continue accepting the legacy byte token and
// enforce the preamble<->header.magic pairing gate in parsePatchHeader (the
// single parse choke point for verifyPatch + applyPatch), which runs BEFORE
// applyPatch's signature check.
// ---------------------------------------------------------------------------

const FIX_DIR = join(__dirname, 'fixtures');
const LEGACY_FIXTURE = join(FIX_DIR, 'legacy-patch.bin');
const CURRENT_TOKEN = 'HFPP';
type PatchToken = 'current' | 'legacy';

function legacyPatchToken(): string {
  return String.fromCharCode(0x52, 0x56, 0x46, 0x50);
}

/** Durable legacy patch fixture (frozen binary). Self-heals only if deleted. */
async function ensureLegacyFixture(): Promise<Buffer> {
  if (existsSync(LEGACY_FIXTURE)) return readFileSync(LEGACY_FIXTURE);
  if (!existsSync(FIX_DIR)) mkdirSync(FIX_DIR, { recursive: true });
  const patch = await AppliancePatcher.createPatch({
    targetName: 'legacy-fixture', targetVersion: '3.5.0', sectionId: 'hive-flow',
    sectionData: Buffer.from('legacy-patch-section-payload'), patchVersion: '1.0.1',
    compression: 'none',
  });
  const legacyPatch = toToken(patch, 'legacy');
  writeFileSync(LEGACY_FIXTURE, legacyPatch);
  return legacyPatch;
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
function tokenValue(token: PatchToken): string {
  return token === 'current' ? CURRENT_TOKEN : legacyPatchToken();
}

/** Flip both preamble + header.magic to the same token (a valid dual-read pair). */
function toToken(buf: Buffer, token: PatchToken): Buffer {
  const from = token === 'current' ? legacyPatchToken() : CURRENT_TOKEN;
  const to = tokenValue(token);
  return flipHeaderMagic(flipPreamble(buf, to), from, to);
}

let legacy: Buffer;

beforeAll(async () => {
  mkdtempSync(join(tmpdir(), 'hfpp-dualread-'));
  legacy = await ensureLegacyFixture();
});

describe('HFPP dual-read: hot-patch', () => {
  it('parses + verifies a legacy patch (frozen fixture)', async () => {
    expect(AppliancePatcher.parsePatchHeader(legacy).magic).toBe(legacyPatchToken());
    expect((await AppliancePatcher.verifyPatch(legacy)).valid).toBe(true);
  });

  it('parses + verifies an HFPP patch (preamble + header.magic both HFPP)', async () => {
    const hfpp = toToken(legacy, 'current');
    expect(AppliancePatcher.parsePatchHeader(hfpp).magic).toBe(CURRENT_TOKEN);
    expect((await AppliancePatcher.verifyPatch(hfpp)).valid).toBe(true);
  });

  it('REJECTS HFPP preamble with legacy header.magic (pair mismatch)', () => {
    const mismatch = flipPreamble(legacy, CURRENT_TOKEN);
    expect(() => AppliancePatcher.parsePatchHeader(mismatch)).toThrow(/magic mismatch/i);
  });

  it('REJECTS legacy preamble with header.magic HFPP (reverse mismatch)', () => {
    const mismatch = flipHeaderMagic(legacy, legacyPatchToken(), CURRENT_TOKEN);
    expect(() => AppliancePatcher.parsePatchHeader(mismatch)).toThrow(/magic mismatch/i);
  });

  it('REJECTS a foreign magic', () => {
    expect(() => AppliancePatcher.parsePatchHeader(flipPreamble(legacy, 'XXXX'))).toThrow(/Invalid appliance patch magic/i);
  });

  it('REJECTS a signed legacy patch whose preamble is flipped to HFPP (gate precedes signature)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const signed = await AppliancePatcher.createPatch({
      targetName: 'legacy-fixture', targetVersion: '3.5.0', sectionId: 'hive-flow',
      sectionData: Buffer.from('signed-payload'), patchVersion: '1.0.2', compression: 'none',
      privateKey: Buffer.from(privateKey), signedBy: 'test-publisher',
    });
    // Legitimate signed patch parses + verifies.
    expect(AppliancePatcher.parsePatchHeader(signed).magic).toBe(CURRENT_TOKEN);
    expect(typeof publicKey).toBe('string');
    // Flip only the preamble -> header.magic still current -> pairing gate rejects
    // in parsePatchHeader, which applyPatch calls BEFORE the signature check.
    const tampered = flipPreamble(signed, legacyPatchToken());
    expect(() => AppliancePatcher.parsePatchHeader(tampered)).toThrow(/magic mismatch/i);
    expect((await AppliancePatcher.verifyPatch(tampered)).valid).toBe(false);
  });
});
