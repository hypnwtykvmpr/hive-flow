import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendCredentialHolderCommand } from '../holder.js';
import {
  bootstrapProductionCredentialHolder,
  initializeCredentialVault,
  inspectCredentialKeyStatus,
  removeProviderCredential,
  storeProviderCredential,
} from '../holder-runtime.js';
import { decryptVault, readVaultEnvelope } from '../vault.js';
import type { CredentialStoreProvider } from '../credential-store.js';
import type { SealedKek } from '../kek.js';
import type { PeerCredential } from '../peer-credentials.js';

class MemoryCredentialStore implements CredentialStoreProvider {
  readonly secrets = new Map<string, Buffer>();
  readonly consentOps: string[] = [];
  readonly backendName = 'memory-test-store';
  unsealCalls = 0;

  isAvailable(): boolean {
    return true;
  }

  async storeSecret(provider: string, secret: Uint8Array | string): Promise<void> {
    this.consentOps.push(`store:${provider.toLowerCase()}`);
    this.secrets.set(provider.toLowerCase(), Buffer.from(secret));
  }

  async retrieveSecret(provider: string): Promise<Uint8Array | null> {
    this.consentOps.push(`retrieve:${provider.toLowerCase()}`);
    const secret = this.secrets.get(provider.toLowerCase());
    return secret ? Buffer.from(secret) : null;
  }

  async deleteSecret(provider: string): Promise<void> {
    this.consentOps.push(`delete:${provider.toLowerCase()}`);
    this.secrets.delete(provider.toLowerCase());
  }

  status() {
    return { available: true };
  }

  async sealKek(kek: Uint8Array): Promise<SealedKek> {
    await this.storeSecret('vault-kek', kek);
    return {
      version: 1,
      backend: this.backendName,
      sealed: Buffer.from(JSON.stringify({ version: 1, backend: this.backendName, provider: 'vault-kek' })),
    };
  }

  async unsealKek(sealed: SealedKek): Promise<Uint8Array> {
    this.unsealCalls += 1;
    const parsed = JSON.parse(Buffer.from(sealed.sealed).toString('utf8')) as { backend: string; provider: string };
    if (parsed.backend !== this.backendName) throw new Error('wrong backend');
    const kek = await this.retrieveSecret(parsed.provider);
    if (!kek) throw new Error('missing kek');
    return kek;
  }

  resetConsentOps(): void {
    this.consentOps.splice(0);
  }
}

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hive-flow-holder-runtime-'));
  roots.push(root);
  return root;
}

function makeSocketPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hf-${label}-`));
  roots.push(dir);
  return join(dir, 'holder.sock');
}

function sameUserPeer(pid = process.pid): PeerCredential {
  return {
    pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    startTime: `test-peer-${pid}`,
  };
}

function helperSequenceGolden(): Record<'freshEnroll' | 'updateExistingVault' | 'bootstrapSeedAll', string[]> {
  return JSON.parse(readFileSync(
    join(__dirname, 'fixtures', 'credential-enrollment-helper-sequences.golden.json'),
    'utf8',
  )) as Record<'freshEnroll' | 'updateExistingVault' | 'bootstrapSeedAll', string[]>;
}

async function enrollInVault(
  store: MemoryCredentialStore,
  vaultPath: string,
  provider: string,
  secret: Uint8Array | string,
): Promise<void> {
  await storeProviderCredential({ credentialStore: store, vaultPath, provider, secret });
}

function readVaultProvidersForTest(vaultPath: string, store: MemoryCredentialStore): Record<string, string> {
  const kek = store.secrets.get('vault-kek');
  if (!kek) throw new Error('missing test KEK');
  const decrypted = decryptVault(readVaultEnvelope(vaultPath), kek);
  try {
    const parsed = JSON.parse(decrypted.toString('utf8')) as { providers?: Record<string, string> };
    return Object.fromEntries(
      Object.entries(parsed.providers ?? {})
        .map(([provider, encoded]) => [provider, Buffer.from(String(encoded), 'base64').toString('utf8')]),
    );
  } finally {
    decrypted.fill(0);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('production credential holder runtime bootstrap', () => {
  it('creates and reopens an empty encrypted vault from the platform KEK', async () => {
    const root = makeRoot();
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');

    await expect(initializeCredentialVault({
      credentialStore: store,
      vaultPath,
      randomBytes: size => Buffer.alloc(size, 4),
      now: () => new Date('2026-06-08T00:00:00.000Z'),
    })).resolves.toMatchObject({
      createdVault: true,
      decrypts: true,
    });
    await expect(initializeCredentialVault({ credentialStore: store, vaultPath })).resolves.toMatchObject({
      createdVault: false,
      decrypts: true,
    });
  });

  it('rejects unsupported vault KEK versions before unsealing platform KEK material', async () => {
    const root = makeRoot();
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');

    await initializeCredentialVault({
      credentialStore: store,
      vaultPath,
      randomBytes: size => Buffer.alloc(size, 4),
      now: () => new Date('2026-06-08T00:00:00.000Z'),
    });
    store.unsealCalls = 0;

    const envelope = JSON.parse(readFileSync(vaultPath, 'utf8')) as { aad: { kekVersion: number } };
    envelope.aad.kekVersion = 2;
    writeFileSync(vaultPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

    await expect(initializeCredentialVault({ credentialStore: store, vaultPath }))
      .rejects.toThrow(/unsupported KEK version/i);
    expect(store.unsealCalls).toBe(0);
  });

  it('stores a first provider in the encrypted vault with only one consent-bearing KEK store', async () => {
    const root = makeRoot();
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');

    await storeProviderCredential({
      credentialStore: store,
      vaultPath,
      provider: 'OpenRouter',
      secret: 'or-first-secret',
    });

    expect(store.consentOps).toEqual(helperSequenceGolden().freshEnroll);
    expect(store.secrets.has('openrouter')).toBe(false);
    expect(readVaultProvidersForTest(vaultPath, store)).toEqual({ openrouter: 'or-first-secret' });
  });

  it('updates an existing provider in the encrypted vault with one KEK unseal and no provider keychain write', async () => {
    const root = makeRoot();
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');
    await enrollInVault(store, vaultPath, 'openrouter', 'or-initial-secret');
    store.resetConsentOps();

    await storeProviderCredential({
      credentialStore: store,
      vaultPath,
      provider: 'openrouter',
      secret: 'or-updated-secret',
    });

    expect(store.consentOps).toEqual(helperSequenceGolden().updateExistingVault);
    expect(store.secrets.has('openrouter')).toBe(false);
    expect(readVaultProvidersForTest(vaultPath, store)).toEqual({ openrouter: 'or-updated-secret' });
  });

  it('reports provider presence and removes providers from the encrypted vault without touching provider keychain items', async () => {
    const root = makeRoot();
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');
    await enrollInVault(store, vaultPath, 'openrouter', 'or-secret');
    await enrollInVault(store, vaultPath, 'deepseek', 'ds-secret');
    store.resetConsentOps();

    await expect(inspectCredentialKeyStatus({ credentialStore: store, provider: 'openrouter', vaultPath }))
      .resolves.toMatchObject({ provider: 'openrouter', present: true });
    expect(store.consentOps).toEqual(helperSequenceGolden().updateExistingVault);

    store.resetConsentOps();
    await removeProviderCredential({ credentialStore: store, provider: 'openrouter', vaultPath });

    expect(store.consentOps).toEqual(helperSequenceGolden().updateExistingVault);
    expect(store.secrets.has('openrouter')).toBe(false);
    expect(readVaultProvidersForTest(vaultPath, store)).toEqual({ deepseek: 'ds-secret' });
  });

  it('preserves all other vaulted providers when one provider is enrolled or updated', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.constantFrom('openrouter', 'deepseek', 'openai', 'qwen', 'anthropic'),
          fc.string({ minLength: 1, maxLength: 24 }),
          { minKeys: 1, maxKeys: 5 },
        ),
        fc.string({ minLength: 1, maxLength: 24 }),
        async (existingProviders, replacementSecret) => {
          const root = makeRoot();
          const store = new MemoryCredentialStore();
          const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');
          for (const [provider, secret] of Object.entries(existingProviders)) {
            await enrollInVault(store, vaultPath, provider, secret);
          }
          const target = Object.keys(existingProviders)[0];
          store.resetConsentOps();

          await enrollInVault(store, vaultPath, target, replacementSecret);

          expect(store.consentOps).toEqual(helperSequenceGolden().updateExistingVault);
          expect(readVaultProvidersForTest(vaultPath, store)).toEqual({
            ...existingProviders,
            [target]: replacementSecret,
          });
        },
      ),
      { numRuns: 50 },
    );
  });

  it('starts a seeded holder and completes a strict provider call without leaking raw keys', async () => {
    const root = makeRoot();
    const socketPath = makeSocketPath('seeded');
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');
    const rawKey = 'or-pr5-bootstrap-secret';
    const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'ambient-host-openrouter-key';
    await enrollInVault(store, vaultPath, 'openrouter', rawKey);
    store.resetConsentOps();

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${rawKey}` });
      return new Response(JSON.stringify({
        model: 'test-model',
        choices: [{ message: { content: 'seeded completion' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    let runtime: Awaited<ReturnType<typeof bootstrapProductionCredentialHolder>> | undefined;
    try {
      runtime = await bootstrapProductionCredentialHolder({
        projectRoot: root,
        socketPath,
        credentialStore: store,
        vaultPath,
        providers: ['openrouter'],
        fetchImpl,
        peerCredentialResolver: async () => sameUserPeer(),
        baseUrls: { openrouter: 'https://strict.test/v1' },
      });
      expect(runtime.seededProviders).toEqual(['openrouter']);
      expect(store.consentOps).toEqual(helperSequenceGolden().bootstrapSeedAll);
      const response = await sendCredentialHolderCommand(socketPath, {
        action: 'provider_call',
        taskId: 'strict-pr5-e2e',
        provider: 'openrouter',
        request: {
          action: 'complete',
          payload: {
            model: 'test-model',
            timeout: 2_000,
            messages: [{ role: 'user', content: 'ping' }],
          },
        },
      });

      expect(response).toMatchObject({
        ok: true,
        response: {
          content: 'seeded completion',
          model: 'test-model',
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        },
      });
      const renderedResponse = JSON.stringify(response);
      const renderedFetchArgs = JSON.stringify(fetchImpl.mock.calls);
      const renderedArgv = process.argv.join('\0');
      expect(renderedResponse).not.toContain(rawKey);
      expect(renderedResponse).not.toContain('OPENROUTER_API_KEY');
      expect(renderedFetchArgs).not.toContain('process.env');
      expect(renderedFetchArgs).not.toContain('ambient-host-openrouter-key');
      expect(renderedArgv).not.toContain(rawKey);
      expect(process.env.OPENROUTER_API_KEY).toBe('ambient-host-openrouter-key');
    } finally {
      if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
      await runtime?.stop();
    }
  });

  it('seeds every strict API provider present in the credential backend by default', async () => {
    const root = makeRoot();
    const socketPath = makeSocketPath('seed-all');
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');
    await enrollInVault(store, vaultPath, 'openrouter', 'or-seed-all-secret');
    await enrollInVault(store, vaultPath, 'deepseek', 'ds-seed-all-secret');
    store.resetConsentOps();
    const seenAuth = new Map<string, string>();

    const runtime = await bootstrapProductionCredentialHolder({
      projectRoot: root,
      socketPath,
      credentialStore: store,
      vaultPath,
      fetchImpl: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const renderedUrl = String(url);
        const provider = renderedUrl.includes('deepseek') ? 'deepseek' : 'openrouter';
        seenAuth.set(provider, String((init?.headers as Record<string, string> | undefined)?.Authorization || ''));
        return new Response(JSON.stringify({
          choices: [{ message: { content: `${provider} seeded` }, finish_reason: 'stop' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      peerCredentialResolver: async () => sameUserPeer(),
    });

    try {
      expect(runtime.seededProviders).toEqual(expect.arrayContaining(['deepseek', 'openrouter']));
      expect(store.consentOps).toEqual(helperSequenceGolden().bootstrapSeedAll);

      const deepseek = await sendCredentialHolderCommand(socketPath, {
        action: 'provider_call',
        taskId: 'seed-all-deepseek',
        provider: 'deepseek',
        request: {
          action: 'complete',
          payload: {
            messages: [{ role: 'user', content: 'ping' }],
            model: 'deepseek-v4-pro',
            timeout: 1_000,
          },
        },
      });
      const openrouter = await sendCredentialHolderCommand(socketPath, {
        action: 'provider_call',
        taskId: 'seed-all-openrouter',
        provider: 'openrouter',
        request: {
          action: 'complete',
          payload: {
            messages: [{ role: 'user', content: 'ping' }],
            model: 'auto',
            timeout: 1_000,
          },
        },
      });

      expect(deepseek).toMatchObject({ ok: true, response: { content: 'deepseek seeded' } });
      expect(openrouter).toMatchObject({ ok: true, response: { content: 'openrouter seeded' } });
      expect(seenAuth.get('deepseek')).toBe('Bearer ds-seed-all-secret');
      expect(seenAuth.get('openrouter')).toBe('Bearer or-seed-all-secret');
    } finally {
      await runtime.stop();
    }
  });

  it('does not expose the holder socket until strict provider seeding has completed', async () => {
    const root = makeRoot();
    const socketPath = makeSocketPath('seed-before-bind');
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');
    await enrollInVault(store, vaultPath, 'deepseek', 'ds-delayed-secret');
    store.resetConsentOps();
    let releaseRetrieve!: () => void;
    const originalRetrieve = store.retrieveSecret.bind(store);
    const retrieveStarted = new Promise<void>((resolveStarted) => {
      store.retrieveSecret = async (provider: string): Promise<Uint8Array | null> => {
        if (provider.toLowerCase() === 'vault-kek') {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseRetrieve = resolve;
          });
        }
        return originalRetrieve(provider);
      };
    });

    const boot = bootstrapProductionCredentialHolder({
      projectRoot: root,
      socketPath,
      credentialStore: store,
      vaultPath,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'seeded' }, finish_reason: 'stop' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
      peerCredentialResolver: async () => sameUserPeer(),
    });

    await retrieveStarted;
    expect(existsSync(socketPath)).toBe(false);
    releaseRetrieve();
    const runtime = await boot;
    try {
      expect(existsSync(socketPath)).toBe(true);
      expect(runtime.seededProviders).toContain('deepseek');
    } finally {
      await runtime.stop();
    }
  });

  it('allows a same-UID peer to use holder-owned provider_call without raw key material', async () => {
    const root = makeRoot();
    const socketPath = makeSocketPath('subagent');
    const store = new MemoryCredentialStore();
    const vaultPath = join(root, '.hive-flow', 'credential-vault.json.gcm');
    const rawKey = 'or-subagent-holder-secret';
    await enrollInVault(store, vaultPath, 'openrouter', rawKey);
    store.resetConsentOps();

    const runtime = await bootstrapProductionCredentialHolder({
      projectRoot: root,
      socketPath,
      credentialStore: store,
      vaultPath,
      providers: ['openrouter'],
      fetchImpl: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({ Authorization: `Bearer ${rawKey}` });
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'subagent completion' }, finish_reason: 'stop' }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      peerCredentialResolver: async () => sameUserPeer(),
    });

    try {
      const response = await sendCredentialHolderCommand(socketPath, {
        action: 'provider_call',
        taskId: 'sub-agent-denied',
        provider: 'openrouter',
        request: {
          action: 'complete',
          payload: {
            messages: [{ role: 'user', content: 'ping' }],
            model: 'test-model',
            timeout: 1_000,
          },
        },
      });

      expect(response).toMatchObject({
        ok: true,
        response: {
          content: 'subagent completion',
        },
      });
      expect(JSON.stringify(response)).not.toContain(rawKey);
    } finally {
      await runtime.stop();
    }
  });
});
