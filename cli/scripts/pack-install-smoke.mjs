#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CLI_ROOT = resolve(scriptDir, '..');
export const DEFAULT_REPO_ROOT = resolveRepoRoot(DEFAULT_CLI_ROOT);
export const DEFAULT_PROVIDERS_ROOT = resolveProvidersRoot({
  cliRoot: DEFAULT_CLI_ROOT,
  repoRoot: DEFAULT_REPO_ROOT,
});

export const REQUIRED_EXACT_PACK_PATHS = Object.freeze([
  'bin/cli.js',
  'bin/mcp-server.js',
  'dist/src/index.js',
  'node_modules/@hive-flow/providers/dist/index.js',
  'node_modules/@hive-flow/providers/scripts/provider-agent-bridge.mjs',
  'node_modules/@hive-flow/providers/scripts/agent-task-journal.mjs',
]);

export const REQUIRED_PACK_PREDICATES = Object.freeze([
  {
    label: '.claude/helpers/* runtime hooks',
    test: (path) => path.startsWith('.claude/helpers/') && !path.endsWith('/'),
  },
  {
    label: 'agents/**/*.yaml',
    test: (path) => path.startsWith('agents/') && path.endsWith('.yaml'),
  },
]);

const OMITTED_WORKSPACE_OPTIONALS = new Set([
  '@hive-flow/embeddings',
  '@hive-flow/plugin-gastown-bridge',
]);

const RUNTIME_COPY_ENTRIES = Object.freeze([
  'dist',
  'bin',
  'scripts/verify-appliance.sh',
  'helpers',
  'agents',
  '.claude/commands',
  '.claude/helpers',
  '.claude/skills',
  '.claude/settings.json',
  'README.md',
]);

const PROVIDER_COPY_FALLBACK = Object.freeze([
  'dist',
  'src',
  'scripts/provider-agent-bridge.mjs',
  'scripts/agent-task-journal.mjs',
  'scripts/agent-task-journal.d.ts',
  'scripts/bridge-grep-validators.mjs',
  'scripts/diagnose-strict-provider-tools.mjs',
  'scripts/provider-auth-helpers.mjs',
  'scripts/sandbox-runner.mjs',
]);

