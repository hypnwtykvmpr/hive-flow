/**
 * Provider Integration Tests
 *
 * These tests exercise the HTTP request building, response parsing, and the
 * cross-provider orchestration in `ProviderManager` against mocked fetch
 * responses.
 *
 * Originally these tests were `it.skipIf(!apiKey)` and required real network
 * calls. They have been rewritten as deterministic unit tests using
 * `vi.stubGlobal('fetch', ...)` so they exercise the same code paths
 * (request build → fetch → response transform → manager cache/failover)
 * without an outbound HTTP call or any provider API key.
 *
 * Mock dispatch is keyed by request URL so the health check probes that
 * `BaseProvider.initialize()` always fires don't disrupt the call ordering.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
  OllamaProvider,
  createProviderManager,
  ProviderManager,
  LLMRequest,
  LLMProviderConfig,
  ProviderManagerConfig,
  ILLMProvider,
} from '../index.js';
import { ILogger } from '../base-provider.js';

const silentLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const TEST_PROMPT = 'Say "Hello from Hive Flow V3!" in exactly 5 words.';
const TEST_MESSAGES: LLMRequest['messages'] = [
  { role: 'user', content: TEST_PROMPT },
];

const createTestRequest = (model?: string): LLMRequest => ({
  messages: TEST_MESSAGES,
  ...(model ? { model } : {}),
  maxTokens: 50,
  temperature: 0.1,
  requestId: 'test-static-id',
});

/** Build a Response object for a successful JSON body. */
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a streaming Response that emits the given SSE-style chunks. */
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

/**
 * Build a fetch mock that dispatches by request URL.
 *
 * `BaseProvider.initialize()` always runs a health check, so each provider
 * needs both its health-check response and its actual chat response.
 */
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

