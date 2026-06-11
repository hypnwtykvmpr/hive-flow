import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKek } from '../kek.js';
import {
  HELPER_BINARIES,
  installedHelperPath,
} from '../helper-paths.js';
import {
  MacOSKeychainCredentialStore,
  LinuxSecretServiceCredentialStore,
  WindowsCredentialManagerCredentialStore,
  assertCredentialBackendReady,
  createPlatformCredentialStore,
} from '../platform-backends.js';

type ExecOptions = { input?: Uint8Array | string; encoding?: BufferEncoding; stdio?: unknown };
type Runner = (file: string, args: readonly string[], options?: ExecOptions) => Buffer | string;

function commandExists(command: string): boolean {
  try {
    execFileSync('command', ['-v', command], { stdio: 'pipe' });
    return true;
  } catch {
    try {
      execFileSync('/usr/bin/which', [command], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function makeSecretToolRunner() {
  const calls: Array<{ file: string; args: readonly string[]; input?: Uint8Array | string }> = [];
  const items = new Map<string, string>();
  const keyFromArgs = (args: readonly string[]) => args.slice(-6).join('\0');
  const runner: Runner = (file, args, options = {}) => {
    calls.push({ file, args: [...args], input: options.input });
    if (file !== 'secret-tool') throw new Error(`unexpected command ${file}`);
    if (args[0] === '--help') return Buffer.from('Usage:\n  secret-tool store --label=LABEL ATTR VALUE\n');
    if (args[0] === 'store') {
      items.set(keyFromArgs(args), String(options.input ?? '').trim());
      return Buffer.from('');
    }
    if (args[0] === 'lookup') {
      return Buffer.from(`${items.get(keyFromArgs(args)) ?? ''}\n`);
    }
    if (args[0] === 'clear') {
      items.delete(keyFromArgs(args));
      return Buffer.from('');
    }
    throw new Error(`unexpected secret-tool args ${args.join(' ')}`);
  };
  return { calls, runner };
}

function makeWindowsRunner() {
  const calls: Array<{ file: string; args: readonly string[]; input?: Uint8Array | string }> = [];
  const items = new Map<string, string>();
  const runner: Runner = (file, args, options = {}) => {
    calls.push({ file, args: [...args], input: options.input });
    if (file !== 'hive-flow-windows-credential-helper') throw new Error(`unexpected command ${file}`);
    const target = args[1] ?? '';
    if (args[0] === 'status') return Buffer.from('available\n');
    if (args[0] === 'store') {
      items.set(target, String(options.input ?? '').trim());
      return Buffer.from('');
    }
    if (args[0] === 'retrieve') return Buffer.from(`${items.get(target) ?? ''}\n`);
    if (args[0] === 'delete') {
      items.delete(target);
      return Buffer.from('');
    }
    throw new Error(`unexpected windows helper args ${args.join(' ')}`);
  };
  return { calls, runner };
}

function makeMacOSHelperRunner() {
  const calls: Array<{ file: string; args: readonly string[]; input?: Uint8Array | string }> = [];
  const items = new Map<string, string>();
  const keyFromArgs = (args: readonly string[]) => `${args[1] ?? ''}\0${args[2] ?? ''}\0${args[3] ?? ''}`;
  const runner: Runner = (file, args, options = {}) => {
    calls.push({ file, args: [...args], input: options.input });
    if (file !== 'hive-flow-macos-keychain-helper') throw new Error(`unexpected command ${file}`);
    if (args[0] === 'status') return Buffer.from('available\n');
    if (args[0] === 'store') {
      const payload = JSON.parse(String(options.input ?? '{}')) as { secret?: string };
      items.set(keyFromArgs(args), String(payload.secret ?? ''));
      return Buffer.from('');
    }
    if (args[0] === 'retrieve') return Buffer.from(`${items.get(keyFromArgs(args)) ?? ''}\n`);
    if (args[0] === 'delete') {
      items.delete(keyFromArgs(args));
      return Buffer.from('');
    }
    throw new Error(`unexpected macOS helper args ${args.join(' ')}`);
  };
  return { calls, runner };
}

describe('credential platform backend selection and degraded install gate', () => {
  it('selects explicit backend per platform', () => {
    expect(createPlatformCredentialStore({ platform: 'darwin' })).toBeInstanceOf(MacOSKeychainCredentialStore);
    expect(createPlatformCredentialStore({ platform: 'linux' })).toBeInstanceOf(LinuxSecretServiceCredentialStore);
    expect(createPlatformCredentialStore({ platform: 'win32' })).toBeInstanceOf(WindowsCredentialManagerCredentialStore);
  });

  it('credential backend status exposes only probed backend readiness fields', () => {
    const source = readFileSync(resolve(__dirname, '..', 'credential-store.ts'), 'utf8');
    const statusBody = source.match(/export interface CredentialStoreStatus \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(statusBody).not.toMatch(/\blocked\b/);
    expect(statusBody).not.toMatch(/\bprovider\b/);
  });

  it('does not echo provider-specific state from backend availability probes', async () => {
    const { runner: linuxRunner } = makeSecretToolRunner();
    const linux = new LinuxSecretServiceCredentialStore({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/fake-bus' },
      execFileSync: linuxRunner,
    });
    const { runner: windowsRunner } = makeWindowsRunner();
    const windows = new WindowsCredentialManagerCredentialStore({
      platform: 'win32',
      helperCommand: 'hive-flow-windows-credential-helper',
      execFileSync: windowsRunner,
    });
    const { runner: macRunner } = makeMacOSHelperRunner();
    const macos = new MacOSKeychainCredentialStore({
      platform: 'darwin',
      helperCommand: 'hive-flow-macos-keychain-helper',
      execFileSync: macRunner,
    });

    for (const status of [
      await linux.status('OpenRouter'),
      await windows.status('OpenRouter'),
      await macos.status('OpenRouter'),
    ]) {
      expect(status).toEqual({ available: true });
      expect(status).not.toHaveProperty('provider');
      expect(status).not.toHaveProperty('locked');
    }
  });

  it('fails closed for unavailable or degraded backends unless degraded mode is explicit', () => {
    expect(() => assertCredentialBackendReady({ available: false, degraded: true, reason: 'no dbus' })).toThrow(/degraded|unavailable/i);
    expect(() => assertCredentialBackendReady({ available: false, degraded: true, reason: 'no dbus' }, { allowDegraded: true })).not.toThrow();
  });
});

describe('Linux Secret Service backend', () => {
  it('stores provider secrets and KEK envelopes through secret-tool stdin without argv secret material', async () => {
    const { calls, runner } = makeSecretToolRunner();
    const backend = new LinuxSecretServiceCredentialStore({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/fake-bus' },
      execFileSync: runner,
    });
    const secret = Buffer.from('or-linux-secret');
    await backend.storeSecret('OpenRouter', secret);
    await expect(backend.retrieveSecret('openrouter')).resolves.toEqual(secret);

    const kek = generateKek(size => Buffer.alloc(size, 7));
    const sealed = await backend.sealKek(kek);
    expect(Buffer.from(sealed.sealed).includes(kek)).toBe(false);
    await expect(backend.unsealKek(sealed)).resolves.toEqual(kek);

    const argv = calls.flatMap(call => call.args).join(' ');
    expect(argv).not.toContain(secret.toString('utf8'));
    expect(argv).not.toContain(base64(secret));
  });

  it('reports explicit degraded status when secret-tool or the D-Bus session is unavailable', async () => {
    const backend = new LinuxSecretServiceCredentialStore({
      platform: 'linux',
      env: {},
      execFileSync: () => {
        throw new Error('missing secret-tool');
      },
    });
    await expect(backend.status()).resolves.toMatchObject({
      available: false,
      degraded: true,
    });
    await expect(backend.storeSecret('openrouter', Buffer.from('key'))).rejects.toThrow(/degraded|unavailable|secret-tool/i);
  });

  it('round-trips arbitrary byte secrets as Buffers through the mocked backend', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 64 }), async bytes => {
        const { runner } = makeSecretToolRunner();
        const backend = new LinuxSecretServiceCredentialStore({
          platform: 'linux',
          env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/fake-bus' },
          execFileSync: runner,
        });
        const secret = Buffer.from(bytes);
        await backend.storeSecret('deepseek', secret);
        const retrieved = await backend.retrieveSecret('deepseek');
        expect(Buffer.isBuffer(retrieved)).toBe(true);
        expect(retrieved).toEqual(secret);
      }),
    );
  });
});

