import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

const createProviderManager = vi.fn(() => {
  throw new Error('strict API provider_complete must not use provider-manager');
});

vi.mock('@hive-flow/providers', () => ({
  createProviderManager,
  resolveProviderModel: vi.fn((provider: string, model: string | undefined) => {
    if (provider === 'openrouter' && model === 'mini') return 'moonshotai/kimi-k2.6';
    return model || 'auto';
  }),
}));

import { providerTools } from '../mcp-tools/provider-tools.js';

const providerComplete = providerTools.find((tool) => tool.name === 'provider_complete')!;
const providerStatus = providerTools.find((tool) => tool.name === 'provider_status')!;

describe('provider_complete strict API holder route', () => {
  const originalSocket = process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  let originalCwd: string;
  let tmpRoot = '';
  let server: Server | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpRoot = mkdtempSync(join(tmpdir(), 'hf-provider-tools-'));
    process.chdir(tmpRoot);
    createProviderManager.mockClear();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (originalSocket === undefined) delete process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET;
    else process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET = originalSocket;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    process.chdir(originalCwd);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('routes OpenRouter completions through the credential holder socket without provider-manager', async () => {
    const socketPath = join(tmpRoot, 'credential-holder.sock');
    const observedCommands: unknown[] = [];
    server = createServer((socket: Socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const line = buffer.slice(0, buffer.indexOf('\n'));
        observedCommands.push(JSON.parse(line));
        socket.end(`${JSON.stringify({
          ok: true,
          response: {
            content: 'holder completion',
            model: 'moonshotai/kimi-k2.6',
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
          },
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
    process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET = socketPath;

    const result = await providerComplete.handler({
      provider: 'openrouter',
      model: 'mini',
      prompt: 'ping',
      systemPrompt: 'system',
      timeout: 12_000,
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      provider: 'openrouter',
      text: 'holder completion',
      model: 'moonshotai/kimi-k2.6',
      resolvedModel: 'moonshotai/kimi-k2.6',
      credentialBoundary: 'holder',
    });
    expect(createProviderManager).not.toHaveBeenCalled();
    expect(observedCommands).toHaveLength(1);
    expect(observedCommands[0]).toMatchObject({
      action: 'provider_call',
      provider: 'openrouter',
      request: {
        action: 'complete',
        payload: {
          model: 'moonshotai/kimi-k2.6',
          timeout: 12_000,
          messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'ping' },
          ],
        },
      },
    });
    expect(JSON.stringify(observedCommands[0])).not.toContain('OPENROUTER_API_KEY');
  });

  it('routes strict provider_status through the holder health check instead of raw-key provider manager', async () => {
    const socketPath = join(tmpRoot, 'credential-holder.sock');
    const observedCommands: unknown[] = [];
    process.env.OPENROUTER_API_KEY = 'or-env-secret-that-must-not-be-used';
    server = createServer((socket: Socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const line = buffer.slice(0, buffer.indexOf('\n'));
        observedCommands.push(JSON.parse(line));
        socket.end(`${JSON.stringify({
          ok: true,
          response: {
            healthy: true,
            status: 200,
            latency: 4,
            details: { credentialBoundary: 'holder' },
          },
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, () => resolve());
    });
    chmodSync(socketPath, 0o600);
    process.env.HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET = socketPath;

    const result = await providerStatus.handler({ provider: 'openrouter' }) as Record<string, unknown>;

    expect(result.providers).toEqual([
      expect.objectContaining({
        name: 'openrouter',
        available: true,
        healthy: true,
        latency: 4,
        credentialBoundary: 'holder',
      }),
    ]);
    expect(createProviderManager).not.toHaveBeenCalled();
    expect(observedCommands).toHaveLength(1);
    expect(observedCommands[0]).toMatchObject({
      action: 'provider_call',
      provider: 'openrouter',
      request: {
        action: 'health_check',
        payload: { timeout: 5_000 },
      },
    });
    expect(JSON.stringify(observedCommands[0])).not.toContain('or-env-secret-that-must-not-be-used');
  });
});
