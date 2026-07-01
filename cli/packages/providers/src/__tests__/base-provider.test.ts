/**
 * Base Provider Tests
 *
 * Regression tests for the `BaseProvider.complete()` error-emit guard.
 *
 * Background: Node's EventEmitter throws synchronously when `.emit('error', ...)`
 * is called with no listener attached, wrapping the real cause in a generic
 * `Error('Unhandled error.')`. Before the fix, this wrapping happened inside
 * `BaseProvider.complete()`'s catch block, replacing the typed
 * `LLMProviderError` with a plain Error. That broke the
 * `isLLMProviderError(error)` check in `ProviderManager.completeWithFallback`
 * (`provider-manager.ts:201`) and silently disabled fallback on every error.
 *
 * The fix guards the emit with `this.listenerCount('error') > 0`.
 *
 * @module @hive-flow/providers/__tests__/base-provider
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { OpenAIProvider } from '../openai-provider.js';
import { ProviderManager } from '../provider-manager.js';
import {
  LLMProviderError,
  LLMRequest,
  LLMResponse,
  ProviderManagerConfig,
} from '../types.js';
import { ILogger } from '../base-provider.js';

const silentLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const TEST_REQUEST: LLMRequest = {
  messages: [{ role: 'user', content: 'ping' }],
  maxTokens: 32,
  temperature: 0.1,
  requestId: 'base-provider-test',
};

/** Build a JSON Response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A successful OpenAI-shaped chat-completion response body (used for health checks). */
const openAISuccessBody = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-4o-mini',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'pong' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
};

describe('BaseProvider error-emit guard (regression)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects with the typed LLMProviderError when no listener is attached', async () => {
    // Stub fetch so initialize()'s health check resolves cleanly. After
    // initialize, we swap in a stub doComplete that throws a typed error so
    // the catch block in BaseProvider.complete is exercised.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(openAISuccessBody)),
    );

    const provider = new OpenAIProvider({
      config: {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        maxTokens: 32,
      },
      logger: silentLogger,
    });

    await provider.initialize();

    // Replace doComplete (protected) to throw a typed LLMProviderError.
    const boom = new LLMProviderError('boom', 'X', 'openai');
    (provider as unknown as { doComplete: () => Promise<LLMResponse> }).doComplete =
      vi.fn(async () => {
        throw boom;
      });

    // CRITICAL: do NOT attach any 'error' listener. Before the fix this
    // caused Node's EventEmitter to throw a generic
    // `Error('Unhandled error.')` inside complete()'s catch, masking the
    // typed LLMProviderError and breaking fallback in ProviderManager.
    expect(provider.listenerCount('error')).toBe(0);

    let captured: unknown;
    try {
      await provider.complete(TEST_REQUEST);
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(LLMProviderError);
    expect((captured as LLMProviderError).message).toBe('boom');
    expect((captured as LLMProviderError).code).toBe('X');
    expect((captured as LLMProviderError).provider).toBe('openai');

    provider.destroy();
  });

  it('fallback chain runs when underlying provider fails (regression)', async () => {
    // ProviderManager.complete -> completeWithFallback path requires the
    // first error to remain `instanceof LLMProviderError` so the
    // `isLLMProviderError(error)` check in provider-manager.ts:201 returns
    // true. Without the emit guard fix, the error was wrapped in a generic
    // `Error('Unhandled error.')` and fallback was silently skipped.

    // Stub fetch for the health-check probes that initialize() fires.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(openAISuccessBody)),
    );

    const config: ProviderManagerConfig = {
      providers: [
        {
          provider: 'openai',
          apiKey: 'sk-primary',
          model: 'gpt-4o-mini',
          maxTokens: 32,
        },
        {
          provider: 'openrouter',
          apiKey: 'sk-fallback',
          model: 'gpt-4o-mini',
          maxTokens: 32,
        },
      ],
      fallback: { enabled: true, maxAttempts: 2 },
    };

    // Bypass createProviderManager() so we can install stubs for doComplete
    // on each instance before any complete() call hits the wire.
    const manager = new ProviderManager(config, silentLogger);

    const primary = new OpenAIProvider({
      config: config.providers[0],
      logger: silentLogger,
    });
    const fallback = new OpenAIProvider({
      config: config.providers[1],
      logger: silentLogger,
    });

    await primary.initialize();
    await fallback.initialize();

    // primary fails with typed LLMProviderError; fallback returns a valid
    // LLMResponse.
    (primary as unknown as { doComplete: () => Promise<LLMResponse> }).doComplete =
      vi.fn(async () => {
        throw new LLMProviderError(
          'primary-down',
          'X',
          'openai',
          undefined,
          true,
        );
      });

    const fallbackResponse: LLMResponse = {
      id: 'fallback-1',
      model: 'gpt-4o-mini',
      provider: 'openrouter',
      content: 'fallback-pong',
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      finishReason: 'stop',
    };
    (fallback as unknown as { doComplete: () => Promise<LLMResponse> }).doComplete =
      vi.fn(async () => fallbackResponse);

    // Inject providers into the manager's private map. The manager keys by
    // `LLMProvider`; use 'openai' and 'openrouter' to keep them distinct.
    // The `name` property on each instance must match the map key for the
    // fallback iteration in completeWithFallback to skip the failed one.
    type ManagerInternals = {
      providers: Map<string, OpenAIProvider>;
      metrics: Map<
        string,
        { latency: number; errorRate: number; cost: number; lastUsed: number }
      >;
    };
    const internals = manager as unknown as ManagerInternals;
    Object.defineProperty(primary, 'name', {
      value: 'openai',
      configurable: true,
    });
    Object.defineProperty(fallback, 'name', {
      value: 'openrouter',
      configurable: true,
    });
    internals.providers.set('openai', primary);
    internals.providers.set('openrouter', fallback);
    internals.metrics.set('openai', {
      latency: 0,
      errorRate: 0,
      cost: 0,
      lastUsed: 0,
    });
    internals.metrics.set('openrouter', {
      latency: 0,
      errorRate: 0,
      cost: 0,
      lastUsed: 0,
    });

    // Sanity: NO error listeners on either provider. The fix means
    // complete() now rejects with the typed error instead of an
    // 'Unhandled error.' wrapper, so completeWithFallback's
    // `isLLMProviderError(error)` returns true and triggers fallback.
    expect(primary.listenerCount('error')).toBe(0);
    expect(fallback.listenerCount('error')).toBe(0);

    const response = await manager.complete(TEST_REQUEST, 'openai');
    expect(response.content).toBe('fallback-pong');
    expect(response.id).toBe('fallback-1');

    primary.destroy();
    fallback.destroy();
    manager.destroy();
  });
});
