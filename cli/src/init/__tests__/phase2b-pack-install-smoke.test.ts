import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type PackSmokeModule = {
  REQUIRED_EXACT_PACK_PATHS: readonly string[];
  assertPackageFileList(files: string[]): void;
  assertCompatShimManifest(
    manifest: Record<string, unknown>,
    canonicalPackage: Record<string, unknown>,
  ): void;
  createBundledProviderManifest(providersPackage: Record<string, unknown>): Record<string, unknown>;
  createFutureHiveFlowManifest(args: {
    cliPackage: Record<string, unknown>;
    providersPackage: Record<string, unknown>;
    rootPackage: Record<string, unknown>;
  }): Record<string, any>;
  isForbiddenPackagePath(path: string): boolean;
};

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

const REPO_ROOT = findRepoRoot();

function currentCliRoot(): string {
  const promoted = resolve(REPO_ROOT, 'cli');
  if (existsSync(resolve(promoted, 'package.json'))) return promoted;
  return resolve(REPO_ROOT, 'v3/@hive-flow/cli');
}

function currentProvidersRoot(): string {
  const promoted = resolve(REPO_ROOT, 'cli/packages/providers');
  if (existsSync(resolve(promoted, 'package.json'))) return promoted;
  return resolve(REPO_ROOT, 'cli/packages/providers');
}

