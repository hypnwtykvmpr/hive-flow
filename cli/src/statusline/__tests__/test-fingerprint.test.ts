// cli/src/statusline/__tests__/test-fingerprint.test.ts
//
// Behavioural tests for the content-aware test-source fingerprint. These
// tests follow the Phase 4.5 spec in the canonical merged runbook
// (Codex-merged-statusline-implementation-runbook-2026-05-20.md), updated
// for Codex's Phase 2 round-3 improvement: the fingerprint is computed by
// hashing *file contents*, not by parsing `git status` text.
//
// What the suite exercises:
//   1. Stability: two consecutive calls on an unchanged tree produce
//      identical digests, identical file-count, and identical file maps.
//   2. Sensitivity to a single file's content change.
//   3. Deletion tracking via `D <relpath>\n` markers folded into the
//      digest before file contents.
//   4. Glob respect: a non-matching `.ts` file (e.g. `src/index.ts`) does
//      NOT contribute to the digest; only `*.test.ts` / `__tests__/**` do.
//   5. Bounded byte budget: a tree whose total test-file byte count
//      exceeds the configured budget is REFUSED with
//      `FingerprintByteBudgetExceededError`.
//   6. Bounded file-count: a tree with more test files than the configured
//      cap marks `truncated: true` but still returns a stable digest.
//   7. Concurrent invocations with identical inputs return identical
//      digests (single-flight cache behaviour + race-safety).
//   8. Hidden directories (`.cache`, `.next`) and ignored basenames
//      (`node_modules`, `dist`, `coverage`) are excluded.
//   9. Custom `testGlobs` override the defaults (`__custom__/**`).
//
// All tests use `mkdtempSync(tmpdir())` so they are self-contained — no
// git repo, no fixture I/O against the worktree root.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  computeSourceFingerprint,
  FingerprintByteBudgetExceededError,
  DEFAULT_MAX_FINGERPRINT_FILES,
  DEFAULT_MAX_FINGERPRINT_BYTES,
  DEFAULT_TEST_GLOBS,
  type SourceFingerprintFile,
} from '../test-fingerprint.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mkTmpRoot(prefix = 'hf-fp-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFile(root: string, rel: string, body: string): void {
  const abs = join(root, ...rel.split('/'));
  const dir = abs.slice(0, abs.lastIndexOf(sep));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeSourceFingerprint (content-aware)', () => {
  let root: string;

  beforeEach(() => {
    root = mkTmpRoot();
    // Minimal mixed tree: two test files, one ordinary source file (should
    // be excluded), one fixture inside `__tests__/`.
    writeFile(root, 'src/index.ts', 'export const x = 1;\n');
    writeFile(root, 'src/a.test.ts', 'import { describe } from "vitest";\n');
    writeFile(root, 'src/b.test.ts', 'describe("b", () => {});\n');
    writeFile(root, '__tests__/fixtures/sample.json', '{"k":"v"}\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns a stable digest across two identical calls', async () => {
    const a = await computeSourceFingerprint({ projectRoot: root });
    const b = await computeSourceFingerprint({ projectRoot: root });
    expect(a.version).toBe(1);
    expect(b.sha256).toBe(a.sha256);
    expect(b.fileCount).toBe(a.fileCount);
    expect([...b.files.keys()].sort()).toEqual([...a.files.keys()].sort());
    // Walk root is normalised to absolute & resolved.
    expect(a.walkRoot.length).toBeGreaterThan(0);
    expect(a.walkRoot).toBe(b.walkRoot);
    // Sanity: at least the two `.test.ts` files plus the `__tests__/` fixture
    // are picked up by the defaults.
    expect(a.fileCount).toBeGreaterThanOrEqual(2);
  });

  it('changes the digest when a single matched file content changes', async () => {
    const before = await computeSourceFingerprint({ projectRoot: root });
    appendFileSync(join(root, 'src/a.test.ts'), 'export const y = 2;\n');
    const after = await computeSourceFingerprint({ projectRoot: root });
    expect(after.sha256).not.toBe(before.sha256);
    // The per-file hash for `src/a.test.ts` must differ between snapshots.
    expect(after.files.get('src/a.test.ts')?.sha256).not.toBe(
      before.files.get('src/a.test.ts')?.sha256,
    );
    // Other matched files are untouched.
    expect(after.files.get('src/b.test.ts')?.sha256).toBe(
      before.files.get('src/b.test.ts')?.sha256,
    );
  });

  it('does NOT change the digest when a non-test source file changes', async () => {
    const before = await computeSourceFingerprint({ projectRoot: root });
    // `src/index.ts` does not match `**/*.test.ts` / `__tests__/**`; mutating
    // it must leave the fingerprint untouched.
    appendFileSync(join(root, 'src/index.ts'), '\nexport const z = 3;\n');
    const after = await computeSourceFingerprint({ projectRoot: root });
    expect(after.sha256).toBe(before.sha256);
    expect(after.files.has('src/index.ts')).toBe(false);
  });

  it('records deletions in the digest via D <relpath> markers', async () => {
    const before = await computeSourceFingerprint({ projectRoot: root });
    // Delete one matched file but keep the rest of the tree intact.
    rmSync(join(root, 'src/b.test.ts'), { force: true });
    const after = await computeSourceFingerprint({
      projectRoot: root,
      priorFingerprintFiles: before.files,
    });
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.deletions).toContain('src/b.test.ts');
    expect(after.files.has('src/b.test.ts')).toBe(false);
    // Reasonable invariant: deletion alone is what changed the digest, so
    // the file map of the surviving files must match the prior snapshot.
    for (const [rel, meta] of after.files.entries()) {
      expect(before.files.get(rel)?.sha256).toBe(meta.sha256);
    }
  });

  it('treats a re-created file with identical content as unchanged after prior', async () => {
    // Stability under "delete then write back with same bytes" — the
    // fingerprint should converge to the original digest.
    const original = await computeSourceFingerprint({ projectRoot: root });
    const path = join(root, 'src/a.test.ts');
    const fileMeta: SourceFingerprintFile | undefined =
      original.files.get('src/a.test.ts');
    expect(fileMeta).toBeDefined();
    rmSync(path);
    writeFile(root, 'src/a.test.ts', 'import { describe } from "vitest";\n');
    const after = await computeSourceFingerprint({ projectRoot: root });
    expect(after.sha256).toBe(original.sha256);
  });

  it('refuses to fingerprint when total bytes exceed maxFingerprintBytes', async () => {
    // Two 32 KiB test files; budget = 40 KiB. Exceeds on the second file.
    writeFile(root, 'src/big1.test.ts', 'x'.repeat(32 * 1024));
    writeFile(root, 'src/big2.test.ts', 'y'.repeat(32 * 1024));
    await expect(
      computeSourceFingerprint({
        projectRoot: root,
        maxFingerprintBytes: 40 * 1024,
      }),
    ).rejects.toBeInstanceOf(FingerprintByteBudgetExceededError);
  });

  it('marks truncated and stops the walk when maxFingerprintFiles is reached', async () => {
    // Create > maxFiles test files in a fresh tree.
    const max = 5;
    for (let i = 0; i < max + 4; i++) {
      writeFile(root, `gen/g${i}.test.ts`, `// gen ${i}\n`);
    }
    const fp = await computeSourceFingerprint({
      projectRoot: root,
      maxFingerprintFiles: max,
    });
    expect(fp.truncated).toBe(true);
    expect(fp.fileCount).toBeLessThanOrEqual(max);
    // A second identical call returns the same digest (truncation is
    // deterministic because the walker sorts each directory).
    const fp2 = await computeSourceFingerprint({
      projectRoot: root,
      maxFingerprintFiles: max,
    });
    expect(fp2.sha256).toBe(fp.sha256);
  });

  it('respects a custom testGlobs override', async () => {
    // `.spec.tsx` is also a default-matched extension, so pick something
    // outside the default set: `*.feature` (gherkin) — under `__custom__/`.
    writeFile(root, '__custom__/login.feature', 'Feature: login\n');
    const def = await computeSourceFingerprint({ projectRoot: root });
    // Without override: `.feature` is ignored.
    expect(def.files.has('__custom__/login.feature')).toBe(false);
    // With override: only `.feature` files participate.
    const custom = await computeSourceFingerprint({
      projectRoot: root,
      testGlobs: ['**/*.feature'],
    });
    expect(custom.fileCount).toBe(1);
    expect(custom.files.has('__custom__/login.feature')).toBe(true);
    // And the two digests differ because the matched corpus differs.
    expect(custom.sha256).not.toBe(def.sha256);
  });

  it('excludes ignored directories (node_modules, dist, coverage, .git)', async () => {
    writeFile(
      root,
      'node_modules/somepkg/something.test.ts',
      'export const ignore = 1;\n',
    );
    writeFile(root, 'dist/output.test.ts', 'export const ignore2 = 1;\n');
    writeFile(root, 'coverage/cov.test.ts', 'export const ignore3 = 1;\n');
    writeFile(root, '.git/hooks/pre.test.ts', 'export const ignore4 = 1;\n');
    const fp = await computeSourceFingerprint({ projectRoot: root });
    for (const key of fp.files.keys()) {
      expect(
        key.startsWith('node_modules/') ||
          key.startsWith('dist/') ||
          key.startsWith('coverage/') ||
          key.startsWith('.git/'),
      ).toBe(false);
    }
  });

  it('returns an empty stable digest when the walk root has no test files', async () => {
    const bareRoot = mkTmpRoot();
    try {
      writeFile(bareRoot, 'README.md', '# nothing\n');
      const a = await computeSourceFingerprint({ projectRoot: bareRoot });
      const b = await computeSourceFingerprint({ projectRoot: bareRoot });
      expect(a.fileCount).toBe(0);
      expect(a.sha256).toBe(b.sha256);
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty result when the walk root does not exist', async () => {
    const missing = join(root, 'this-path-does-not-exist');
    const fp = await computeSourceFingerprint({ projectRoot: missing });
    expect(fp.fileCount).toBe(0);
    expect(fp.sha256.length).toBe(64);
    expect(fp.walkRoot.endsWith('this-path-does-not-exist')).toBe(true);
  });

  it('concurrent fingerprint calls with identical inputs return identical digests', async () => {
    // Run several concurrent calls; the single-flight cache should coalesce
    // them and they must all return equal digests and file maps.
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        computeSourceFingerprint({ projectRoot: root }),
      ),
    );
    const first = results[0]!;
    for (const r of results) {
      expect(r.sha256).toBe(first.sha256);
      expect(r.fileCount).toBe(first.fileCount);
    }
  });

  it('concurrent fingerprint calls with different priors do not contaminate each other', async () => {
    // Two priors with different "deleted" content set; the resulting digests
    // must differ even when issued concurrently.
    const seed = await computeSourceFingerprint({ projectRoot: root });
    // Synthesize a second, smaller "prior" that pretends only one file
    // existed before. Both invocations target the same current tree, so
    // the digest difference must come from the prior-derived deletion set.
    const priorWithExtra = new Map<string, SourceFingerprintFile>(seed.files);
    priorWithExtra.set('src/c.test.ts', {
      mtimeMs: 0,
      size: 0,
      sha256: 'a'.repeat(64),
      oversize: false,
    });
    const [a, b] = await Promise.all([
      computeSourceFingerprint({ projectRoot: root, priorFingerprintFiles: seed.files }),
      computeSourceFingerprint({
        projectRoot: root,
        priorFingerprintFiles: priorWithExtra,
      }),
    ]);
    // First call uses the actual prior -> no deletions -> matches seed.
    expect(a.deletions.length).toBe(0);
    // Second call: extra synthetic file in prior was never present -> 1
    // deletion -> different digest.
    expect(b.deletions).toContain('src/c.test.ts');
    expect(b.sha256).not.toBe(a.sha256);
  });

  it('rejects non-absolute projectRoot', async () => {
    await expect(
      computeSourceFingerprint({ projectRoot: 'relative/path' }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects malformed testGlobs entries', async () => {
    await expect(
      computeSourceFingerprint({
        projectRoot: root,
        // empty string is invalid
        testGlobs: [''],
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('exports stable default constants', () => {
    expect(DEFAULT_MAX_FINGERPRINT_FILES).toBe(1000);
    expect(DEFAULT_MAX_FINGERPRINT_BYTES).toBe(50 * 1024 * 1024);
    expect(DEFAULT_TEST_GLOBS.length).toBeGreaterThan(0);
    // Sanity: defaults contain the runbook-mandated patterns.
    expect(DEFAULT_TEST_GLOBS).toContain('**/*.test.ts');
    expect(DEFAULT_TEST_GLOBS).toContain('**/__tests__/**');
  });
});
