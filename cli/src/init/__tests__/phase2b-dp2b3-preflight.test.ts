import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../../../..');

const MOVED_ROOTS = [
  'v3/@hive-flow/providers',
  'v3/@hive-flow/embeddings',
  'v3/plugins/gastown-bridge',
] as const;

const LEGACY_PACKAGE_SENTINELS = [
  'v3/@hive-flow/providers/package.json',
  'v3/@hive-flow/embeddings/package.json',
  'v3/plugins/gastown-bridge/package.json',
] as const;

const DP2B3_OLD_PATH_ALLOWLIST = new Set([
  'cli/src/init/__tests__/phase2b-dp2b3-preflight.test.ts',
  'cli/src/mcp-tools/provider-bridge-resolver.ts',
  'cli/src/mcp-tools/__tests__/provider-bridge-resolver.test.ts',
]);

function gitTrackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function isTextFile(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|md|yml|yaml|toml|bats|sh)$/.test(path);
}

function hasMovedRootPathReference(source: string): boolean {
  if (MOVED_ROOTS.some((root) => source.includes(root))) return true;

  const pathAssemblyPatterns = [
    /(?<!\.)\b(?:join|resolve)\([^)]*['"`]v3['"`][^)]*['"`]@hive-flow['"`][^)]*['"`](?:providers|embeddings)['"`]/s,
    /(?<!\.)\b(?:join|resolve)\([^)]*['"`]v3['"`][^)]*['"`]plugins['"`][^)]*['"`]gastown-bridge['"`]/s,
    /(?<!\.)\b(?:join|resolve)\([^)]*['"`]@hive-flow\/(?:providers|embeddings)['"`]/s,
    /(?<!\.)\b(?:join|resolve)\([^)]*['"`]plugins\/gastown-bridge['"`]/s,
  ];
  return pathAssemblyPatterns.some((pattern) => pattern.test(source));
}

describe('DP2B-3 provider package move preflight', () => {
  it('arms the old filesystem path gate for the post-move tree', () => {
    const legacySentinelsStillPresent = LEGACY_PACKAGE_SENTINELS
      .filter((path) => existsSync(resolve(REPO_ROOT, path)));

    if (legacySentinelsStillPresent.length > 0) {
      expect(legacySentinelsStillPresent).toEqual([...LEGACY_PACKAGE_SENTINELS]);
      return;
    }

    const offenders = gitTrackedFiles()
      .filter((path) => isTextFile(path))
      .filter((path) => !DP2B3_OLD_PATH_ALLOWLIST.has(path))
      .filter((path) => {
        const absolutePath = resolve(REPO_ROOT, path);
        const source = readFileSync(absolutePath, 'utf8');
        return hasMovedRootPathReference(source);
      })
      .map((path) => relative(REPO_ROOT, resolve(REPO_ROOT, path)));

    expect(offenders).toEqual([]);
  });
});