describe('Phase 2B C3 pack/install smoke harness', () => {
  let smoke: PackSmokeModule;
  let rootPackage: Record<string, any>;
  let cliPackage: Record<string, any>;
  let providersPackage: Record<string, any>;
  let cliRoot: string;
  let providersRoot: string;

  beforeAll(async () => {
    cliRoot = currentCliRoot();
    providersRoot = currentProvidersRoot();
    smoke = await import(
      pathToFileURL(resolve(cliRoot, 'scripts/pack-install-smoke.mjs')).href
    ) as PackSmokeModule;
    rootPackage = readJson(resolve(REPO_ROOT, 'package.json'));
    cliPackage = readJson(resolve(cliRoot, 'package.json'));
    providersPackage = readJson(resolve(providersRoot, 'package.json'));
  });

  it('synthesizes an installable hive-flow manifest without workspace-only optional packages', () => {
    const manifest = smoke.createFutureHiveFlowManifest({
      cliPackage,
      providersPackage,
      rootPackage,
    });

    expect(manifest.name).toBe('hive-flow');
    expect(manifest.version).toBe(cliPackage.version);
    expect(manifest.bin).toMatchObject(cliPackage.bin);
    expect(manifest.exports).toMatchObject(cliPackage.exports);
    expect(manifest.exports).toHaveProperty('./memory');
    expect(manifest.dependencies['@hive-flow/providers']).toBe(providersPackage.version);
    expect(manifest.dependencies.undici).toBe(
      rootPackage.overrides['undici@>=7.0.0 <7.28.0'] ?? providersPackage.dependencies.undici,
    );
    expect(manifest.optionalDependencies).toHaveProperty('better-sqlite3');
    expect(JSON.stringify(manifest)).not.toContain('workspace:');
    expect(JSON.stringify(manifest)).not.toContain('@hive-flow/embeddings');
    expect(JSON.stringify(manifest)).not.toContain('@hive-flow/plugin-gastown-bridge');
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('requires the @hive-flow/cli compat shim to pack with a concrete hive-flow dependency', () => {
    const shimManifest = {
      name: '@hive-flow/cli',
      version: cliPackage.version,
      dependencies: {
        'hive-flow': cliPackage.version,
      },
      exports: cliPackage.exports,
      bin: cliPackage.bin,
    };

    expect(() => smoke.assertCompatShimManifest(shimManifest, cliPackage)).not.toThrow();
    expect(() => smoke.assertCompatShimManifest({
      ...shimManifest,
      dependencies: {
        'hive-flow': 'workspace:*',
      },
    }, cliPackage)).toThrow(/workspace/);
    expect(() => smoke.assertCompatShimManifest({
      ...shimManifest,
      exports: {
        '.': cliPackage.exports['.'],
      },
    }, cliPackage)).toThrow(/export keys/);
  });

  it('keeps third-party deps out of the bundled providers manifest while root declares undici', () => {
    const manifest = smoke.createFutureHiveFlowManifest({
      cliPackage,
      providersPackage,
      rootPackage,
    });
    const bundledProvider = smoke.createBundledProviderManifest(providersPackage);

    expect(manifest.dependencies.undici).toBe(
      rootPackage.overrides['undici@>=7.0.0 <7.28.0'] ?? providersPackage.dependencies.undici,
    );
    expect(bundledProvider.dependencies).toBeUndefined();
    expect(bundledProvider.devDependencies).toBeUndefined();
    expect(bundledProvider.exports).toHaveProperty('./scripts/provider-agent-bridge.mjs');
    expect(bundledProvider.exports).toHaveProperty('./scripts/agent-task-journal.mjs');
  });

  it('does not use CommonJS package resolution for the ESM-only providers main export', () => {
    const source = readFileSync(
      resolve(cliRoot, 'scripts/pack-install-smoke.mjs'),
      'utf8',
    );

    expect(source).toContain("await import.meta.resolve('@hive-flow/providers')");
    expect(source).not.toContain("require.resolve('@hive-flow/providers')");
    expect(source).toContain("require.resolve('undici'");
  });

  it('forces optional-free install and keeps native optional imports lazy', () => {
    const smokeSource = readFileSync(
      resolve(cliRoot, 'scripts/pack-install-smoke.mjs'),
      'utf8',
    );
    const sqliteBackendSource = readFileSync(
      resolve(cliRoot, 'src/memory/sqlite-backend.ts'),
      'utf8',
    );
    const astAnalyzerSource = readFileSync(
      resolve(cliRoot, 'src/hivector/ast-analyzer.ts'),
      'utf8',
    );

    expect(smokeSource).toContain("'--omit=optional'");
    expect(sqliteBackendSource).not.toMatch(/import\s+Database\s+from\s+['"]better-sqlite3['"]/);
    expect(sqliteBackendSource).toContain("await import('better-sqlite3' as string)");
    expect(sqliteBackendSource).toContain('better-sqlite3 optional dependency is not available');
    expect(astAnalyzerSource).not.toMatch(/import\s+\{[^}]*\}\s+from\s+['"]@ast-grep\/napi['"]/);
    expect(astAnalyzerSource).toContain("require('@ast-grep/napi')");
    expect(astAnalyzerSource).toContain('if (!astGrep) return null');
  });

  it('requires positive runtime paths and rejects known trash/private artifacts', () => {
    const validFiles = [
      ...smoke.REQUIRED_EXACT_PACK_PATHS,
      '.claude/helpers/hook-handler.cjs',
      'agents/coordinator.yaml',
    ];

    expect(() => smoke.assertPackageFileList(validFiles)).not.toThrow();
    expect(() => smoke.assertPackageFileList(validFiles.filter((path) => path !== 'bin/mcp-server.js')))
      .toThrow(/bin\/mcp-server\.js/);
    expect(() => smoke.assertPackageFileList([...validFiles, 'dist/src/index.js.map']))
      .toThrow(/forbidden packaged paths/);
    expect(() => smoke.assertPackageFileList([...validFiles, '.claude/helpers/.hive-flow/data.json']))
      .toThrow(/forbidden packaged paths/);
  });

  it('classifies package exclusions used by the copy and tarball audits', () => {
    expect(smoke.isForbiddenPackagePath('dist/src/index.js')).toBe(false);
    expect(smoke.isForbiddenPackagePath('dist/src/index.js.map')).toBe(true);
    expect(smoke.isForbiddenPackagePath('src/__tests__/example.test.ts')).toBe(true);
    expect(smoke.isForbiddenPackagePath('.claude/helpers/.context-tracker.json')).toBe(true);
    expect(smoke.isForbiddenPackagePath('.claude/helpers/checkpoints/1.json')).toBe(true);
    expect(smoke.isForbiddenPackagePath('agents/DELETE_old.yaml')).toBe(true);
    expect(smoke.isForbiddenPackagePath('.claude/helpers/memory.db-wal')).toBe(true);
  });
});
