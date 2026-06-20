import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUSPECT_LEGACY_RU_PREFIX } from './debrand-prohibited-patterns.js';
import { isScannedTextFile, REPO_ROOT, trackedFilesForShippedSurfaces } from './debrand-static-scope.js';

interface ClassifiedSuspect {
  readonly classification: 'compatibility-alias' | 'migration-deferred';
  readonly reason: string;
}

const CLASSIFIED_SUSPECTS: ReadonlyMap<string, ClassifiedSuspect> = new Map([
]);

function hitKey(relativePath: string, location: 'path' | 'content', label: string): string {
  return `${relativePath}:${location}:${label}`;
}

describe('DB-5 legacy ru-prefix suspect classification', () => {
  it('has no unclassified suspect ru-prefixed tokens in widened tracked shipped surfaces', () => {
    const findings = collectSuspectFindings();
    const unclassified = findings
      .filter(({ key }) => !CLASSIFIED_SUSPECTS.has(key))
      .map(({ key, pattern }) => `${key}: ${pattern}`);

    expect(unclassified, '[DB-5 ru-audit] classify or remove suspect legacy ru-prefixed tokens').toEqual([]);
  });

  it('keeps the documented ru-prefix allowlist synchronized with real hits', () => {
    const findingKeys = new Set(collectSuspectFindings().map(({ key }) => key));
    const stale = [...CLASSIFIED_SUSPECTS.keys()].filter((key) => !findingKeys.has(key));

    expect(stale, '[DB-5 ru-audit] remove stale legacy ru-prefix allowlist entries').toEqual([]);
  });
});

function collectSuspectFindings(): Array<{ key: string; pattern: RegExp }> {
  return trackedFilesForShippedSurfaces()
    .filter(isScannedTextFile)
    .flatMap((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      const content = readFileSync(absolutePath, 'utf8');
      const normalizedPath = relativePath.split(sep).join('/');
      return SUSPECT_LEGACY_RU_PREFIX.flatMap(({ label, pattern }) => {
        const findings: Array<{ key: string; pattern: RegExp }> = [];
        if (pattern.test(normalizedPath)) findings.push({ key: hitKey(normalizedPath, 'path', label), pattern });
        if (pattern.test(content)) findings.push({ key: hitKey(normalizedPath, 'content', label), pattern });
        return findings;
      });
    });
}
