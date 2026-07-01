import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateMCPConfig, generateMCPJson } from '../mcp-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../types.js';

function findRepoRoot(start = __dirname): string {
  let current = resolve(start);
  for (;;) {
    if (
      existsSync(resolve(current, 'package.json')) &&
      existsSync(resolve(current, 'cli', 'package.json'))
    ) {
      return current;
    }
    const parent = resolve(current, '..');
    if (parent === current) throw new Error('Unable to locate hive-flow repo root');
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot();
const NEGATIVE_ASSERTION_FIXTURES = new Set([
  'cli/src/init/__tests__/mcp-generator-package-tag.test.ts',
]);
const FORBIDDEN_PACKAGE_TAGS = [
  'hive-flow@latest',
  '@hive-flow/cli@latest',
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function trackedCliSourceFiles(): string[] {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'cli/src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((path) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(path));
  const self = 'cli/src/init/__tests__/mcp-generator-package-tag.test.ts';
  if (existsSync(resolve(REPO_ROOT, self)) && !files.includes(self)) {
    files.push(self);
  }
  return files;
}

function activeForbiddenPackageTagRefs(relativePath: string): string[] {
  if (NEGATIVE_ASSERTION_FIXTURES.has(relativePath)) return [];
  const source = stripComments(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8'));
  return FORBIDDEN_PACKAGE_TAGS
    .filter((tag) => source.includes(tag))
    .map((tag) => `${relativePath}: ${tag}`);
}

describe('MCP generator package tag', () => {
  it('uses the v3alpha hive-flow package for generated Hive Flow MCP config', () => {
    const config = generateMCPConfig(DEFAULT_INIT_OPTIONS) as {
      mcpServers: {
        'hive-flow': {
          args: string[];
        };
      };
    };

    const args = config.mcpServers['hive-flow'].args.join(' ');

    expect(args).toContain('hive-flow@v3alpha');
    expect(args).not.toContain('hive-flow@latest');
    expect(args).not.toContain('@hive-flow/cli@latest');
  });

  it('serializes generated JSON without the latest tag', () => {
    const json = generateMCPJson(DEFAULT_INIT_OPTIONS);

    expect(json).toContain('hive-flow@v3alpha');
    expect(json).not.toContain('hive-flow@latest');
    expect(json).not.toContain('@hive-flow/cli@latest');
  });

  it('keeps tracked cli/src code free of stale latest-tag Hive Flow package invocations', () => {
    const offenders = trackedCliSourceFiles().flatMap(activeForbiddenPackageTagRefs);

    expect(offenders).toEqual([]);
  });
});
