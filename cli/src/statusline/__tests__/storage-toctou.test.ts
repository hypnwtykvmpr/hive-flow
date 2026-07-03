// cli/src/statusline/__tests__/storage-toctou.test.ts
//
// Statusboard audit Slice A — TOCTOU bounded-read regression suite.
//
// readJsonFileStrict / readJsonl classify the target via lstat and THEN read
// it. The fix replaced the post-classify `readFile(path,'utf8')` (which slurps
// the whole file into memory before any post-hoc size guard) with a bounded
// `open()+read()` loop capped at `maxBytes + 1`. A swapped/grown file in the
// TOCTOU window between classify's lstat and the read therefore can no longer
// be fully materialized.
//
// To simulate the window deterministically we mock `lstat` so classify sees a
// SMALL size while the file on disk is huge — exactly the race the unbounded
// readFile was vulnerable to. The test asserts the read aborts (oversize /
// corrupt) and the heap does not balloon to the file size; it would FAIL
// against the old unbounded `readFile` (which would load the full payload).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Re-export node:fs/promises through a mock so per-test vi.spyOn can intercept
// `lstat`. `...actual` preserves every real behavior; only the scoped spy
// rewrites the size classify() observes.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual };
});

import { readJsonFile, readJsonFileStrict, readJsonl } from '../storage.js';

const FIVE_MIB = 5 * 1024 * 1024;

// Capture the genuine lstat ONCE (before any spy replaces it).
let realLstat: typeof fsPromises.lstat;

/**
 * Spy on lstat so the TARGET path reports `fakeSize` (small enough to pass
 * classify) while every other path resolves through the real lstat (so the
 * symlink path-walk inside `assertSafeStatuslineStoragePath` still works).
 */
function spoofLstatSize(targetPath: string, fakeSize: number): void {
  vi.spyOn(fsPromises, 'lstat').mockImplementation((async (
    p: Parameters<typeof fsPromises.lstat>[0],
  ) => {
    const stats = await realLstat(p as string);
    if (String(p) === targetPath) {
      // Override only the size; keep the real isFile()/isSymbolicLink()/etc.
      Object.defineProperty(stats, 'size', { value: fakeSize, configurable: true });
    }
    return stats;
  }) as unknown as typeof fsPromises.lstat);
}

describe('storage TOCTOU bounded reads (Slice A)', () => {
  let root: string;
  beforeEach(async () => {
    realLstat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat;
    root = mkdtempSync(join(tmpdir(), 'hf-toctou-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('readJsonFileStrict does not materialize a file that grew past the cap after classify', async () => {
    const file = join(root, '.hive-flow', 'big.json');
    mkdirSync(join(root, '.hive-flow'), { recursive: true });
    // 5 MiB on disk; valid JSON so the ONLY thing stopping a full load is the
    // bounded cap (a parse error would also stop it, so keep it parseable).
    writeFileSync(file, '{"data":"' + 'x'.repeat(FIVE_MIB) + '"}');
    expect(statSync(file).size).toBeGreaterThanOrEqual(FIVE_MIB);

    // classify() will see a 64-byte "safe" file (the TOCTOU window); the real
    // file is 5 MiB. The bounded loop (cap 1 MiB) must abort before loading it.
    spoofLstatSize(file, 64);

    const beforeHeap = process.memoryUsage().heapUsed;
    const strict = await readJsonFileStrict(file, 1024 * 1024);
    const afterHeap = process.memoryUsage().heapUsed;

    expect(strict.kind).toBe('oversize');
    // The bounded buffer is cap+1 (~1 MiB); the old unbounded readFile would
    // have loaded the full 5 MiB. Allow generous GC headroom but well under 5 MiB.
    expect(afterHeap - beforeHeap).toBeLessThan(3 * 1024 * 1024);
    // Loose wrapper collapses oversize to undefined.
    expect(await readJsonFile(file, 1024 * 1024)).toBeUndefined();
  });

  it('readJsonl does not materialize a file that grew past the cap after classify', async () => {
    const ledger = join(root, '.hive-flow', 'big.jsonl');
    mkdirSync(join(root, '.hive-flow'), { recursive: true });
    // 5 MiB JSONL on disk.
    writeFileSync(ledger, '{"id":1}\n'.repeat(Math.ceil(FIVE_MIB / 9)));
    expect(statSync(ledger).size).toBeGreaterThanOrEqual(FIVE_MIB);

    spoofLstatSize(ledger, 64);

    const beforeHeap = process.memoryUsage().heapUsed;
    const parsed = await readJsonl(ledger, { maxBytes: 1024 * 1024 });
    const afterHeap = process.memoryUsage().heapUsed;

    // Overflow during the bounded read surfaces as a single corrupt marker.
    expect(parsed).toEqual({ events: [], corrupt: 1 });
    expect(afterHeap - beforeHeap).toBeLessThan(3 * 1024 * 1024);
  });

  it('happy path: a small file under the cap still round-trips through the bounded read', async () => {
    const file = join(root, '.hive-flow', 'small.json');
    mkdirSync(join(root, '.hive-flow'), { recursive: true });
    const payload = { hello: 'world', n: 42 };
    writeFileSync(file, JSON.stringify(payload));
    // No spoof: real lstat. The bounded loop must not truncate a small file.
    expect(await readJsonFile(file, 1024 * 1024)).toEqual(payload);
  });
});
