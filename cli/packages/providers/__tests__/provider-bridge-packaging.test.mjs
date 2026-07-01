import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const providersRoot = resolve(here, '..');
const cliRoot = resolve(providersRoot, '../..');
const bridgePath = resolve(providersRoot, 'scripts/provider-agent-bridge.mjs');
const cliPermissionGuardDistPath = resolve(cliRoot, 'dist/src/permission-guard');
const cliSharedUtilsDistPath = resolve(cliRoot, 'dist/src/shared/utils');

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

function makeProjectRoot(prefix = 'hf-provider-pack-smoke-project-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(root, '.claude'), { recursive: true });
  const key = randomBytes(32).toString('hex');
  const keyPath = join(root, '.hive-flow', 'enforcement', '.hmac-key');
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  const state = {
    level: 0,
    ts: '2026-06-08T00:00:00.000Z',
    violations: 0,
    restrictedGroups: [],
    history: [],
    integrityCompromised: false,
  };
  writeFileSync(join(root, '.hive-flow', 'enforcement', 'state.json'), JSON.stringify({
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  }, null, 2), 'utf8');
  return root;
}

function copyPackedProviderFiles(targetRoot, files) {
  for (const file of files) {
    const source = resolve(providersRoot, file);
    const target = join(targetRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  copyFileSync(resolve(providersRoot, 'package.json'), join(targetRoot, 'package.json'));
}

function makePackedInstallLayout() {
  if (!existsSync(cliPermissionGuardDistPath)) {
    throw new Error('CLI permission-guard dist must exist; run CLI build before this test');
  }

  const installRoot = mkdtempSync(join(tmpdir(), 'hf-provider-packed-install-'));
  const scopeDir = join(installRoot, 'node_modules', '@hive-flow');
  const nodeProviders = join(scopeDir, 'providers');
  const nodeCli = join(scopeDir, 'cli');
  mkdirSync(scopeDir, { recursive: true });
  mkdirSync(nodeProviders, { recursive: true });
  mkdirSync(join(nodeCli, 'dist', 'src'), { recursive: true });
  mkdirSync(join(nodeCli, 'dist', 'src', 'install'), { recursive: true });

  copyPackedProviderFiles(nodeProviders, providerPackFileList());
  cpSync(cliPermissionGuardDistPath, join(nodeCli, 'dist', 'src', 'permission-guard'), { recursive: true });
  cpSync(cliSharedUtilsDistPath, join(nodeCli, 'dist', 'src', 'shared', 'utils'), { recursive: true });
  copyFileSync(
    resolve(cliRoot, 'dist/src/install/portable-prompt.js'),
    join(nodeCli, 'dist', 'src', 'install', 'portable-prompt.js'),
  );

  const markerPath = join(installRoot, 'fake-cli-package-imported.txt');
  const fakeCliModule = `
    import { writeFileSync } from 'node:fs';
    if (process.env.HF_FAKE_CLI_IMPORT_MARKER) {
      writeFileSync(process.env.HF_FAKE_CLI_IMPORT_MARKER, 'imported');
    }
    export const marker = 'fake-cli-package';
    export default { marker };
  `;
  writeFileSync(join(nodeCli, 'package.json'), JSON.stringify({
    name: '@hive-flow/cli',
    type: 'module',
    exports: {
      '.': './index.js',
      './mcp-client': './mcp-client.js',
    },
  }, null, 2));
  writeFileSync(join(nodeCli, 'index.js'), fakeCliModule, 'utf8');
  writeFileSync(join(nodeCli, 'mcp-client.js'), fakeCliModule, 'utf8');

  return {
    installRoot,
    bridgePath: join(nodeProviders, 'scripts', 'provider-agent-bridge.mjs'),
    markerPath,
  };
}

function runPackedBridgeSmoke(layout, root) {
  const script = `
    const bridge = await import(${JSON.stringify(pathToFileURL(layout.bridgePath).href)});
    const unknown = await bridge.evaluateToolCall('unknown_runtime_tool', { unsafe: true });
    const webSearch = JSON.parse(await bridge.evaluateToolCall('web_search', { query: 'packed smoke' }));
    const shellDenied = JSON.parse(await bridge.evaluateToolCall(
      'run_shell',
      { argv: ['node', '--version'] },
      { sandboxOptions: { backendOrder: [] } }
    ));
    process.stdout.write(JSON.stringify({
      unknown,
      webSearch,
      shellDenied,
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      CLAUDE_PROJECT_DIR: root,
      HIVE_FLOW_AGENT_ID: '',
      CLAUDE_AGENT_ID: '',
      HIVE_FLOW_HIVE_ID: '',
      HF_FAKE_CLI_IMPORT_MARKER: layout.markerPath,
    },
    encoding: 'utf8',
  });
  return JSON.parse(output);
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
    expect(source).not.toContain('@hive-flow/cli');
    expect(source).not.toContain('mcp-client');
    expect(source).toContain("'..', '..', '..', 'dist', 'src', 'permission-guard', moduleName");
    expect(source).toContain("'..', '..', 'cli', 'dist', 'src', 'permission-guard', moduleName");
    expect(source).toContain("'..', '..', '..', '..', 'dist', 'src', 'permission-guard', moduleName");
    expect(source).toContain('CLI permission-guard dist artifact missing; tried:');
    expect(source).toContain("importCliPermissionGuardDist('protected-paths.js')");
    expect(source).toContain("importCliPermissionGuardDist('gate.js')");
  });

  it('can resolve sibling CLI dist permission-guard modules in repo and node_modules layouts', async () => {
    const repoPolicy = resolve(dirname(bridgePath), '../../../dist/src/permission-guard/protected-paths.js');
    const repoGate = resolve(dirname(bridgePath), '../../../dist/src/permission-guard/gate.js');

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

  it('imports and executes from a packed-install layout without package-private CLI or MCP imports', () => {
    const layout = makePackedInstallLayout();
    const root = makeProjectRoot();

    const result = runPackedBridgeSmoke(layout, root);

    expect(result.unknown).toMatchObject({
      status: 'denied',
      denyReason: 'unknown-tool',
      tool: 'unknown_runtime_tool',
    });
    expect(result.webSearch).toMatchObject({
      status: 'denied',
      provider: 'duckduckgo-html',
      results: [],
    });
    expect(result.webSearch.denyReason).not.toBe('web-search-unsupported');
    expect(result.shellDenied).toMatchObject({
      status: 'denied',
      denyReason: 'sandbox-unavailable:no-verified-backend',
      sandboxBackend: null,
    });
    expect(existsSync(layout.markerPath)).toBe(false);
  });
});
