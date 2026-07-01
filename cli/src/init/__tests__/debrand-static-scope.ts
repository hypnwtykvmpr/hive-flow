import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '../../../..');

export const SHIPPED_SURFACE_ROOTS = [
  'AGENTS.md',
  'README.md',
  'CLAUDE.md',
  'LICENSE',
  'package.json',
  'bin',
  'scripts',
  '.agents',
  'v3/README.md',
  'v3/CLAUDE.md',
  'v3/CHANGELOG.md',
  'v3/swarm.config.ts',
  'v3/plugins',
  '.claude/commands',
  '.claude/skills',
  '.agents/skills',
  '.claude-plugin',
  'plugin',
  '.github/dependabot.yml',
  '.gitignore',
  'cli',
  'hive-flow-npm',
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
  'pnpm-lock.yaml',
] as const;

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.full',
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

export function trackedFilesForShippedSurfaces(): string[] {
  const args = ['ls-files', '--', ...SHIPPED_SURFACE_ROOTS];
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isScannedTextFile(relativePath: string): boolean {
  if (EXCLUDED_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  if (relativePath.split('/').some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment))) return false;
  const absolutePath = resolve(REPO_ROOT, relativePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return false;
  return TEXT_EXTENSIONS.has(extname(relativePath));
}
