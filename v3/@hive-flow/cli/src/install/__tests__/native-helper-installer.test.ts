import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HELPER_BINARIES, helperBinDir } from '../../credential-store/helper-paths.js';
import {
  buildAndInstallNativeHelpers,
  copyHelperSources,
  ensureHelperBinOnPath,
  verifyInstalledHelpers,
  type ExecFileNoThrowResult,
  type HelperResult,
  type RunFile,
} from '../native-helper-installer.js';

const roots: string[] = [];

function commandExists(command: string): boolean {
  try {
    execFileSync('/usr/bin/which', [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `hf-native-${label}-`));
  roots.push(root);
  return root;
}

function writeFixtureSources(projectRoot: string): string {
  const helpers = join(projectRoot, 'src', 'credential-store', 'helpers');
  const files: Record<string, string> = {
    'macos-keychain.swift': 'print("mac helper")\n',
    'peer-cred-helper.c': 'int main(){return 0;}\n',
    'windows-credential-helper/HiveFlow.WindowsCredentialHelper.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows10.0.19041.0</TargetFramework></PropertyGroup></Project>\n',
    'windows-credential-helper/Program.cs': 'Console.WriteLine("cred");\n',
    'windows-credential-helper/.hive-flow/cache.txt': 'do not copy\n',
    'windows-peer-cred-helper/HiveFlow.WindowsPeerCredHelper.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows10.0.19041.0</TargetFramework></PropertyGroup></Project>\n',
    'windows-peer-cred-helper/Program.cs': 'Console.WriteLine("peer");\n',
    'windows-peer-cred-helper/.hive-flow/cache.txt': 'do not copy\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = join(helpers, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return helpers;
}

function ok(stdout = ''): ExecFileNoThrowResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(stderr = 'missing'): ExecFileNoThrowResult {
  return { code: 127, stdout: '', stderr };
}

function fakeRunner(options: {
  failCommands?: Set<string>;
  verifyOk?: boolean;
} = {}): { calls: Array<{ file: string; args: readonly string[] }>; runFile: RunFile } {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const runFile: RunFile = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (options.failCommands?.has(file)) return fail(`${file} unavailable`);
    if (args.includes('--version')) return ok(`${file} version\n`);
    if (args[0] === 'status') return options.verifyOk === false ? fail('not ready') : ok('available\n');
    if (args[0] === 'selftest') return options.verifyOk === false ? fail('not ready') : ok('{"platform":"darwin","pid":1,"uid":501,"startTime":"1"}\n');
    return ok('');
  };
  return { calls, runFile };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native helper installer', () => {
  it('builds and verifies the darwin keychain and peer helpers with shell-free argv arrays', async () => {
    const projectRoot = tempRoot('darwin-project');
    writeFixtureSources(projectRoot);
    const binDir = join(tempRoot('darwin-home'), '.hive-flow', 'bin');
    const { calls, runFile } = fakeRunner();

    const results = await buildAndInstallNativeHelpers({
      projectRoot,
      binDir,
      platform: 'darwin',
      runFile,
    });

    expect(results.every(result => result.status === 'installed')).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      { file: 'swiftc', args: expect.arrayContaining(['-O', '-parse-as-library', '-framework', 'Foundation', '-framework', 'Security', '-framework', 'LocalAuthentication']) },
      { file: 'codesign', args: ['--sign', '-', '--force', join(binDir, HELPER_BINARIES.macosKeychain)] },
      { file: 'cc', args: ['-O2', '-o', join(binDir, HELPER_BINARIES.peerCred), join(projectRoot, 'src', 'credential-store', 'helpers', 'peer-cred-helper.c')] },
      { file: join(binDir, HELPER_BINARIES.macosKeychain), args: ['status'] },
      { file: join(binDir, HELPER_BINARIES.peerCred), args: ['selftest'] },
    ]));
    expect(existsSync(join(binDir, '.native-helpers.version'))).toBe(true);
  });

  it('skips a matching install when marker and verification are already healthy', async () => {
    const projectRoot = tempRoot('skip-project');
    writeFixtureSources(projectRoot);
    const binDir = join(tempRoot('skip-home'), '.hive-flow', 'bin');
    const first = fakeRunner();
    await buildAndInstallNativeHelpers({ projectRoot, binDir, platform: 'linux', runFile: first.runFile });
    const second = fakeRunner();

    const results = await buildAndInstallNativeHelpers({ projectRoot, binDir, platform: 'linux', runFile: second.runFile });

    expect(results).toEqual([{ helper: 'native-helpers', status: 'skipped', reason: 'already installed' } satisfies HelperResult]);
    expect(second.calls.map(call => call.file)).not.toContain('cc');
  });

  it('fails soft with remediation when a host toolchain probe is unavailable', async () => {
    const projectRoot = tempRoot('missing-toolchain-project');
    writeFixtureSources(projectRoot);
    const binDir = join(tempRoot('missing-toolchain-home'), '.hive-flow', 'bin');
    const { runFile } = fakeRunner({ failCommands: new Set(['swiftc']) });

    const results = await buildAndInstallNativeHelpers({
      projectRoot,
      binDir,
      platform: 'darwin',
      runFile,
    });

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        helper: HELPER_BINARIES.macosKeychain,
        status: 'unavailable',
        remediation: expect.stringMatching(/xcode-select/i),
      }),
    ]));
  });

  it('verifies host-specific helper self-check commands', async () => {
    const binDir = join(tempRoot('verify-home'), '.hive-flow', 'bin');
    const { calls, runFile } = fakeRunner();

    const results = await verifyInstalledHelpers(binDir, 'win32', runFile);

    expect(results.every(result => result.status === 'installed')).toBe(true);
    expect(calls).toEqual([
      { file: join(binDir, HELPER_BINARIES.winCredential), args: ['status'] },
      { file: join(binDir, HELPER_BINARIES.winPeerCred), args: ['selftest'] },
    ]);
  });

  it('copies helper sources while excluding nested .hive-flow cache directories', () => {
    const projectRoot = tempRoot('copy-project');
    const source = writeFixtureSources(projectRoot);
    const target = join(tempRoot('copy-target'), 'dist', 'credential-store', 'helpers');

    copyHelperSources(source, target);

    expect(existsSync(join(target, 'macos-keychain.swift'))).toBe(true);
    expect(existsSync(join(target, 'windows-credential-helper', 'HiveFlow.WindowsCredentialHelper.csproj'))).toBe(true);
    expect(existsSync(join(target, 'windows-credential-helper', '.hive-flow'))).toBe(false);
    expect(existsSync(join(target, 'windows-peer-cred-helper', '.hive-flow'))).toBe(false);
  });

  it('uses ~/.hive-flow/bin as the default helper install directory', () => {
    const homeDir = tempRoot('home');
    expect(helperBinDir(homeDir)).toBe(join(homeDir, '.hive-flow', 'bin'));
  });

  it('adds ~/.hive-flow/bin to a POSIX shell profile idempotently when PATH does not already include it', () => {
    const homeDir = tempRoot('profile-home');
    const profile = join(homeDir, '.zshrc');

    const first = ensureHelperBinOnPath({
      homeDir,
      platform: 'darwin',
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    });
    const second = ensureHelperBinOnPath({
      homeDir,
      platform: 'darwin',
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    });

    expect(first).toEqual({ helper: 'PATH', status: 'installed', reason: profile });
    expect(second).toEqual({ helper: 'PATH', status: 'skipped', reason: 'profile already contains hive-flow bin block' });
    const contents = readFileSync(profile, 'utf8');
    expect(contents.match(/hive-flow bin \(managed\)/g)).toHaveLength(2);
    expect(contents).toContain('export PATH="$HOME/.hive-flow/bin:$PATH"');
  });

  it.skipIf(
    process.platform !== 'darwin'
    || !commandExists('swiftc')
    || !commandExists('cc')
    || !commandExists('codesign'),
  )(
    'drives the real macOS installer build so Swift arguments cannot drift from native compilation',
    async () => {
      const packageRoot = resolve(__dirname, '..', '..', '..');
      const binDir = join(tempRoot('real-darwin-home'), '.hive-flow', 'bin');

      const results = await buildAndInstallNativeHelpers({
        projectRoot: packageRoot,
        binDir,
        platform: 'darwin',
        force: true,
      });

      expect(results).toEqual(expect.arrayContaining([
        { helper: HELPER_BINARIES.macosKeychain, status: 'installed' },
        { helper: HELPER_BINARIES.peerCred, status: 'installed' },
      ]));
      expect(String(execFileSync(join(binDir, HELPER_BINARIES.macosKeychain), ['status'])).trim()).toBe('available');
      const peerSelftest = JSON.parse(String(execFileSync(join(binDir, HELPER_BINARIES.peerCred), ['selftest'])));
      expect(peerSelftest).toMatchObject({
        platform: 'darwin',
        uid: process.getuid?.(),
      });
    },
    180_000,
  );
});
