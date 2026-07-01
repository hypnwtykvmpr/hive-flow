import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  HELPER_BINARIES,
  helperBinDir,
} from '../credential-store/helper-paths.js';
import {
  execFileNoThrow,
  type ExecFileNoThrowResult,
} from '../utils/execFileNoThrow.js';

export type { ExecFileNoThrowResult } from '../utils/execFileNoThrow.js';

export type RunFile = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array | string; timeout?: number; windowsHide?: boolean }
) => Promise<ExecFileNoThrowResult>;

export interface HelperResult {
  helper: string;
  status: 'installed' | 'skipped' | 'unavailable' | 'failed';
  reason?: string;
  remediation?: string;
}

export interface InstallNativeHelpersOptions {
  projectRoot: string;
  binDir?: string;
  platform?: NodeJS.Platform;
  force?: boolean;
  runFile?: RunFile;
}

export interface EnsureHelperPathOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const MARKER_FILE = '.native-helpers.version';
const PATH_BLOCK_START = '# >>> hive-flow bin (managed) >>>';
const PATH_BLOCK_END = '# <<< hive-flow bin (managed) <<<';

function ok(result: ExecFileNoThrowResult): boolean {
  return result.code === 0;
}

function renderFailure(result: ExecFileNoThrowResult): string {
  return (result.stderr || result.stdout || result.error || `exit ${result.code}`).trim();
}

function moduleRelativeCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, '..', 'credential-store', 'helpers'),
    resolve(here, '..', '..', 'credential-store', 'helpers'),
  ];
}

export function helperSourceDir(projectRoot: string): string {
  const candidates = [
    join(projectRoot, 'dist', 'credential-store', 'helpers'),
    join(projectRoot, 'src', 'credential-store', 'helpers'),
    join(projectRoot, 'cli', 'dist', 'credential-store', 'helpers'),
    join(projectRoot, 'cli', 'src', 'credential-store', 'helpers'),
    ...moduleRelativeCandidates(),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('helper sources not found (run build:helpers-src)');
  return found;
}

export function copyHelperSources(sourceDir: string, targetDir: string): void {
  const copyRecursive = (source: string, target: string): void => {
    if (source.split(/[\\/]/).includes('.hive-flow')) return;
    const sourceStat = statSync(source);
    if (sourceStat.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(source)) {
        copyRecursive(join(source, entry), join(target, entry));
      }
      return;
    }
    if (sourceStat.isFile()) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  };
  rmSync(targetDir, { recursive: true, force: true });
  copyRecursive(sourceDir, targetDir);
}

export function profilePathFor(homeDir: string, env: NodeJS.ProcessEnv): string {
  const shell = String(env.SHELL ?? '');
  if (shell.endsWith('/zsh') || shell.endsWith('\\zsh')) return join(homeDir, '.zshrc');
  if (shell.endsWith('/bash') || shell.endsWith('\\bash')) return join(homeDir, '.bashrc');
  return join(homeDir, '.profile');
}

export function ensureHelperBinOnPath(options: EnsureHelperPathOptions = {}): HelperResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? (env.HOME || process.env.HOME || '');
  if (!homeDir) {
    return { helper: 'PATH', status: 'skipped', reason: 'home directory unavailable' };
  }
  if (platform === 'win32') {
    return {
      helper: 'PATH',
      status: 'skipped',
      reason: 'fixed-dir helper resolution is used on Windows; add %USERPROFILE%\\.hive-flow\\bin to PATH for shell access',
    };
  }
  const binDir = helperBinDir(homeDir);
  const pathEntries = String(env.PATH ?? '').split(':').filter(Boolean);
  if (pathEntries.includes(binDir)) {
    return { helper: 'PATH', status: 'skipped', reason: 'PATH already contains hive-flow bin' };
  }
  const profile = profilePathFor(homeDir, env);
  let existing = '';
  try {
    existing = readFileSync(profile, 'utf8');
  } catch {
    existing = '';
  }
  if (existing.includes(PATH_BLOCK_START)) {
    return { helper: 'PATH', status: 'skipped', reason: 'profile already contains hive-flow bin block' };
  }
  mkdirSync(dirname(profile), { recursive: true });
  const block = [
    '',
    PATH_BLOCK_START,
    'case ":$PATH:" in *":$HOME/.hive-flow/bin:"*) ;; *) export PATH="$HOME/.hive-flow/bin:$PATH";; esac',
    PATH_BLOCK_END,
    '',
  ].join('\n');
  appendFileSync(profile, block, { mode: 0o600 });
  return { helper: 'PATH', status: 'installed', reason: profile };
}

function hashSources(platform: NodeJS.Platform, sourceDir: string): string {
  const hash = createHash('sha256');
  hash.update(platform);
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === '.hive-flow') continue;
      const file = join(dir, entry);
      const st = statSync(file);
      if (st.isDirectory()) {
        visit(file);
      } else if (st.isFile()) {
        hash.update(file.slice(sourceDir.length));
        hash.update(readFileSync(file));
      }
    }
  };
  visit(sourceDir);
  return hash.digest('hex');
}

