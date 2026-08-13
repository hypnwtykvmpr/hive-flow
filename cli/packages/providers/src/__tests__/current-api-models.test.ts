import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicProvider } from '../anthropic-provider.js';
import { CohereProvider, COHERE_DEFAULT_MODEL } from '../cohere-provider.js';
import { CopilotProvider, COPILOT_FALLBACK_MODEL } from '../copilot-provider.js';
import { GoogleProvider } from '../google-provider.js';
import { OpenAIProvider } from '../openai-provider.js';
import { ANTHROPIC_CLI_DEFAULT_MODEL, CODEX_CLI_DEFAULT_MODEL } from '../model-alias-resolver.js';
import type { ILogger } from '../base-provider.js';

const silentLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('current API model catalogs', () => {
  it('advertises the current Anthropic model first while retaining compatibility IDs', () => {
    const provider = new AnthropicProvider({
      config: { provider: 'anthropic', model: ANTHROPIC_CLI_DEFAULT_MODEL },
      logger: silentLogger,
    });

    expect(provider.capabilities.supportedModels[0]).toBe(ANTHROPIC_CLI_DEFAULT_MODEL);
    expect(provider.capabilities.maxContextLength[ANTHROPIC_CLI_DEFAULT_MODEL]).toBe(1_000_000);
    expect(provider.capabilities.maxOutputTokens[ANTHROPIC_CLI_DEFAULT_MODEL]).toBe(128_000);
    expect(provider.capabilities.pricing[ANTHROPIC_CLI_DEFAULT_MODEL]).toMatchObject({
      promptCostPer1k: 0.005,
      completionCostPer1k: 0.025,
    });
    expect(provider.capabilities.supportedModels).toContain('claude-3-5-sonnet-latest');
  });

  it('advertises the current OpenAI model first while retaining compatibility IDs', () => {
    const provider = new OpenAIProvider({
      config: { provider: 'openai', model: CODEX_CLI_DEFAULT_MODEL },
      logger: silentLogger,
    });

    expect(provider.capabilities.supportedModels[0]).toBe(CODEX_CLI_DEFAULT_MODEL);
    expect(provider.capabilities.maxContextLength[CODEX_CLI_DEFAULT_MODEL]).toBe(1_050_000);
    expect(provider.capabilities.maxOutputTokens[CODEX_CLI_DEFAULT_MODEL]).toBe(128_000);
    expect(provider.capabilities.pricing[CODEX_CLI_DEFAULT_MODEL]).toMatchObject({
      promptCostPer1k: 0.005,
      completionCostPer1k: 0.03,
    });
    expect(provider.capabilities.supportedModels).toContain('gpt-4o');
  });

  it('advertises the current stable Gemini API model first while retaining compatibility IDs', () => {
    const provider = new GoogleProvider({
      config: { provider: 'google', model: 'gemini-3.6-flash' },
      logger: silentLogger,
    });

    expect(provider.capabilities.supportedModels[0]).toBe('gemini-3.6-flash');
    expect(provider.capabilities.maxContextLength['gemini-3.6-flash']).toBe(1_048_576);
    expect(provider.capabilities.maxOutputTokens['gemini-3.6-flash']).toBe(65_536);
    expect(provider.capabilities.pricing['gemini-3.6-flash']).toMatchObject({
      promptCostPer1k: 0.0015,
      completionCostPer1k: 0.0075,
    });
    expect(provider.capabilities.supportedModels).toContain('gemini-2.0-flash');
  });

  it('advertises current Cohere models first while retaining legacy compatibility IDs', () => {
    const provider = new CohereProvider({
      config: { provider: 'cohere', model: COHERE_DEFAULT_MODEL },
      logger: silentLogger,
    });

    expect(provider.capabilities.supportedModels.slice(0, 2)).toEqual([
      COHERE_DEFAULT_MODEL,
      'command-a-03-2025',
    ]);
    expect(provider.capabilities.maxContextLength[COHERE_DEFAULT_MODEL]).toBe(128_000);
    expect(provider.capabilities.maxOutputTokens[COHERE_DEFAULT_MODEL]).toBe(64_000);
    expect(provider.capabilities.supportedModels).toContain('command-r-plus');
  });

  it('keeps live Copilot discovery authoritative with a current fallback catalog', async () => {
    const provider = new CopilotProvider({
      config: { provider: 'copilot', model: COPILOT_FALLBACK_MODEL },
      logger: silentLogger,
    });

    expect(provider.capabilities.supportedModels.slice(0, 2)).toEqual([
      COPILOT_FALLBACK_MODEL,
      'gpt-5.4',
    ]);
    expect(provider.capabilities.supportedModels).toContain('gpt-4o');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'account-specific-current-model' }],
    }), { status: 200 })));
    await expect(provider.listModels()).resolves.toEqual(['account-specific-current-model']);
  });
});
