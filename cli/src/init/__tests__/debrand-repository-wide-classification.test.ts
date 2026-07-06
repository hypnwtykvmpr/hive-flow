import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORE_PROHIBITED,
  DROPPED_INTEGRATION_PROHIBITED,
  DROPPED_UMBRELLA_PROHIBITED,
  URL_AND_INSTALL_PROHIBITED,
  type ProhibitedPattern,
} from './debrand-prohibited-patterns.js';
import { REPO_ROOT } from './debrand-static-scope.js';

const REPOSITORY_WIDE_PROHIBITED: readonly ProhibitedPattern[] = [
  ...CORE_PROHIBITED,
  ...DROPPED_INTEGRATION_PROHIBITED,
  ...DROPPED_UMBRELLA_PROHIBITED,
  ...URL_AND_INSTALL_PROHIBITED.filter(({ label }) => label === 'bare public Flow Nexus domain'),
];

const REPOSITORY_WIDE_CLASSIFIED_EXCEPTIONS: ReadonlyMap<string, string> = new Map([]);

const EXCLUDED_PATH_SEGMENTS = new Set([
  '.git',
  '.hive-flow',
  'data',
  'dist',
  'node_modules',
  'wasm-pkg',
]);

const EXCLUDED_SUFFIXES = [
  '.db',
  '.db-shm',
  '.db-wal',
  '.map',
  'pnpm-lock.yaml',
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

describe('repository-wide debrand classification', () => {
  it('has no unclassified legacy brand/domain hits across tracked text surfaces', () => {
    const findings = collectRepositoryWideFindings();
    const unclassified = findings
      .filter(({ key }) => !REPOSITORY_WIDE_CLASSIFIED_EXCEPTIONS.has(key))
      .map(({ message }) => message);

    expect(unclassified, '[Slice E] classify or remove legacy brand/domain hits across tracked text').toEqual([]);
  });

  it('keeps repository-wide classification exceptions synchronized', () => {
    const findingKeys = new Set(collectRepositoryWideFindings().map(({ key }) => key));
    const stale = [...REPOSITORY_WIDE_CLASSIFIED_EXCEPTIONS.keys()]
      .filter((key) => !findingKeys.has(key));

    expect(stale, '[Slice E] remove stale repository-wide debrand exception entries').toEqual([]);
  });

  it('has no legacy brand/domain hits in the npm package dry-run surface', () => {
    const findings = collectPackageSurfaceFindings();

    expect(findings, '[Slice E] npm package dry-run surface must stay debranded').toEqual([]);
  }, 30_000);
});

function collectRepositoryWideFindings(): Array<{ key: string; message: string }> {
  return trackedTextFiles()
    .flatMap((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      const content = readFileSync(absolutePath, 'utf8');
      const normalizedPath = relativePath.split(sep).join('/');
      return REPOSITORY_WIDE_PROHIBITED.flatMap(({ label, pattern }) => {
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

function collectPackageSurfaceFindings(): string[] {
  const npmCache = mkdtempSync(join(tmpdir(), 'hf-debrand-pack-cache-'));
  try {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: resolve(REPO_ROOT, 'cli'),
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    return parsed[0].files
      .map((file) => file.path)
      .filter((relativePath) => TEXT_EXTENSIONS.has(extname(relativePath)))
      .flatMap((relativePath) => {
        const absolutePath = resolve(REPO_ROOT, 'cli', relativePath);
        if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return [];
        const content = readFileSync(absolutePath, 'utf8');
        return REPOSITORY_WIDE_PROHIBITED.flatMap(({ label, pattern }) => {
          const findings: string[] = [];
          if (pattern.test(relativePath)) findings.push(`${relativePath}: path: ${label}: ${pattern}`);
          if (pattern.test(content)) findings.push(`${relativePath}: content: ${label}: ${pattern}`);
          return findings;
        });
      });
  } finally {
    rmSync(npmCache, { recursive: true, force: true });
  }
}

function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((relativePath) => !EXCLUDED_SUFFIXES.some((suffix) => relativePath.endsWith(suffix)))
    .filter((relativePath) => !relativePath.split('/').some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment)))
    .filter((relativePath) => TEXT_EXTENSIONS.has(extname(relativePath)))
    .filter((relativePath) => {
      const absolutePath = resolve(REPO_ROOT, relativePath);
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    });
}
