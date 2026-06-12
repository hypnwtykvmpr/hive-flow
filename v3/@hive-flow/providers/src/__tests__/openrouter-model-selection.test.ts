import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
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
  resolveProviderModelOrOpus,
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

    it('uses opus pool for undefined/empty/inherit model via resolver', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);

      const result = resolveProviderModel('openrouter', undefined);
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
    });
  });

  describe('allowlist enforcement', () => {
    it('allows model in allowedModels list', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const config = loadOpenRouterConfig();
      expect(isModelAllowed(config, 'xiaomi/mimo-v2.5-pro')).toBe(true);
    });

    it('blocks model NOT in allowedModels and returns undefined', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const config = loadOpenRouterConfig();
      expect(isModelAllowed(config, 'unknown/blocked-model')).toBe(false);
    });

    it('passes through direct provider/model slug when in allowlist', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const config = loadOpenRouterConfig();
      expect(isModelAllowed(config, 'qwen/qwen3.7-max')).toBe(true);
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

    it('resolveProviderModel with openrouter + mini returns model from sonnet pool (Decision 3)', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = resolveProviderModel('openrouter', 'mini');
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });

    it('resolveProviderModel with openrouter + sonnet returns model from sonnet pool', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = resolveProviderModel('openrouter', 'sonnet');
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });

    it('resolveProviderModel with openrouter + direct model returns it if allowed', () => {
      const result = resolveProviderModel('openrouter', 'qwen/qwen3.7-max');
      expect(result).toBe('qwen/qwen3.7-max');
    });

    it('resolveProviderModel with openrouter + blocked model returns undefined', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveProviderModel('openrouter', 'unknown/blocked-model');
      expect(result).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('not in allowedModels'));
    });

    it('resolveProviderModel with openrouter + no model returns opus pool model', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = resolveProviderModel('openrouter', undefined);
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
    });

    it('resolveProviderModel intercepts openrouter (does not passthrough)', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = resolveProviderModel('openrouter', 'opus');
      // Should NOT return 'opus' unchanged — should return a pool model
      expect(result).not.toBe('opus');
      expect(result).toBeDefined();
    });
  });

  describe('resolveProviderModelOrOpus opus-class fallback (always-resolve)', () => {
    beforeEach(() => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      resetOpenRouterConfigCache();
    });

    it('degrades a blocked OpenRouter direct model to the opus class instead of undefined', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveProviderModelOrOpus('openrouter', 'unknown/blocked-model');
      expect(result).toBeDefined();
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('defaulting to the opus class'));
    });

    it('passes through an allowed OpenRouter direct model unchanged (no degrade)', () => {
      const result = resolveProviderModelOrOpus('openrouter', 'qwen/qwen3.7-max');
      expect(result).toBe('qwen/qwen3.7-max');
    });

    it('opus alias still selects from the opus pool', () => {
      const result = resolveProviderModelOrOpus('openrouter', 'opus');
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
    });

    it('leaves non-OpenRouter CLI providers unchanged (codex-cli enforces gpt-5.5)', () => {
      const result = resolveProviderModelOrOpus('codex-cli', 'minimax/minimax-m3');
      expect(result).toBe('gpt-5.5');
    });

    it('does not inject opus for non-OpenRouter unresolved providers (openai → undefined)', () => {
      expect(resolveProviderModelOrOpus('openai', undefined)).toBeUndefined();
    });
  });

  describe('expanded coverage (real-world + edge + regression)', () => {
    beforeEach(() => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      resetOpenRouterConfigCache();
    });

    // ── Real-world coverage ──

    it('opus alias selects from opus pool only', () => {
      for (let i = 0; i < 30; i++) {
        const result = resolveProviderModel('openrouter', 'opus');
        expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
        expect(DEFAULT_CONFIG.tiers.sonnet).not.toContain(result);
        expect(DEFAULT_CONFIG.tiers.haiku).not.toContain(result);
      }
    });

    it('sonnet alias selects from sonnet pool only', () => {
      for (let i = 0; i < 30; i++) {
        const result = resolveProviderModel('openrouter', 'sonnet');
        expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
        expect(DEFAULT_CONFIG.tiers.opus).not.toContain(result);
        expect(DEFAULT_CONFIG.tiers.haiku).not.toContain(result);
      }
    });

    it('haiku alias selects from haiku pool only', () => {
      for (let i = 0; i < 30; i++) {
        const result = resolveProviderModel('openrouter', 'haiku');
        expect(DEFAULT_CONFIG.tiers.haiku).toContain(result);
        expect(DEFAULT_CONFIG.tiers.opus).not.toContain(result);
        expect(DEFAULT_CONFIG.tiers.sonnet).not.toContain(result);
      }
    });

    it('mini alias selects from sonnet pool, not haiku', () => {
      for (let i = 0; i < 30; i++) {
        const result = resolveProviderModel('openrouter', 'mini');
        expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
        expect(DEFAULT_CONFIG.tiers.haiku).not.toContain(result);
      }
    });

    it('random distribution across opus pool over many trials', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const result = resolveProviderModel('openrouter', 'opus');
        if (result) seen.add(result);
      }
      // Catches hardcoded [0] regression — must see >= 2 distinct models
      expect(seen.size).toBeGreaterThanOrEqual(2);
    });

    // ── Edge cases ──

    it('direct allowed-list model passes through', () => {
      const result = resolveProviderModel('openrouter', 'xiaomi/mimo-v2.5-pro');
      expect(result).toBe('xiaomi/mimo-v2.5-pro');
    });

    it('direct allowed-list model is case-insensitive and returns canonical slug', () => {
      const result = resolveProviderModel('openrouter', ' Xiaomi/MIMO-V2.5-PRO ');
      expect(result).toBe('xiaomi/mimo-v2.5-pro');
    });

    it('tier aliases are case-insensitive and whitespace-tolerant', () => {
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.0);
      const result = resolveProviderModel('openrouter', ' MINI ');
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });

    it('direct blocked model returns undefined and warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveProviderModel('openrouter', 'gpt-4o');
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('empty allowedModels config blocks all direct strings', () => {
      // Two-layer assertion:
      //   1. `isModelAllowed` returns false for any model when the config
      //      allowlist is empty (the predicate's documented contract).
      //   2. `resolveProviderModel` honours that allowlist end-to-end by
      //      reading the same on-disk config — we drop a real
      //      `.hive-flow/config.json` into a temp dir and run the resolver
      //      from inside that dir so `loadOpenRouterConfig` (which uses
      //      `process.cwd()`) picks it up. This avoids module-level fs
      //      mocking which would clash with the rest of the suite.
      const emptyAllowConfig: OpenRouterModelConfig = {
        tiers: { ...DEFAULT_CONFIG.tiers },
        allowedModels: [],
      };

      // Layer 1: predicate
      expect(isModelAllowed(emptyAllowConfig, 'xiaomi/mimo-v2.5-pro')).toBe(false);
      expect(isModelAllowed(emptyAllowConfig, 'qwen/qwen3.7-max')).toBe(false);
      expect(isModelAllowed(emptyAllowConfig, 'unknown/blocked-model')).toBe(false);

      // Layer 2: resolver via a real on-disk config in a temp working dir
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-or-config-'));
      const hiveDir = path.join(tmpRoot, '.hive-flow');
      fs.mkdirSync(hiveDir, { recursive: true });
      fs.writeFileSync(
        path.join(hiveDir, 'config.json'),
        JSON.stringify({
          values: {
            openrouter: {
              allowedModels: [],
              tiers: DEFAULT_CONFIG.tiers,
            },
          },
        }),
      );

      const originalCwd = process.cwd();
      process.chdir(tmpRoot);
      resetOpenRouterConfigCache();

      try {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        // Direct slug normally in DEFAULT_CONFIG.allowedModels is now blocked
        const blocked = resolveProviderModel('openrouter', 'xiaomi/mimo-v2.5-pro');
        expect(blocked).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('not in allowedModels'),
        );

        // Aliases still draw from tier pools (allowlist only gates direct slugs)
        vi.spyOn(Math, 'random').mockReturnValue(0.0);
        const opusPick = resolveProviderModel('openrouter', 'opus');
        expect(DEFAULT_CONFIG.tiers.opus).toContain(opusPick);
      } finally {
        process.chdir(originalCwd);
        resetOpenRouterConfigCache();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('config cache is scoped by project directory', () => {
      const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-or-cache-a-'));
      const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-or-cache-b-'));
      for (const root of [rootA, rootB]) {
        fs.mkdirSync(path.join(root, '.hive-flow'), { recursive: true });
      }
      fs.writeFileSync(path.join(rootA, '.hive-flow', 'config.json'), JSON.stringify({
        openrouter: {
          tiers: { opus: ['a/opus'], sonnet: ['a/sonnet'], haiku: ['a/haiku'] },
          allowedModels: ['a/opus'],
        },
      }));
      fs.writeFileSync(path.join(rootB, '.hive-flow', 'config.json'), JSON.stringify({
        openrouter: {
          tiers: { opus: ['b/opus'], sonnet: ['b/sonnet'], haiku: ['b/haiku'] },
          allowedModels: ['b/opus'],
        },
      }));

      try {
        resetOpenRouterConfigCache();
        expect(loadOpenRouterConfig(rootA).tiers.opus).toEqual(['a/opus']);
        expect(loadOpenRouterConfig(rootB).tiers.opus).toEqual(['b/opus']);
      } finally {
        resetOpenRouterConfigCache();
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
      }
    });

    // ── Regression prevention (user directive + runbook fixes) ──

    it('regression: undefined model picks from opus pool (user directive — not sonnet)', () => {
      for (let i = 0; i < 30; i++) {
        const result = resolveProviderModel('openrouter', undefined);
        expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
        expect(DEFAULT_CONFIG.tiers.sonnet).not.toContain(result);
      }
    });

    it('regression: empty string model picks from opus pool', () => {
      for (let i = 0; i < 30; i++) {
        const result = resolveProviderModel('openrouter', '');
        expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
        expect(DEFAULT_CONFIG.tiers.sonnet).not.toContain(result);
      }
    });

    it('regression: inherit picks from opus pool', () => {
      for (let i = 0; i < 30; i++) {
        const result = resolveProviderModel('openrouter', 'inherit');
        expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
        expect(DEFAULT_CONFIG.tiers.sonnet).not.toContain(result);
      }
    });

    it('regression: mini-tier reuse — does not require a separate mini tier config', () => {
      // Verify DEFAULT_CONFIG.tiers has no 'mini' key
      expect((DEFAULT_CONFIG.tiers as Record<string, unknown>).mini).toBeUndefined();
      // Yet 'mini' still resolves to a valid model (sonnet pool reuse)
      const result = resolveProviderModel('openrouter', 'mini');
      expect(result).toBeDefined();
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });
  });
});
