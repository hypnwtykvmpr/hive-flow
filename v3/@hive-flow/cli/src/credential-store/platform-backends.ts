import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CredentialStoreProvider, CredentialStoreStatus } from './credential-store.js';
import { normalizeProviderKeyName } from './credential-store.js';
import type { KekProvider, SealedKek } from './kek.js';
import { assertValidKek } from './kek.js';

type ExecOptions = {
  input?: Uint8Array | string;
  encoding?: BufferEncoding;
  env?: NodeJS.ProcessEnv;
  stdio?: unknown;
};

type ExecFileSync = (file: string, args: readonly string[], options?: ExecOptions) => Buffer | string;

export interface CredentialBackendReadyOptions {
  allowDegraded?: boolean;
}

export interface PlatformCredentialStoreOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFileSync?: ExecFileSync;
  servicePrefix?: string;
  accountName?: string;
  keychainPath?: string;
  keychainPassword?: string;
  helperCommand?: string;
}

type SecretKind = 'provider-secret' | 'kek';

const DEFAULT_SERVICE_PREFIX = 'hive-flow-provider-key';
const KEK_PROVIDER_NAME = 'vault-kek';

function asBuffer(secret: Uint8Array | string): Buffer {
  return typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
}

function encodeSecret(secret: Uint8Array | string): string {
  return asBuffer(secret).toString('base64');
}

function decodeSecret(raw: Buffer | string): Buffer | null {
  const rendered = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const trimmed = rendered.trim();
  if (!trimmed) return null;
  return Buffer.from(trimmed, 'base64');
}

function sealedReference(backend: string, provider: string): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, backend, provider }), 'utf8');
}

function parseSealedReference(sealed: SealedKek, expectedBackend: string): { provider: string } {
  if (sealed.backend !== expectedBackend) {
    throw new Error(`credential KEK envelope belongs to ${sealed.backend}, not ${expectedBackend}`);
  }
  const raw = Buffer.from(sealed.sealed).toString('utf8');
  const parsed = JSON.parse(raw) as { version?: number; backend?: string; provider?: string };
  if (parsed.version !== 1 || parsed.backend !== expectedBackend || !parsed.provider) {
    throw new Error('credential KEK envelope is malformed');
  }
  return { provider: parsed.provider };
}

function unavailable(reason: string): CredentialStoreStatus {
  return { available: false, degraded: true, reason };
}

function run(execFileSync: ExecFileSync, file: string, args: readonly string[], options: ExecOptions = {}): Buffer | string {
  return execFileSync(file, [...args], options);
}

export function assertCredentialBackendReady(
  status: CredentialStoreStatus,
  options: CredentialBackendReadyOptions = {},
): void {
  if (status.degraded && options.allowDegraded) return;
  if (!status.available || status.degraded) {
    throw new Error(`credential backend unavailable${status.reason ? `: ${status.reason}` : ''}`);
  }
}

abstract class BaseCredentialStore implements CredentialStoreProvider, KekProvider {
  protected readonly platform: NodeJS.Platform;
  protected readonly env: NodeJS.ProcessEnv;
  protected readonly execFileSync: ExecFileSync;
  protected readonly servicePrefix: string;

  abstract readonly backendName: string;

  protected constructor(options: PlatformCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.execFileSync = options.execFileSync ?? ((file, args, execOptions = {}) => nodeExecFileSync(file, [...args], execOptions as Parameters<typeof nodeExecFileSync>[2]));
    this.servicePrefix = options.servicePrefix ?? DEFAULT_SERVICE_PREFIX;
  }

  abstract status(provider?: string): Promise<CredentialStoreStatus>;
  protected abstract storeSecretKind(kind: SecretKind, provider: string, secret: Uint8Array | string): Promise<void>;
  protected abstract retrieveSecretKind(kind: SecretKind, provider: string): Promise<Buffer | null>;
  protected abstract deleteSecretKind(kind: SecretKind, provider: string): Promise<void>;

  async isAvailable(): Promise<boolean> {
    return (await this.status()).available;
  }

  async storeSecret(provider: string, secret: Uint8Array | string): Promise<void> {
    await this.storeSecretKind('provider-secret', normalizeProviderKeyName(provider), secret);
  }

