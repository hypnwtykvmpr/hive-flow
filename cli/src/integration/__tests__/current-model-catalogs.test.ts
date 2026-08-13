import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_CLI_DEFAULT_MODEL,
  ANTHROPIC_SONNET_MODEL,
  CODEX_CLI_DEFAULT_MODEL,
  GEMINI_API_DEFAULT_MODEL,
} from '@hive-flow/providers';
import { MultiModelRouter } from '../multi-model-router.js';
import { createDefaultProviders } from '../provider-adapter.js';

describe('integration model catalogs', () => {
  it('routes against current models while retaining compatibility entries', () => {
    const router = new MultiModelRouter();
    const models = router.getModels();
    const ids = models.map(model => model.id);

    expect(ids).toEqual(expect.arrayContaining([
      ANTHROPIC_CLI_DEFAULT_MODEL,
      ANTHROPIC_SONNET_MODEL,
      CODEX_CLI_DEFAULT_MODEL,
      GEMINI_API_DEFAULT_MODEL,
      'gpt-4o',
      'gemini-2.5-flash',
    ]));
    expect(() => router.getEstimatedSavings({ task: 'audit', messages: [{ role: 'user', content: 'hello' }] })).not.toThrow();
    router.shutdown();
  });

  it('publishes current defaults through the provider adapter', () => {
    const providers = createDefaultProviders();
    const anthropic = providers.find(provider => provider.type === 'anthropic');
    const openai = providers.find(provider => provider.type === 'openai');

    expect(anthropic?.models[0]).toMatchObject({
      id: ANTHROPIC_CLI_DEFAULT_MODEL,
      maxContextLength: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(openai?.models[0]).toMatchObject({
      id: CODEX_CLI_DEFAULT_MODEL,
      maxContextLength: 1_050_000,
      maxOutputTokens: 128_000,
    });
    expect(anthropic?.models.map(model => model.id)).toContain('claude-3-5-sonnet-20241022');
    expect(openai?.models.map(model => model.id)).toContain('gpt-4o');
  });
});
