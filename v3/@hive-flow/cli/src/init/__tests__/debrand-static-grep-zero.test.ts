import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEBRAND_ASSERT_ZERO_PROHIBITED } from './debrand-prohibited-patterns.js';
import { isScannedTextFile, REPO_ROOT, trackedFilesForShippedSurfaces } from './debrand-static-scope.js';

const CLASSIFIED_STATIC_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'v3/@hive-flow/cli/src/appliance/rvfa-builder.ts:content:dropped legacy umbrella brand',
    'RVFA serialized section/package identity is deferred to DB-RVFA dual-read migration.',
  ],
  [
    'v3/@hive-flow/cli/src/appliance/rvfa-format.ts:content:old RuVector brand',
    'RVFA format name is an on-disk identity and is deferred to DB-RVFA/DB-6 handling.',
  ],
  [
    'v3/@hive-flow/cli/src/appliance/rvfa-format.ts:content:dropped legacy umbrella brand',
    'RVFA default boot/format strings are deferred to DB-RVFA dual-read migration.',
  ],
  [
    'v3/@hive-flow/cli/src/appliance/rvfa-runner.ts:content:dropped legacy umbrella brand',
    'RVFA reader section identity is deferred to DB-RVFA dual-read migration.',
  ],
]);

describe('DB-5 static prohibited debrand sweep', () => {
  it('has zero prohibited debrand strings in widened tracked shipped surfaces', () => {
    const findings = collectStaticFindings();
    const hits = findings
      .filter(({ key }) => !CLASSIFIED_STATIC_EXCEPTIONS.has(key))
      .map(({ message }) => message);

    expect(hits, '[DB-5 grep-zero] prohibited debrand strings in widened shipped surfaces').toEqual([]);
  });

  it('keeps static exception list synchronized with real deferred RVFA hits', () => {
    const findingKeys = new Set(collectStaticFindings().map(({ key }) => key));
    const stale = [...CLASSIFIED_STATIC_EXCEPTIONS.keys()].filter((key) => !findingKeys.has(key));

    expect(stale, '[DB-5 grep-zero] remove stale static debrand exception entries').toEqual([]);
  });
});

function collectStaticFindings(): Array<{ key: string; message: string }> {
  return trackedFilesForShippedSurfaces()
    .filter(isScannedTextFile)
    .flatMap((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      const content = readFileSync(absolutePath, 'utf8');
      const normalizedPath = relativePath.split(sep).join('/');
      return DEBRAND_ASSERT_ZERO_PROHIBITED.flatMap(({ label, pattern }) => {
        const findings: Array<{ key: string; message: string }> = [];
        if (pattern.test(normalizedPath)) {
          findings.push({
            key: `${normalizedPath}:path:${label}`,
            message: `${normalizedPath}: path: ${label}: ${pattern}`,
          });
        }
        if (pattern.test(content)) {
          findings.push({
            key: `${normalizedPath}:content:${label}`,
            message: `${normalizedPath}: content: ${label}: ${pattern}`,
          });
        }
        return findings;
      });
    });
}
