/**
 * OpenAI Provider Tests
 *
 * Covers initialization, header propagation, and protected-header guards.
 *
 * The header tests assert the regression fix for `providerOptions.headers`:
 * extra headers must survive into outgoing requests, but caller-supplied
 * `Authorization` / `Content-Type` MUST NOT clobber the provider defaults.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { OpenAIProvider } from '../openai-provider.js';
import { LLMRequest } from '../types.js';
import { ILogger } from '../base-provider.js';

const silentLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const TEST_MESSAGES: LLMRequest['messages'] = [
  { role: 'user', content: 'hi' },
];

const createTestRequest = (model?: string): LLMRequest => ({
  messages: TEST_MESSAGES,
  ...(model ? { model } : {}),
  maxTokens: 50,
  temperature: 0.1,
  requestId: 'test-static-id',
});

const okBody = {
  id: 'chatcmpl_test_001',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop' as const,
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetchDispatcher(
  handlers: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: (call: number) => Response | Promise<Response> }>,
): ReturnType<typeof vi.fn> {
  const counters = new Map<number, number>();
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (let i = 0; i < handlers.length; i++) {
      if (handlers[i].match(u, init)) {
        const count = (counters.get(i) ?? 0) + 1;
        counters.set(i, count);
        return handlers[i].respond(count);
      }
    }
    throw new Error(`Unexpected fetch call: ${u}`);
  });
  return fn;
}

/** Standard OpenAI dispatcher: health check (/models) + chat completion. */
function mountOpenAIMocks() {
  const fetchMock = makeFetchDispatcher([
    {
      match: (u) => u === 'https://api.openai.com/v1/chat/completions',
      respond: () => jsonResponse(okBody),
    },
    {
      match: (u) => u === 'https://api.openai.com/v1/models',
      respond: () => jsonResponse({ data: [] }),
    },
  ]);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Find the chat/completions call (skip the /models health check). */
function findCompletionCall(
  fetchMock: ReturnType<typeof vi.fn>,
): [string, RequestInit] {
  const call = fetchMock.mock.calls.find(
    (c) => c[0] === 'https://api.openai.com/v1/chat/completions',
  );
  expect(call).toBeDefined();
  return [call![0] as string, call![1] as RequestInit];
}

describe('OpenAIProvider providerOptions.headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('providerOptions.headers survives into outgoing requests', async () => {
    const fetchMock = mountOpenAIMocks();

    const provider = new OpenAIProvider({
      config: {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        maxTokens: 100,
        providerOptions: {
          headers: {
            'HTTP-Referer': 'https://example.com',
            'X-Title': 'test',
          },
        },
      },
      logger: silentLogger,
    });

    await provider.initialize();
    await provider.complete(createTestRequest());

    const [, init] = findCompletionCall(fetchMock);
    const headers = init.headers as Record<string, string>;

    expect(headers['HTTP-Referer']).toBe('https://example.com');
    expect(headers['X-Title']).toBe('test');

    provider.destroy();
  });

  it('providerOptions.headers cannot overwrite Authorization', async () => {
    const fetchMock = mountOpenAIMocks();

    const provider = new OpenAIProvider({
      config: {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        maxTokens: 100,
        providerOptions: {
          headers: {
            Authorization: 'Bearer EVIL',
          },
        },
      },
      logger: silentLogger,
    });

    await provider.initialize();
    await provider.complete(createTestRequest());

    const [, init] = findCompletionCall(fetchMock);
    const headers = init.headers as Record<string, string>;

    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers.Authorization).not.toBe('Bearer EVIL');

    provider.destroy();
  });

  it('providerOptions.headers cannot overwrite Content-Type', async () => {
    const fetchMock = mountOpenAIMocks();

    const provider = new OpenAIProvider({
      config: {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        maxTokens: 100,
        providerOptions: {
          headers: {
            'Content-Type': 'text/plain',
          },
        },
      },
      logger: silentLogger,
    });

    await provider.initialize();
    await provider.complete(createTestRequest());

    const [, init] = findCompletionCall(fetchMock);
    const headers = init.headers as Record<string, string>;

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Content-Type']).not.toBe('text/plain');

    provider.destroy();
  });
});
