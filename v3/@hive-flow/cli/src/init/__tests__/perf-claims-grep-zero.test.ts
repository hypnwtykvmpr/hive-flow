import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ProhibitedPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const REPO_ROOT = resolve(__dirname, '../../../../../..');

const SHIPPED_SURFACE_ROOTS = [
  'README.md',
  'CLAUDE.md',
  'v3/README.md',
  'v3/CLAUDE.md',
  'v3/CHANGELOG.md',
  'v3/index.ts',
  'v3/swarm.config.ts',
  'v3/helpers',
  '.claude',
  '.agents/skills',
  'v3/@hive-flow',
] as const;

const EXCLUDED_PATH_SEGMENTS = new Set([
  '__tests__',
  'tests',
  'dist',
  'node_modules',
  'data',
  'wasm-pkg',
  'cloud-functions',
]);

const EXCLUDED_SUFFIXES = [
  '.test.ts',
  '.test.js',
  '.spec.ts',
  '.spec.js',
  '.map',
  '.db',
  '.db-shm',
  '.db-wal',
] as const;

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ps1',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

const PROHIBITED_PERF_CLAIMS: ProhibitedPattern[] = [
  {
    label: 'fictional HNSW speed multiplier',
    pattern: /\b(?:150\s*x|12,?500\s*x|150\s*x\s*(?:-|–|to|and)\s*12,?500\s*x)\b/i,
  },
  {
    label: 'fictional Flash Attention speed range',
    pattern: /\b2\.49\s*x\s*(?:-|–|to)\s*7\.47\s*x\b/i,
  },
  {
    label: 'fictional SWE-Bench solve rate',
    pattern: /\b84\.8\s*%/,
  },
  {
    label: 'fictional SONA adaptation latency',
    pattern: /(?:<\s*)?0\.05\s*ms/i,
  },
  {
    label: 'old RuVector intelligence label',
    pattern: /RuVector Intelligence System/,
  },
];

function trackedFilesForShippedSurfaces(): string[] {
  const args = ['ls-files', '--', ...SHIPPED_SURFACE_ROOTS];
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isScannedTextFile(relativePath: string): boolean {
  if (EXCLUDED_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  if (relativePath.split('/').some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) return false;
  const absolutePath = resolve(REPO_ROOT, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return false;
  return TEXT_EXTENSIONS.has(extname(relativePath));
}

describe('DB-2 prohibited performance claims', () => {
  it('has zero fictional performance claims in tracked shipped source, docs, helpers, and generated-template surfaces', () => {
    const hits = trackedFilesForShippedSurfaces()
      .filter(isScannedTextFile)
      .flatMap((relativePath) => {
        const absolutePath = resolve(REPO_ROOT, relativePath);
        const content = readFileSync(absolutePath, 'utf8');
        return PROHIBITED_PERF_CLAIMS
          .filter(({ pattern }) => pattern.test(content))
          .map(({ label, pattern }) => `${relativePath.split(sep).join('/')}: ${label}: ${pattern}`);
      });

    expect(
      hits,
      '[DB-2 grep-zero] prohibited fictional performance claims in shipped surfaces',
    ).toEqual([]);
  });
});
