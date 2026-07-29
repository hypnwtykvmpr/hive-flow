import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKek } from '../kek.js';
import {
  HELPER_BINARIES,
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
    expect(source).toContain('touchIDAuthenticationAllowableReuseDuration');
    expect(source).toContain('LATouchIDAuthenticationMaximumAllowableReuseDuration');
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

describe('credential helper resolution honors the configured environment', () => {
  // Regression for the red Windows CI lane in Credential Backend Matrix run
  // 30437766596: the workflow built the helper and exported
  // HIVE_FLOW_WINDOWS_CREDENTIAL_HELPER, but the constructor resolved with the
  // env-blind `installedHelperPath`, ignored the exported path, and fell through
  // to the bare binary name on PATH -> ENOENT. `helper-paths.ts` advertises these
  // env vars, so honoring them is the shipped contract, not a test convenience.
  function recordingRunner() {
    const files: string[] = [];
    const runner: Runner = (file) => {
      files.push(file);
      return Buffer.from('available\n');
    };
    return { files, runner };
  }

  it('resolves the Windows helper from HIVE_FLOW_WINDOWS_CREDENTIAL_HELPER', async () => {
    const configured = 'C:\\ci\\out\\HiveFlow.WindowsCredentialHelper.exe';
    const { files, runner } = recordingRunner();
    const backend = new WindowsCredentialManagerCredentialStore({
      platform: 'win32',
      env: { HIVE_FLOW_WINDOWS_CREDENTIAL_HELPER: configured },
      execFileSync: runner,
    });
    await expect(backend.status()).resolves.toEqual({ available: true });
    expect(files).toEqual([configured]);
    expect(files).not.toContain(HELPER_BINARIES.winCredential);
  });

  it('resolves the macOS helper from HIVE_FLOW_MACOS_KEYCHAIN_HELPER', async () => {
    const configured = '/opt/ci/hive-flow-macos-keychain-helper';
    const { files, runner } = recordingRunner();
    const backend = new MacOSKeychainCredentialStore({
      platform: 'darwin',
      env: { HIVE_FLOW_MACOS_KEYCHAIN_HELPER: configured },
      execFileSync: runner,
    });
    await expect(backend.status()).resolves.toEqual({ available: true });
    expect(files).toEqual([configured]);
    expect(files).not.toContain(HELPER_BINARIES.macosKeychain);
  });

  it('keeps an explicit helperCommand override ahead of the environment', async () => {
    const override = 'C:\\explicit\\override.exe';
    const { files, runner } = recordingRunner();
    const backend = new WindowsCredentialManagerCredentialStore({
      platform: 'win32',
      helperCommand: override,
      env: { HIVE_FLOW_WINDOWS_CREDENTIAL_HELPER: 'C:\\ci\\ignored.exe' },
      execFileSync: runner,
    });
    await expect(backend.status()).resolves.toEqual({ available: true });
    expect(files).toEqual([override]);
  });
});

/**
 * The Windows credential helper fails closed when Windows Hello cannot be used
 * non-interactively, which is the permanent state of a GitHub-hosted runner:
 *
 *   Windows Hello unavailable in non-interactive credential helper context: DeviceNotPresent
 *
 * That refusal is the *correct* production behavior (`Program.cs`
 * `FailClosedIfBiometricUnavailable`) and is asserted by its own dedicated test,
 * which passes on Windows CI. It is not weakened or bypassed here.
 *
 * This predicate exists so the native round-trip lane can classify that one
 * environment-dependent diagnostic as an honest skip while **rethrowing
 * everything else** — a path, process, credential, parsing, or permission
 * failure must still turn CI red. It is deliberately stricter than the Linux
 * lane's bare `catch`, which skips on any error at all.
 *
 * Narrowness comes from two things: the full sentence emitted by the helper, and
 * an enumeration of the non-`Available` `UserConsentVerifierAvailability` values.
 * A future enum value therefore fails the run rather than being silently
 * swallowed — failing loudly is the safe direction for a security boundary.
 */
const WINDOWS_HELLO_UNAVAILABLE =
  /Windows Hello unavailable in non-interactive credential helper context: (DeviceNotPresent|DeviceBusy|DisabledByPolicy|NotConfiguredForUser)\b/;

export function isWindowsHelloUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { message?: unknown; stderr?: unknown };
  // Node surfaces the helper's stderr in the thrown message for execFileSync,
  // but check stderr explicitly too so the classification does not depend on
  // that formatting detail.
  const parts = [
    typeof e.message === 'string' ? e.message : '',
    typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : '',
  ];
  return parts.some(part => WINDOWS_HELLO_UNAVAILABLE.test(part));
}

