import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CredentialStoreProvider } from './credential-store.js';
import { normalizeProviderKeyName } from './credential-store.js';
import type { KekProvider, RandomBytes } from './kek.js';
import { generateKek } from './kek.js';
import type { PeerCredentialResolver } from './peer-credentials.js';
import {
  DEFAULT_CREDENTIAL_VAULT_PATH,
  assertCredentialBackendReady,
  createPlatformCredentialStore,
} from './platform-backends.js';
import {
  createProductionCredentialHolderService,
  probeCredentialHolderStatus,
  STRICT_API_PROVIDERS,
} from './strict-api-provider.js';
import {
  assertSupportedVaultKekVersion,
  decryptVault,
  encryptVault,
  readVaultEnvelope,
  writeVaultAtomic,
  type VaultEnvelope,
} from './vault.js';

export const DEFAULT_HOLDER_BOOTSTRAP_PROVIDERS = [...STRICT_API_PROVIDERS].sort();

export interface InitializeCredentialVaultOptions {
  credentialStore?: CredentialStoreProvider & KekProvider;
  vaultPath?: string;
  allowDegraded?: boolean;
  randomBytes?: RandomBytes;
  now?: () => Date;
}

export interface CredentialVaultBootstrapStatus {
  backend: Awaited<ReturnType<CredentialStoreProvider['status']>>;
  vaultPath: string;
  createdVault: boolean;
  decrypts: boolean;
}

export interface StoreProviderCredentialOptions {
  provider: string;
  secret: Uint8Array | string;
  credentialStore?: CredentialStoreProvider & Partial<KekProvider>;
  vaultPath?: string;
  allowDegraded?: boolean;
}

export interface CredentialKeyStatusOptions {
  provider?: string;
  credentialStore?: CredentialStoreProvider & Partial<KekProvider>;
  vaultPath?: string;
}

export interface CredentialKeyStatus {
  provider?: string;
  present: boolean;
  drift: boolean;
  holderCache: boolean;
  unlock: 'available' | 'unavailable';
  backend: Awaited<ReturnType<CredentialStoreProvider['status']>>;
}

export interface RepairCredentialVaultOptions {
  credentialStore?: CredentialStoreProvider & KekProvider;
  vaultPath?: string;
  allowDegraded?: boolean;
}

export interface RemoveProviderCredentialOptions {
  provider: string;
  credentialStore?: CredentialStoreProvider & Partial<KekProvider>;
  vaultPath?: string;
  allowDegraded?: boolean;
}

export interface BootstrapProductionCredentialHolderOptions {
  projectRoot: string;
  socketPath?: string;
  credentialStore?: CredentialStoreProvider & Partial<KekProvider>;
  vaultPath?: string;
  providers?: readonly string[];
  allowDegraded?: boolean;
  peerHelperCommand?: string;
  peerCredentialResolver?: PeerCredentialResolver['lookup'];
  fetchImpl?: typeof fetch;
  baseUrls?: Partial<Record<string, string>>;
}

export interface ProductionCredentialHolderRuntime {
  holder: ReturnType<typeof createProductionCredentialHolderService>;
  socketPath: string;
  seededProviders: string[];
  backendStatus: Awaited<ReturnType<CredentialStoreProvider['status']>>;
  stop(): Promise<void>;
}

interface CredentialVaultDocument {
  version: number;
  createdAt: string;
  updatedAt?: string;
  providers: Record<string, string>;
  sealedKek: Parameters<KekProvider['unsealKek']>[0];
}

interface LoadedCredentialVault {
  backend: Awaited<ReturnType<CredentialStoreProvider['status']>>;
  document: CredentialVaultDocument;
  kek: Buffer;
  createdVault: boolean;
}

