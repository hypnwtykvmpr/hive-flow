import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MEMORY_PACKAGE = new URL('../package.json', import.meta.url);
const V3_PACKAGE = new URL('../../../package.json', import.meta.url);
const V3_LOCKFILE = new URL('../../../pnpm-lock.yaml', import.meta.url);
const V3_NPMRC = new URL('../../../.npmrc', import.meta.url);

const PINNED_AGENTDB = '3.0.0-alpha.9';

function readJson(path: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('agentdb version pin', () => {
  it('keeps the memory seam pinned to the patched agentdb version', () => {
    const memoryPackage = readJson(MEMORY_PACKAGE);
    const dependencies = memoryPackage.dependencies as Record<string, string>;

    expect(dependencies.agentdb).toBe(PINNED_AGENTDB);
  });

  it('keeps the v3 lockfile resolved to the patched agentdb package', () => {
    const lockfile = readFileSync(V3_LOCKFILE, 'utf8');

    expect(lockfile).toContain(`specifier: ${PINNED_AGENTDB}`);
    expect(lockfile).not.toContain(`specifier: ^${PINNED_AGENTDB}`);
    expect(lockfile).toContain(`agentdb@${PINNED_AGENTDB}:`);
    expect(lockfile).toContain(`/agentdb@${PINNED_AGENTDB}(patch_hash=`);
    expect(lockfile).toContain('patched: true');
    expect(lockfile).not.toContain('agentdb@3.0.0-alpha.10');
    expect(lockfile).not.toContain('agentdb@2.0.0-alpha.3.7');
  });

  it('keeps the patched dependency target aligned with the package pin', () => {
    const v3Package = readJson(V3_PACKAGE);
    const pnpm = v3Package.pnpm as Record<string, unknown>;
    const patchedDependencies = pnpm.patchedDependencies as Record<string, string>;

    expect(patchedDependencies).toEqual({
      [`agentdb@${PINNED_AGENTDB}`]: `patches/agentdb@${PINNED_AGENTDB}.patch`,
    });
  });

  it('enforces frozen lockfile installs by default', () => {
    const npmrc = readFileSync(V3_NPMRC, 'utf8');

    expect(npmrc).toMatch(/^frozen-lockfile=true$/m);
  });
});
