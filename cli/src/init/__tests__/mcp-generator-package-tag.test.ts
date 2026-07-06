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
const FORBIDDEN_GENERATED_MCP_PACKAGE_TAGS = [
  'hive-flow@v3alpha',
  'hive-flow@latest',
  '@hive-flow/cli@latest',
];
const FORBIDDEN_LATEST_PACKAGE_TAGS = [
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
  return FORBIDDEN_LATEST_PACKAGE_TAGS
    .filter((tag) => source.includes(tag))
    .map((tag) => `${relativePath}: ${tag}`);
}

describe('MCP generator package tag', () => {
  it('uses the installed hive-flow command for generated Hive Flow MCP config', () => {
    const config = generateMCPConfig(DEFAULT_INIT_OPTIONS) as {
      mcpServers: {
        'hive-flow': {
          command: string;
          args: string[];
        };
      };
    };

    const command = config.mcpServers['hive-flow'].command;
    const args = config.mcpServers['hive-flow'].args.join(' ');

    expect(command).toBe(process.platform === 'win32' ? 'cmd' : 'hive-flow');
    expect(args).toContain(process.platform === 'win32' ? 'hive-flow mcp start' : 'mcp start');
    for (const tag of FORBIDDEN_GENERATED_MCP_PACKAGE_TAGS) {
      expect(args).not.toContain(tag);
    }
  });

  it('serializes generated JSON without package tags', () => {
    const json = generateMCPJson(DEFAULT_INIT_OPTIONS);

    expect(json).toContain('"hive-flow"');
    expect(json).toContain('"mcp"');
    expect(json).toContain('"start"');
    for (const tag of FORBIDDEN_GENERATED_MCP_PACKAGE_TAGS) {
      expect(json).not.toContain(tag);
    }
  });

  it('keeps tracked cli/src code free of stale latest-tag Hive Flow package invocations', () => {
    const offenders = trackedCliSourceFiles().flatMap(activeForbiddenPackageTagRefs);

    expect(offenders).toEqual([]);
  });
});
