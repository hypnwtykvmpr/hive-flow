import { describe, it, expect, beforeAll } from 'vitest';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BinaryBackend } from '../binary-backend.js';
import { BinaryMigrator } from '../binary-migration.js';
import type { MemoryEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Phase-R dual-read: memory binary backend.
//
// Read-widen only — writers stay legacy 'RVF\0'. We accept the new read-only
// 'HFDB' token AND enforce a preamble<->header.magic pairing gate: loadFromDisk
// previously checked only the preamble and never compared it to header.magic,
// so a mismatch was a silent-accept gap. It must now reject (load 0 entries).
// ---------------------------------------------------------------------------

const FIX_DIR = join(__dirname, 'fixtures');
const LEGACY_FIXTURE = join(FIX_DIR, 'legacy-rvf.bin');

function entry(id: string, key: string): MemoryEntry {
  return {
    id, key, content: `content-${id}`, type: 'semantic', namespace: 'fixtures',
    tags: [], metadata: {}, accessLevel: 'private',
    createdAt: 1700000000000, updatedAt: 1700000000000, version: 1,
    references: [], accessCount: 0, lastAccessedAt: 1700000000000,
  };
}

/**
 * Durable legacy RVF\0 memory fixture. Committed as a frozen binary so "legacy
 * reads forever" is proven against a real artifact, not a writer that could
 * drift. Generate-if-missing only self-heals a deleted fixture.
 */
async function ensureLegacyFixture(): Promise<Buffer> {
  if (existsSync(LEGACY_FIXTURE)) return readFileSync(LEGACY_FIXTURE);
  if (!existsSync(FIX_DIR)) mkdirSync(FIX_DIR, { recursive: true });
  const b = new BinaryBackend({ databasePath: LEGACY_FIXTURE, autoPersistInterval: 0 });
  await b.initialize();
  await b.store(entry('m1', 'alpha'));
  await b.store(entry('m2', 'beta'));
  await b.shutdown(); // persists
  return readFileSync(LEGACY_FIXTURE);
}

/** 4-byte preamble for a memory magic token. */
function preambleBytes(magic: 'RVF\0' | 'HFDB'): Buffer {
  return magic === 'HFDB' ? Buffer.from('HFDB', 'ascii') : Buffer.from([0x52, 0x56, 0x46, 0x00]);
}

/**
 * Rebuild a memory file with a chosen preamble magic and header.magic. The
 * header.magic JSON-encodes at different byte-lengths per token, so we
 * re-serialize the header (entries are sequential length-prefixed records with
 * no absolute offsets, so they survive a header-length change unchanged).
 */
function reMagic(buf: Buffer, preamble: 'RVF\0' | 'HFDB', headerMagic: 'RVF\0' | 'HFDB'): Buffer {
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf-8')) as Record<string, unknown>;
  header.magic = headerMagic;
  const newHeader = Buffer.from(JSON.stringify(header), 'utf-8');
  const entries = buf.subarray(8 + headerLen);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(newHeader.length, 0);
  return Buffer.concat([preambleBytes(preamble), lenBuf, newHeader, entries]);
}

let dir: string;
let legacy: Buffer;

async function loadCount(bytes: Buffer, name: string): Promise<number> {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  const b = new BinaryBackend({ databasePath: p, autoPersistInterval: 0 });
  await b.initialize();
  const n = await b.count();
  await b.shutdown();
  return n;
}

async function detect(bytes: Buffer, name: string): Promise<string> {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return BinaryMigrator.detectFormat(p);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hf-rvf-dualread-'));
  legacy = await ensureLegacyFixture();
});

describe('RVF Phase-R dual-read: memory backend', () => {
  it('loads a legacy RVF\\0 fixture + detectFormat -> rvf', async () => {
    expect(await loadCount(legacy, 'legacy.bin')).toBe(2);
    expect(await detect(legacy, 'legacy-detect.bin')).toBe('rvf');
  });

  it('loads an HFDB file (preamble + header.magic both HFDB) + detectFormat -> rvf', async () => {
    const hfdb = reMagic(legacy, 'HFDB', 'HFDB');
    expect(await loadCount(hfdb, 'hfdb.bin')).toBe(2);
    expect(await detect(hfdb, 'hfdb-detect.bin')).toBe('rvf');
  });

  it('REJECTS HFDB preamble with header.magic RVF\\0 (never silently loaded)', async () => {
    const mismatch = reMagic(legacy, 'HFDB', 'RVF\0');
    expect(await loadCount(mismatch, 'hfdb-pre-rvf-hdr.bin')).toBe(0);
  });

  it('REJECTS RVF\\0 preamble with header.magic HFDB (reverse mismatch)', async () => {
    const mismatch = reMagic(legacy, 'RVF\0', 'HFDB');
    expect(await loadCount(mismatch, 'rvf-pre-hfdb-hdr.bin')).toBe(0);
  });

  it('ignores a foreign magic (loads nothing, detect -> unknown)', async () => {
    const foreign = Buffer.concat([Buffer.from('XXXX', 'ascii'), legacy.subarray(4)]);
    expect(await loadCount(foreign, 'foreign.bin')).toBe(0);
    expect(await detect(foreign, 'foreign-detect.bin')).toBe('unknown');
  });
});
