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
  credentialStore?: CredentialStoreProvider;
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
  credentialStore?: CredentialStoreProvider;
}

export interface BootstrapProductionCredentialHolderOptions {
  projectRoot: string;
  socketPath?: string;
  credentialStore?: CredentialStoreProvider;
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

export async function initializeCredentialVault(
  options: InitializeCredentialVaultOptions = {},
): Promise<CredentialVaultBootstrapStatus> {
  const credentialStore = options.credentialStore ?? createPlatformCredentialStore();
  const vaultPath = options.vaultPath ?? DEFAULT_CREDENTIAL_VAULT_PATH;
  const backend = await credentialStore.status();
  assertCredentialBackendReady(backend, { allowDegraded: options.allowDegraded });

  if (!existsSync(vaultPath)) {
    mkdirSync(dirname(vaultPath), { recursive: true, mode: 0o700 });
    const kek = generateKek(options.randomBytes);
    try {
      const sealedKek = await credentialStore.sealKek(kek);
      const emptyVault = {
        version: 1,
        createdAt: (options.now ?? (() => new Date()))().toISOString(),
        providers: {},
        sealedKek,
      };
      writeVaultAtomic(vaultPath, encryptVault(JSON.stringify(emptyVault), kek, { randomBytes: options.randomBytes }));
      return { backend, vaultPath, createdVault: true, decrypts: true };
    } finally {
      kek.fill(0);
    }
  }

  const envelope = readVaultEnvelope(vaultPath);
  const decrypted = await decryptExistingVault(credentialStore, envelope);
  decrypted.fill(0);
  return { backend, vaultPath, createdVault: false, decrypts: true };
}

export async function storeProviderCredential(
  options: StoreProviderCredentialOptions,
): Promise<{ provider: string; stored: boolean; vaultReady: boolean }> {
  const provider = normalizeProviderKeyName(options.provider);
  const credentialStore = options.credentialStore ?? createPlatformCredentialStore();
  if (hasKekProvider(credentialStore)) {
    await initializeCredentialVault({
      credentialStore,
      vaultPath: options.vaultPath,
      allowDegraded: options.allowDegraded,
    });
  } else {
    assertCredentialBackendReady(await credentialStore.status(provider), { allowDegraded: options.allowDegraded });
  }
  await credentialStore.storeSecret(provider, options.secret);
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
      const secret = await credentialStore.retrieveSecret(provider);
      if (secret) {
        present = true;
        Buffer.from(secret).fill(0);
        if (secret instanceof Buffer) secret.fill(0);
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
  await credentialStore.deleteSecret(provider);
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
    for (const provider of options.providers ?? DEFAULT_HOLDER_BOOTSTRAP_PROVIDERS) {
      const normalized = normalizeProviderKeyName(provider);
      if (!STRICT_API_PROVIDERS.has(normalized)) continue;
      const secret = await credentialStore.retrieveSecret(normalized);
      if (!secret) continue;
      const secretBuffer = Buffer.from(secret);
      pendingSecrets.push({ provider: normalized, secret: secretBuffer });
      if (secret instanceof Buffer) secret.fill(0);
    }
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

async function decryptExistingVault(
  credentialStore: CredentialStoreProvider & KekProvider,
  envelope: VaultEnvelope,
): Promise<Buffer> {
  const sealedReference = decryptVault(envelope, await unsealExistingKekReference(credentialStore, envelope));
  let parsed: { sealedKek?: unknown };
  try {
    parsed = JSON.parse(sealedReference.toString('utf8')) as { sealedKek?: unknown };
  } finally {
    sealedReference.fill(0);
  }
  if (!parsed.sealedKek || typeof parsed.sealedKek !== 'object') {
    throw new Error('credential vault does not contain a sealed KEK reference');
  }
  const kek = await credentialStore.unsealKek(parsed.sealedKek as Parameters<KekProvider['unsealKek']>[0]);
  try {
    return decryptVault(envelope, kek);
  } finally {
    Buffer.from(kek).fill(0);
  }
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