export async function initializeCredentialVault(
  options: InitializeCredentialVaultOptions = {},
): Promise<CredentialVaultBootstrapStatus> {
  const credentialStore = options.credentialStore ?? createPlatformCredentialStore();
  const vaultPath = options.vaultPath ?? DEFAULT_CREDENTIAL_VAULT_PATH;
  const loaded = await loadOrCreateCredentialVault({
    credentialStore,
    vaultPath,
    allowDegraded: options.allowDegraded,
    randomBytes: options.randomBytes,
    now: options.now,
  });
  loaded.kek.fill(0);
  return { backend: loaded.backend, vaultPath, createdVault: loaded.createdVault, decrypts: true };
}

export async function storeProviderCredential(
  options: StoreProviderCredentialOptions,
): Promise<{ provider: string; stored: boolean; vaultReady: boolean }> {
  const provider = normalizeProviderKeyName(options.provider);
  const credentialStore = options.credentialStore ?? createPlatformCredentialStore();
  if (hasKekProvider(credentialStore)) {
    const loaded = await loadOrCreateCredentialVault({
      credentialStore,
      vaultPath: options.vaultPath,
      allowDegraded: options.allowDegraded,
    });
    try {
      loaded.document.providers[provider] = encodeVaultProviderSecret(options.secret);
      loaded.document.updatedAt = new Date().toISOString();
      writeCredentialVaultDocument(options.vaultPath ?? DEFAULT_CREDENTIAL_VAULT_PATH, loaded.document, loaded.kek);
    } finally {
      loaded.kek.fill(0);
    }
  } else {
    assertCredentialBackendReady(await credentialStore.status(provider), { allowDegraded: options.allowDegraded });
    await credentialStore.storeSecret(provider, options.secret);
  }
  return { provider, stored: true, vaultReady: true };
}

export async function inspectCredentialKeyStatus(
  options: CredentialKeyStatusOptions = {},
): Promise<CredentialKeyStatus> {
  const credentialStore = options.credentialStore ?? createPlatformCredentialStore();
  const provider = options.provider ? normalizeProviderKeyName(options.provider) : undefined;
  const backend = await credentialStore.status(provider);
  let present = false;
  if (provider && backend.available && !backend.degraded) {
    try {
      if (hasKekProvider(credentialStore)) {
        const loaded = await loadExistingCredentialVault(credentialStore, options.vaultPath ?? DEFAULT_CREDENTIAL_VAULT_PATH);
        try {
          present = Object.hasOwn(loaded.document.providers, provider);
        } finally {
          loaded.kek.fill(0);
        }
      } else {
        const secret = await credentialStore.retrieveSecret(provider);
        if (secret) {
          present = true;
          Buffer.from(secret).fill(0);
          if (secret instanceof Buffer) secret.fill(0);
        }
      }
    } catch {
      present = false;
    }
  }
  const holderStatus = await probeCredentialHolderStatus();
  return {
    provider,
    present,
    drift: false,
    holderCache: holderStatus.available,
    unlock: backend.available && !backend.degraded ? 'available' : 'unavailable',
    backend,
  };
}

export async function repairCredentialVault(
  options: RepairCredentialVaultOptions = {},
): Promise<{ repaired: boolean; vaultReady: boolean; status: CredentialVaultBootstrapStatus }> {
  const status = await initializeCredentialVault(options);
  return { repaired: true, vaultReady: status.decrypts, status };
}

export async function removeProviderCredential(
  options: RemoveProviderCredentialOptions,
): Promise<{ provider: string; removed: boolean }> {
  const provider = normalizeProviderKeyName(options.provider);
  const credentialStore = options.credentialStore ?? createPlatformCredentialStore();
  if (hasKekProvider(credentialStore)) {
    const vaultPath = options.vaultPath ?? DEFAULT_CREDENTIAL_VAULT_PATH;
    if (existsSync(vaultPath)) {
      const loaded = await loadExistingCredentialVault(credentialStore, vaultPath);
      try {
        delete loaded.document.providers[provider];
        loaded.document.updatedAt = new Date().toISOString();
        writeCredentialVaultDocument(vaultPath, loaded.document, loaded.kek);
      } finally {
        loaded.kek.fill(0);
      }
    }
  } else {
    await credentialStore.deleteSecret(provider);
  }
  return { provider, removed: true };
}

