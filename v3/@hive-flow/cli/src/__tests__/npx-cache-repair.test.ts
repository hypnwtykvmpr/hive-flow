import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../../..');

/** Build a realistic cacache JSONL line for a given npm registry URL. */
function makeCacheLine(url: string): string {
  const key = `make-fetch-happen:request-cache:${url}`;
  return `abc123def456\t${JSON.stringify({ key, integrity: 'sha512-fake==', time: 1000, size: 100 })}`;
}

describe('npx cache repair pruning', () => {
  it('keeps the hive-flow cacache predicate non-tautological across shipped repair paths', () => {
    const files = [
      'package.json',
      'hive-flow-npm/package.json',
      'bin/npx-repair.js',
      'v3/@hive-flow/cli/bin/preinstall.cjs',
    ];
    const duplicateHiveFlowPredicate =
      /(content|content2|c)\.(?:includes\('hive-flow'\)|indexOf\('hive-flow'\)\s*!==\s*-1)\s*\|\|\s*\1\.(?:includes\('hive-flow'\)|indexOf\('hive-flow'\)\s*!==\s*-1)/;

    const hits = files.filter((file) =>
      duplicateHiveFlowPredicate.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
    );

    expect(hits).toEqual([]);
  });

  it('classifies hive-flow cacache entries without pruning unrelated package entries', async () => {
    const repairModule = (await import(pathToFileURL(resolve(REPO_ROOT, 'bin/npx-repair.js')).href)) as {
      isHiveFlowCacheIndexEntry: (content: string) => boolean;
    };

    // ── TRUE: real hive-flow registry keys ────────────────────────────────
    // Bare registry URL (legacy / fallback path)
    expect(repairModule.isHiveFlowCacheIndexEntry('https://registry.npmjs.org/hive-flow')).toBe(true);
    expect(repairModule.isHiveFlowCacheIndexEntry('https://registry.npmjs.org/@hive-flow/cli')).toBe(true);

    // Realistic cacache JSONL lines (make-fetch-happen key field)
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/hive-flow'))).toBe(true);
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/hive-flow/-/hive-flow-3.0.0.tgz'))).toBe(true);
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/@hive-flow/cli'))).toBe(true);
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/@hive-flow/cli/-/cli-3.0.0.tgz'))).toBe(true);
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/@hive-flow/memory'))).toBe(true);

    // ── FALSE: unrelated packages that must NOT be evicted ────────────────
    expect(repairModule.isHiveFlowCacheIndexEntry('https://registry.npmjs.org/left-pad')).toBe(false);
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/left-pad'))).toBe(false);

    // "claude-flow" must not match even though it contains a similar token
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/claude-flow'))).toBe(false);

    // A package whose name starts with "hive-flow-" but is unrelated
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/hive-flow-unrelated'))).toBe(false);

    // A bucket that contains ONLY unrelated entries must not match
    const unrelatedBucket = [
      makeCacheLine('https://registry.npmjs.org/left-pad'),
      makeCacheLine('https://registry.npmjs.org/claude-flow'),
      makeCacheLine('https://registry.npmjs.org/hive-flow-unrelated'),
    ].join('\n');
    const bucketLines = unrelatedBucket.split('\n');
    const anyMatch = bucketLines.some((line) => repairModule.isHiveFlowCacheIndexEntry(line));
    expect(anyMatch).toBe(false);
  });

  it('pruneHiveFlowCacheIndexBucket removes only hive-flow lines and flags empty buckets', async () => {
    const repairModule = (await import(pathToFileURL(resolve(REPO_ROOT, 'bin/npx-repair.js')).href)) as {
      pruneHiveFlowCacheIndexBucket: (content: string) => {
        removed: number;
        survivors: string;
        deleteBucket: boolean;
      };
    };
    const { pruneHiveFlowCacheIndexBucket } = repairModule;

    const hiveLine = makeCacheLine('https://registry.npmjs.org/@hive-flow/cli');
    const unrelatedLine = makeCacheLine('https://registry.npmjs.org/left-pad');

    // ── MIXED bucket: drop the one hive-flow line, keep the unrelated one ──
    const mixed = pruneHiveFlowCacheIndexBucket(`${hiveLine}\n${unrelatedLine}`);
    expect(mixed.removed).toBe(1);
    expect(mixed.deleteBucket).toBe(false);
    expect(mixed.survivors).toContain(unrelatedLine);
    expect(mixed.survivors).not.toContain(hiveLine);

    // ── ALL hive-flow (cacache writes a leading blank line) -> delete bucket ──
    const allHive = pruneHiveFlowCacheIndexBucket(`\n${hiveLine}\n${makeCacheLine('https://registry.npmjs.org/hive-flow')}`);
    expect(allHive.removed).toBe(2);
    expect(allHive.deleteBucket).toBe(true);
    expect(allHive.survivors.trim()).toBe('');

    // ── UNRELATED only: no removals, content unchanged ──
    const unrelatedOnly = `${unrelatedLine}\n${makeCacheLine('https://registry.npmjs.org/claude-flow')}`;
    const untouched = pruneHiveFlowCacheIndexBucket(unrelatedOnly);
    expect(untouched.removed).toBe(0);
    expect(untouched.deleteBucket).toBe(false);
    expect(untouched.survivors).toBe(unrelatedOnly);
  });
});
