import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoSecretLeak } from '@hive-flow/testing/helpers';

import { OpenRouterProvider } from '../openrouter-provider.js';
import { AuthenticationError } from '../types.js';
import { DEFAULT_CONFIG, resetOpenRouterConfigCache } from '../openrouter-model-config.js';

const SECRET = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz123456';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  resetOpenRouterConfigCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenRouter provider hardening with mocked fetch', () => {
  it('ignores ambient OPENROUTER_API_KEY when strict config has no apiKey', async () => {
    process.env.OPENROUTER_API_KEY = SECRET;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'xiaomi/mimo-v2.5-pro', context_length: 4096 }] });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }));

    const provider = new OpenRouterProvider({
      config: {
        provider: 'openrouter',
        model: 'xiaomi/mimo-v2.5-pro',
        apiUrl: 'https://openrouter.test/v1',
        timeout: 2_000,
      },
    });

    await expect(provider.initialize()).rejects.toThrow(/config\.apiKey/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('completes without external network access', async () => {
    const seenAuth: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      seenAuth.push(String((init?.headers as Record<string, string> | undefined)?.Authorization || ''));
      if (u.endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'xiaomi/mimo-v2.5-pro', context_length: 4096 }] });
      }
      if (u.endsWith('/chat/completions')) {
        return jsonResponse({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'xiaomi/mimo-v2.5-pro',
          choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }));

    const provider = new OpenRouterProvider({
      config: {
        provider: 'openrouter',
        model: 'xiaomi/mimo-v2.5-pro',
        apiKey: SECRET,
        apiUrl: 'https://openrouter.test/v1',
        timeout: 2_000,
      },
    });
    await provider.initialize();
    const response = await provider.complete({ messages: [{ role: 'user', content: 'ping' }] });
    expect(response.content).toBe('PONG');
    expect(seenAuth).toContain(`Bearer ${SECRET}`);
  });

  it('fails authentication without leaking the configured key in the thrown error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'xiaomi/mimo-v2.5-pro', context_length: 4096 }] });
      }
      return new Response(JSON.stringify({ error: { message: 'invalid credentials' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const provider = new OpenRouterProvider({
      config: {
        provider: 'openrouter',
        model: 'xiaomi/mimo-v2.5-pro',
        apiKey: SECRET,
        apiUrl: 'https://openrouter.test/v1',
        timeout: 2_000,
      },
    });
    await provider.initialize();
    let thrown: unknown;
    try {
      await provider.complete({ messages: [{ role: 'user', content: 'ping' }] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AuthenticationError);
    assertNoSecretLeak(String((thrown as Error | undefined)?.message || thrown));
  });

  it('requests OpenRouter stream usage and uses the final SSE usage chunk for completion tokens', async () => {
    const seenBodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'xiaomi/mimo-v2.5-pro', context_length: 4096 }] });
      }
      if (u.endsWith('/chat/completions')) {
        seenBodies.push(JSON.parse(String(init?.body)));
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
          'data: [DONE]\n\n',
        ]);
      }
      throw new Error(`Unexpected URL: ${u}`);
    }));

    const provider = new OpenRouterProvider({
      config: {
        provider: 'openrouter',
        model: 'xiaomi/mimo-v2.5-pro',
        apiKey: SECRET,
        apiUrl: 'https://openrouter.test/v1',
        timeout: 2_000,
      },
    });
    provider.capabilities.pricing['xiaomi/mimo-v2.5-pro'] = {
      promptCostPer1k: 0.01,
      completionCostPer1k: 0.02,
      currency: 'USD',
    };
    await provider.initialize();

    const events = [];
    for await (const event of provider.streamComplete({ messages: [{ role: 'user', content: 'ping' }] })) {
      events.push(event);
    }

    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    const done = events.find((event) => event.type === 'done');
    expect(done?.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(done?.cost?.completionCost).toBeCloseTo(0.00006);
  });

  it('resolves OpenRouter model aliases before request building and cost lookup', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const resolvedModel = DEFAULT_CONFIG.tiers.opus[0];
    const seenBodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/models')) {
        return jsonResponse({ data: [{ id: resolvedModel, context_length: 4096 }] });
      }
      if (u.endsWith('/chat/completions')) {
        seenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          id: 'chatcmpl-alias',
          object: 'chat.completion',
          created: 1,
          model: resolvedModel,
          choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    }));

    const provider = new OpenRouterProvider({
      config: {
        provider: 'openrouter',
        model: 'opus',
        apiKey: SECRET,
        apiUrl: 'https://openrouter.test/v1',
        timeout: 2_000,
      },
    });
    provider.capabilities.pricing[resolvedModel] = {
      promptCostPer1k: 0.01,
      completionCostPer1k: 0.02,
      currency: 'USD',
    };
    await provider.initialize();

    const response = await provider.complete({ messages: [{ role: 'user', content: 'ping' }] });

    expect(seenBodies[0]).toMatchObject({ model: resolvedModel });
    expect(response.model).toBe(resolvedModel);
    expect(response.cost?.totalCost).toBeCloseTo(0.0001);
  });
});
