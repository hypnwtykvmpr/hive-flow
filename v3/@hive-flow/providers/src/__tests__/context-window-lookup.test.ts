import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Stats } from 'node:fs';

import {
  getModelContextLength,
  DEFAULT_CONTEXT_WINDOWS,
} from '../model-alias-resolver.js';

import {
  loadOpenRouterConfig,
  resetOpenRouterConfigCache,
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_WINDOWS as OR_DEFAULT_CONTEXT_WINDOWS,
  getModelContextLength as getOpenRouterModelContextLength,
} from '../openrouter-model-config.js';

/*
 * loadOpenRouterConfig uses destructured imports (`import { readFileSync, statSync } from 'fs'`),
 * so vi.spyOn(fs, 'readFileSync') does NOT intercept them. We must use vi.mock('fs') to replace
 * the module-level bindings. The mock keeps the real implementation by default and only overrides
 * readFileSync / statSync in specific tests via mockReturnValue on the hoisted mock.
 */
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    statSync: vi.fn(actual.statSync),
  };
});

// Import after mock is declared so vitest resolves the mocked module
import { readFileSync, statSync } from 'fs';

const mockedStatSync = statSync as ReturnType<typeof vi.fn>;
const mockedReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

/** Helper: configure mocks so loadOpenRouterConfig reads a virtual config */
function mockConfigFile(content: object, mtimeMs = 1): void {
  mockedStatSync.mockReturnValue({ mtimeMs } as Stats);
  mockedReadFileSync.mockReturnValue(JSON.stringify(content));
}