describe('Provider Integration Tests (mocked fetch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Anthropic Provider', () => {
    const anthropicBody = {
      id: 'msg_test_001',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-latest',
      content: [{ type: 'text', text: 'Hello from Hive Flow V3!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 7 },
    };

    it('builds the request and parses the response for Claude 3.5 Sonnet', async () => {
      // Anthropic does both health-check and complete via POST to /v1/messages;
      // they differ by body. Match on URL and dispatch by call count.
      fetchMock = makeFetchDispatcher([
        {
          match: (u) => u === 'https://api.anthropic.com/v1/messages',
          respond: () => jsonResponse(anthropicBody),
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const provider = new AnthropicProvider({
        config: {
          provider: 'anthropic',
          apiKey: 'sk-test-anthropic',
          model: 'claude-3-5-sonnet-latest',
          maxTokens: 100,
        },
        logger: silentLogger,
      });

      await provider.initialize();
      const response = await provider.complete(createTestRequest());

      // Find the complete() call (max_tokens > 1 — health check uses max_tokens=1)
      const completeCall = fetchMock.mock.calls.find((call) => {
        const init = call[1] as RequestInit | undefined;
        if (!init?.body) return false;
        const body = JSON.parse(String(init.body));
        return body.max_tokens !== 1;
      });
      expect(completeCall).toBeDefined();
      const init = completeCall![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('sk-test-anthropic');
      expect(headers['anthropic-version']).toBe('2023-06-01');

      expect(response.provider).toBe('anthropic');
      expect(response.content).toBe('Hello from Hive Flow V3!');
      expect(response.usage.totalTokens).toBe(19);
      expect(response.cost?.totalCost).toBeGreaterThan(0);
      expect(response.finishReason).toBe('stop');

      provider.destroy();
    });

    it('streams response chunks via SSE', async () => {
      const sseLines = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"text":" from"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"text":" Hive!"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ];

      fetchMock = makeFetchDispatcher([
        {
          match: (u, init) => {
            if (u !== 'https://api.anthropic.com/v1/messages') return false;
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            return body.stream === true;
          },
          respond: () => sseResponse(sseLines),
        },
        {
          // Health check (no stream)
          match: (u) => u === 'https://api.anthropic.com/v1/messages',
          respond: () => jsonResponse(anthropicBody),
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const provider = new AnthropicProvider({
        config: {
          provider: 'anthropic',
          apiKey: 'sk-test-anthropic',
          model: 'claude-3-5-sonnet-latest',
          maxTokens: 100,
        },
        logger: silentLogger,
      });

      await provider.initialize();

      const chunks: string[] = [];
      let doneEvent: { type: string; usage?: { totalTokens: number } } | null = null;
      for await (const event of provider.streamComplete(createTestRequest())) {
        if (event.type === 'content' && event.delta?.content) {
          chunks.push(event.delta.content);
        } else if (event.type === 'done') {
          doneEvent = event as { type: string; usage?: { totalTokens: number } };
        }
      }

      expect(chunks).toEqual(['Hello', ' from', ' Hive!']);
      expect(doneEvent).not.toBeNull();
      expect(doneEvent!.usage?.totalTokens).toBe(15);

      provider.destroy();
    });
  });

  describe('Google Gemini Provider', () => {
    const geminiBody = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello from Hive Flow V3!' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 8,
        totalTokenCount: 23,
      },
    };

    it('builds the request and parses Gemini 2.0 Flash response', async () => {
      fetchMock = makeFetchDispatcher([
        {
          match: (u) => u.includes(':generateContent'),
          respond: () => jsonResponse(geminiBody),
        },
        {
          // Health check hits /models endpoint
          match: (u) => u.includes('/models?key='),
          respond: () => jsonResponse({ models: [] }),
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const provider = new GoogleProvider({
        config: {
          provider: 'google',
          apiKey: 'gk-test-google',
          model: 'gemini-2.0-flash',
          maxTokens: 100,
        },
        logger: silentLogger,
      });

      await provider.initialize();
      const response = await provider.complete(createTestRequest());

      // The generateContent URL was hit with the configured key
      const generateCall = fetchMock.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes(':generateContent'),
      );
      expect(generateCall).toBeDefined();
      expect(generateCall![0]).toMatch(/gemini-2\.0-flash:generateContent\?key=gk-test-google/);

      expect(response.provider).toBe('google');
      expect(response.content).toBe('Hello from Hive Flow V3!');

      provider.destroy();
    });
  });

  describe('OpenRouter Provider (OpenAI Compatible)', () => {
    const openrouterBody = {
      id: 'chatcmpl_or_test',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'openai/gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from Hive Flow V3!',
          },
          finish_reason: 'stop' as const,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    };

    it('routes through the OpenAI-compatible OpenRouter URL', async () => {
      fetchMock = makeFetchDispatcher([
        {
          match: (u) => u === 'https://openrouter.ai/api/v1/chat/completions',
          respond: () => jsonResponse(openrouterBody),
        },
        {
          // OpenAI health check hits /models
          match: (u) => u === 'https://openrouter.ai/api/v1/models',
          respond: () => jsonResponse({ data: [] }),
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const provider = new OpenAIProvider({
        config: {
          provider: 'openai',
          apiKey: 'or-test-openrouter',
          apiUrl: 'https://openrouter.ai/api/v1',
          model: 'openai/gpt-4o-mini',
          maxTokens: 100,
        },
        logger: silentLogger,
      });

      await provider.initialize();
      const response = await provider.complete(createTestRequest('openai/gpt-4o-mini'));

      // POST to chat/completions with bearer auth
      const completionCall = fetchMock.mock.calls.find(
        (call) => call[0] === 'https://openrouter.ai/api/v1/chat/completions',
      );
      expect(completionCall).toBeDefined();
      const headers = (completionCall![1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer or-test-openrouter');

      expect(response.content).toBe('Hello from Hive Flow V3!');
      expect(response.usage.totalTokens).toBe(16);

      provider.destroy();
    });
  });

  describe('Ollama Provider (Local)', () => {
    const ollamaBody = {
      model: 'llama3.2',
      created_at: '2024-01-01T00:00:00Z',
      message: { role: 'assistant', content: 'Hello from Hive Flow V3!' },
      done: true,
      prompt_eval_count: 9,
      eval_count: 5,
    };

    it('builds the request and parses an Ollama response from a local URL', async () => {
      fetchMock = makeFetchDispatcher([
        {
          match: (u) => u === 'http://localhost:11434/api/chat',
          respond: () => jsonResponse(ollamaBody),
        },
        {
          // Ollama health check hits /api/tags
          match: (u) => u === 'http://localhost:11434/api/tags',
          respond: () => jsonResponse({ models: [{ name: 'llama3.2' }] }),
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const provider = new OllamaProvider({
        config: {
          provider: 'ollama',
          apiUrl: 'http://localhost:11434',
          model: 'llama3.2',
          maxTokens: 100,
        },
        logger: silentLogger,
      });

      await provider.initialize();
      const response = await provider.complete(createTestRequest());

      const chatCall = fetchMock.mock.calls.find(
        (call) => call[0] === 'http://localhost:11434/api/chat',
      );
      expect(chatCall).toBeDefined();

      expect(response.provider).toBe('ollama');
      expect(response.content).toBe('Hello from Hive Flow V3!');
      expect(response.cost?.totalCost).toBe(0); // local model, no cost

      provider.destroy();
    });
  });

  describe('Provider Manager', () => {
    it('fails fast instead of routing to a known-bad provider when all providers are unavailable', async () => {
      const knownBadProvider = Object.assign(new EventEmitter(), {
        name: 'openrouter',
        capabilities: {
          supportedModels: ['test/model'],
          maxContextLength: { 'test/model': 4096 },
          maxOutputTokens: { 'test/model': 1024 },
          supportsStreaming: false,
          supportsToolCalling: false,
          supportsSystemMessages: true,
          supportsVision: false,
          supportsAudio: false,
          supportsFineTuning: false,
          supportsEmbeddings: false,
          supportsBatching: false,
          pricing: {},
        },
        config: { provider: 'openrouter', model: 'test/model' },
        initialize: vi.fn(),
        complete: vi.fn(async () => ({
          id: 'known-bad',
          model: 'test/model',
          provider: 'openrouter',
          content: 'should not route here',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        })),
        streamComplete: vi.fn(),
        listModels: vi.fn(),
        getModelInfo: vi.fn(),
        validateModel: vi.fn(),
        healthCheck: vi.fn(),
        getStatus: vi.fn(() => ({
          available: false,
          currentLoad: 0,
          queueLength: 0,
          activeRequests: 0,
        })),
        estimateCost: vi.fn(),
        getUsage: vi.fn(),
        destroy: vi.fn(),
      }) as unknown as ILLMProvider;

      const manager = new ProviderManager({
        providers: [],
        loadBalancing: { enabled: true, strategy: 'round-robin' },
      }, silentLogger);
      const internals = manager as unknown as {
        providers: Map<string, ILLMProvider>;
        metrics: Map<string, unknown>;
      };
      internals.providers.set('openrouter', knownBadProvider);
      internals.metrics.set('openrouter', { latency: 0, errorRate: 0, cost: 0, lastUsed: 0 });

      await expect(manager.complete(createTestRequest())).rejects.toThrow(/No available providers/i);
      expect(knownBadProvider.complete).not.toHaveBeenCalled();
    });

    const anthropicBody = {
      id: 'msg_mgr_001',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-latest',
      content: [{ type: 'text', text: 'managed-anthropic-reply' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    };

    const geminiBody = {
      candidates: [
        {
          content: { parts: [{ text: 'managed-gemini-reply' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
    };

    function mountTwoProviderMocks(options: { anthropicStatus?: number } = {}) {
      const anthropicStatus = options.anthropicStatus ?? 200;
      fetchMock = makeFetchDispatcher([
        {
          match: (u, init) => {
            if (u !== 'https://api.anthropic.com/v1/messages') return false;
            // Distinguish complete() (large max_tokens) from health check (1)
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            return body.max_tokens !== 1;
          },
          respond: () =>
            anthropicStatus === 200
              ? jsonResponse(anthropicBody)
              : new Response(JSON.stringify({ error: { message: 'server error' } }), {
                  status: anthropicStatus,
                  headers: { 'Content-Type': 'application/json' },
                }),
        },
        {
          // Anthropic health check (max_tokens=1) → always succeed
          match: (u) => u === 'https://api.anthropic.com/v1/messages',
          respond: () => jsonResponse(anthropicBody),
        },
        {
          match: (u) => u.includes(':generateContent'),
          respond: () => jsonResponse(geminiBody),
        },
        {
          match: (u) => u.includes('/models?key='),
          respond: () => jsonResponse({ models: [] }),
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);
    }

    it('manages multiple providers and round-robin selects one', async () => {
      mountTwoProviderMocks();

      const providers: LLMProviderConfig[] = [
        {
          provider: 'anthropic',
          apiKey: 'sk-test',
          model: 'claude-3-5-sonnet-latest',
          maxTokens: 100,
        },
        {
          provider: 'google',
          apiKey: 'gk-test',
          model: 'gemini-2.0-flash',
          maxTokens: 100,
        },
      ];

      const config: ProviderManagerConfig = {
        providers,
        loadBalancing: { enabled: true, strategy: 'round-robin' },
        fallback: { enabled: true, maxAttempts: 2 },
        cache: { enabled: false, ttl: 60_000, maxSize: 100 },
      };

      const manager = await createProviderManager(config, silentLogger);

      const list = manager.listProviders();
      expect(list).toContain('anthropic');
      expect(list).toContain('google');

      const response = await manager.complete(createTestRequest());
      // Round-robin starts at index 0 (anthropic)
      expect(response.provider).toBe('anthropic');
      expect(response.content).toBe('managed-anthropic-reply');

      // estimateCost is computed locally from token estimates → no network calls
      const estimates = await manager.estimateCost(createTestRequest());
      expect(estimates.has('anthropic')).toBe(true);
      expect(estimates.has('google')).toBe(true);

      manager.destroy();
    });

    it('falls back to a second provider when the first errors', async () => {
      mountTwoProviderMocks({ anthropicStatus: 500 });

      const config: ProviderManagerConfig = {
        providers: [
          {
            provider: 'anthropic',
            apiKey: 'sk-test',
            model: 'claude-3-5-sonnet-latest',
            maxTokens: 100,
          },
          {
            provider: 'google',
            apiKey: 'gk-test',
            model: 'gemini-2.0-flash',
            maxTokens: 100,
          },
        ],
        loadBalancing: { enabled: true, strategy: 'round-robin' },
        fallback: { enabled: true, maxAttempts: 2 },
      };

      const manager = await createProviderManager(config, silentLogger);

      // Providers extend EventEmitter and emit 'error' on failure. Attach a
      // no-op listener so the failover path doesn't crash Node's EventEmitter
      // unhandled-error guard during the test.
      const anthropic = manager.getProvider('anthropic');
      expect(anthropic).toBeDefined();
      (anthropic as { on(e: string, fn: (...args: unknown[]) => void): void }).on(
        'error',
        () => {},
      );

      const response = await manager.complete(createTestRequest(), 'anthropic');

      expect(response.provider).toBe('google');
      expect(response.content).toBe('managed-gemini-reply');

      manager.destroy();
    });

    it('uses the cache for repeated identical requests', async () => {
      mountTwoProviderMocks();

      const manager = await createProviderManager(
        {
          providers: [
            {
              provider: 'anthropic',
              apiKey: 'sk-test',
              model: 'claude-3-5-sonnet-latest',
              maxTokens: 50,
            },
          ],
          cache: { enabled: true, ttl: 60_000, maxSize: 100 },
        },
        silentLogger,
      );

      const request = createTestRequest();
      const response1 = await manager.complete(request);
      const response2 = await manager.complete(request);

      expect(response1.content).toBe(response2.content);

      // The complete() endpoint should only have been hit ONCE — second is cached
      const completionCalls = fetchMock.mock.calls.filter((call) => {
        if (call[0] !== 'https://api.anthropic.com/v1/messages') return false;
        const body = (call[1] as RequestInit)?.body
          ? JSON.parse(String((call[1] as RequestInit).body))
          : {};
        return body.max_tokens !== 1;
      });
      expect(completionCalls).toHaveLength(1);

      manager.destroy();
    });
  });

  describe('Cost Estimation', () => {
    it('estimates cost from local pricing tables without network calls', async () => {
      // Health check still fires from initialize(); mock both endpoints.
      fetchMock = makeFetchDispatcher([
        {
          match: (u) => u === 'https://api.anthropic.com/v1/messages',
          respond: () => jsonResponse({
            id: 'health',
            type: 'message',
            role: 'assistant',
            model: 'claude-3-5-sonnet-latest',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const manager = await createProviderManager(
        {
          providers: [
            {
              provider: 'anthropic',
              apiKey: 'sk-test',
              model: 'claude-3-5-sonnet-latest',
              maxTokens: 100,
            },
          ],
        },
        silentLogger,
      );

      const callsBefore = fetchMock.mock.calls.length;
      const estimates = await manager.estimateCost(createTestRequest());
      const callsAfter = fetchMock.mock.calls.length;

      // estimateCost must not perform any HTTP calls of its own
      expect(callsAfter).toBe(callsBefore);

      const estimate = estimates.get('anthropic');
      expect(estimate).toBeDefined();
      expect(estimate!.estimatedPromptTokens).toBeGreaterThan(0);
      expect(estimate!.estimatedCompletionTokens).toBe(50);
      expect(estimate!.estimatedCost.total).toBeGreaterThan(0);
      expect(estimate!.estimatedCost.currency).toBe('USD');

      manager.destroy();
    });
  });
});
