import { afterEach, describe, expect, it } from 'vitest';
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
  });

  it('capabilities.maxContextLength is 128000 for both models', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-chat' },
      logger: noopLogger,
    });

    expect(provider.capabilities.maxContextLength['deepseek-chat']).toBe(128000);
    expect(provider.capabilities.maxContextLength['deepseek-reasoner']).toBe(128000);
  });

  it('capabilities.maxOutputTokens is 8192 for deepseek-chat', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-chat' },
      logger: noopLogger,
    });

    expect(provider.capabilities.maxOutputTokens['deepseek-chat']).toBe(8192);
  });

  it('capabilities.maxOutputTokens is 32768 for deepseek-reasoner', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-chat' },
      logger: noopLogger,
    });

    expect(provider.capabilities.maxOutputTokens['deepseek-reasoner']).toBe(32768);
  });

  it('supportedModels includes deepseek-chat and deepseek-reasoner', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-chat' },
      logger: noopLogger,
    });

    expect(provider.capabilities.supportedModels).toContain('deepseek-chat');
    expect(provider.capabilities.supportedModels).toContain('deepseek-reasoner');
  });

  it('name is deepseek', () => {
    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-chat' },
      logger: noopLogger,
    });

    expect(provider.name).toBe('deepseek');
  });

  it('health check returns unhealthy without API key', async () => {
    delete process.env.DEEPSEEK_API_KEY;

    const provider = new DeepSeekProvider({
      config: { provider: 'deepseek', model: 'deepseek-chat' },
      logger: noopLogger,
    });

    await provider.initialize();

    const health = await provider.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.error).toBe('DeepSeek API key not configured');
  });
});