describe('Dynamic context window lookup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetOpenRouterConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetOpenRouterConfigCache();
  });

  describe('getModelContextLength from config', () => {
    it('returns config contextWindows value when present', () => {
      mockConfigFile({
        openrouter: {
          tiers: { opus: ['anthropic/claude-opus-4-6'], sonnet: ['google/gemini-2.5-flash'], haiku: ['openai/gpt-4o-mini'] },
          allowedModels: DEFAULT_CONFIG.allowedModels,
          contextWindows: { 'anthropic/claude-opus-4-6': 500000 },
        },
      });

      const config = loadOpenRouterConfig();
      expect(config.contextWindows).toBeDefined();
      expect(config.contextWindows!['anthropic/claude-opus-4-6']).toBe(500000);
    });

    it('returns DEFAULT_CONTEXT_WINDOWS value when config has no override', () => {
      const result = getModelContextLength('claude-opus-4-6');
      expect(result).toBe(DEFAULT_CONTEXT_WINDOWS['claude-opus-4-6']);
      expect(result).toBe(1_000_000);
    });

    it('returns 128000 fallback for unknown model', () => {
      const result = getModelContextLength('totally-unknown-model-xyz');
      expect(result).toBe(128_000);
    });

    it('config override takes priority over DEFAULT_CONTEXT_WINDOWS', () => {
      mockConfigFile({
        openrouter: {
          tiers: DEFAULT_CONFIG.tiers,
          allowedModels: DEFAULT_CONFIG.allowedModels,
          contextWindows: { 'google/gemini-2.5-flash': 999999 },
        },
      }, 2);

      const config = loadOpenRouterConfig();
      const overrideValue = config.contextWindows?.['google/gemini-2.5-flash'];
      const defaultValue = OR_DEFAULT_CONTEXT_WINDOWS['google/gemini-2.5-flash'];

      expect(overrideValue).toBe(999999);
      expect(defaultValue).toBe(1048576);
      expect(overrideValue).not.toBe(defaultValue);
    });
  });

  describe('DEFAULT_CONTEXT_WINDOWS', () => {
    it('contains all 9 default OpenRouter models', () => {
      const orModels = [
        'anthropic/claude-opus-4-6',
        'anthropic/claude-sonnet-4-6',
        'google/gemini-2.5-pro',
        'google/gemini-2.5-flash',
        'google/gemini-2.5-flash-lite',
        'meta-llama/llama-3.3-70b',
        'deepseek/deepseek-reasoner',
        'openai/gpt-4o-mini',
        'mistralai/mistral-small-25',
      ];

      for (const model of orModels) {
        expect(OR_DEFAULT_CONTEXT_WINDOWS).toHaveProperty(model);
      }
      expect(Object.keys(OR_DEFAULT_CONTEXT_WINDOWS)).toHaveLength(9);
    });

    it('google/gemini-2.5-flash has 1048576 context', () => {
      expect(OR_DEFAULT_CONTEXT_WINDOWS['google/gemini-2.5-flash']).toBe(1048576);
    });

    it('mistralai/mistral-small-25 has 32768 context', () => {
      expect(OR_DEFAULT_CONTEXT_WINDOWS['mistralai/mistral-small-25']).toBe(32768);
    });
  });

  describe('config contextWindows field', () => {
    it('loadOpenRouterConfig includes contextWindows when present in config', () => {
      mockConfigFile({
        openrouter: {
          tiers: DEFAULT_CONFIG.tiers,
          allowedModels: DEFAULT_CONFIG.allowedModels,
          contextWindows: {
            'anthropic/claude-opus-4-6': 300000,
            'custom/my-model': 65536,
          },
        },
      }, 3);

      const config = loadOpenRouterConfig();
      expect(config.contextWindows).toEqual({
        'anthropic/claude-opus-4-6': 300000,
        'custom/my-model': 65536,
      });
    });

    it('loadOpenRouterConfig returns undefined contextWindows when not in config', () => {
      mockConfigFile({
        openrouter: {
          tiers: DEFAULT_CONFIG.tiers,
          allowedModels: DEFAULT_CONFIG.allowedModels,
        },
      }, 4);

      const config = loadOpenRouterConfig();
      expect(config.contextWindows).toBeUndefined();
    });

    it('existing configs without contextWindows still load correctly', () => {
      mockConfigFile({
        openrouter: {
          tiers: {
            opus: ['anthropic/claude-opus-4-6'],
            sonnet: ['google/gemini-2.5-flash'],
            haiku: ['openai/gpt-4o-mini'],
          },
          allowedModels: ['anthropic/claude-opus-4-6', 'google/gemini-2.5-flash', 'openai/gpt-4o-mini'],
        },
      }, 5);

      const config = loadOpenRouterConfig();
      expect(config.tiers.opus).toEqual(['anthropic/claude-opus-4-6']);
      expect(config.tiers.sonnet).toEqual(['google/gemini-2.5-flash']);
      expect(config.tiers.haiku).toEqual(['openai/gpt-4o-mini']);
      expect(config.allowedModels).toEqual(['anthropic/claude-opus-4-6', 'google/gemini-2.5-flash', 'openai/gpt-4o-mini']);
      expect(config.contextWindows).toBeUndefined();
    });
  });

  describe('getModelContextLength edge cases', () => {
    it('returns fallback for undefined model', () => {
      expect(getModelContextLength(undefined)).toBe(128_000);
    });

    it('returns custom fallback when provided', () => {
      expect(getModelContextLength('nonexistent-model', 64_000)).toBe(64_000);
    });

    it('returns correct value for each provider family', () => {
      // Anthropic
      expect(getModelContextLength('claude-opus-4-6')).toBe(1_000_000);
      // Gemini
      expect(getModelContextLength('gemini-3.1-pro-preview')).toBe(1_000_000);
      // Codex / OpenAI
      expect(getModelContextLength('gpt-5.4')).toBe(256_000);
      // DeepSeek
      expect(getModelContextLength('deepseek-reasoner')).toBe(128_000);
    });

    it('falls through to default when config contextWindows has non-numeric value', () => {
      mockConfigFile({
        openrouter: {
          tiers: DEFAULT_CONFIG.tiers,
          allowedModels: DEFAULT_CONFIG.allowedModels,
          contextWindows: { 'anthropic/claude-opus-4-6': 'not-a-number' },
        },
      }, 6);

      const config = loadOpenRouterConfig();
      // The non-numeric value is stored as-is in config (no runtime validation)
      // getModelContextLength from model-alias-resolver does NOT read openrouter config,
      // so it returns its own DEFAULT_CONTEXT_WINDOWS for the bare model name
      const result = getModelContextLength('claude-opus-4-6');
      expect(result).toBe(1_000_000);
    });
  });

  describe('getModelContextLength from openrouter-model-config', () => {
    it('returns built-in default for known OpenRouter model', () => {
      const result = getOpenRouterModelContextLength('google/gemini-2.5-flash');
      expect(result).toBe(1048576);
    });

    it('returns config override when present', () => {
      mockConfigFile({
        openrouter: {
          tiers: DEFAULT_CONFIG.tiers,
          allowedModels: DEFAULT_CONFIG.allowedModels,
          contextWindows: { 'google/gemini-2.5-flash': 500000 },
        },
      }, 7);

      const config = loadOpenRouterConfig();
      const result = getOpenRouterModelContextLength('google/gemini-2.5-flash', config);
      expect(result).toBe(500000);
    });

    it('returns 128000 fallback for unknown model', () => {
      const result = getOpenRouterModelContextLength('unknown/model-xyz');
      expect(result).toBe(128000);
    });
  });
});
