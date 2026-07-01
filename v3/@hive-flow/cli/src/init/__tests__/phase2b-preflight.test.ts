import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateAutoMemoryHook } from '../helpers-generator.js';
import { REPO_ROOT } from './debrand-static-scope.js';

describe('Phase 2B preflight invariants', () => {
  it('generates auto-memory fallback imports through the promoted hive-flow package name', () => {
    const hook = generateAutoMemoryHook();

    expect(hook).toContain("import('hive-flow/memory')");
    expect(hook).not.toContain("import('@hive-flow/cli/memory')");
  });

  it('keeps Vitest out of runtime dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'v3/@hive-flow/cli/package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies ?? {}).not.toHaveProperty('vitest');
    expect(packageJson.devDependencies?.vitest).toBe('^4.0.16');
  });
});
