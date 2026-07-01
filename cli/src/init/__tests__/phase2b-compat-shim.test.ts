import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function findRepoRoot(start = __dirname): string {
  let current = resolve(start);
  for (;;) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, 'cli', 'package.json')) &&
      existsSync(join(current, 'v3'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('Unable to locate hive-flow repo root');
    current = parent;
  }
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  function walk(current: string) {
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) walk(join(current, entry));
      return;
    }
    files.push(relative(root, current).replace(/\\/g, '/'));
  }
  walk(root);
  return files;
}

describe('Phase 2B @hive-flow/cli compatibility shim', () => {
  const REPO_ROOT = findRepoRoot();
  const cliRoot = resolve(REPO_ROOT, 'cli');
  const shimRoot = resolve(cliRoot, 'packages/cli-compat');
  const canonicalPackage = readJson(resolve(cliRoot, 'package.json'));
  const shimPackage = readJson(resolve(shimRoot, 'package.json'));

  it('mirrors the canonical export and bin keys without reviving the old source tree', () => {
    expect(existsSync(resolve(REPO_ROOT, 'v3/@hive-flow/cli'))).toBe(false);
    expect(shimPackage.name).toBe('@hive-flow/cli');
    expect(shimPackage.version).toBe(canonicalPackage.version);
    expect(shimPackage.dependencies).toEqual({ 'hive-flow': 'workspace:*' });
    expect(Object.keys(shimPackage.exports)).toEqual(Object.keys(canonicalPackage.exports));
    expect(Object.keys(shimPackage.bin)).toEqual(Object.keys(canonicalPackage.bin));
  });

  it('uses generated local stubs for exact and wildcard exports', () => {
    const files = new Set(walkFiles(resolve(shimRoot, 'exports')));

    expect(files.has('index.js')).toBe(true);
    expect(files.has('memory.js')).toBe(true);
    expect(files.has('memory/index.js')).toBe(true);
    expect(files.has('shared/utils/resolve-project-root.js')).toBe(true);
    expect(files.has('plugin-sdk/index.js')).toBe(true);

    expect(readFileSync(resolve(shimRoot, 'exports/index.js'), 'utf8'))
      .toContain("export * from 'hive-flow';");
    expect(readFileSync(resolve(shimRoot, 'exports/memory.js'), 'utf8'))
      .toContain("export * from 'hive-flow/memory';");
    expect(readFileSync(resolve(shimRoot, 'exports/shared/utils/resolve-project-root.js'), 'utf8'))
      .toContain("export * from 'hive-flow/shared/utils/resolve-project-root';");
  });

  it('keeps bin wrappers filesystem-resolved through hive-flow/package.json', () => {
    for (const [name, target] of Object.entries(canonicalPackage.bin as Record<string, string>)) {
      const wrapperRel = shimPackage.bin[name];
      expect(wrapperRel).toBe(`./bin/${name}.js`);
      const source = readFileSync(resolve(shimRoot, wrapperRel), 'utf8');
      expect(source).toContain("require.resolve('hive-flow/package.json')");
      expect(source).toContain(target.replace(/^\.\//, ''));
      expect(source).not.toContain("require.resolve('hive-flow/bin/");
    }
  });

  it('does not hand-write default re-exports that could break modules without defaults', () => {
    for (const file of walkFiles(resolve(shimRoot, 'exports')).filter((path) => path.endsWith('.js'))) {
      const source = readFileSync(resolve(shimRoot, 'exports', file), 'utf8');
      expect(source).not.toMatch(/export\s+\{\s*default\s*\}/);
    }
  });
});
