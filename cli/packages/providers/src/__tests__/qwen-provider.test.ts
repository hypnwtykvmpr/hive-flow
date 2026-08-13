import { afterEach, describe, expect, it, vi } from 'vitest';
import { QwenCLIProvider } from '../qwen-cli-provider.js';
import { QwenProvider } from '../qwen-provider.js';

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('QwenProvider', () => {
  const originalQwenKey = process.env.QWEN_API_KEY;
  const originalDashscopeKey = process.env.DASHSCOPE_API_KEY;

  afterEach(() => {
    if (originalQwenKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = originalQwenKey;
    if (originalDashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = originalDashscopeKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['qwen', QwenProvider],
    ['qwen-cli', QwenCLIProvider],
  ] as const)('%s defaults to the current recommended Qwen model', (_name, Provider) => {
    const provider = new Provider({
      config: { provider: _name, model: undefined as never },
      logger: noopLogger,
    });
    (provider as unknown as { validateConfig(): void }).validateConfig();

    expect(provider.config.model).toBe('qwen3.7-plus');
    expect(provider.capabilities.supportedModels).toContain('qwen3.7-plus');
    expect(provider.capabilities.maxContextLength['qwen3.7-plus']).toBe(1_000_000);
    expect(provider.capabilities.maxOutputTokens['qwen3.7-plus']).toBe(65_536);
    expect(provider.capabilities.pricing['qwen3.7-plus']).toMatchObject({
      promptCostPer1k: 0.0012,
      completionCostPer1k: 0.0048,
      currency: 'USD',
    });
    expect(provider.capabilities.pricing['qwen3.7-max']).toMatchObject({
      promptCostPer1k: 0.0025,
      completionCostPer1k: 0.0075,
      currency: 'USD',
    });
  });

  it('ignores ambient QWEN_API_KEY and DASHSCOPE_API_KEY when strict config has no apiKey', async () => {
    process.env.QWEN_API_KEY = 'sk-qwen-secret-that-must-stay-out';
    process.env.DASHSCOPE_API_KEY = 'sk-dashscope-secret-that-must-stay-out';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    const provider = new QwenProvider({
      config: { provider: 'qwen', model: 'qwen-plus' },
      logger: noopLogger,
    });

    await provider.initialize();

    expect((provider as unknown as { headers?: Record<string, string> }).headers?.Authorization).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