  async retrieveSecret(provider: string): Promise<Buffer | null> {
    return this.retrieveSecretKind('provider-secret', normalizeProviderKeyName(provider));
  }

  async deleteSecret(provider: string): Promise<void> {
    await this.deleteSecretKind('provider-secret', normalizeProviderKeyName(provider));
  }

  async sealKek(kek: Uint8Array): Promise<SealedKek> {
    assertValidKek(kek);
    await this.storeSecretKind('kek', KEK_PROVIDER_NAME, kek);
    return {
      version: 1,
      backend: this.backendName,
      sealed: sealedReference(this.backendName, KEK_PROVIDER_NAME),
    };
  }

  async unsealKek(sealed: SealedKek): Promise<Buffer> {
    const reference = parseSealedReference(sealed, this.backendName);
    const kek = await this.retrieveSecretKind('kek', reference.provider);
    if (!kek) throw new Error(`credential KEK is unavailable in ${this.backendName}`);
    assertValidKek(kek);
    return Buffer.from(kek);
  }

  protected async requireReady(): Promise<void> {
    assertCredentialBackendReady(await this.status());
  }
}

export class MacOSKeychainCredentialStore extends BaseCredentialStore {
  readonly backendName = 'macos-keychain';
  private readonly accountName: string;
  private readonly helperCommand: string;

  constructor(options: PlatformCredentialStoreOptions = {}) {
    super(options);
    this.accountName = options.accountName ?? this.env.USER ?? 'user';
    this.helperCommand = options.helperCommand ?? this.env.HIVE_FLOW_MACOS_CREDENTIAL_HELPER ?? 'hive-flow-macos-keychain-helper';
  }

  async status(provider?: string): Promise<CredentialStoreStatus> {
    if (this.platform !== 'darwin') return unavailable('macOS Keychain backend requires darwin');
    try {
      run(this.execFileSync, this.helperCommand, ['status'], { stdio: 'pipe', env: this.env });
      return { available: true, provider: provider ? normalizeProviderKeyName(provider) : undefined };
    } catch (error) {
      return unavailable(`macOS keychain helper unavailable: ${(error as Error).message}`);
    }
  }

  protected async storeSecretKind(kind: SecretKind, provider: string, secret: Uint8Array | string): Promise<void> {
    await this.requireReady();
    run(this.execFileSync, this.helperCommand, [
      'store',
      this.serviceName(kind, provider),
      this.accountName,
    ], { input: `${JSON.stringify(this.helperInput({ secret: encodeSecret(secret) }))}\n`, stdio: 'pipe', env: this.env });
  }

  protected async retrieveSecretKind(kind: SecretKind, provider: string): Promise<Buffer | null> {
    await this.requireReady();
    try {
      return decodeSecret(run(this.execFileSync, this.helperCommand, [
        'retrieve',
        this.serviceName(kind, provider),
        this.accountName,
      ], { input: `${JSON.stringify(this.helperInput())}\n`, stdio: 'pipe', env: this.env }));
    } catch {
      return null;
    }
  }

  protected async deleteSecretKind(kind: SecretKind, provider: string): Promise<void> {
    await this.requireReady();
    try {
      run(this.execFileSync, this.helperCommand, [
        'delete',
        this.serviceName(kind, provider),
        this.accountName,
      ], { input: `${JSON.stringify(this.helperInput())}\n`, stdio: 'pipe', env: this.env });
    } catch {
      // Missing keychain items are fine during delete.
    }
  }

  private serviceName(kind: SecretKind, provider: string): string {
    return `${this.servicePrefix}:${kind}:${provider}`;
  }

  private helperInput(extra: { secret?: string } = {}): Record<string, string> {
    return { ...extra };
  }
}

export class LinuxSecretServiceCredentialStore extends BaseCredentialStore {
  readonly backendName = 'linux-secret-service';

  constructor(options: PlatformCredentialStoreOptions = {}) {
    super(options);
  }

  async status(provider?: string): Promise<CredentialStoreStatus> {
    if (this.platform !== 'linux') return unavailable('Secret Service backend requires linux');
    if (!this.env.DBUS_SESSION_BUS_ADDRESS) {
      return unavailable('Secret Service requires an active D-Bus session');
    }
    try {
      run(this.execFileSync, 'secret-tool', ['--version'], { stdio: 'pipe', env: this.env });
      return { available: true, provider: provider ? normalizeProviderKeyName(provider) : undefined };
    } catch (error) {
      return unavailable(`secret-tool unavailable: ${(error as Error).message}`);
    }
  }

