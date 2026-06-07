import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DROPPED_INTEGRATION_PROHIBITED } from './debrand-prohibited-patterns.js';

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
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

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
