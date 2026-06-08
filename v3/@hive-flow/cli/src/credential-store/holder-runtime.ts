import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CredentialStoreProvider } from './credential-store.js';
import { normalizeProviderKeyName } from './credential-store.js';
import type { CredentialPeerRole } from './holder.js';
import type { KekProvider, RandomBytes } from './kek.js';
import { generateKek } from './kek.js';
import type { PeerCredential, PeerCredentialResolver } from './peer-credentials.js';
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
  decryptVault,
  encryptVault,
  readVaultEnvelope,
  writeVaultAtomic,
  type VaultEnvelope,
} from './vault.js';

export const DEFAULT_HOLDER_BOOTSTRAP_PROVIDERS = [...STRICT_API_PROVIDERS].sort();

export interface HiveFlowPeerRoleResolverOptions {
  projectRoot: string;
}

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
  unlock: 'available' | 'locked' | 'unavailable';
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
  peerRoleResolver?: (peer: PeerCredential) => CredentialPeerRole | Promise<CredentialPeerRole>;
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

interface TaskTrackingRecord {
  pid?: unknown;
  status?: unknown;
}

interface AgentStoreShape {
  agents?: unknown;
}

export function createHiveFlowPeerRoleResolver(
  options: HiveFlowPeerRoleResolverOptions,
): (peer: PeerCredential) => Promise<CredentialPeerRole> {
  const projectRoot = options.projectRoot;
  return async (peer: PeerCredential): Promise<CredentialPeerRole> => {
    if (isProviderWorkerPid(projectRoot, peer.pid)) return 'provider-worker';
    if (isSubAgentPid(projectRoot, peer.pid)) return 'sub-agent';
    return 'coordinator';
  };
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
  if (provider && backend.available && !backend.degraded && !backend.locked) {
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
  const holderStatus = probeCredentialHolderStatus();
  return {
    provider,
    present,
    drift: false,
    holderCache: holderStatus.available,
    unlock: backend.locked ? 'locked' : backend.available && !backend.degraded ? 'available' : 'unavailable',
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
    peerRoleResolver: options.peerRoleResolver ?? createHiveFlowPeerRoleResolver({ projectRoot: options.projectRoot }),
    fetchImpl: options.fetchImpl,
    baseUrls: options.baseUrls,
  });

  await holder.start();
  const seededProviders: string[] = [];
  try {
    for (const provider of options.providers ?? DEFAULT_HOLDER_BOOTSTRAP_PROVIDERS) {
      const normalized = normalizeProviderKeyName(provider);
      if (!STRICT_API_PROVIDERS.has(normalized)) continue;
      const secret = await credentialStore.retrieveSecret(normalized);
      if (!secret) continue;
      const secretBuffer = Buffer.from(secret);
      try {
        holder.setProviderSecret(normalized, secretBuffer);
        seededProviders.push(normalized);
      } finally {
        secretBuffer.fill(0);
        if (secret instanceof Buffer) secret.fill(0);
      }
    }
  } catch (error) {
    await holder.stop();
    throw error;
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
  const status = await credentialStore.status();
  return status.provider ? String(status.provider) : 'credential-store';
}

function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isProviderWorkerPid(projectRoot: string, pid: number): boolean {
  const tasksDir = join(projectRoot, '.hive-flow', 'tasks');
  if (!existsSync(tasksDir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(tasksDir).filter(entry => entry.endsWith('.json') && !entry.endsWith('.result.json'));
  } catch {
    return false;
  }
  for (const entry of entries) {
    const record = readJsonFile(join(tasksDir, entry)) as TaskTrackingRecord | undefined;
    if (!record || Number(record.pid) !== pid) continue;
    const status = String(record.status || '').toLowerCase();
    if (!['complete', 'completed', 'failed', 'cancelled', 'terminated'].includes(status)) return true;
  }
  return false;
}

function isSubAgentPid(projectRoot: string, pid: number): boolean {
  const store = readJsonFile(join(projectRoot, '.hive-flow', 'agents', 'store.json')) as AgentStoreShape | undefined;
  const agents = store?.agents;
  const records = Array.isArray(agents)
    ? agents
    : agents && typeof agents === 'object'
      ? Object.values(agents)
      : [];
  return records.some((record) => {
    if (!record || typeof record !== 'object') return false;
    const agent = record as Record<string, unknown>;
    const candidatePid = Number(agent.pid ?? agent.processId ?? getNestedPid(agent.tracking) ?? getNestedPid(agent.config));
    if (candidatePid !== pid) return false;
    const status = String(agent.status || '').toLowerCase();
    return status !== 'terminated';
  });
}

function getNestedPid(value: unknown): unknown {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>).pid
    : undefined;
}

function hasKekProvider(value: CredentialStoreProvider & Partial<KekProvider>): value is CredentialStoreProvider & KekProvider {
  return typeof value.sealKek === 'function' && typeof value.unsealKek === 'function';
}
