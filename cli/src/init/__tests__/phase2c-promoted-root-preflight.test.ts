import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
const OLD_CLI_PATH = ['v3', '@hive-flow', 'cli'].join('/');

const DELIBERATE_OLD_CLI_SENTINELS = new Set([
  'cli/src/init/__tests__/phase2b-compat-shim.test.ts',
  'cli/src/init/__tests__/phase2b-dp2b8-dot-config-preflight.test.ts',
  'cli/src/init/__tests__/phase2c-promoted-root-preflight.test.ts',
]);

function trackedCliSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'cli/src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((path) => /\.(?:ts|tsx|mts|cts|mjs|cjs|js|json|md|yml|yaml|toml|bats|sh)$/.test(path));
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function hasAssembledOldCliPath(source: string): boolean {
  const oldCliSegments = /['"`]v3['"`][\s\S]{0,240}['"`]@hive-flow['"`][\s\S]{0,240}['"`]cli['"`]/;
  return oldCliSegments.test(source);
}

function activeOldCliPathReferences(source: string): string[] {
  const stripped = stripComments(source);
  const findings: string[] = [];
  if (stripped.includes(OLD_CLI_PATH)) findings.push(OLD_CLI_PATH);
  if (hasAssembledOldCliPath(stripped)) findings.push('assembled old cli path');
  return findings;
}

describe('Phase 2C promoted-root preflight', () => {
  it('ignores cosmetic comments while detecting active old CLI path references', () => {
    expect(activeOldCliPathReferences(`// ${OLD_CLI_PATH}/src/index.ts\nconst ok = true;\n`)).toEqual([]);
    expect(activeOldCliPathReferences(`const path = '${OLD_CLI_PATH}/bin/cli.js';\n`)).toEqual([
      OLD_CLI_PATH,
    ]);
    expect(activeOldCliPathReferences(`const path = join(root, 'v3', '@hive-flow', 'cli', 'bin');\n`)).toEqual([
      'assembled old cli path',
    ]);
  });

  it('keeps active old CLI filesystem paths out of tracked cli/src files', () => {
    const offenders = trackedCliSourceFiles()
      .filter((path) => !DELIBERATE_OLD_CLI_SENTINELS.has(path))
      .flatMap((path) => {
        const findings = activeOldCliPathReferences(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
        return findings.map((finding) => `${path}: ${finding}`);
      });

    expect(offenders).toEqual([]);
  });
});
