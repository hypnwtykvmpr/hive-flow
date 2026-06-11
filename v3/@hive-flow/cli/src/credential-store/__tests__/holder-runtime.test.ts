import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendCredentialHolderCommand } from '../holder.js';
import {
  bootstrapProductionCredentialHolder,
  createHiveFlowPeerRoleResolver,
  initializeCredentialVault,
} from '../holder-runtime.js';
import type { CredentialStoreProvider } from '../credential-store.js';
import type { SealedKek } from '../kek.js';
import type { PeerCredential } from '../peer-credentials.js';

class MemoryCredentialStore implements CredentialStoreProvider {
  readonly secrets = new Map<string, Buffer>();
  readonly backendName = 'memory-test-store';
  unsealCalls = 0;

  isAvailable(): boolean {
    return true;
  }

  async storeSecret(provider: string, secret: Uint8Array | string): Promise<void> {
    this.secrets.set(provider.toLowerCase(), Buffer.from(secret));
  }

  async retrieveSecret(provider: string): Promise<Uint8Array | null> {
    const secret = this.secrets.get(provider.toLowerCase());
    return secret ? Buffer.from(secret) : null;
  }

  async deleteSecret(provider: string): Promise<void> {
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

function writeAgentStore(root: string, records: unknown[]): void {
  const dir = join(root, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'store.json'), JSON.stringify({
    agents: records,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
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

  it('starts a seeded holder and completes a strict provider call without leaking raw keys', async () => {
    const root = makeRoot();
    const socketPath = makeSocketPath('seeded');
    const store = new MemoryCredentialStore();
    const rawKey = 'or-pr5-bootstrap-secret';
    const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'ambient-host-openrouter-key';
    await store.storeSecret('openrouter', rawKey);

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
        providers: ['openrouter'],
        fetchImpl,
        peerCredentialResolver: async () => sameUserPeer(),
        baseUrls: { openrouter: 'https://strict.test/v1' },
      });
      expect(runtime.seededProviders).toEqual(['openrouter']);
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

  it('allows a same-UID registered sub-agent PID to use holder-owned provider_call without raw key material', async () => {
    const root = makeRoot();
    const socketPath = makeSocketPath('subagent');
    const store = new MemoryCredentialStore();
    const rawKey = 'or-subagent-holder-secret';
    await store.storeSecret('openrouter', rawKey);
    writeAgentStore(root, [{
      agentId: 'sub-agent-1',
      type: 'coder',
      status: 'busy',
      pid: process.pid,
    }]);

    const runtime = await bootstrapProductionCredentialHolder({
      projectRoot: root,
      socketPath,
      credentialStore: store,
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

describe('Hive Flow peer role resolver', () => {
  it('classifies arbitrary task-tracking PIDs as advisory provider workers', () => {
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2_000_000_000 }), async (pid) => {
        const root = makeRoot();
        const tasksDir = join(root, '.hive-flow', 'tasks');
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, 'task-1.json'), JSON.stringify({
          taskId: 'task-1',
          agentId: 'agent-1',
          status: 'running',
          provider: 'openrouter',
          pid,
        }), 'utf8');

        const resolver = createHiveFlowPeerRoleResolver({ projectRoot: root });
        await expect(resolver({ ...sameUserPeer(pid), pid })).resolves.toBe('provider-worker');
      }),
      { numRuns: 25 },
    );
  });
});
