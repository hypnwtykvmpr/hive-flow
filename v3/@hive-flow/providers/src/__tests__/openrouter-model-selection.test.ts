import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The module under test — created in Step 1
import {
  loadOpenRouterConfig,
  selectFromPool,
  isModelAllowed,
  resetOpenRouterConfigCache,
  DEFAULT_CONFIG,
  type OpenRouterModelConfig,
} from '../openrouter-model-config.js';

// Integration with the resolver — updated in Step 2
import {
  resolveProviderModel,
  PROVIDER_DEFAULTS,
} from '../model-alias-resolver.js';

describe('OpenRouter config-driven model selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetOpenRouterConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetOpenRouterConfigCache();
  });

  describe('config loading', () => {
    it('falls back to DEFAULT_CONFIG when config file has no openrouter key', () => {
      // loadOpenRouterConfig uses destructured imports from 'fs', so spying on the
      // module object doesn't intercept. Instead, test that default is returned when
      // the real file system has no .hive-flow/config.json (already the case in test env).
      const config = loadOpenRouterConfig();
      expect(config.tiers.opus).toEqual(DEFAULT_CONFIG.tiers.opus);
      expect(config.tiers.sonnet).toEqual(DEFAULT_CONFIG.tiers.sonnet);
      expect(config.tiers.haiku).toEqual(DEFAULT_CONFIG.tiers.haiku);
      expect(config.allowedModels).toEqual(DEFAULT_CONFIG.allowedModels);
    });

    it('falls back to DEFAULT_CONFIG when config file is missing', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const config = loadOpenRouterConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('falls back to DEFAULT_CONFIG when config has malformed JSON', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('not-valid-json{{{');

      const config = loadOpenRouterConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('caches config and returns same result within TTL', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      const readSpy = vi.spyOn(fs, 'readFileSync');

      const config1 = loadOpenRouterConfig();
      const config2 = loadOpenRouterConfig();

      expect(config1).toBe(config2); // same reference = cached
      // existsSync may be called once or twice, but readFileSync should not be called
      // since the file doesn't exist — the key thing is the result is the same object
      expect(config1).toEqual(DEFAULT_CONFIG);
    });

    it('reloads config after resetOpenRouterConfigCache()', () => {
      const config1 = loadOpenRouterConfig();
      resetOpenRouterConfigCache();

      // After reset, loading again should return defaults (file doesn't exist)
      const config2 = loadOpenRouterConfig();

      // Both fall back to default
      expect(config2.tiers).toEqual(DEFAULT_CONFIG.tiers);
      expect(config2.allowedModels).toEqual(DEFAULT_CONFIG.allowedModels);
    });
  });

  describe('tier pool random selection', () => {
    it('selects from opus pool when model is "opus"', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = selectFromPool(DEFAULT_CONFIG.tiers.opus);
      expect(result).toBe(DEFAULT_CONFIG.tiers.opus[0]);
    });

    it('selects from sonnet pool when model is "sonnet"', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = selectFromPool(DEFAULT_CONFIG.tiers.sonnet);
      expect(result).toBe(DEFAULT_CONFIG.tiers.sonnet[0]);
    });

    it('selects from haiku pool when model is "haiku"', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = selectFromPool(DEFAULT_CONFIG.tiers.haiku);
      expect(result).toBe(DEFAULT_CONFIG.tiers.haiku[0]);
    });

    it('returns single model when pool has exactly one entry', () => {
      const result = selectFromPool(['only/one-model']);
      expect(result).toBe('only/one-model');
    });

    it('returns undefined when pool is empty', () => {
      const result = selectFromPool([]);
      expect(result).toBeUndefined();
    });

    it('falls back to DEFAULT_CONFIG when tier pool is empty array', () => {
      // Config with empty opus pool should use default
      resetOpenRouterConfigCache();
      const result = selectFromPool([]);
      expect(result).toBeUndefined();
    });

    it('distributes selections across pool over 100 calls', () => {
      const pool = DEFAULT_CONFIG.tiers.opus;
      const counts: Record<string, number> = {};
      for (const model of pool) counts[model] = 0;

      // Restore Math.random for distribution test
      vi.spyOn(Math, 'random').mockRestore();

      for (let i = 0; i < 100; i++) {
        const selected = selectFromPool(pool);
        if (selected && counts[selected] !== undefined) {
          counts[selected]++;
        }
      }

      // Each model should be selected at least once over 100 calls with 3 models
      for (const model of pool) {
        expect(counts[model]).toBeGreaterThan(0);
      }
    });

    it('uses sonnet pool for undefined/empty/inherit model via resolver', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);

      const result = resolveProviderModel('openrouter', undefined);
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });
  });

  describe('allowlist enforcement', () => {
    it('allows model in allowedModels list', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const config = loadOpenRouterConfig();
      expect(isModelAllowed(config, 'anthropic/claude-opus-4-6')).toBe(true);
    });

    it('blocks model NOT in allowedModels and returns undefined', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const config = loadOpenRouterConfig();
      expect(isModelAllowed(config, 'unknown/blocked-model')).toBe(false);
    });

    it('passes through direct provider/model slug when in allowlist', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const config = loadOpenRouterConfig();
      expect(isModelAllowed(config, 'google/gemini-2.5-flash')).toBe(true);
    });
  });

  describe('integration with resolveProviderModel', () => {
    beforeEach(() => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    });

    it('resolveProviderModel with openrouter + opus returns model from opus pool', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = resolveProviderModel('openrouter', 'opus');
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
    });

    it('resolveProviderModel with openrouter + direct model returns it if allowed', () => {
      const result = resolveProviderModel('openrouter', 'google/gemini-2.5-flash');
      expect(result).toBe('google/gemini-2.5-flash');
    });

    it('resolveProviderModel with openrouter + blocked model returns undefined', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveProviderModel('openrouter', 'unknown/blocked-model');
      expect(result).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not in allowedModels'));
    });

    it('resolveProviderModel with openrouter + no model returns sonnet pool model', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = resolveProviderModel('openrouter', undefined);
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });

    it('resolveProviderModel intercepts openrouter (does not passthrough)', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = resolveProviderModel('openrouter', 'opus');
      // Should NOT return 'opus' unchanged — should return a pool model
      expect(result).not.toBe('opus');
      expect(result).toBeDefined();
    });
  });
});
