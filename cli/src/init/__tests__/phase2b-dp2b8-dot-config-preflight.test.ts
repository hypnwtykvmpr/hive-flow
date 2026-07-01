import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../../../..');

const DOT_CONFIG_PATHS = [
  '.claude',
  '.agents',
  'cli/.claude',
  '.mcp.json',
] as const;

const DOT_CONFIG_GATE_ALLOWLIST = new Set([
  'cli/src/init/__tests__/phase2b-dp2b8-dot-config-preflight.test.ts',
]);

function gitTrackedDotConfigFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...DOT_CONFIG_PATHS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((path) => !path.includes('/.claude/worktrees/'));
}

function isTextFile(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|md|yml|yaml|toml|bats|sh)$/.test(path);
}

function staleDotConfigMatches(source: string): string[] {
  const matches: string[] = [];

  if (source.includes('v3/@hive-flow/cli')) {
    matches.push('literal v3/@hive-flow/cli path');
  }

  if (source.includes('node_modules/@hive-flow/cli')) {
    matches.push('legacy node_modules package path');
  }

  if (source.includes('@hive-flow/cli')) {
    matches.push('legacy @hive-flow/cli package reference');
  }

  if (/['"`]@hive-flow['"`]\s*,\s*['"`]cli['"`]/.test(source)) {
    matches.push('assembled @hive-flow/cli path segments');
  }

  return [...new Set(matches)];
}

describe('DP2B-8 dot-config preflight', () => {
  it('catches literal, assembled, and package-name references to the old CLI layout', () => {
    expect(staleDotConfigMatches('node v3/@hive-flow/cli/bin/cli.js')).toContain(
      'literal v3/@hive-flow/cli path',
    );
    expect(staleDotConfigMatches('$V3_DIR/@hive-flow/cli/src/security')).toContain(
      'legacy @hive-flow/cli package reference',
    );
    expect(staleDotConfigMatches("join(V3_DIR, '@hive-flow', 'cli', 'src')")).toContain(
      'assembled @hive-flow/cli path segments',
    );
    expect(staleDotConfigMatches("import('@hive-flow/cli/memory')")).toContain(
      'legacy @hive-flow/cli package reference',
    );
    expect(staleDotConfigMatches('node_modules/@hive-flow/cli/dist/src/memory/index.js')).toContain(
      'legacy node_modules package path',
    );
  });

  it('keeps tracked dot-config and packaged helper files free of old CLI references', () => {
    const offenders = gitTrackedDotConfigFiles()
      .filter((path) => isTextFile(path))
      .filter((path) => !DOT_CONFIG_GATE_ALLOWLIST.has(path))
      .flatMap((path) => {
        const source = readFileSync(resolve(REPO_ROOT, path), 'utf8');
        return staleDotConfigMatches(source).map((match) => ({ path, match }));
      });

    expect(offenders).toEqual([]);
  });
});
