import { afterEach, describe, expect, it, vi } from 'vitest';
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