function normalizePath(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function firstExistingDirectory(candidates) {
  return candidates.find((candidate) => directoryExists(candidate));
}

function resolveRepoRoot(cliRoot) {
  const candidates = [
    resolve(cliRoot, '..'),
    resolve(cliRoot, '../../..'),
  ];
  const found = candidates.find((candidate) => fileExists(join(candidate, 'package.json')));
  return found ?? candidates[0];
}

function resolveProvidersRoot({ cliRoot, repoRoot }) {
  const candidates = [
    resolve(repoRoot, 'cli/packages/providers'),
    resolve(repoRoot, 'v3/@hive-flow/providers'),
    resolve(cliRoot, '../providers'),
  ];
  return firstExistingDirectory(candidates) ?? candidates[0];
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function hasWorkspaceSpec(group = {}) {
  return Object.values(group).some((spec) => typeof spec === 'string' && spec.startsWith('workspace:'));
}

function withoutWorkspaceDeps(group = {}, versionsByPackage = new Map()) {
  const out = {};
  for (const [dep, spec] of Object.entries(group)) {
    if (OMITTED_WORKSPACE_OPTIONALS.has(dep)) continue;
    if (dep === '@hive-flow/providers') continue;
    if (typeof spec === 'string' && spec.startsWith('workspace:')) {
      const version = versionsByPackage.get(dep);
      if (version) out[dep] = version;
      continue;
    }
    out[dep] = spec;
  }
  return out;
}

function resolveUndiciRuntimeSpec(rootPackage, providerUndici) {
  const overrides = rootPackage.overrides ?? {};
  for (const [selector, spec] of Object.entries(overrides)) {
    if (selector.startsWith('undici@>=7.') && typeof spec === 'string') {
      return spec;
    }
  }
  return providerUndici;
}

export function createFutureHiveFlowManifest({ cliPackage, providersPackage, rootPackage = {} }) {
  const providerVersion = providersPackage.version;
  if (!providerVersion) {
    throw new Error('providers package.json has no version');
  }

  const dependencies = withoutWorkspaceDeps(cliPackage.dependencies);
  dependencies['@hive-flow/providers'] = providerVersion;

  const providerUndici = providersPackage.dependencies?.undici;
  const undiciRuntimeSpec = resolveUndiciRuntimeSpec(rootPackage, providerUndici);
  if (undiciRuntimeSpec) {
    dependencies.undici = dependencies.undici ?? undiciRuntimeSpec;
  }

  const optionalDependencies = withoutWorkspaceDeps(cliPackage.optionalDependencies);
  delete optionalDependencies['@hive-flow/providers'];

  const manifest = {
    name: 'hive-flow',
    version: cliPackage.version,
    description: rootPackage.description ?? cliPackage.description,
    type: cliPackage.type,
    main: cliPackage.main,
    types: cliPackage.types,
    sideEffects: cliPackage.sideEffects,
    bin: cliPackage.bin,
    exports: cliPackage.exports,
    files: cliPackage.files,
    scripts: {
      preinstall: 'node bin/preinstall.cjs || true',
    },
    engines: cliPackage.engines,
    dependencies,
    bundledDependencies: ['@hive-flow/providers'],
    keywords: rootPackage.keywords ?? cliPackage.keywords,
    contributors: rootPackage.contributors ?? cliPackage.contributors,
    license: rootPackage.license ?? cliPackage.license,
    publishConfig: rootPackage.publishConfig ?? cliPackage.publishConfig,
  };

  if (Object.keys(optionalDependencies).length > 0) {
    manifest.optionalDependencies = optionalDependencies;
  }
  if (rootPackage.overrides) {
    manifest.overrides = rootPackage.overrides;
  }
  if (rootPackage.packageManager) {
    manifest.packageManager = rootPackage.packageManager;
  }

  assertManifestInstallable(manifest, providersPackage);
  return manifest;
}

export function createBundledProviderManifest(providersPackage) {
  const manifest = {
    name: providersPackage.name,
    version: providersPackage.version,
    description: providersPackage.description,
    main: providersPackage.main,
    module: providersPackage.module,
    types: providersPackage.types,
    type: providersPackage.type,
    exports: providersPackage.exports,
    files: providersPackage.files,
    keywords: providersPackage.keywords,
    author: providersPackage.author,
    license: providersPackage.license,
    engines: providersPackage.engines,
  };
  for (const key of Object.keys(manifest)) {
    if (manifest[key] === undefined) delete manifest[key];
  }
  return manifest;
}

export function assertManifestInstallable(manifest, providersPackage) {
  const serialized = JSON.stringify(manifest);
  if (manifest.name !== 'hive-flow') {
    throw new Error(`future manifest must be named hive-flow, got ${manifest.name}`);
  }
  if (!manifest.bin?.['hive-flow'] || !manifest.bin?.['hive-flow-mcp']) {
    throw new Error('future manifest must preserve hive-flow and hive-flow-mcp bins');
  }
  if (!manifest.exports?.['./memory']) {
    throw new Error('future manifest must preserve the hive-flow/memory export');
  }
  if (manifest.dependencies?.['@hive-flow/providers'] !== providersPackage.version) {
    throw new Error('future manifest must depend on the concrete providers source version');
  }
  if (!manifest.dependencies?.undici) {
    throw new Error('future manifest must declare undici for the eager bundled providers runtime');
  }
  if (serialized.includes('workspace:')) {
    throw new Error('future manifest must not contain workspace:* specs');
  }
  for (const dep of OMITTED_WORKSPACE_OPTIONALS) {
    if (manifest.dependencies?.[dep] || manifest.optionalDependencies?.[dep] || serialized.includes(`"${dep}"`)) {
      throw new Error(`future manifest must omit eager ${dep}; this is a separate product decision`);
    }
  }
  if (hasWorkspaceSpec(manifest.dependencies) || hasWorkspaceSpec(manifest.optionalDependencies)) {
    throw new Error('future manifest contains a workspace dependency spec');
  }
}

export function isForbiddenPackagePath(path) {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  const name = basename(normalized);
  if (normalized.endsWith('.map')) return true;
  if (segments.includes('__tests__')) return true;
  if (segments.includes('.hive-flow')) return true;
  if (segments.includes('checkpoints')) return true;
  if (name.startsWith('DELETE_')) return true;
  if (name === '.context-tracker.json') return true;
  if (/\.(db|db-shm|db-wal|db-journal)$/.test(name)) return true;
  return false;
}

export function assertPackageFileList(files) {
  const normalized = files.map(normalizePath);
  const fileSet = new Set(normalized);
  const missingExact = REQUIRED_EXACT_PACK_PATHS.filter((path) => !fileSet.has(path));
  const missingPredicates = REQUIRED_PACK_PREDICATES
    .filter((entry) => !normalized.some((path) => entry.test(path)))
    .map((entry) => entry.label);
  const forbidden = normalized.filter(isForbiddenPackagePath);

  if (missingExact.length || missingPredicates.length || forbidden.length) {
    const details = [];
    if (missingExact.length) details.push(`missing required paths: ${missingExact.join(', ')}`);
    if (missingPredicates.length) details.push(`missing required classes: ${missingPredicates.join(', ')}`);
    if (forbidden.length) details.push(`forbidden packaged paths: ${forbidden.slice(0, 20).join(', ')}`);
    throw new Error(`[pack-smoke] invalid tarball contents: ${details.join('; ')}`);
  }
}

function copyPathFiltered(sourceRoot, relPath, targetRoot) {
  const source = join(sourceRoot, relPath);
  if (!existsSync(source)) return false;
  const target = join(targetRoot, relPath);
  copyRecursive(sourceRoot, source, target);
  return true;
}

function copyRecursive(baseRoot, source, target) {
  const rel = normalizePath(relative(baseRoot, source));
  if (rel && isForbiddenPackagePath(rel)) return;

  const stat = statSync(source);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyRecursive(baseRoot, join(source, entry), join(target, entry));
    }
    chmodSync(target, stat.mode);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  chmodSync(target, stat.mode);
}

function copyRuntimePayload({ cliRoot, repoRoot, packRoot }) {
  for (const rel of RUNTIME_COPY_ENTRIES) {
    copyPathFiltered(cliRoot, rel, packRoot);
  }

  const cliLicense = join(cliRoot, 'LICENSE');
  const repoLicense = join(repoRoot, 'LICENSE');
  if (existsSync(cliLicense)) {
    copyPathFiltered(cliRoot, 'LICENSE', packRoot);
  } else if (existsSync(repoLicense)) {
    copyRecursive(repoRoot, repoLicense, join(packRoot, 'LICENSE'));
  }
}

function copyBundledProviders({ providersRoot, packRoot, providersPackage }) {
  const providerDest = join(packRoot, 'node_modules', '@hive-flow', 'providers');
  rmSync(providerDest, { recursive: true, force: true });
  mkdirSync(providerDest, { recursive: true });

  const entries = Array.isArray(providersPackage.files) && providersPackage.files.length
    ? providersPackage.files
    : PROVIDER_COPY_FALLBACK;
  for (const rel of entries) {
    copyPathFiltered(providersRoot, rel, providerDest);
  }
  writeJson(join(providerDest, 'package.json'), createBundledProviderManifest(providersPackage));
}

function assertBuiltRuntime({ cliRoot, providersRoot }) {
  const required = [
    join(cliRoot, 'dist', 'src', 'index.js'),
    join(cliRoot, 'dist', 'src', 'mcp-client.js'),
    join(cliRoot, 'bin', 'cli.js'),
    join(cliRoot, 'bin', 'mcp-server.js'),
    join(providersRoot, 'dist', 'index.js'),
    join(providersRoot, 'scripts', 'provider-agent-bridge.mjs'),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(
      `[pack-smoke] built runtime missing:\n  - ${missing.join('\n  - ')}\n` +
        'Run: npm --prefix cli run build; also build the active providers workspace.',
    );
  }
}

export function prepareSyntheticPackRoot(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const cliRoot = resolve(options.cliRoot ?? DEFAULT_CLI_ROOT);
  const providersRoot = resolve(options.providersRoot ?? resolveProvidersRoot({ cliRoot, repoRoot }));
  const packRoot = resolve(options.packRoot ?? mkdtempSync(join(tmpdir(), 'hf-pack-smoke-root-')));

  assertBuiltRuntime({ cliRoot, providersRoot });

  rmSync(packRoot, { recursive: true, force: true });
  mkdirSync(packRoot, { recursive: true });

  const rootPackage = readJson(join(repoRoot, 'package.json'));
  const cliPackage = readJson(join(cliRoot, 'package.json'));
  const providersPackage = readJson(join(providersRoot, 'package.json'));
  const manifest = createFutureHiveFlowManifest({ cliPackage, providersPackage, rootPackage });

  copyRuntimePayload({ cliRoot, repoRoot, packRoot });
  copyBundledProviders({ providersRoot, packRoot, providersPackage });
  writeJson(join(packRoot, 'package.json'), manifest);

  return {
    cliRoot,
    manifest,
    omittedWorkspaceOptionals: Array.from(OMITTED_WORKSPACE_OPTIONALS),
    packRoot,
    providersRoot,
    repoRoot,
  };
}

function npmEnv(workRoot) {
  return {
    ...process.env,
    npm_config_cache: join(workRoot, 'npm-cache'),
    npm_config_loglevel: 'error',
    npm_config_update_notifier: 'false',
  };
}

function parseNpmJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(`[pack-smoke] npm did not emit JSON: ${trimmed.slice(0, 500)}`);
  }
}