/**
 * Linux sibling of `isWindowsHelloUnavailable`, and deliberately built the same
 * way — the bare `catch {}` this replaces classified *every* store failure as
 * environmental and could hide missing-path, permission, process, parsing, and
 * credential-store regressions.
 *
 * One structural difference from the Windows case. `Program.cs` owns its
 * diagnostic sentence, so that matcher anchors on a first-party literal.
 * `secret-tool` owns nothing: its store failure path prints `"%s: %s\n"` —
 * program name plus `error->message` — so the text is propagated from GDBus.
 * The only stable anchor is therefore the complete emitted line, matched on
 * stderr. `error.message` is deliberately NOT consulted: Node wraps it with
 * `Command failed: ...`, which is a much weaker substrate for an exact match.
 *
 * Everything secret-tool emits from its own literals — "couldn't write
 * password", "must specify a label for the new item", "password is too long",
 * "collection must be a full path" — is a genuine failure and must rethrow.
 */
const SECRET_SERVICE_UNAVAILABLE_LINE =
  'secret-tool: The name org.freedesktop.secrets was not provided by any .service files';

/**
 * Read every field the classifier inspects under ONE fail-closed guard.
 *
 * All three reads must be protected together. Guarding only `stderr` would still
 * let a throwing getter on `status` or `signal` escape, and an exception raised
 * *inside the classifier* would stop the call site from ever reaching
 * `throw error` — so the act of classifying would itself destroy the contract to
 * rethrow the original object unchanged. Returning null on any hostile access
 * means the classifier answers "not environmental" and the original error is
 * rethrown intact.
 */
function readErrorFields(
  error: unknown,
): { status: unknown; signal: unknown; stderr: unknown } | null {
  if (error === null || typeof error !== 'object') return null;
  try {
    const e = error as { status?: unknown; signal?: unknown; stderr?: unknown };
    return { status: e.status, signal: e.signal, stderr: e.stderr };
  } catch {
    return null;
  }
}

function stderrText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) {
    try {
      return raw.toString('utf8');
    } catch {
      return '';
    }
  }
  return '';
}

export function isSecretServiceUnavailable(error: unknown): boolean {
  const fields = readErrorFields(error);
  if (fields === null) return false;
  // Require the expected child-process termination shape. A signal, a spawn
  // error, an absent status, or any other exit code is not this condition.
  if (fields.status !== 1) return false;
  // Explicitly `null` only. An absent/undefined signal is not the documented
  // clean-exit shape, so it stays red rather than being treated as equivalent.
  if (fields.signal !== null) return false;
  // The ENTIRE stderr buffer must be the emitted line, with at most one
  // trailing newline. No multiline flag, no trim, no substring: the expected
  // sentence appearing *among* other output means something else also went
  // wrong, and that must not be classified as environmental.
  const text = stderrText(fields.stderr);
  return text === SECRET_SERVICE_UNAVAILABLE_LINE
    || text === `${SECRET_SERVICE_UNAVAILABLE_LINE}\n`
    || text === `${SECRET_SERVICE_UNAVAILABLE_LINE}\r\n`;
}