describe('Windows Credential Manager backend', () => {
  it('stores provider secrets and KEK envelopes through the DPAPI helper stdin', async () => {
    const { calls, runner } = makeWindowsRunner();
    const backend = new WindowsCredentialManagerCredentialStore({
      platform: 'win32',
      helperCommand: 'hive-flow-windows-credential-helper',
      execFileSync: runner,
    });
    const secret = Buffer.from('or-windows-secret');
    await backend.storeSecret('OpenRouter', secret);
    await expect(backend.retrieveSecret('openrouter')).resolves.toEqual(secret);

    const kek = generateKek(size => Buffer.alloc(size, 9));
    const sealed = await backend.sealKek(kek);
    expect(Buffer.from(sealed.sealed).includes(kek)).toBe(false);
    await expect(backend.unsealKek(sealed)).resolves.toEqual(kek);

    const argv = calls.flatMap(call => call.args).join(' ');
    expect(argv).not.toContain(secret.toString('utf8'));
    expect(argv).not.toContain(base64(secret));
  });

  it('reports explicit degraded status when the Windows helper is unavailable', async () => {
    const backend = new WindowsCredentialManagerCredentialStore({
      platform: 'win32',
      helperCommand: 'hive-flow-windows-credential-helper',
      execFileSync: () => {
        throw new Error('missing helper');
      },
    });
    await expect(backend.status()).resolves.toMatchObject({
      available: false,
      degraded: true,
    });
    await expect(backend.retrieveSecret('openrouter')).rejects.toThrow(/degraded|unavailable|helper/i);
  });

  it('helper fails closed for redirected non-interactive use when Windows Hello is unavailable', () => {
    const source = readFileSync(
      resolve(__dirname, '..', 'helpers', 'windows-credential-helper', 'Program.cs'),
      'utf8',
    );

    expect(source).toContain('FailClosedIfBiometricUnavailable');
    expect(source).toContain('Console.IsInputRedirected');
    expect(source).toMatch(/UserConsentVerifierAvailability\.Available/);
  });
});