function npmPack(packRoot, workRoot, { dryRun }) {
  const args = ['pack', '--json', '--ignore-scripts'];
  if (dryRun) args.push('--dry-run');
  const stdout = execFileSync('npm', args, {
    cwd: packRoot,
    env: npmEnv(workRoot),
    encoding: 'utf8',
    timeout: 120_000,
  });
  const parsed = parseNpmJson(stdout);
  if (!Array.isArray(parsed) || !parsed[0]?.files) {
    throw new Error('[pack-smoke] npm pack JSON did not include file metadata');
  }
  const info = parsed[0];
  const files = info.files.map((file) => file.path);
  assertPackageFileList(files);
  return {
    files,
    filename: info.filename,
    tarballPath: info.filename ? join(packRoot, info.filename) : null,
  };
}

function npmInstallTarball(tarballPath, installRoot, workRoot) {
  mkdirSync(installRoot, { recursive: true });
  execFileSync('npm', [
    'install',
    '--prefix',
    installRoot,
    '--package-lock=false',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    tarballPath,
  ], {
    cwd: installRoot,
    env: npmEnv(workRoot),
    stdio: 'pipe',
    timeout: 240_000,
  });
}

function probeEnv(installRoot) {
  const home = join(installRoot, 'home');
  const hiveHome = join(installRoot, '.hive-flow-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(hiveHome, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    HIVE_FLOW_HOME: hiveHome,
    HIVE_FLOW_CREDENTIAL_HOLDER_REQUIRED: '0',
    HIVE_FLOW_DISABLE_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

function probeCliVersion(packageRoot, installRoot) {
  return execFileSync(process.execPath, [join(packageRoot, 'bin', 'cli.js'), '--version'], {
    cwd: installRoot,
    env: probeEnv(installRoot),
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

function runImportProbe(packageRoot, installRoot) {
  const probePath = join(packageRoot, '.pack-smoke-import-probe.mjs');
  writeFileSync(probePath, `
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const loaded = [];
for (const specifier of [
  'hive-flow',
  'hive-flow/memory',
  '@hive-flow/providers',
  '@hive-flow/providers/scripts/agent-task-journal.mjs',
]) {
  await import(specifier);
  loaded.push(specifier);
}

const bridge = await import('@hive-flow/providers/scripts/provider-agent-bridge.mjs');
if (typeof bridge.evaluateToolCall !== 'function') {
  throw new Error('provider bridge did not expose evaluateToolCall');
}

const providerIndex = fileURLToPath(await import.meta.resolve('@hive-flow/providers'));
const providerRoot = dirname(dirname(providerIndex));
const undiciPath = require.resolve('undici', { paths: [providerRoot] });
process.stdout.write(JSON.stringify({
  loaded,
  providerRoot,
  undiciPath,
  bridgeEvaluateToolCall: typeof bridge.evaluateToolCall,
}));
`, 'utf8');

  const stdout = execFileSync(process.execPath, [probePath], {
    cwd: packageRoot,
    env: probeEnv(installRoot),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

function probeMcpServer(packageRoot, installRoot) {
  const env = probeEnv(installRoot);
  const serverPath = join(packageRoot, 'bin', 'mcp-server.js');
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: installRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      rejectProbe(new Error(`[pack-smoke] MCP initialize probe timed out. stderr:\n${stderr}`));
    }, 15_000);

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      fn(value);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const message = JSON.parse(trimmed);
          if (message.id === 1) {
            if (message.error) {
              settle(rejectProbe, new Error(`[pack-smoke] MCP initialize returned error: ${JSON.stringify(message.error)}`));
            } else {
              settle(resolveProbe, message.result);
            }
            return;
          }
        } catch {
          // Ignore incomplete/non-JSON lines until timeout.
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      settle(rejectProbe, error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      clearTimeout(timeout);
      rejectProbe(new Error(`[pack-smoke] MCP server exited before initialize response code=${code} signal=${signal}. stderr:\n${stderr}`));
    });

    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  });
}

export async function runPackInstallSmoke(options = {}) {
  const keepTemp = options.keepTemp ?? process.env.HIVE_FLOW_PACK_SMOKE_KEEP_TEMP === '1';
  const workRoot = resolve(options.workRoot ?? mkdtempSync(join(tmpdir(), 'hf-pack-install-smoke-')));
  const packRoot = join(workRoot, 'pack-root');
  const installRoot = join(workRoot, 'install-root');
  let success = false;

  try {
    const prepared = prepareSyntheticPackRoot({ ...options, packRoot });
    const dryRun = npmPack(packRoot, workRoot, { dryRun: true });
    const packed = npmPack(packRoot, workRoot, { dryRun: false });
    if (!packed.tarballPath || !existsSync(packed.tarballPath)) {
      throw new Error('[pack-smoke] npm pack did not create a tarball');
    }

    npmInstallTarball(packed.tarballPath, installRoot, workRoot);

    const packageRoot = join(installRoot, 'node_modules', 'hive-flow');
    const versionOutput = probeCliVersion(packageRoot, installRoot);
    const importProbe = runImportProbe(packageRoot, installRoot);
    const mcpProbe = await probeMcpServer(packageRoot, installRoot);

    success = true;
    return {
      status: 'ok',
      generatedPackageName: prepared.manifest.name,
      generatedPackageVersion: prepared.manifest.version,
      dryRunFileCount: dryRun.files.length,
      packedFileCount: packed.files.length,
      versionOutput,
      importProbe,
      mcpProbe,
      omittedWorkspaceOptionals: prepared.omittedWorkspaceOptionals,
      providerUndiciSpec: prepared.manifest.dependencies.undici,
      workRoot,
      packRoot,
      installRoot,
      tarballPath: packed.tarballPath,
      tempRetained: keepTemp,
    };
  } finally {
    if (success && !keepTemp) {
      rmSync(workRoot, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep-temp') {
      options.keepTemp = true;
    } else if (arg === '--repo-root') {
      options.repoRoot = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/pack-install-smoke.mjs [--keep-temp] [--repo-root PATH]',
    '',
    'Builds a temporary hive-flow package root from cli/,',
    'packs it, installs the tarball into a temporary prefix, and probes CLI,',
    'MCP, public exports, bundled providers, and undici resolution.',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runPackInstallSmoke(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
