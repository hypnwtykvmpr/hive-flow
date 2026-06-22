import { execFileSync, spawnSync } from 'node:child_process';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './debrand-static-scope.js';

const CANONICAL_ROOT = 'v3/@hive-flow/cli/helpers/';
const RETIRED_ROOT = 'v3/helpers/';

const expectedHelperAssets = [
  'README.md',
  'docs/installation.md',
  'hive-flow-v3.ps1',
  'hive-flow-v3.sh',
  'templates/config-validator.sh',
  'templates/progress-manager.ps1',
  'templates/progress-manager.sh',
  'templates/status-display.sh',
] as const;

function trackedFiles(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

describe('helper asset location', () => {
  it('keeps every helper asset under v3/@hive-flow/cli/helpers', () => {
    const tracked = new Set(trackedFiles(CANONICAL_ROOT, RETIRED_ROOT));

    fc.assert(
      fc.property(fc.constantFrom(...expectedHelperAssets), (asset) => {
        expect(tracked.has(`${CANONICAL_ROOT}${asset}`)).toBe(true);
        expect(tracked.has(`${RETIRED_ROOT}${asset}`)).toBe(false);
      }),
    );
  });

  it('does not document the retired v3/helpers source path', () => {
    const result = spawnSync(
      'git',
      [
        'grep',
        '-n',
        'v3/helpers',
        '--',
        ':!tests/packaging-proof.test.mjs',
        ':!v3/tests/bats/helper-assets-location.bats',
        ':!v3/@hive-flow/cli/src/init/__tests__/helper-assets-location.test.ts',
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
  });
});
