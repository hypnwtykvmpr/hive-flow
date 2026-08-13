import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveProviderModel,
  PROVIDER_ALIAS_MAP,
  PROVIDER_DEFAULTS,
  KNOWN_PROVIDER_MODELS,
  CLAUDE_ALIASES,
} from '../model-alias-resolver.js';
import { DEFAULT_CONFIG } from '../openrouter-model-config.js';

describe('current provider defaults (2026-08)', () => {
  const expectedDefaults = {
    'anthropic-cli': 'claude-opus-5',
    'gemini-cli': 'gemini-3.6-flash-high',
    'codex-cli': 'gpt-5.6-sol',
  } as const;

  for (const [provider, model] of Object.entries(expectedDefaults)) {
    it(`${provider} resolves its default and flagship alias to the current model`, () => {
      expect(PROVIDER_DEFAULTS[provider as keyof typeof expectedDefaults]).toBe(model);
      expect(KNOWN_PROVIDER_MODELS[provider as keyof typeof expectedDefaults].has(model)).toBe(true);
      expect(resolveProviderModel(provider, 'opus')).toBe(model);
      expect(resolveProviderModel(provider, 'inherit')).toBe(model);
    });
  }
});

describe('resolveProviderModel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Claude alias mapping', () => {
    it('maps opus to gemini-3.6-flash-high for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'opus')).toBe('gemini-3.6-flash-high');
    });

    it('maps sonnet to gemini-3.6-flash-high for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'sonnet')).toBe('gemini-3.6-flash-high');
    });

    it('maps haiku to gemini-3.6-flash-high for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'haiku')).toBe('gemini-3.6-flash-high');
    });

    it('maps opus to gpt-5.6-sol for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'opus')).toBe('gpt-5.6-sol');
    });

    it('maps sonnet to gpt-5.6-sol for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'sonnet')).toBe('gpt-5.6-sol');
    });

    it('maps haiku to gpt-5.6-sol for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'haiku')).toBe('gpt-5.6-sol');
    });

    it('maps inherit to the enforced Codex default', () => {
      // codex-cli enforces gpt-5.6-sol regardless of input
      expect(resolveProviderModel('codex-cli', 'inherit')).toBe('gpt-5.6-sol');
    });

    it('maps mini to claude-sonnet-5 for anthropic-cli', () => {
      expect(resolveProviderModel('anthropic-cli', 'mini')).toBe('claude-sonnet-5');
    });

    it('maps mini to gpt-5.6-sol for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'mini')).toBe('gpt-5.6-sol');
    });

    it('maps mini to auto for cursor-cli', () => {
      expect(resolveProviderModel('cursor-cli', 'mini')).toBe('auto');
    });

    it('maps mini to deepseek-v4-flash for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'mini')).toBe('deepseek-v4-flash');
    });

    it('maps mini to the local default for lm-studio', () => {
      expect(resolveProviderModel('lm-studio', 'mini')).toBe('local-model');
    });

    it('maps mini to gemini-3.6-flash-high for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'mini')).toBe('gemini-3.6-flash-high');
    });

    it('maps all aliases to auto for cursor-cli', () => {
      expect(resolveProviderModel('cursor-cli', 'opus')).toBe('auto');
      expect(resolveProviderModel('cursor-cli', 'sonnet')).toBe('auto');
      expect(resolveProviderModel('cursor-cli', 'haiku')).toBe('auto');
    });
  });

  describe('DeepSeek alias mapping', () => {
    it('maps opus to deepseek-v4-pro for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'opus')).toBe('deepseek-v4-pro');
    });

    it('maps sonnet to deepseek-v4-pro for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'sonnet')).toBe('deepseek-v4-pro');
    });

    it('maps haiku to deepseek-v4-flash for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'haiku')).toBe('deepseek-v4-flash');
    });

    it('maps inherit to deepseek-v4-pro for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'inherit')).toBe('deepseek-v4-pro');
    });

    it('returns deepseek-v4-pro as default for undefined model', () => {
      expect(resolveProviderModel('deepseek', undefined)).toBe('deepseek-v4-pro');
    });

    it('passes through known deepseek model names', () => {
      expect(resolveProviderModel('deepseek', 'deepseek-v4-pro')).toBe('deepseek-v4-pro');
      expect(resolveProviderModel('deepseek', 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
    });
  });

  describe('provider defaults (no model specified)', () => {
    it('returns gemini-3.6-flash-high for gemini-cli with undefined model', () => {
      expect(resolveProviderModel('gemini-cli', undefined)).toBe('gemini-3.6-flash-high');
    });

    it('returns gpt-5.6-sol for codex-cli with undefined model (enforcement, not undefined)', () => {
      expect(resolveProviderModel('codex-cli', undefined)).toBe('gpt-5.6-sol');
    });

    it('returns auto for cursor-cli with undefined model', () => {
      expect(resolveProviderModel('cursor-cli', undefined)).toBe('auto');
    });

    it('returns provider default for empty string model', () => {
      expect(resolveProviderModel('gemini-cli', '')).toBe('gemini-3.6-flash-high');
    });

    it('returns local-model for lm-studio with undefined or empty model', () => {
      expect(resolveProviderModel('lm-studio', undefined)).toBe('local-model');
      expect(resolveProviderModel('lm-studio', '')).toBe('local-model');
    });
  });

  describe('auto model handling', () => {
    it('maps auto to provider default for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'auto')).toBe('gemini-3.6-flash-high');
    });

    it('maps auto to gpt-5.6-sol for codex-cli (model input ignored)', () => {
      expect(resolveProviderModel('codex-cli', 'auto')).toBe('gpt-5.6-sol');
    });

    it('maps auto to auto for cursor-cli', () => {
      expect(resolveProviderModel('cursor-cli', 'auto')).toBe('auto');
    });
  });

  describe('provider-hardcoded enforcement (no passthrough)', () => {
    it('returns gpt-5.6-sol for codex-cli regardless of input model', () => {
      expect(resolveProviderModel('codex-cli', 'gpt-5.3-codex')).toBe('gpt-5.6-sol');
      expect(resolveProviderModel('codex-cli', 'gpt-5.4')).toBe('gpt-5.6-sol');
      expect(resolveProviderModel('codex-cli', 'gemini-2.5-pro')).toBe('gpt-5.6-sol');
      expect(resolveProviderModel('codex-cli', 'some-unknown-model')).toBe('gpt-5.6-sol');
    });

    it('returns gemini-3.6-flash-high for gemini-cli regardless of input model', () => {
      expect(resolveProviderModel('gemini-cli', 'gemini-2.5-pro')).toBe('gemini-3.6-flash-high');
      expect(resolveProviderModel('gemini-cli', 'gemini-3-flash-preview')).toBe('gemini-3.6-flash-high');
      expect(resolveProviderModel('gemini-cli', 'gpt-5.3-codex')).toBe('gemini-3.6-flash-high');
      expect(resolveProviderModel('gemini-cli', 'some-unknown-model')).toBe('gemini-3.6-flash-high');
    });

    it('returns auto for cursor-cli regardless of input model', () => {
      expect(resolveProviderModel('cursor-cli', 'composer-1.5')).toBe('auto');
      expect(resolveProviderModel('cursor-cli', 'gpt-5.3-codex-xhigh')).toBe('auto');
      expect(resolveProviderModel('cursor-cli', 'some-unknown-model')).toBe('auto');
    });

    it('passes through exact local model ids for lm-studio', () => {
      expect(resolveProviderModel('lm-studio', 'llama-3.2-3b-instruct')).toBe('llama-3.2-3b-instruct');
      expect(resolveProviderModel('lm-studio', 'local/qwen3')).toBe('local/qwen3');
    });
  });

  describe('provider-native model passthrough (legacy — now enforced)', () => {
    it('codex-cli always returns gpt-5.6-sol (enforcement overrides passthrough)', () => {
      expect(resolveProviderModel('codex-cli', 'gpt-5.3-codex')).toBe('gpt-5.6-sol');
    });

    it('gemini-cli always returns gemini-3.6-flash-high (enforcement overrides passthrough)', () => {
      expect(resolveProviderModel('gemini-cli', 'gemini-2.5-pro')).toBe('gemini-3.6-flash-high');
    });

    it('cursor-cli always returns auto (enforcement overrides passthrough)', () => {
      expect(resolveProviderModel('cursor-cli', 'composer-1.5')).toBe('auto');
    });
  });

  describe('cross-provider model detection (enforcement — no warnings needed)', () => {
    it('returns gpt-5.6-sol when gemini model used with codex provider', () => {
      const result = resolveProviderModel('codex-cli', 'gemini-2.5-pro');
      expect(result).toBe('gpt-5.6-sol'); // codex enforcement (not undefined)
    });

    it('returns gemini-3.6-flash-high when codex model used with gemini provider', () => {
      const result = resolveProviderModel('gemini-cli', 'gpt-5.3-codex');
      expect(result).toBe('gemini-3.6-flash-high'); // gemini enforcement
    });
  });

  describe('non-CLI provider passthrough', () => {
    it('passes model through for non-CLI providers', () => {
      expect(resolveProviderModel('anthropic', 'haiku')).toBe('haiku');
    });

    it('passes model through when provider is undefined', () => {
      expect(resolveProviderModel(undefined, 'haiku')).toBe('haiku');
    });

    it('passes undefined model through for non-CLI providers', () => {
      expect(resolveProviderModel('openai', undefined)).toBeUndefined();
    });
  });

  describe('unknown model handling (enforcement — no passthrough)', () => {
    it('returns enforced model, not unknown string', () => {
      const result = resolveProviderModel('gemini-cli', 'some-unknown-model');
      expect(result).toBe('gemini-3.6-flash-high'); // enforced, not passed through
    });
  });

  describe('exports', () => {
    it('exports CLAUDE_ALIASES with correct values (including mini)', () => {
      expect(CLAUDE_ALIASES).toContain('haiku');
      expect(CLAUDE_ALIASES).toContain('sonnet');
      expect(CLAUDE_ALIASES).toContain('opus');
      expect(CLAUDE_ALIASES).toContain('inherit');
      expect(CLAUDE_ALIASES).toContain('mini');
    });

    it('exports PROVIDER_ALIAS_MAP for all CLI providers', () => {
      expect(PROVIDER_ALIAS_MAP).toHaveProperty('gemini-cli');
      expect(PROVIDER_ALIAS_MAP).toHaveProperty('codex-cli');
      expect(PROVIDER_ALIAS_MAP).toHaveProperty('cursor-cli');
      expect(PROVIDER_ALIAS_MAP).toHaveProperty('deepseek');
      expect(PROVIDER_ALIAS_MAP).toHaveProperty('lm-studio');
    });

    it('exports KNOWN_PROVIDER_MODELS as Sets', () => {
      expect(KNOWN_PROVIDER_MODELS['gemini-cli']).toBeInstanceOf(Set);
      expect(KNOWN_PROVIDER_MODELS['codex-cli']).toBeInstanceOf(Set);
      expect(KNOWN_PROVIDER_MODELS['cursor-cli']).toBeInstanceOf(Set);
      expect(KNOWN_PROVIDER_MODELS['deepseek']).toBeInstanceOf(Set);
      expect(KNOWN_PROVIDER_MODELS['lm-studio']).toBeInstanceOf(Set);
      expect(KNOWN_PROVIDER_MODELS['lm-studio'].has('local-model')).toBe(true);
    });

    it('exports lm-studio as a provider default', () => {
      expect(PROVIDER_DEFAULTS['lm-studio']).toBe('local-model');
    });
  });

  describe('OpenRouter provider mapping', () => {
    it('includes openrouter in PROVIDER_ALIAS_MAP', () => {
      expect(PROVIDER_ALIAS_MAP).toHaveProperty('openrouter');
    });

    it('includes openrouter in KNOWN_PROVIDER_MODELS', () => {
      expect(KNOWN_PROVIDER_MODELS).toHaveProperty('openrouter');
      expect(KNOWN_PROVIDER_MODELS['openrouter']).toBeInstanceOf(Set);
    });

    it('includes openrouter in PROVIDER_DEFAULTS', () => {
      expect(PROVIDER_DEFAULTS).toHaveProperty('openrouter');
      expect(typeof PROVIDER_DEFAULTS['openrouter']).toBe('string');
    });

    it('returns opus-tier model for openrouter when no model specified', async () => {
      // OpenRouter default tier is now opus (per user directive)
      const result = resolveProviderModel('openrouter', undefined);
      // Should return a model from the opus tier pool (MiniMax M3 is first by default)
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      // Verify it's in the opus pool using dynamic import (ESM)
      const { loadOpenRouterConfig } = await import('../openrouter-model-config.js');
      const config = loadOpenRouterConfig();
      expect(config.tiers.opus).toContain(result);
    });
  });

  describe('expanded coverage (real-world + edge + regression)', () => {
    // ── Real-world coverage: every provider × every alias ──

    // anthropic-cli (5)
    it('real-world: anthropic-cli + opus → claude-opus-5', () => {
      expect(resolveProviderModel('anthropic-cli', 'opus')).toBe('claude-opus-5');
    });
    it('real-world: anthropic-cli + sonnet → claude-sonnet-5', () => {
      expect(resolveProviderModel('anthropic-cli', 'sonnet')).toBe('claude-sonnet-5');
    });
    it('real-world: anthropic-cli + haiku → claude-sonnet-5', () => {
      expect(resolveProviderModel('anthropic-cli', 'haiku')).toBe('claude-sonnet-5');
    });
    it('real-world: anthropic-cli + mini → claude-sonnet-5', () => {
      expect(resolveProviderModel('anthropic-cli', 'mini')).toBe('claude-sonnet-5');
    });
    it('real-world: anthropic-cli + inherit → claude-opus-5', () => {
      expect(resolveProviderModel('anthropic-cli', 'inherit')).toBe('claude-opus-5');
    });

    // gemini-cli (5)
    it('real-world: gemini-cli + opus → gemini-3.6-flash-high', () => {
      expect(resolveProviderModel('gemini-cli', 'opus')).toBe('gemini-3.6-flash-high');
    });
    it('real-world: gemini-cli + sonnet → gemini-3.6-flash-high', () => {
      expect(resolveProviderModel('gemini-cli', 'sonnet')).toBe('gemini-3.6-flash-high');
    });
    it('real-world: gemini-cli + haiku → gemini-3.6-flash-high', () => {
      expect(resolveProviderModel('gemini-cli', 'haiku')).toBe('gemini-3.6-flash-high');
    });
    it('real-world: gemini-cli + mini → gemini-3.6-flash-high', () => {
      expect(resolveProviderModel('gemini-cli', 'mini')).toBe('gemini-3.6-flash-high');
    });
    it('real-world: gemini-cli + inherit → gemini-3.6-flash-high', () => {
      expect(resolveProviderModel('gemini-cli', 'inherit')).toBe('gemini-3.6-flash-high');
    });

    // codex-cli (5)
    it('real-world: codex-cli + opus → gpt-5.6-sol', () => {
      expect(resolveProviderModel('codex-cli', 'opus')).toBe('gpt-5.6-sol');
    });
    it('real-world: codex-cli + sonnet → gpt-5.6-sol', () => {
      expect(resolveProviderModel('codex-cli', 'sonnet')).toBe('gpt-5.6-sol');
    });
    it('real-world: codex-cli + haiku → gpt-5.6-sol', () => {
      expect(resolveProviderModel('codex-cli', 'haiku')).toBe('gpt-5.6-sol');
    });
    it('real-world: codex-cli + mini → gpt-5.6-sol', () => {
      expect(resolveProviderModel('codex-cli', 'mini')).toBe('gpt-5.6-sol');
    });
    it('real-world: codex-cli + inherit → gpt-5.6-sol', () => {
      expect(resolveProviderModel('codex-cli', 'inherit')).toBe('gpt-5.6-sol');
    });

    // cursor-cli (5)
    it('real-world: cursor-cli + opus → auto', () => {
      expect(resolveProviderModel('cursor-cli', 'opus')).toBe('auto');
    });
    it('real-world: cursor-cli + sonnet → auto', () => {
      expect(resolveProviderModel('cursor-cli', 'sonnet')).toBe('auto');
    });
    it('real-world: cursor-cli + haiku → auto', () => {
      expect(resolveProviderModel('cursor-cli', 'haiku')).toBe('auto');
    });
    it('real-world: cursor-cli + mini → auto', () => {
      expect(resolveProviderModel('cursor-cli', 'mini')).toBe('auto');
    });
    it('real-world: cursor-cli + inherit → auto', () => {
      expect(resolveProviderModel('cursor-cli', 'inherit')).toBe('auto');
    });

    // deepseek (5)
    it('real-world: deepseek + opus → deepseek-v4-pro', () => {
      expect(resolveProviderModel('deepseek', 'opus')).toBe('deepseek-v4-pro');
    });
    it('real-world: deepseek + sonnet → deepseek-v4-pro', () => {
      expect(resolveProviderModel('deepseek', 'sonnet')).toBe('deepseek-v4-pro');
    });
    it('real-world: deepseek + haiku → deepseek-v4-flash', () => {
      expect(resolveProviderModel('deepseek', 'haiku')).toBe('deepseek-v4-flash');
    });
    it('real-world: deepseek + mini → deepseek-v4-flash', () => {
      expect(resolveProviderModel('deepseek', 'mini')).toBe('deepseek-v4-flash');
    });
    it('real-world: deepseek + inherit → deepseek-v4-pro', () => {
      expect(resolveProviderModel('deepseek', 'inherit')).toBe('deepseek-v4-pro');
    });

    // lm-studio (5): aliases collapse to a local placeholder, exact ids pass through.
    it('real-world: lm-studio + opus → local-model', () => {
      expect(resolveProviderModel('lm-studio', 'opus')).toBe('local-model');
    });
    it('real-world: lm-studio + sonnet → local-model', () => {
      expect(resolveProviderModel('lm-studio', 'sonnet')).toBe('local-model');
    });
    it('real-world: lm-studio + haiku → local-model', () => {
      expect(resolveProviderModel('lm-studio', 'haiku')).toBe('local-model');
    });
    it('real-world: lm-studio + mini → local-model', () => {
      expect(resolveProviderModel('lm-studio', 'mini')).toBe('local-model');
    });
    it('real-world: lm-studio + inherit → local-model', () => {
      expect(resolveProviderModel('lm-studio', 'inherit')).toBe('local-model');
    });

    // openrouter (5)
    it('real-world: openrouter + opus → from opus pool', () => {
      const result = resolveProviderModel('openrouter', 'opus');
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
    });
    it('real-world: openrouter + sonnet → from sonnet pool', () => {
      const result = resolveProviderModel('openrouter', 'sonnet');
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });
    it('real-world: openrouter + haiku → from haiku pool', () => {
      const result = resolveProviderModel('openrouter', 'haiku');
      expect(DEFAULT_CONFIG.tiers.haiku).toContain(result);
    });
    it('real-world: openrouter + mini → from sonnet pool', () => {
      const result = resolveProviderModel('openrouter', 'mini');
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });
    it('real-world: openrouter + inherit → from opus pool', () => {
      const result = resolveProviderModel('openrouter', 'inherit');
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
    });

    // ── Edge cases ──

    // Case-insensitive matching for anthropic-cli legacy names
    it('edge: anthropic-cli case-insensitive match → CLAUDE-3-5-SONNET-20241022 → claude-sonnet-5', () => {
      expect(resolveProviderModel('anthropic-cli', 'CLAUDE-3-5-SONNET-20241022')).toBe('claude-sonnet-5');
    });
    // FIX-A1: arbitrary strings containing 'mini' (e.g. cross-provider model
    // names like 'gpt-5-codex-mini') no longer leak into anthropic-cli's
    // sonnet bucket. Only exact aliases or 'claude-'-prefixed legacy names
    // route to claude-sonnet-5; everything else falls through to the
    // opus default.
    it('edge: anthropic-cli ignores stray "mini" in unrelated name → Mini-Some-Model → claude-opus-5 (default)', () => {
      expect(resolveProviderModel('anthropic-cli', 'Mini-Some-Model')).toBe('claude-opus-5');
    });
    it('edge: anthropic-cli blocks cross-provider leak → gpt-5-codex-mini → claude-opus-5 (default)', () => {
      expect(resolveProviderModel('anthropic-cli', 'gpt-5-codex-mini')).toBe('claude-opus-5');
    });

    // Case-insensitive matching for deepseek legacy names
    it('edge: deepseek case-insensitive match → DeepSeek-FLASH-2 → deepseek-v4-flash', () => {
      expect(resolveProviderModel('deepseek', 'DeepSeek-FLASH-2')).toBe('deepseek-v4-flash');
    });
    // FIX-A1: arbitrary strings containing 'mini' or 'flash' (e.g.
    // 'gemini-2.5-flash') no longer leak into deepseek's flash bucket.
    // Only exact aliases or 'deepseek-'-prefixed legacy names route to
    // deepseek-v4-flash; everything else falls through to the pro default.
    it('edge: deepseek ignores stray "mini" in unrelated name → X-MINI-Y → deepseek-v4-pro (default)', () => {
      expect(resolveProviderModel('deepseek', 'X-MINI-Y')).toBe('deepseek-v4-pro');
    });
    it('edge: deepseek blocks cross-provider leak → gemini-2.5-flash → deepseek-v4-pro (default)', () => {
      expect(resolveProviderModel('deepseek', 'gemini-2.5-flash')).toBe('deepseek-v4-pro');
    });

    // Empty-string model for each CLI provider
    it('edge: anthropic-cli + empty string → claude-opus-5', () => {
      expect(resolveProviderModel('anthropic-cli', '')).toBe('claude-opus-5');
    });
    it('edge: deepseek + empty string → deepseek-v4-pro', () => {
      expect(resolveProviderModel('deepseek', '')).toBe('deepseek-v4-pro');
    });
    it('edge: gemini-cli + empty string → gemini-3.6-flash-high', () => {
      expect(resolveProviderModel('gemini-cli', '')).toBe('gemini-3.6-flash-high');
    });
    it('edge: codex-cli + empty string → gpt-5.6-sol', () => {
      expect(resolveProviderModel('codex-cli', '')).toBe('gpt-5.6-sol');
    });
    it('edge: cursor-cli + empty string → auto', () => {
      expect(resolveProviderModel('cursor-cli', '')).toBe('auto');
    });
    it('edge: openrouter + empty string → opus pool selection', () => {
      const result = resolveProviderModel('openrouter', '');
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
    });
    it('edge: openrouter + uppercase/whitespace mini → sonnet pool selection', () => {
      const result = resolveProviderModel('openrouter', ' MINI ');
      expect(DEFAULT_CONFIG.tiers.sonnet).toContain(result);
    });
    it('edge: openrouter + uppercase direct model → canonical allowlist slug', () => {
      expect(resolveProviderModel('openrouter', ' Xiaomi/MIMO-V2.5-PRO ')).toBe('xiaomi/mimo-v2.5-pro');
    });

    it('DO-NOT-REVERT: OpenRouter default and human-selected model pins stay on current slugs', () => {
      expect(PROVIDER_DEFAULTS.openrouter).toBe('minimax/minimax-m3');
      expect(KNOWN_PROVIDER_MODELS.openrouter.has('minimax/minimax-m3')).toBe(true);
      expect(KNOWN_PROVIDER_MODELS.openrouter.has('x-ai/grok-4.3')).toBe(true);
      expect(KNOWN_PROVIDER_MODELS.openrouter.has('qwen/qwen3.7-plus')).toBe(true);
      expect(KNOWN_PROVIDER_MODELS.openrouter.has('z-ai/glm-5.2')).toBe(true);
      expect(KNOWN_PROVIDER_MODELS.openrouter.has('z-ai/glm-5.1')).toBe(false);
      expect(KNOWN_PROVIDER_MODELS.openrouter.has('qwen/qwen3.7-max')).toBe(false);
      expect(resolveProviderModel('openrouter', 'qwen/qwen3.7-plus')).toBe('qwen/qwen3.7-plus');
      expect(resolveProviderModel('openrouter', 'z-ai/glm-5.2')).toBe('z-ai/glm-5.2');
      expect(resolveProviderModel('openrouter', 'z-ai/glm-5.1')).toBeUndefined();
    });

    // Undefined model for each CLI provider
    it('edge: anthropic-cli + undefined → claude-opus-5', () => {
      expect(resolveProviderModel('anthropic-cli', undefined)).toBe('claude-opus-5');
    });
    it('edge: deepseek + undefined → deepseek-v4-pro', () => {
      expect(resolveProviderModel('deepseek', undefined)).toBe('deepseek-v4-pro');
    });
    it('edge: gemini-cli + undefined → gemini-3.6-flash-high', () => {
      expect(resolveProviderModel('gemini-cli', undefined)).toBe('gemini-3.6-flash-high');
    });
    it('edge: codex-cli + undefined → gpt-5.6-sol', () => {
      expect(resolveProviderModel('codex-cli', undefined)).toBe('gpt-5.6-sol');
    });
    it('edge: cursor-cli + undefined → auto', () => {
      expect(resolveProviderModel('cursor-cli', undefined)).toBe('auto');
    });
    it('edge: openrouter + undefined → opus pool selection', () => {
      const result = resolveProviderModel('openrouter', undefined);
      expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
    });

    // Non-CLI provider passthrough
    it('edge: non-CLI provider (anthropic) passthrough — haiku returned as-is', () => {
      expect(resolveProviderModel('anthropic', 'haiku')).toBe('haiku');
    });

    // Undefined provider
    it('edge: undefined provider — model returned as-is', () => {
      expect(resolveProviderModel(undefined, 'haiku')).toBe('haiku');
    });

    // ── Regression prevention ──

    it('regression: codex-cli no longer passes through gpt-5.3-codex', () => {
      expect(resolveProviderModel('codex-cli', 'gpt-5.3-codex')).toBe('gpt-5.6-sol');
    });

    it('regression: gemini-cli no longer passes through gemini-2.5-pro', () => {
      expect(resolveProviderModel('gemini-cli', 'gemini-2.5-pro')).toBe('gemini-3.6-flash-high');
    });

    it('regression: cursor-cli no longer passes through composer-1.5', () => {
      expect(resolveProviderModel('cursor-cli', 'composer-1.5')).toBe('auto');
    });

    it('regression: anthropic-cli no longer passes through legacy claude-3-5-sonnet', () => {
      expect(resolveProviderModel('anthropic-cli', 'claude-3-5-sonnet-20241022')).toBe('claude-sonnet-5');
    });

    it('regression: deepseek no longer passes through deepseek-chat', () => {
      expect(resolveProviderModel('deepseek', 'deepseek-chat')).toBe('deepseek-v4-pro');
    });

    it('regression: deepseek no longer passes through deepseek-reasoner', () => {
      expect(resolveProviderModel('deepseek', 'deepseek-reasoner')).toBe('deepseek-v4-pro');
    });

    it('regression: cross-provider warning loop removed for CLI providers', () => {
      // codex-cli with a gemini model name must enforce gpt-5.6-sol (not fall back to undefined)
      expect(resolveProviderModel('codex-cli', 'gemini-2.5-pro')).toBe('gpt-5.6-sol');
    });

    it('regression: OpenRouter default (no/empty/inherit) selects from opus pool, not sonnet', () => {
      for (const input of [undefined, '', 'inherit'] as const) {
        const result = resolveProviderModel('openrouter', input);
        expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
        expect(DEFAULT_CONFIG.tiers.sonnet).not.toContain(result);
      }
    });

    it('regression: codex-cli inherit returns gpt-5.6-sol (not undefined)', () => {
      expect(resolveProviderModel('codex-cli', 'inherit')).toBe('gpt-5.6-sol');
    });

    it('regression: PROVIDER_DEFAULTS.codex-cli is gpt-5.6-sol (not undefined)', () => {
      expect(PROVIDER_DEFAULTS['codex-cli']).toBe('gpt-5.6-sol');
    });

    it('regression: deepseek-chat removed from KNOWN_PROVIDER_MODELS', () => {
      expect(KNOWN_PROVIDER_MODELS['deepseek'].has('deepseek-chat')).toBe(false);
    });

    it('regression: deepseek-reasoner removed from KNOWN_PROVIDER_MODELS', () => {
      expect(KNOWN_PROVIDER_MODELS['deepseek'].has('deepseek-reasoner')).toBe(false);
    });
  });
});
