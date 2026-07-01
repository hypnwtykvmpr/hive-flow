import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DROPPED_INTEGRATION_PROHIBITED } from './debrand-prohibited-patterns.js';
import { isScannedTextFile, REPO_ROOT, trackedFilesForShippedSurfaces } from './debrand-static-scope.js';

describe('DB-4 dropped legacy swarm integration', () => {
  it('has zero dropped integration references in tracked shipped source, docs, helpers, and generated-template surfaces', () => {
    const hits = trackedFilesForShippedSurfaces()
      .filter(isScannedTextFile)
      .flatMap((relativePath) => {
        const absolutePath = resolve(REPO_ROOT, relativePath);
        const content = readFileSync(absolutePath, 'utf8');
        return DROPPED_INTEGRATION_PROHIBITED
          .filter(({ pattern }) => pattern.test(content))
          .map(({ label, pattern }) => `${relativePath.split(sep).join('/')}: ${label}: ${pattern}`);
      });

    expect(hits, '[DB-4 grep-zero] dropped legacy swarm integration references in shipped surfaces').toEqual([]);
  });
});
