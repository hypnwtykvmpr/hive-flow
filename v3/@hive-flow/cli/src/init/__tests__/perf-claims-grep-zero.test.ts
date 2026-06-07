import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERF_CLAIM_PROHIBITED } from './debrand-prohibited-patterns.js';
import { isScannedTextFile, REPO_ROOT, trackedFilesForShippedSurfaces } from './debrand-static-scope.js';

describe('DB-2 prohibited performance claims', () => {
  it('has zero fictional performance claims in tracked shipped source, docs, helpers, and generated-template surfaces', () => {
    const hits = trackedFilesForShippedSurfaces()
      .filter(isScannedTextFile)
      .flatMap((relativePath) => {
        const absolutePath = resolve(REPO_ROOT, relativePath);
        const content = readFileSync(absolutePath, 'utf8');
        return PERF_CLAIM_PROHIBITED
          .filter(({ pattern }) => pattern.test(content))
          .map(({ label, pattern }) => `${relativePath.split(sep).join('/')}: ${label}: ${pattern}`);
      });

    expect(
      hits,
      '[DB-2 grep-zero] prohibited fictional performance claims in shipped surfaces',
    ).toEqual([]);
  });
});
