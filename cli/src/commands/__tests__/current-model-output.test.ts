import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_CLI_DEFAULT_MODEL,
  CODEX_CLI_DEFAULT_MODEL,
  COHERE_DEFAULT_MODEL,
  COPILOT_FALLBACK_MODEL,
  GEMINI_API_DEFAULT_MODEL,
  GEMINI_CLI_DEFAULT_MODEL,
  PROVIDER_DEFAULTS,
} from '@hive-flow/providers';
import { output } from '../../output.js';
import { configCommand } from '../config.js';
import { providersCommand } from '../providers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('current model command output', () => {
  it('reports canonical defaults from config providers', async () => {
    vi.spyOn(output, 'printJson').mockImplementation(() => {});
    const command = configCommand.subcommands?.find(subcommand => subcommand.name === 'providers');

    const result = await command?.action({ flags: { format: 'json' }, args: [] } as never);
    const providers = result?.data as Array<{ name: string; model: string }>;

    expect(providers.find(provider => provider.name === 'anthropic')?.model).toBe(ANTHROPIC_CLI_DEFAULT_MODEL);
    expect(providers.find(provider => provider.name === 'openrouter')?.model).toBe(PROVIDER_DEFAULTS.openrouter);
    expect(providers.find(provider => provider.name === 'gemini')?.model).toBe(GEMINI_API_DEFAULT_MODEL);
    expect(providers.find(provider => provider.name === 'ollama')?.model).toBe('(local catalog)');
  });

  it('lists current API and CLI models while keeping compatibility entries', async () => {
    const printTable = vi.spyOn(output, 'printTable').mockImplementation(() => {});
    vi.spyOn(output, 'writeln').mockImplementation(() => {});
    const command = providersCommand.subcommands?.find(subcommand => subcommand.name === 'models');

    await command?.action({ flags: {}, args: [] } as never);
    const table = printTable.mock.calls.at(-1)?.[0];
    const models = table?.data as Array<{ model: string; provider: string }>;

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: ANTHROPIC_CLI_DEFAULT_MODEL, provider: 'Anthropic' }),
      expect.objectContaining({ model: CODEX_CLI_DEFAULT_MODEL, provider: 'OpenAI' }),
      expect.objectContaining({ model: CODEX_CLI_DEFAULT_MODEL, provider: 'Codex CLI' }),
      expect.objectContaining({ model: GEMINI_API_DEFAULT_MODEL, provider: 'Google' }),
      expect.objectContaining({ model: GEMINI_CLI_DEFAULT_MODEL, provider: 'Gemini CLI' }),
      expect.objectContaining({ model: PROVIDER_DEFAULTS.openrouter, provider: 'OpenRouter' }),
      expect.objectContaining({ model: COHERE_DEFAULT_MODEL, provider: 'Cohere' }),
      expect.objectContaining({ model: COPILOT_FALLBACK_MODEL, provider: 'Copilot API' }),
      expect.objectContaining({ model: '(local catalog)', provider: 'Ollama' }),
      expect.objectContaining({ model: 'gpt-4o', provider: 'OpenAI' }),
    ]));
  });
});