  protected async storeSecretKind(kind: SecretKind, provider: string, secret: Uint8Array | string): Promise<void> {
    await this.requireReady();
    run(this.execFileSync, 'secret-tool', [
      'store',
      '--label', `Hive Flow ${kind} ${provider}`,
      ...this.attributes(kind, provider),
    ], { input: `${encodeSecret(secret)}\n`, stdio: 'pipe', env: this.env });
  }

  protected async retrieveSecretKind(kind: SecretKind, provider: string): Promise<Buffer | null> {
    await this.requireReady();
    try {
      return decodeSecret(run(this.execFileSync, 'secret-tool', [
        'lookup',
        ...this.attributes(kind, provider),
      ], { stdio: 'pipe', env: this.env }));
    } catch {
      return null;
    }
  }

  protected async deleteSecretKind(kind: SecretKind, provider: string): Promise<void> {
    await this.requireReady();
    try {
      run(this.execFileSync, 'secret-tool', [
        'clear',
        ...this.attributes(kind, provider),
      ], { stdio: 'pipe', env: this.env });
    } catch {
      // Missing Secret Service items are fine during delete.
    }
  }

  private attributes(kind: SecretKind, provider: string): string[] {
    return ['service', 'hive-flow', 'kind', kind, 'provider', provider];
  }
}

export class WindowsCredentialManagerCredentialStore extends BaseCredentialStore {
  readonly backendName = 'windows-credential-manager';
  private readonly helperCommand: string;

  constructor(options: PlatformCredentialStoreOptions = {}) {
    super(options);
    this.helperCommand = options.helperCommand ?? this.env.HIVE_FLOW_WINDOWS_CREDENTIAL_HELPER ?? 'hive-flow-windows-credential-helper';
  }

  async status(provider?: string): Promise<CredentialStoreStatus> {
    if (this.platform !== 'win32') return unavailable('Windows Credential Manager backend requires win32');
    try {
      run(this.execFileSync, this.helperCommand, ['status'], { stdio: 'pipe', env: this.env });
      return { available: true, provider: provider ? normalizeProviderKeyName(provider) : undefined };
    } catch (error) {
      return unavailable(`Windows credential helper unavailable: ${(error as Error).message}`);
    }
  }

  protected async storeSecretKind(kind: SecretKind, provider: string, secret: Uint8Array | string): Promise<void> {
    await this.requireReady();
    run(this.execFileSync, this.helperCommand, [
      'store',
      this.targetName(kind, provider),
    ], { input: `${encodeSecret(secret)}\n`, stdio: 'pipe', env: this.env });
  }

  protected async retrieveSecretKind(kind: SecretKind, provider: string): Promise<Buffer | null> {
    await this.requireReady();
    try {
      return decodeSecret(run(this.execFileSync, this.helperCommand, [
        'retrieve',
        this.targetName(kind, provider),
      ], { stdio: 'pipe', env: this.env }));
    } catch {
      return null;
    }
  }

  protected async deleteSecretKind(kind: SecretKind, provider: string): Promise<void> {
    await this.requireReady();
    try {
      run(this.execFileSync, this.helperCommand, [
        'delete',
        this.targetName(kind, provider),
      ], { stdio: 'pipe', env: this.env });
    } catch {
      // Missing Credential Manager items are fine during delete.
    }
  }

  private targetName(kind: SecretKind, provider: string): string {
    return `${this.servicePrefix}:${kind}:${provider}`;
  }
}

export function createPlatformCredentialStore(
  options: PlatformCredentialStoreOptions = {},
): CredentialStoreProvider & KekProvider {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return new MacOSKeychainCredentialStore(options);
  if (platform === 'linux') return new LinuxSecretServiceCredentialStore(options);
  if (platform === 'win32') return new WindowsCredentialManagerCredentialStore(options);
  return new LinuxSecretServiceCredentialStore({ ...options, platform: 'linux' });
}

export const DEFAULT_CREDENTIAL_VAULT_PATH = join(homedir(), '.hive-flow', 'credential-vault.json.gcm');