describe('native Linux Secret Service unavailability is classified narrowly', () => {
  const UNAVAILABLE = SECRET_SERVICE_UNAVAILABLE_LINE;
  // execFileSync's thrown error shape: the classifier requires all three parts.
  const spawnFailure = (stderr: unknown, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error('Command failed: secret-tool store ...'), {
      status: 1,
      signal: null,
      stderr,
      ...extra,
    });

  it.each([
    ['bare line', UNAVAILABLE],
    ['trailing LF', `${UNAVAILABLE}\n`],
    ['trailing CRLF', `${UNAVAILABLE}\r\n`],
  ])('classifies the exact emitted buffer: %s', (_label, stderr) => {
    expect(isSecretServiceUnavailable(spawnFailure(stderr))).toBe(true);
  });

  it.each([
    ['Buffer, bare', Buffer.from(UNAVAILABLE)],
    ['Buffer, trailing LF', Buffer.from(`${UNAVAILABLE}\n`)],
    ['Buffer, trailing CRLF', Buffer.from(`${UNAVAILABLE}\r\n`)],
  ])('classifies a Buffer stderr: %s', (_label, stderr) => {
    expect(isSecretServiceUnavailable(spawnFailure(stderr))).toBe(true);
  });

  // Other D-Bus failures are NOT "no provider registered" and must stay red.
  // Raised by the read-only verifier as the most realistic uncovered gap: these
  // are exactly what a misconfigured runner emits, and skipping them would hide
  // a broken CI environment behind a green run.
  it.each([
    ['autolaunch without X11', 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY'],
    ['bus connection refused', 'secret-tool: Failed to connect to socket /run/dbus/system_bus_socket: Connection refused'],
    ['closed bus connection', 'secret-tool: The connection is closed'],
    ['activation access denied', 'secret-tool: Rejected send message, 1 matched rules; type="method_call"'],
    ['no session bus address', 'secret-tool: Unable to autolaunch a dbus-daemon without a $DISPLAY for X11'],
  ])('rethrows a different D-Bus failure: %s', (_label, stderr) => {
    expect(isSecretServiceUnavailable(spawnFailure(stderr))).toBe(false);
  });

  // Encoding and coercion probes. All must be false; the safe direction for an
  // unrecognized shape is red, never a silent skip.
  it.each([
    ['UTF-16LE buffer', Buffer.from(UNAVAILABLE, 'utf16le')],
    ['UTF-8 BOM prefix', `${String.fromCharCode(0xfeff)}${UNAVAILABLE}`],
    ['embedded NUL suffix', `${UNAVAILABLE}${String.fromCharCode(0)}`],
    ['CR-only terminator', `${UNAVAILABLE}\r`],
    ['trailing space', `${UNAVAILABLE}${String.fromCharCode(32)}`],
    ['trailing tab', `${UNAVAILABLE}\t`],
    ['double LF', `${UNAVAILABLE}\n\n`],
  ])('rejects an encoding/whitespace variant: %s', (_label, stderr) => {
    expect(isSecretServiceUnavailable(spawnFailure(stderr))).toBe(false);
  });

  it.each([
    ['string status', { status: '1' }],
    ['boxed Number status', { status: new Number(1) }],
    ['bigint status', { status: 1n }],
  ])('rejects a coerced status: %s', (_label, extra) => {
    expect(isSecretServiceUnavailable(spawnFailure(UNAVAILABLE, extra))).toBe(false);
  });

  // Every field the classifier reads must be guarded, not just stderr: an
  // exception from ANY of them would abort classification and stop the call site
  // from rethrowing the original error unchanged.
  it.each(['status', 'signal', 'stderr'])(
    'does not let a throwing %s getter escape the classifier',
    field => {
      const error = Object.defineProperty(
        Object.assign(new Error('Command failed'), {
          status: 1,
          signal: null,
          stderr: SECRET_SERVICE_UNAVAILABLE_LINE,
        }),
        field,
        { get() { throw new Error(`hostile ${field} getter`); } },
      );
      expect(() => isSecretServiceUnavailable(error)).not.toThrow();
      expect(isSecretServiceUnavailable(error)).toBe(false);
    },
  );

  it('classifies a null-prototype object by structure only', () => {
    // Documents the known limit: the classifier matches shape, not provenance.
    // Reachable only if non-secret-tool code throws this exact structure, which
    // cannot happen at the call site since the error comes from execFileSync.
    const forged = Object.assign(Object.create(null), {
      status: 1,
      signal: null,
      stderr: UNAVAILABLE,
    });
    expect(isSecretServiceUnavailable(forged)).toBe(true);
  });

  // Negatives. Each is a real defect this lane exists to catch, and each would
  // have been silently skipped by the bare `catch {}` this replaces.
  it.each([
    ['leading noise before the sentence', `warning: something else\n${UNAVAILABLE}`],
    ['trailing noise after the sentence', `${UNAVAILABLE}\nwarning: something else`],
    ['a second copy of the line', `${UNAVAILABLE}\n${UNAVAILABLE}`],
    ['inline prefix on the same line', `note: ${UNAVAILABLE}`],
    ['a DIFFERENT dbus service', 'secret-tool: The name org.freedesktop.other was not provided by any .service files'],
    ['near-miss wording', 'secret-tool: The name org.freedesktop.secrets was not provided'],
    ['path / secret-tool missing', 'spawnSync secret-tool ENOENT'],
    ['permission', "Error: EACCES: permission denied, open '/usr/bin/secret-tool'"],
    ['generic process failure', 'secret-tool: unexpected failure'],
    ['credential store write failure', "secret-tool: couldn't write password: some backend error"],
    ['credential store read failure', "secret-tool: couldn't read password: some backend error"],
    ['parsing / usage', 'secret-tool: must specify a label for the new item'],
    ['collection misuse', "secret-tool: collection must be a full path, or the 'default' alias"],
    ['empty stderr', ''],
  ])('rethrows unrelated failure: %s', (_label, stderr) => {
    expect(isSecretServiceUnavailable(spawnFailure(stderr))).toBe(false);
  });

  // Termination shape: the right sentence with the wrong process outcome means
  // something other than a clean "service not available" exit.
  it.each([
    ['exit code 2', { status: 2 }],
    ['exit code 0', { status: 0 }],
    ['null status', { status: null }],
    ['absent status', { status: undefined }],
    ['killed by signal', { signal: 'SIGTERM' }],
    ['absent signal', { signal: undefined }],
  ])('rejects the right sentence with the wrong termination: %s', (_label, extra) => {
    expect(isSecretServiceUnavailable(spawnFailure(UNAVAILABLE, extra))).toBe(false);
  });

  it('never classifies from error.message alone', () => {
    // Node prefixes execFileSync failures with `Command failed: ...`. Matching
    // there would let a wrapper carrying the phrase bypass the stderr anchor.
    const error = Object.assign(new Error(`Command failed: ${UNAVAILABLE}`), {
      status: 1,
      signal: null,
    });
    expect(isSecretServiceUnavailable(error)).toBe(false);
  });

  it('ignores non-error values', () => {
    expect(isSecretServiceUnavailable(null)).toBe(false);
    expect(isSecretServiceUnavailable(UNAVAILABLE)).toBe(false);
  });
});

describe('native Windows Hello unavailability is classified narrowly', () => {
  // Positive: every non-Available availability the helper can report.
  it.each(['DeviceNotPresent', 'DeviceBusy', 'DisabledByPolicy', 'NotConfiguredForUser'])(
    'treats the explicit non-interactive diagnostic (%s) as skippable',
    availability => {
      const error = new Error(
        'Command failed: HiveFlow.WindowsCredentialHelper.exe store hive-flow-provider-key\n'
        + `Unhandled exception. System.InvalidOperationException: Windows Hello unavailable in non-interactive credential helper context: ${availability}`,
      );
      expect(isWindowsHelloUnavailable(error)).toBe(true);
    },
  );

  it('classifies the diagnostic when it arrives only on stderr', () => {
    const error = Object.assign(new Error('Command failed'), {
      stderr: Buffer.from(
        'Unhandled exception. System.InvalidOperationException: Windows Hello unavailable in non-interactive credential helper context: DeviceNotPresent',
      ),
    });
    expect(isWindowsHelloUnavailable(error)).toBe(true);
  });

  // Negative: the skip must never swallow a real defect. Each of these is a
  // failure mode the native lane exists to catch.
  it.each([
    ['path / helper missing', 'spawnSync hive-flow-windows-credential-helper.exe ENOENT'],
    ['permission', "Error: EACCES: permission denied, open 'HiveFlow.WindowsCredentialHelper.exe'"],
    ['process exit without diagnostic', 'Command failed: HiveFlow.WindowsCredentialHelper.exe store x\nUnhandled exception. System.Exception: boom'],
    ['credential store failure', 'Unhandled exception. System.ComponentModel.Win32Exception: CredWrite failed (1312)'],
    ['parsing', 'Unhandled exception. System.FormatException: unexpected helper output'],
    ['consent denied (a real refusal, not unavailability)', 'Unhandled exception. System.InvalidOperationException: Windows Hello consent denied: Canceled'],
    ['near-miss wording', 'Windows Hello unavailable'],
    ['sentinel without an availability value', 'Windows Hello unavailable in non-interactive credential helper context: '],
    ['unknown future availability value', 'Windows Hello unavailable in non-interactive credential helper context: SomeFutureState'],
  ])('rethrows unrelated failure: %s', (_label, message) => {
    expect(isWindowsHelloUnavailable(new Error(message))).toBe(false);
  });

  it('ignores non-error values', () => {
    expect(isWindowsHelloUnavailable(null)).toBe(false);
    expect(isWindowsHelloUnavailable('Windows Hello unavailable in non-interactive credential helper context: DeviceNotPresent')).toBe(false);
  });
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
      } catch (error) {
        // Only "secret-tool ran but no Secret Service provider is reachable" is
        // environmental. Anything else is a real defect and must fail the run.
        //
        // The original error is rethrown unchanged: execFileSync already retains
        // `status`, `signal`, and `stderr` on it and folds captured stderr into
        // the message, so preserving the object gives Vitest the strongest
        // diagnostic. Wrapping it would duplicate the output and hide those
        // fields behind a synthesized message.
        if (!isSecretServiceUnavailable(error)) throw error;
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
    async (ctx) => {
      // No `helperCommand` override: the backend must resolve the helper through
      // its own production path (HIVE_FLOW_WINDOWS_CREDENTIAL_HELPER -> installed
      // -> bare name). Supplying a test-resolved command here would prove only
      // that the fixture can find the helper, not that the shipped code can —
      // which is exactly how CI passed a broken resolver for this lane.
      const backend = new WindowsCredentialManagerCredentialStore({ platform: 'win32' });
      // `status` still runs unconditionally: the runner must reach and execute
      // the real workflow-built helper before any skip is permitted. A missing or
      // unresolvable helper fails here, before the classification below.
      assertCredentialBackendReady(await backend.status());
      const provider = `native-windows-${process.pid}`;
      const secret = Buffer.from(`native-windows-secret-${Date.now()}`);
      try {
        await backend.storeSecret(provider, secret);
      } catch (error) {
        // A GitHub-hosted Windows runner has no Windows Hello device, so the
        // helper fails closed exactly as designed. Classify only that diagnostic
        // as environmental and rethrow everything else — a broad `catch` here
        // would silently swallow the very defects this lane exists to catch.
        if (!isWindowsHelloUnavailable(error)) throw error;
        ctx.skip();
        return;
      }
      await expect(backend.retrieveSecret(provider)).resolves.toEqual(secret);
      await backend.deleteSecret(provider);
      await expect(backend.retrieveSecret(provider)).resolves.toBeNull();
    },
  );
});
