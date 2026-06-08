import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider } from '../deepseek-provider.js';

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('DeepSeekProvider', () => {
  const originalApiKey = process.env.DEEPSEEK_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalApiKey;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('capabilities.maxContextLength is 1M for both models', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      logger: noopLogger,
    });

    expect(provider.capabilities.maxContextLength['deepseek-v4-flash']).toBe(1000000);
    expect(provider.capabilities.maxContextLength['deepseek-v4-pro']).toBe(1000000);
  });

  it('capabilities.maxOutputTokens is 384000 for deepseek-v4-flash', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      logger: noopLogger,
    });

    expect(provider.capabilities.maxOutputTokens['deepseek-v4-flash']).toBe(384000);
  });

  it('capabilities.maxOutputTokens is 384000 for deepseek-v4-pro', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      logger: noopLogger,
    });

    expect(provider.capabilities.maxOutputTokens['deepseek-v4-pro']).toBe(384000);
  });

  it('supportedModels includes deepseek-v4-flash and deepseek-v4-pro', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      logger: noopLogger,
    });

    expect(provider.capabilities.supportedModels).toContain('deepseek-v4-flash');
    expect(provider.capabilities.supportedModels).toContain('deepseek-v4-pro');
  });

  it('name is deepseek', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      logger: noopLogger,
    });

    expect(provider.name).toBe('deepseek');
  });

  it('health check returns unhealthy without API key', async () => {
    delete process.env.DEEPSEEK_API_KEY;

    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      logger: noopLogger,
    });

    await provider.initialize();

    const health = await provider.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.error).toBe('DeepSeek API key not configured');
  });

  it('ignores ambient DEEPSEEK_API_KEY when strict config has no apiKey', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek-secret-that-must-stay-out';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      logger: noopLogger,
    });

    await provider.initialize();

    expect((provider as unknown as { headers?: Record<string, string> }).headers?.Authorization).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