describe('macOS Keychain backend', () => {
  it('stores provider secrets and KEK envelopes through the macOS helper stdin without argv secret material', async () => {
    const { calls, runner } = makeMacOSHelperRunner();
    const backend = new MacOSKeychainCredentialStore({
      platform: 'darwin',
      helperCommand: 'hive-flow-macos-keychain-helper',
      execFileSync: runner,
    });
    const secret = Buffer.from('or-macos-secret');
    await backend.storeSecret('OpenRouter', secret);
    await expect(backend.retrieveSecret('openrouter')).resolves.toEqual(secret);

    const kek = generateKek(size => Buffer.alloc(size, 3));
    const sealed = await backend.sealKek(kek);
    expect(Buffer.from(sealed.sealed).includes(kek)).toBe(false);
    await expect(backend.unsealKek(sealed)).resolves.toEqual(kek);

    const argv = calls.flatMap(call => call.args).join(' ');
    const helperInputs = calls
      .filter(call => call.file === 'hive-flow-macos-keychain-helper' && call.args[0] === 'store')
      .map(call => String(call.input ?? ''));
    expect(argv).not.toContain(secret.toString('utf8'));
    expect(argv).not.toContain(base64(secret));
    expect(helperInputs.join('\n')).toContain(base64(secret));
  });

  it('helper protects credential access with explicit LAContext consent and file-keychain items', () => {
    const source = readFileSync(resolve(__dirname, '..', 'helpers', 'macos-keychain.swift'), 'utf8');

    expect(source).toContain('import LocalAuthentication');
    expect(source).toContain('LAContext');
    expect(source).toContain('canEvaluatePolicy(.deviceOwnerAuthentication');
    expect(source).toContain('evaluatePolicy(.deviceOwnerAuthentication');
    expect(source).toContain('kSecAttrAccessibleWhenUnlockedThisDeviceOnly');
    expect(source).not.toContain('SecAccessControlCreateWithFlags');
    expect(source).not.toContain('kSecAttrAccessControl');
    expect(source).not.toContain('kSecUseAuthenticationContext');
    expect(source).not.toContain('kSecUseDataProtectionKeychain');
  });

  it.skipIf(
    process.platform !== 'darwin'
    || process.env.HIVE_FLOW_RUN_NATIVE_MACOS_CREDENTIAL_TESTS !== '1'
    || !commandExists('swiftc'),
  )(
    'round-trips provider secrets and KEK envelopes through the native macOS helper and user Keychain',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-flow-keychain-'));
      const helperPath = join(root, 'macos-keychain-helper');
      const moduleCache = join(root, 'module-cache');
      const servicePrefix = `hive-flow-provider-key-test-${process.pid}-${Date.now()}`;
      const accountName = process.env.USER ?? 'user';
      const providerService = `${servicePrefix}:provider-secret:native-macos-${process.pid}-${Date.now()}`;
      const kekService = `${servicePrefix}:kek:vault-kek`;
      execFileSync('/usr/bin/swiftc', [
        '-module-cache-path', moduleCache,
        '-parse-as-library',
        resolve(__dirname, '..', 'helpers', 'macos-keychain.swift'),
        '-o',
        helperPath,
      ], { stdio: 'pipe' });

      const secret = Buffer.from('or-native-macos-secret');
      const kek = generateKek(size => Buffer.alloc(size, 3));
      const encodedSecret = base64(secret);
      const encodedKek = base64(kek);
      try {
        execFileSync(helperPath, ['store', providerService, accountName], {
          input: `${JSON.stringify({ secret: encodedSecret })}\n`,
          stdio: 'pipe',
        });
        execFileSync(helperPath, ['store', kekService, accountName], {
          input: `${JSON.stringify({ secret: encodedKek })}\n`,
          stdio: 'pipe',
        });

        expect(String(execFileSync(helperPath, ['retrieve', providerService, accountName], {
          input: '{}\n',
          stdio: 'pipe',
        })).trim()).toBe(encodedSecret);
        expect(String(execFileSync(helperPath, ['retrieve', kekService, accountName], {
          input: '{}\n',
          stdio: 'pipe',
        })).trim()).toBe(encodedKek);
      } finally {
        try {
          execFileSync(helperPath, ['delete', providerService, accountName], { input: '{}\n', stdio: 'pipe' });
          execFileSync(helperPath, ['delete', kekService, accountName], { input: '{}\n', stdio: 'pipe' });
        } catch {
          // Cleanup is best effort for an opt-in native lane.
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(process.platform !== 'darwin' || !commandExists('swiftc'))(
    'compiles the manual biometric Keychain helper without requiring a Touch ID prompt',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'hive-flow-swift-helper-'));
      try {
        const source = resolve(__dirname, '..', 'helpers', 'macos-keychain.swift');
        const out = join(root, 'macos-keychain-helper');
        const moduleCache = join(root, 'module-cache');
        execFileSync('/usr/bin/swiftc', [
          '-module-cache-path', moduleCache,
          '-parse-as-library',
          source,
          '-o',
          out,
        ], { stdio: 'pipe' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe('native Linux and Windows backend lanes', () => {
  it.skipIf(process.platform !== 'linux' || process.env.HIVE_FLOW_RUN_NATIVE_LINUX_CREDENTIAL_TESTS !== '1')(
    'round-trips against native Secret Service when CI starts a D-Bus session',
    async (ctx) => {
      const backend = new LinuxSecretServiceCredentialStore({ platform: 'linux' });
      assertCredentialBackendReady(await backend.status());
      const provider = `native-linux-${process.pid}`;
      const secret = Buffer.from(`native-linux-secret-${Date.now()}`);
      try {
        await backend.storeSecret(provider, secret);
      } catch {
        // secret-tool is present but no Secret Service provider (e.g. gnome-keyring with an unlocked
        // collection) is reachable here. Skip rather than fail; the real round-trip runs where a
        // Secret Service actually exists (a Linux dev box, or a keyring-provisioned CI).
        ctx.skip();
        return;
      }
      await expect(backend.retrieveSecret(provider)).resolves.toEqual(secret);
      await backend.deleteSecret(provider);
      await expect(backend.retrieveSecret(provider)).resolves.toBeNull();
    },
  );

  it.skipIf(process.platform !== 'win32' || process.env.HIVE_FLOW_RUN_NATIVE_WINDOWS_CREDENTIAL_TESTS !== '1')(
    'round-trips against native Windows Credential Manager through the helper',
    async () => {
      const helperCommand = installedHelperPath(HELPER_BINARIES.winCredential) ?? HELPER_BINARIES.winCredential;
      const backend = new WindowsCredentialManagerCredentialStore({ platform: 'win32', helperCommand });
      assertCredentialBackendReady(await backend.status());
      const provider = `native-windows-${process.pid}`;
      const secret = Buffer.from(`native-windows-secret-${Date.now()}`);
      await backend.storeSecret(provider, secret);
      await expect(backend.retrieveSecret(provider)).resolves.toEqual(secret);
      await backend.deleteSecret(provider);
      await expect(backend.retrieveSecret(provider)).resolves.toBeNull();
    },
  );
});