function markerPath(binDir: string): string {
  return join(binDir, MARKER_FILE);
}

function readMarker(binDir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(markerPath(binDir), 'utf8')).stamp;
  } catch {
    return undefined;
  }
}

function writeMarker(binDir: string, stamp: string, results: HelperResult[]): void {
  writeFileSync(markerPath(binDir), JSON.stringify({
    stamp,
    installedAt: new Date().toISOString(),
    results,
  }, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(markerPath(binDir), 0o600); } catch { /* best effort on Windows */ }
}

async function probe(
  runFile: RunFile,
  tool: string,
  remediation: string,
): Promise<HelperResult | undefined> {
  const result = await runFile(tool, ['--version'], { timeout: 10_000 });
  if (ok(result)) return undefined;
  return {
    helper: tool,
    status: 'unavailable',
    reason: renderFailure(result),
    remediation,
  };
}

function chmodIfPresent(file: string, mode: number): void {
  if (!existsSync(file)) return;
  try { chmodSync(file, mode); } catch { /* Windows or unusual fs: verification will catch real failures. */ }
}

async function buildDarwin(sourceDir: string, binDir: string, runFile: RunFile): Promise<HelperResult[]> {
  const results: HelperResult[] = [];
  const swiftUnavailable = await probe(runFile, 'swiftc', 'Install Xcode Command Line Tools: xcode-select --install');
  const ccUnavailable = await probe(runFile, 'cc', 'Install Xcode Command Line Tools: xcode-select --install');
  if (swiftUnavailable) {
    results.push({ ...swiftUnavailable, helper: HELPER_BINARIES.macosKeychain });
  } else {
    const out = join(binDir, HELPER_BINARIES.macosKeychain);
    const compiled = await runFile('swiftc', [
      '-O',
      '-parse-as-library',
      '-framework', 'Foundation',
      '-framework', 'Security',
      '-framework', 'LocalAuthentication',
      join(sourceDir, 'macos-keychain.swift'),
      '-o',
      out,
    ], { timeout: 120_000 });
    if (ok(compiled)) {
      const signed = await runFile('codesign', ['--sign', '-', '--force', out], { timeout: 30_000 });
      if (ok(signed)) {
        chmodIfPresent(out, 0o755);
        results.push({ helper: HELPER_BINARIES.macosKeychain, status: 'installed' });
      } else {
        results.push({ helper: HELPER_BINARIES.macosKeychain, status: 'failed', reason: renderFailure(signed), remediation: 'Ensure macOS codesign is available.' });
      }
    } else {
      results.push({ helper: HELPER_BINARIES.macosKeychain, status: 'failed', reason: renderFailure(compiled) });
    }
  }
  if (ccUnavailable) {
    results.push({ ...ccUnavailable, helper: HELPER_BINARIES.peerCred });
  } else {
    results.push(await buildPeerCred(sourceDir, binDir, runFile));
  }
  return results;
}

async function buildLinux(sourceDir: string, binDir: string, runFile: RunFile): Promise<HelperResult[]> {
  const results: HelperResult[] = [];
  const secretTool = await probe(runFile, 'secret-tool', 'Install libsecret-tools, for example: apt-get install libsecret-tools or dnf install libsecret.');
  results.push(secretTool ? { ...secretTool, helper: 'secret-tool' } : { helper: 'secret-tool', status: 'installed' });
  const ccUnavailable = await probe(runFile, 'cc', 'Install a C compiler, for example: apt-get install build-essential or dnf groupinstall "Development Tools".');
  results.push(ccUnavailable ? { ...ccUnavailable, helper: HELPER_BINARIES.peerCred } : await buildPeerCred(sourceDir, binDir, runFile));
  return results;
}

async function buildPeerCred(sourceDir: string, binDir: string, runFile: RunFile): Promise<HelperResult> {
  const out = join(binDir, HELPER_BINARIES.peerCred);
  const result = await runFile('cc', [
    '-O2',
    '-o',
    out,
    join(sourceDir, 'peer-cred-helper.c'),
  ], { timeout: 60_000 });
  if (!ok(result)) {
    return { helper: HELPER_BINARIES.peerCred, status: 'failed', reason: renderFailure(result) };
  }
  chmodIfPresent(out, 0o755);
  return { helper: HELPER_BINARIES.peerCred, status: 'installed' };
}

async function buildDotnetHelper(
  sourceDir: string,
  binDir: string,
  projectRelative: string,
  assemblyName: string,
  binaryName: string,
  runFile: RunFile,
): Promise<HelperResult> {
  const publishDir = join(binDir, `.publish-${assemblyName}`);
  const result = await runFile('dotnet', [
    'publish',
    join(sourceDir, projectRelative),
    '-c', 'Release',
    '-r', 'win-x64',
    '--self-contained', 'false',
    '-p:PublishSingleFile=true',
    `-p:AssemblyName=${assemblyName}`,
    '-o',
    publishDir,
  ], { timeout: 180_000 });
  if (!ok(result)) {
    return { helper: binaryName, status: 'failed', reason: renderFailure(result) };
  }
  const published = join(publishDir, `${assemblyName}.exe`);
  if (existsSync(published)) copyFileSync(published, join(binDir, binaryName));
  return { helper: binaryName, status: 'installed' };
}

async function buildWindows(sourceDir: string, binDir: string, runFile: RunFile): Promise<HelperResult[]> {
  const dotnetUnavailable = await probe(runFile, 'dotnet', 'Install the .NET SDK from https://dotnet.microsoft.com/download.');
  if (dotnetUnavailable) {
    return [
      { ...dotnetUnavailable, helper: HELPER_BINARIES.winCredential },
      { ...dotnetUnavailable, helper: HELPER_BINARIES.winPeerCred },
    ];
  }
  return [
    await buildDotnetHelper(
      sourceDir,
      binDir,
      join('windows-credential-helper', 'HiveFlow.WindowsCredentialHelper.csproj'),
      'hive-flow-windows-credential-helper',
      HELPER_BINARIES.winCredential,
      runFile,
    ),
    await buildDotnetHelper(
      sourceDir,
      binDir,
      join('windows-peer-cred-helper', 'HiveFlow.WindowsPeerCredHelper.csproj'),
      'hive-flow-windows-peer-cred-helper',
      HELPER_BINARIES.winPeerCred,
      runFile,
    ),
  ];
}

export async function verifyInstalledHelpers(
  binDir: string,
  platform: NodeJS.Platform = process.platform,
  runFile: RunFile = execFileNoThrow,
): Promise<HelperResult[]> {
  if (platform === 'darwin') {
    return [
      await verifyOne(runFile, join(binDir, HELPER_BINARIES.macosKeychain), ['status'], HELPER_BINARIES.macosKeychain),
      await verifyOne(runFile, join(binDir, HELPER_BINARIES.peerCred), ['selftest'], HELPER_BINARIES.peerCred),
    ];
  }
  if (platform === 'linux') {
    return [
      await verifyOne(runFile, 'secret-tool', ['--version'], 'secret-tool'),
      await verifyOne(runFile, join(binDir, HELPER_BINARIES.peerCred), ['selftest'], HELPER_BINARIES.peerCred),
    ];
  }
  if (platform === 'win32') {
    return [
      await verifyOne(runFile, join(binDir, HELPER_BINARIES.winCredential), ['status'], HELPER_BINARIES.winCredential),
      await verifyOne(runFile, join(binDir, HELPER_BINARIES.winPeerCred), ['selftest'], HELPER_BINARIES.winPeerCred),
    ];
  }
  return [{ helper: 'native-helpers', status: 'skipped', reason: `unsupported platform ${platform}` }];
}

async function verifyOne(runFile: RunFile, file: string, args: readonly string[], helper: string): Promise<HelperResult> {
  const result = await runFile(file, args, { timeout: 10_000 });
  return ok(result)
    ? { helper, status: 'installed' }
    : { helper, status: 'failed', reason: renderFailure(result) };
}

export async function buildAndInstallNativeHelpers(options: InstallNativeHelpersOptions): Promise<HelperResult[]> {
  const platform = options.platform ?? process.platform;
  const runFile = options.runFile ?? execFileNoThrow;
  const binDir = resolve(options.binDir ?? helperBinDir());
  const sourceDir = helperSourceDir(options.projectRoot);
  const stamp = hashSources(platform, sourceDir);
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  try { chmodSync(binDir, 0o700); } catch { /* Windows or unusual fs */ }

  if (options.force !== true && readMarker(binDir) === stamp) {
    const verification = await verifyInstalledHelpers(binDir, platform, runFile);
    if (verification.every(result => result.status === 'installed')) {
      return [{ helper: 'native-helpers', status: 'skipped', reason: 'already installed' }];
    }
  }

  let results: HelperResult[];
  if (platform === 'darwin') results = await buildDarwin(sourceDir, binDir, runFile);
  else if (platform === 'linux') results = await buildLinux(sourceDir, binDir, runFile);
  else if (platform === 'win32') results = await buildWindows(sourceDir, binDir, runFile);
  else results = [{ helper: 'native-helpers', status: 'skipped', reason: `unsupported platform ${platform}` }];

  const verification = results.some(result => result.status === 'failed' || result.status === 'unavailable')
    ? []
    : await verifyInstalledHelpers(binDir, platform, runFile);
  const combined = [...results, ...verification.filter(check => check.status !== 'installed')];
  if (combined.every(result => result.status === 'installed' || result.status === 'skipped')) {
    writeMarker(binDir, stamp, combined);
  }
  return combined;
}