export async function bootstrapProductionCredentialHolder(
  options: BootstrapProductionCredentialHolderOptions,
): Promise<ProductionCredentialHolderRuntime> {
  const credentialStore = options.credentialStore ?? createPlatformCredentialStore();
  const backendStatus = await credentialStore.status();
  assertCredentialBackendReady(backendStatus, { allowDegraded: options.allowDegraded });

  const holder = createProductionCredentialHolderService({
    socketPath: options.socketPath,
    peerHelperCommand: options.peerHelperCommand,
    peerCredentialResolver: options.peerCredentialResolver,
    fetchImpl: options.fetchImpl,
    baseUrls: options.baseUrls,
  });

  const seededProviders: string[] = [];
  const pendingSecrets: Array<{ provider: string; secret: Buffer }> = [];
  try {
    pendingSecrets.push(...await collectVaultedProviderSecrets({
      credentialStore,
      vaultPath: options.vaultPath ?? DEFAULT_CREDENTIAL_VAULT_PATH,
      providers: options.providers ?? DEFAULT_HOLDER_BOOTSTRAP_PROVIDERS,
    }));
    await holder.start();
    for (const { provider, secret } of pendingSecrets) {
      holder.setProviderSecret(provider, secret);
      seededProviders.push(provider);
    }
  } catch (error) {
    await holder.stop();
    throw error;
  } finally {
    for (const { secret } of pendingSecrets) secret.fill(0);
  }

  return {
    holder,
    socketPath: holder.socketPath,
    seededProviders,
    backendStatus,
    stop: () => holder.stop(),
  };
}

async function loadOrCreateCredentialVault(options: {
  credentialStore: CredentialStoreProvider & KekProvider;
  vaultPath?: string;
  allowDegraded?: boolean;
  randomBytes?: RandomBytes;
  now?: () => Date;
}): Promise<LoadedCredentialVault> {
  const vaultPath = options.vaultPath ?? DEFAULT_CREDENTIAL_VAULT_PATH;
  const backend = await options.credentialStore.status();
  assertCredentialBackendReady(backend, { allowDegraded: options.allowDegraded });

  if (existsSync(vaultPath)) {
    const loaded = await loadExistingCredentialVault(options.credentialStore, vaultPath);
    return { ...loaded, backend };
  }

  mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
  const kek = generateKek(options.randomBytes);
  try {
    const sealedKek = await options.credentialStore.sealKek(kek);
    const document: CredentialVaultDocument = {
      version: 1,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
      providers: {},
      sealedKek,
    };
    writeCredentialVaultDocument(vaultPath, document, kek, options.randomBytes);
    return { backend, document, kek: Buffer.from(kek), createdVault: true };
  } finally {
    kek.fill(0);
  }
}

async function loadExistingCredentialVault(
  credentialStore: CredentialStoreProvider & KekProvider,
  vaultPath: string,
): Promise<Omit<LoadedCredentialVault, 'backend'>> {
  const envelope = readVaultEnvelope(vaultPath);
  const kek = await unsealExistingKekReference(credentialStore, envelope);
  try {
    const decrypted = decryptVault(envelope, kek);
    try {
      return {
        document: parseCredentialVaultDocument(decrypted),
        kek,
        createdVault: false,
      };
    } finally {
      decrypted.fill(0);
    }
  } catch (error) {
    kek.fill(0);
    throw error;
  }
}

