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
      'v3/@hive-flow/cli/bin/npx-repair.js',
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
    const repairModule = (await import(pathToFileURL(resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/npx-repair.js')).href)) as {
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
    expect(repairModule.isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/@hive-flow/cli/memory'))).toBe(true);

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
    const repairModule = (await import(pathToFileURL(resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/npx-repair.js')).href)) as {
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

// ── d8-003: preinstall.cjs anchored matching ───────────────────────────────

describe('d8-003: preinstall.cjs uses anchored cacache matching', () => {
  const preinstallPath = resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/preinstall.cjs');

  it('preinstall.cjs no longer contains the broad naive substring predicate', () => {
    const src = readFileSync(preinstallPath, 'utf8');

    // The old one-liner that caused the bug — must be gone
    expect(src).not.toMatch(
      /return\s+String\([^)]+\)\.indexOf\('hive-flow'\)\s*!==\s*-1\s*;/,
    );

    // The anchored registry URL patterns must be present (source has backslash-escaped dots)
    expect(src).toContain('registry\\.npmjs\\.org\\/hive-flow');
    // @hive-flow scope pattern — now also matches URL-encoded %2F separator
    expect(src).toContain('registry\\.npmjs\\.org\\/@hive-flow');
    expect(src).toContain('%2[fF]');

    // Line-level pruning helper must exist (replaces whole-bucket delete)
    expect(src).toContain('pruneOrDeleteCacheBucket');
  });

  it('preinstall.cjs isHiveFlowCacheIndexEntry function body uses anchored patterns', () => {
    const src = readFileSync(preinstallPath, 'utf8');

    const fnStart = src.indexOf('function isHiveFlowCacheIndexEntry(');
    expect(fnStart).toBeGreaterThan(-1);

    // Find the closing brace of the function (first \n} after the function open)
    const fnEnd = src.indexOf('\n}', fnStart) + 2;
    expect(fnEnd).toBeGreaterThan(fnStart);

    const fnBody = src.slice(fnStart, fnEnd);

    // Must contain anchored URL patterns (backslash-escaped in regex literals)
    expect(fnBody).toContain('registry\\.npmjs\\.org\\/hive-flow');
    // @hive-flow scope — now also matches URL-encoded %2F separator
    expect(fnBody).toContain('registry\\.npmjs\\.org\\/@hive-flow');
    expect(fnBody).toContain('%2[fF]');

    // Must NOT be a one-liner that just does indexOf on the raw content
    expect(fnBody).not.toMatch(
      /return\s+String\([^)]+\)\.indexOf\('hive-flow'\)\s*!==\s*-1\s*;/,
    );
  });

  it('root package.json preinstall delegates to preinstall.cjs rather than inlining a broad check', () => {
    const pkgJson = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgJson) as { scripts?: { preinstall?: string } };

    const preinstall = pkg.scripts?.preinstall ?? '';

    // Must reference preinstall.cjs
    expect(preinstall).toContain('preinstall.cjs');

    // Must NOT contain the old broad inline cacache substring scan
    expect(preinstall).not.toContain("indexOf('hive-flow') !== -1");
    expect(preinstall).not.toContain(".includes('hive-flow')");
  });

  it('preinstall.cjs correctly accepts real hive-flow entries and rejects false positives (source-text assertions)', () => {
    const src = readFileSync(preinstallPath, 'utf8');

    // The @hive-flow scope pattern must be present (backslash-escaped in regex literals).
    // After d8-003 fix the pattern includes (?:\/|%2[fF]) rather than a bare \/ so we
    // check the common stem and the encoded-variant token separately.
    expect(src).toContain('registry\\.npmjs\\.org\\/@hive-flow');
    expect(src).toContain('%2[fF]');

    // An anchoring terminator for the bare `hive-flow` package must be present to
    // prevent matching `hive-flow-unrelated`.
    // Must contain some form of termination guard — either [/?#] or (?:[/?#]|$)
    const hasCharClass = src.includes('[/?#]');
    const hasNonCapture = src.includes('(?:[/?#]|$)');
    expect(hasCharClass || hasNonCapture).toBe(true);
  });

  // d8-003 fix: encoded scope (%2F / %2f) must also match
  it('preinstall.cjs predicate must contain the encoded-scope pattern %2[fF]', () => {
    const src = readFileSync(preinstallPath, 'utf8');
    expect(src).toContain('%2[fF]');
  });
});

// ── d8-003 BEHAVIORAL: encoded @hive-flow%2F scope ───────────────────────────

describe('d8-003 behavioral: encoded @hive-flow scope matches in both repair files', () => {
  /** Build a cacache JSONL line with a URL-encoded scope separator. */
  function makeEncodedCacheLine(url: string): string {
    const key = `make-fetch-happen:request-cache:${url}`;
    return `abc123def456\t${JSON.stringify({ key, integrity: 'sha512-fake==', time: 1000, size: 100 })}`;
  }

  // ── v3/@hive-flow/cli/bin/npx-repair.js (ESM) ────────────────────────────

  it('v3/@hive-flow/cli/bin/npx-repair.js: matches encoded %2f (lowercase)', async () => {
    const { isHiveFlowCacheIndexEntry } = (await import(
      pathToFileURL(resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/npx-repair.js')).href
    )) as { isHiveFlowCacheIndexEntry: (content: string) => boolean };

    expect(isHiveFlowCacheIndexEntry(makeEncodedCacheLine('https://registry.npmjs.org/@hive-flow%2fcli'))).toBe(true);
  });

  it('v3/@hive-flow/cli/bin/npx-repair.js: matches encoded %2F (uppercase)', async () => {
    const { isHiveFlowCacheIndexEntry } = (await import(
      pathToFileURL(resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/npx-repair.js')).href
    )) as { isHiveFlowCacheIndexEntry: (content: string) => boolean };

    expect(isHiveFlowCacheIndexEntry(makeEncodedCacheLine('https://registry.npmjs.org/@hive-flow%2Fcli'))).toBe(true);
  });

  it('v3/@hive-flow/cli/bin/npx-repair.js: matches unencoded @hive-flow/cli', async () => {
    const { isHiveFlowCacheIndexEntry } = (await import(
      pathToFileURL(resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/npx-repair.js')).href
    )) as { isHiveFlowCacheIndexEntry: (content: string) => boolean };

    expect(isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/@hive-flow/cli'))).toBe(true);
  });

  it('v3/@hive-flow/cli/bin/npx-repair.js: matches bare hive-flow package', async () => {
    const { isHiveFlowCacheIndexEntry } = (await import(
      pathToFileURL(resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/npx-repair.js')).href
    )) as { isHiveFlowCacheIndexEntry: (content: string) => boolean };

    expect(isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/hive-flow'))).toBe(true);
  });

  it('v3/@hive-flow/cli/bin/npx-repair.js: rejects false positives (left-pad, claude-flow, not-hive-flow, my-hive-flow-helper)', async () => {
    const { isHiveFlowCacheIndexEntry } = (await import(
      pathToFileURL(resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/npx-repair.js')).href
    )) as { isHiveFlowCacheIndexEntry: (content: string) => boolean };

    expect(isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/left-pad'))).toBe(false);
    expect(isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/claude-flow'))).toBe(false);
    expect(isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/not-hive-flow'))).toBe(false);
    expect(isHiveFlowCacheIndexEntry(makeCacheLine('https://registry.npmjs.org/my-hive-flow-helper'))).toBe(false);
    // A left-pad line whose description merely mentions "hive-flow"
    const leftPadKey = `make-fetch-happen:request-cache:https://registry.npmjs.org/left-pad`;
    const leftPadMentionLine = `abc\t${JSON.stringify({ key: leftPadKey, description: 'mentions hive-flow only' })}`;
    expect(isHiveFlowCacheIndexEntry(leftPadMentionLine)).toBe(false);
  });

  it('v3/@hive-flow/cli/bin/npx-repair.js: pruneHiveFlowCacheIndexBucket removes encoded @hive-flow lines, preserves unrelated', async () => {
    const { pruneHiveFlowCacheIndexBucket } = (await import(
      pathToFileURL(resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/npx-repair.js')).href
    )) as {
      pruneHiveFlowCacheIndexBucket: (content: string) => { removed: number; survivors: string; deleteBucket: boolean };
    };

    const encodedLine = makeEncodedCacheLine('https://registry.npmjs.org/@hive-flow%2fcli');
    const leftPadLine = makeCacheLine('https://registry.npmjs.org/left-pad');

    // Mixed bucket: encoded hive-flow line is removed, left-pad is preserved.
    const mixed = pruneHiveFlowCacheIndexBucket(`${encodedLine}\n${leftPadLine}`);
    expect(mixed.removed).toBe(1);
    expect(mixed.deleteBucket).toBe(false);
    expect(mixed.survivors).toContain(leftPadLine);
    expect(mixed.survivors).not.toContain(encodedLine);

    // Only encoded hive-flow → bucket should be flagged for deletion.
    const allEncoded = pruneHiveFlowCacheIndexBucket(`\n${encodedLine}`);
    expect(allEncoded.removed).toBe(1);
    expect(allEncoded.deleteBucket).toBe(true);
  });

  // ── v3/@hive-flow/cli/bin/preinstall.cjs: integration probe via temp HOME ──

  it('preinstall.cjs: prunes encoded @hive-flow%2fcli line and preserves left-pad (Repro 2 scenario)', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync: fsWrite, readFileSync: fsRead, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');

    const tmp = mkdtempSync(pathJoin(tmpdir(), 'hf-test-'));
    const bucketDir = pathJoin(tmp, '.npm', '_cacache', 'index-v5', 'aa', 'bb');
    mkdirSync(bucketDir, { recursive: true });
    const bucketFile = pathJoin(bucketDir, 'bucket');

    const encodedLine = `h1\t${JSON.stringify({ key: 'make-fetch-happen:request-cache:https://registry.npmjs.org/@hive-flow%2fcli' })}`;
    const leftPadLine = `h2\t${JSON.stringify({ key: 'make-fetch-happen:request-cache:https://registry.npmjs.org/left-pad', description: 'mentions hive-flow only' })}`;

    fsWrite(bucketFile, `${encodedLine}\n${leftPadLine}\n`, 'utf-8');

    spawnSync(
      process.execPath,
      [resolve(REPO_ROOT, 'v3/@hive-flow/cli/bin/preinstall.cjs')],
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: tmp,
          npm_config_user_agent: 'pnpm/9.15.9 npm/? node/?',
        },
      },
    );

    const after = fsRead(bucketFile, 'utf-8');

    // The encoded @hive-flow line must be pruned.
    expect(after).not.toContain('@hive-flow%2fcli');
    // The unrelated left-pad line must survive.
    expect(after).toContain('left-pad');
  });
});
