import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const providersRoot = resolve(here, '..');
const cliRoot = resolve(here, '../../cli');
const bridgePath = resolve(providersRoot, 'scripts/provider-agent-bridge.mjs');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function bridgeSource() {
  return readFileSync(bridgePath, 'utf8');
}

function providerPackFileList() {
  const npmCache = mkdtempSync(join(tmpdir(), 'hf-provider-npm-cache-'));
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: providersRoot,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_loglevel: 'error',
      npm_config_update_notifier: 'false',
    },
    encoding: 'utf8',
  });
  return JSON.parse(raw)[0].files.map((file) => file.path);
}

describe('provider bridge packaging contract', () => {
  it('declares provider deps and packages the bridge with its local helpers', () => {
    const pkg = readJson(resolve(providersRoot, 'package.json'));

    expect(pkg.dependencies).toMatchObject({
      undici: expect.any(String),
    });
    expect(pkg.devDependencies).toMatchObject({
      'fast-check': expect.any(String),
    });
    expect(pkg.files).toEqual(expect.arrayContaining([
      'dist',
      'src',
      'scripts/provider-agent-bridge.mjs',
      'scripts/bridge-grep-validators.mjs',
      'scripts/provider-auth-helpers.mjs',
      'scripts/sandbox-runner.mjs',
    ]));
    expect(pkg.exports).toHaveProperty('./scripts/sandbox-runner.mjs');
  });

  it('dry-run package file list includes the bridge and required local helpers', () => {
    const files = providerPackFileList();

    expect(files).toContain('scripts/provider-agent-bridge.mjs');
    expect(files).toContain('scripts/bridge-grep-validators.mjs');
    expect(files).toContain('scripts/provider-auth-helpers.mjs');
    expect(files).toContain('scripts/sandbox-runner.mjs');
    expect(files).not.toContain('scripts/setup-provider-agents.ts');
  });

  it('uses packaged CLI dist permission-guard imports, never cli/src or package-private subpaths', () => {
    const source = bridgeSource();

    expect(source).not.toContain('../../cli/src/permission-guard/protected-paths.cjs');
    expect(source).not.toContain('@hive-flow/cli/dist/src/permission-guard/');
    expect(source).toContain("'..', '..', 'cli', 'dist', 'src', 'permission-guard', moduleName");
    expect(source).toContain("importCliPermissionGuardDist('protected-paths.js')");
    expect(source).toContain("importCliPermissionGuardDist('gate.js')");
  });

  it('can resolve sibling CLI dist permission-guard modules in repo and node_modules layouts', async () => {
    const repoPolicy = resolve(dirname(bridgePath), '../../cli/dist/src/permission-guard/protected-paths.js');
    const repoGate = resolve(dirname(bridgePath), '../../cli/dist/src/permission-guard/gate.js');

    expect(existsSync(repoPolicy)).toBe(true);
    expect(existsSync(repoGate)).toBe(true);
    await expect(import(pathToFileURL(repoPolicy).href)).resolves.toHaveProperty('isProtectedReadPath');
    await expect(import(pathToFileURL(repoGate).href)).resolves.toHaveProperty('evaluateHookInput');

    const installRoot = mkdtempSync(join(tmpdir(), 'hf-provider-packaging-'));
    const scopeDir = join(installRoot, 'node_modules', '@hive-flow');
    const nodeProviders = join(scopeDir, 'providers');
    const nodeCli = join(scopeDir, 'cli');
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(providersRoot, nodeProviders, 'dir');
    symlinkSync(cliRoot, nodeCli, 'dir');

    const nodeBridge = join(nodeProviders, 'scripts/provider-agent-bridge.mjs');
    const nodePolicy = resolve(dirname(nodeBridge), '../../cli/dist/src/permission-guard/protected-paths.js');
    const nodeGate = resolve(dirname(nodeBridge), '../../cli/dist/src/permission-guard/gate.js');

    expect(existsSync(nodePolicy)).toBe(true);
    expect(existsSync(nodeGate)).toBe(true);
    await expect(import(pathToFileURL(nodePolicy).href)).resolves.toHaveProperty('isProtectedReadPath');
    await expect(import(pathToFileURL(nodeGate).href)).resolves.toHaveProperty('evaluateHookInput');
  });
});