function parseCredentialVaultDocument(decrypted: Buffer): CredentialVaultDocument {
  const parsed = JSON.parse(decrypted.toString('utf8')) as Partial<CredentialVaultDocument>;
  if (!parsed.sealedKek || typeof parsed.sealedKek !== 'object') {
    throw new Error('credential vault does not contain a sealed KEK reference');
  }
  if (!parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) {
    throw new Error('credential vault provider map is malformed');
  }
  return {
    version: parsed.version ?? 1,
    createdAt: parsed.createdAt ?? new Date(0).toISOString(),
    updatedAt: parsed.updatedAt,
    providers: Object.fromEntries(
      Object.entries(parsed.providers)
        .map(([provider, encoded]) => [normalizeProviderKeyName(provider), String(encoded)]),
    ),
    sealedKek: parsed.sealedKek,
  };
}

function writeCredentialVaultDocument(
  vaultPath: string,
  document: CredentialVaultDocument,
  kek: Uint8Array,
  randomBytes?: RandomBytes,
): void {
  writeVaultAtomic(vaultPath, encryptVault(JSON.stringify(document), kek, { randomBytes }));
}

function encodeVaultProviderSecret(secret: Uint8Array | string): string {
  return Buffer.from(typeof secret === 'string' ? secret : Buffer.from(secret)).toString('base64');
}

function decodeVaultProviderSecret(encoded: string): Buffer {
  return Buffer.from(encoded, 'base64');
}

async function collectVaultedProviderSecrets(options: {
  credentialStore: CredentialStoreProvider & Partial<KekProvider>;
  vaultPath: string;
  providers: readonly string[];
}): Promise<Array<{ provider: string; secret: Buffer }>> {
  if (!hasKekProvider(options.credentialStore)) {
    return collectLegacyProviderSecrets(options.credentialStore, options.providers);
  }
  if (!existsSync(options.vaultPath)) return [];

  const loaded = await loadExistingCredentialVault(options.credentialStore, options.vaultPath);
  try {
    const pendingSecrets: Array<{ provider: string; secret: Buffer }> = [];
    for (const provider of options.providers) {
      const normalized = normalizeProviderKeyName(provider);
      if (!STRICT_API_PROVIDERS.has(normalized)) continue;
      const encoded = loaded.document.providers[normalized];
      if (!encoded) continue;
      pendingSecrets.push({ provider: normalized, secret: decodeVaultProviderSecret(encoded) });
    }
    return pendingSecrets;
  } finally {
    loaded.kek.fill(0);
  }
}

async function collectLegacyProviderSecrets(
  credentialStore: CredentialStoreProvider,
  providers: readonly string[],
): Promise<Array<{ provider: string; secret: Buffer }>> {
  const pendingSecrets: Array<{ provider: string; secret: Buffer }> = [];
  for (const provider of providers) {
    const normalized = normalizeProviderKeyName(provider);
    if (!STRICT_API_PROVIDERS.has(normalized)) continue;
    const secret = await credentialStore.retrieveSecret(normalized);
    if (!secret) continue;
    const secretBuffer = Buffer.from(secret);
    pendingSecrets.push({ provider: normalized, secret: secretBuffer });
    if (secret instanceof Buffer) secret.fill(0);
  }
  return pendingSecrets;
}

async function unsealExistingKekReference(
  credentialStore: CredentialStoreProvider & KekProvider,
  envelope: VaultEnvelope,
): Promise<Buffer> {
  assertSupportedVaultKekVersion(envelope.aad?.kekVersion);
  const bootstrapKek = await credentialStore.unsealKek({
    version: envelope.aad.kekVersion,
    backend: await backendNameFor(credentialStore),
    sealed: Buffer.from(JSON.stringify({ version: 1, backend: await backendNameFor(credentialStore), provider: 'vault-kek' })),
  });
  return Buffer.from(bootstrapKek);
}

async function backendNameFor(credentialStore: CredentialStoreProvider & KekProvider): Promise<string> {
  const name = (credentialStore as { backendName?: unknown }).backendName;
  if (typeof name === 'string' && name.trim()) return name;
  return 'credential-store';
}

function hasKekProvider(value: CredentialStoreProvider & Partial<KekProvider>): value is CredentialStoreProvider & KekProvider {
  return typeof value.sealKek === 'function' && typeof value.unsealKek === 'function';
}
