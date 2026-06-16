/**
 * Regression test for d9-002: embedding ArrayBuffer length corruption.
 *
 * Bug: store() used Buffer.from(entry.embedding.buffer) which writes the
 * ENTIRE backing ArrayBuffer when the Float32Array is a subarray view
 * (byteOffset > 0).  Reload reconstructed a Float32Array over ALL those bytes,
 * inflating the dimension count and corrupting values.
 *
 * Fix: store uses Buffer.from(buf, byteOffset, byteLength); reload copies into
 * a fresh, offset-free ArrayBuffer of the exact element count.
 *
 * The test creates a subarray view and asserts length + values survive a
 * store → retrieve round-trip through SqlJsBackend.
 */

import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqlJsBackend } from './sqljs-backend.js';
import { createDefaultEntry } from './types.js';

// Resolve the local sql-wasm.wasm so tests don't attempt a CDN fetch.
const WASM_PATH = resolve(
  __dirname,
  '../../../node_modules/.pnpm/sql.js@1.14.1/node_modules/sql.js/dist/sql-wasm.wasm',
);

describe('d9-002: SqlJsBackend embedding subarray round-trip', () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = new SqlJsBackend({ databasePath: ':memory:', verbose: false, wasmPath: WASM_PATH });
    await backend.initialize();
  });

  afterEach(async () => {
    await backend.shutdown();
  });

  it('round-trips a subarray Float32Array without inflating the dimension count', async () => {
    // Build a 16-element backing buffer; our embedding occupies elements [4, 12).
    const bigBuf = new Float32Array(16);
    for (let i = 0; i < 16; i++) bigBuf[i] = i * 10;

    // subarray view: byteOffset = 4*4 = 16, byteLength = 8*4 = 32
    const emb = bigBuf.subarray(4, 12);
    expect(emb.length).toBe(8);
    expect(emb.byteOffset).toBe(16); // confirms it IS a view, not a fresh buffer

    const entry = createDefaultEntry({
      key: 'subarray-emb-test',
      content: 'test content',
      namespace: 'test',
    });
    // Assign embedding directly — createDefaultEntry does not pass it through
    entry.embedding = emb;

    await backend.store(entry);

    const retrieved = await backend.get(entry.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.embedding).toBeDefined();

    const out = retrieved!.embedding!;

    // Dimension must be 8, NOT 16 (the full backing buffer size)
    expect(out.length).toBe(8);

    // Values must match the subarray slice [4*10 .. 11*10]
    for (let i = 0; i < 8; i++) {
      expect(out[i]).toBe((i + 4) * 10);
    }
  });

  it('round-trips a non-subarray (byteOffset=0) Float32Array correctly', async () => {
    const emb = new Float32Array([1.1, 2.2, 3.3, 4.4]);
    expect(emb.byteOffset).toBe(0);

    const entry = createDefaultEntry({
      key: 'normal-emb-test',
      content: 'normal content',
      namespace: 'test',
    });
    entry.embedding = emb;

    await backend.store(entry);

    const retrieved = await backend.get(entry.id);
    expect(retrieved!.embedding).toBeDefined();
    const out = retrieved!.embedding!;

    expect(out.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(out[i]).toBeCloseTo(emb[i], 5);
    }
  });
});
