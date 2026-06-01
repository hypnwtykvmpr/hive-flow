import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveProviderModel,
  PROVIDER_ALIAS_MAP,
  PROVIDER_DEFAULTS,
  KNOWN_PROVIDER_MODELS,
  CLAUDE_ALIASES,
} from '../model-alias-resolver.js';
import { DEFAULT_CONFIG } from '../openrouter-model-config.js';

describe('resolveProviderModel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Claude alias mapping', () => {
    it('maps opus to gemini-3.5-flash for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'opus')).toBe('gemini-3.5-flash');
    });

    it('maps sonnet to gemini-3.5-flash for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'sonnet')).toBe('gemini-3.5-flash');
    });

    it('maps haiku to gemini-3.5-flash for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'haiku')).toBe('gemini-3.5-flash');
    });

    it('maps opus to gpt-5.5 for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'opus')).toBe('gpt-5.5');
    });

    it('maps sonnet to gpt-5.5 for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'sonnet')).toBe('gpt-5.5');
    });

    it('maps haiku to gpt-5.5 for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'haiku')).toBe('gpt-5.5');
    });

    it('maps inherit to undefined for codex-cli (use config.toml)', () => {
      // codex-cli enforces gpt-5.5 regardless of input
      expect(resolveProviderModel('codex-cli', 'inherit')).toBe('gpt-5.5');
    });

    it('maps mini to claude-sonnet-4-6 for anthropic-cli', () => {
      expect(resolveProviderModel('anthropic-cli', 'mini')).toBe('claude-sonnet-4-6');
    });

    it('maps mini to gpt-5.5 for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'mini')).toBe('gpt-5.5');
    });

    it('maps mini to auto for cursor-cli', () => {
      expect(resolveProviderModel('cursor-cli', 'mini')).toBe('auto');
    });

    it('maps mini to deepseek-v4-flash for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'mini')).toBe('deepseek-v4-flash');
    });

    it('maps mini to gemini-3.5-flash for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'mini')).toBe('gemini-3.5-flash');
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
    it('returns gemini-3.5-flash for gemini-cli with undefined model', () => {
      expect(resolveProviderModel('gemini-cli', undefined)).toBe('gemini-3.5-flash');
    });

    it('returns gpt-5.5 for codex-cli with undefined model (enforcement, not undefined)', () => {
      expect(resolveProviderModel('codex-cli', undefined)).toBe('gpt-5.5');
    });

    it('returns auto for cursor-cli with undefined model', () => {
      expect(resolveProviderModel('cursor-cli', undefined)).toBe('auto');
    });

    it('returns provider default for empty string model', () => {
      expect(resolveProviderModel('gemini-cli', '')).toBe('gemini-3.5-flash');
    });
  });

  describe('auto model handling', () => {
    it('maps auto to provider default for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'auto')).toBe('gemini-3.5-flash');
    });

    it('maps auto to gpt-5.5 for codex-cli (model input ignored)', () => {
      expect(resolveProviderModel('codex-cli', 'auto')).toBe('gpt-5.5');
    });

    it('maps auto to auto for cursor-cli', () => {
      expect(resolveProviderModel('cursor-cli', 'auto')).toBe('auto');
    });
  });

  describe('provider-hardcoded enforcement (no passthrough)', () => {
    it('returns gpt-5.5 for codex-cli regardless of input model', () => {
      expect(resolveProviderModel('codex-cli', 'gpt-5.3-codex')).toBe('gpt-5.5');
      expect(resolveProviderModel('codex-cli', 'gpt-5.4')).toBe('gpt-5.5');
      expect(resolveProviderModel('codex-cli', 'gemini-2.5-pro')).toBe('gpt-5.5');
      expect(resolveProviderModel('codex-cli', 'some-unknown-model')).toBe('gpt-5.5');
    });

    it('returns gemini-3.5-flash for gemini-cli regardless of input model', () => {
      expect(resolveProviderModel('gemini-cli', 'gemini-2.5-pro')).toBe('gemini-3.5-flash');
      expect(resolveProviderModel('gemini-cli', 'gemini-3-flash-preview')).toBe('gemini-3.5-flash');
      expect(resolveProviderModel('gemini-cli', 'gpt-5.3-codex')).toBe('gemini-3.5-flash');
      expect(resolveProviderModel('gemini-cli', 'some-unknown-model')).toBe('gemini-3.5-flash');
    });

    it('returns auto for cursor-cli regardless of input model', () => {
      expect(resolveProviderModel('cursor-cli', 'composer-1.5')).toBe('auto');
      expect(resolveProviderModel('cursor-cli', 'gpt-5.3-codex-xhigh')).toBe('auto');
      expect(resolveProviderModel('cursor-cli', 'some-unknown-model')).toBe('auto');
    });
  });

  describe('provider-native model passthrough (legacy — now enforced)', () => {
    it('codex-cli always returns gpt-5.5 (enforcement overrides passthrough)', () => {
      expect(resolveProviderModel('codex-cli', 'gpt-5.3-codex')).toBe('gpt-5.5');
    });

    it('gemini-cli always returns gemini-3.5-flash (enforcement overrides passthrough)', () => {
      expect(resolveProviderModel('gemini-cli', 'gemini-2.5-pro')).toBe('gemini-3.5-flash');
    });

    it('cursor-cli always returns auto (enforcement overrides passthrough)', () => {
      expect(resolveProviderModel('cursor-cli', 'composer-1.5')).toBe('auto');
    });
  });

  describe('cross-provider model detection (enforcement — no warnings needed)', () => {
    it('returns gpt-5.5 when gemini model used with codex provider', () => {
      const result = resolveProviderModel('codex-cli', 'gemini-2.5-pro');
      expect(result).toBe('gpt-5.5'); // codex enforcement (not undefined)
    });

    it('returns gemini-3.5-flash when codex model used with gemini provider', () => {
      const result = resolveProviderModel('gemini-cli', 'gpt-5.3-codex');
      expect(result).toBe('gemini-3.5-flash'); // gemini enforcement
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
      expect(result).toBe('gemini-3.5-flash'); // enforced, not passed through
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
    });

    it('exports KNOWN_PROVIDER_MODELS as Sets', () => {
      expect(KNOWN_PROVIDER_MODELS['gemini-cli']).toBeInstanceOf(Set);
      expect(KNOWN_PROVIDER_MODELS['codex-cli']).toBeInstanceOf(Set);
      expect(KNOWN_PROVIDER_MODELS['cursor-cli']).toBeInstanceOf(Set);
      expect(KNOWN_PROVIDER_MODELS['deepseek']).toBeInstanceOf(Set);
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
      // Should return a model from the opus tier pool (e.g., xiaomi/mimo-v2.5-pro)
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
    it('real-world: anthropic-cli + opus → claude-opus-4-8', () => {
      expect(resolveProviderModel('anthropic-cli', 'opus')).toBe('claude-opus-4-8');
    });
    it('real-world: anthropic-cli + sonnet → claude-sonnet-4-6', () => {
      expect(resolveProviderModel('anthropic-cli', 'sonnet')).toBe('claude-sonnet-4-6');
    });
    it('real-world: anthropic-cli + haiku → claude-sonnet-4-6', () => {
      expect(resolveProviderModel('anthropic-cli', 'haiku')).toBe('claude-sonnet-4-6');
    });
    it('real-world: anthropic-cli + mini → claude-sonnet-4-6', () => {
      expect(resolveProviderModel('anthropic-cli', 'mini')).toBe('claude-sonnet-4-6');
    });
    it('real-world: anthropic-cli + inherit → claude-opus-4-8', () => {
      expect(resolveProviderModel('anthropic-cli', 'inherit')).toBe('claude-opus-4-8');
    });

    // gemini-cli (5)
    it('real-world: gemini-cli + opus → gemini-3.5-flash', () => {
      expect(resolveProviderModel('gemini-cli', 'opus')).toBe('gemini-3.5-flash');
    });
    it('real-world: gemini-cli + sonnet → gemini-3.5-flash', () => {
      expect(resolveProviderModel('gemini-cli', 'sonnet')).toBe('gemini-3.5-flash');
    });
    it('real-world: gemini-cli + haiku → gemini-3.5-flash', () => {
      expect(resolveProviderModel('gemini-cli', 'haiku')).toBe('gemini-3.5-flash');
    });
    it('real-world: gemini-cli + mini → gemini-3.5-flash', () => {
      expect(resolveProviderModel('gemini-cli', 'mini')).toBe('gemini-3.5-flash');
    });
    it('real-world: gemini-cli + inherit → gemini-3.5-flash', () => {
      expect(resolveProviderModel('gemini-cli', 'inherit')).toBe('gemini-3.5-flash');
    });

    // codex-cli (5)
    it('real-world: codex-cli + opus → gpt-5.5', () => {
      expect(resolveProviderModel('codex-cli', 'opus')).toBe('gpt-5.5');
    });
    it('real-world: codex-cli + sonnet → gpt-5.5', () => {
      expect(resolveProviderModel('codex-cli', 'sonnet')).toBe('gpt-5.5');
    });
    it('real-world: codex-cli + haiku → gpt-5.5', () => {
      expect(resolveProviderModel('codex-cli', 'haiku')).toBe('gpt-5.5');
    });
    it('real-world: codex-cli + mini → gpt-5.5', () => {
      expect(resolveProviderModel('codex-cli', 'mini')).toBe('gpt-5.5');
    });
    it('real-world: codex-cli + inherit → gpt-5.5', () => {
      expect(resolveProviderModel('codex-cli', 'inherit')).toBe('gpt-5.5');
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
    it('edge: anthropic-cli case-insensitive match → CLAUDE-3-5-SONNET-20241022 → claude-sonnet-4-6', () => {
      expect(resolveProviderModel('anthropic-cli', 'CLAUDE-3-5-SONNET-20241022')).toBe('claude-sonnet-4-6');
    });
    // FIX-A1: arbitrary strings containing 'mini' (e.g. cross-provider model
    // names like 'gpt-5-codex-mini') no longer leak into anthropic-cli's
    // sonnet bucket. Only exact aliases or 'claude-'-prefixed legacy names
    // route to claude-sonnet-4-6; everything else falls through to the
    // opus default.
    it('edge: anthropic-cli ignores stray "mini" in unrelated name → Mini-Some-Model → claude-opus-4-8 (default)', () => {
      expect(resolveProviderModel('anthropic-cli', 'Mini-Some-Model')).toBe('claude-opus-4-8');
    });
    it('edge: anthropic-cli blocks cross-provider leak → gpt-5-codex-mini → claude-opus-4-8 (default)', () => {
      expect(resolveProviderModel('anthropic-cli', 'gpt-5-codex-mini')).toBe('claude-opus-4-8');
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
    it('edge: anthropic-cli + empty string → claude-opus-4-8', () => {
      expect(resolveProviderModel('anthropic-cli', '')).toBe('claude-opus-4-8');
    });
    it('edge: deepseek + empty string → deepseek-v4-pro', () => {
      expect(resolveProviderModel('deepseek', '')).toBe('deepseek-v4-pro');
    });
    it('edge: gemini-cli + empty string → gemini-3.5-flash', () => {
      expect(resolveProviderModel('gemini-cli', '')).toBe('gemini-3.5-flash');
    });
    it('edge: codex-cli + empty string → gpt-5.5', () => {
      expect(resolveProviderModel('codex-cli', '')).toBe('gpt-5.5');
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

    // Undefined model for each CLI provider
    it('edge: anthropic-cli + undefined → claude-opus-4-8', () => {
      expect(resolveProviderModel('anthropic-cli', undefined)).toBe('claude-opus-4-8');
    });
    it('edge: deepseek + undefined → deepseek-v4-pro', () => {
      expect(resolveProviderModel('deepseek', undefined)).toBe('deepseek-v4-pro');
    });
    it('edge: gemini-cli + undefined → gemini-3.5-flash', () => {
      expect(resolveProviderModel('gemini-cli', undefined)).toBe('gemini-3.5-flash');
    });
    it('edge: codex-cli + undefined → gpt-5.5', () => {
      expect(resolveProviderModel('codex-cli', undefined)).toBe('gpt-5.5');
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
      expect(resolveProviderModel('codex-cli', 'gpt-5.3-codex')).toBe('gpt-5.5');
    });

    it('regression: gemini-cli no longer passes through gemini-2.5-pro', () => {
      expect(resolveProviderModel('gemini-cli', 'gemini-2.5-pro')).toBe('gemini-3.5-flash');
    });

    it('regression: cursor-cli no longer passes through composer-1.5', () => {
      expect(resolveProviderModel('cursor-cli', 'composer-1.5')).toBe('auto');
    });

    it('regression: anthropic-cli no longer passes through legacy claude-3-5-sonnet', () => {
      expect(resolveProviderModel('anthropic-cli', 'claude-3-5-sonnet-20241022')).toBe('claude-sonnet-4-6');
    });

    it('regression: deepseek no longer passes through deepseek-chat', () => {
      expect(resolveProviderModel('deepseek', 'deepseek-chat')).toBe('deepseek-v4-pro');
    });

    it('regression: deepseek no longer passes through deepseek-reasoner', () => {
      expect(resolveProviderModel('deepseek', 'deepseek-reasoner')).toBe('deepseek-v4-pro');
    });

    it('regression: cross-provider warning loop removed for CLI providers', () => {
      // codex-cli with a gemini model name must enforce gpt-5.5 (not fall back to undefined)
      expect(resolveProviderModel('codex-cli', 'gemini-2.5-pro')).toBe('gpt-5.5');
    });

    it('regression: OpenRouter default (no/empty/inherit) selects from opus pool, not sonnet', () => {
      for (const input of [undefined, '', 'inherit'] as const) {
        const result = resolveProviderModel('openrouter', input);
        expect(DEFAULT_CONFIG.tiers.opus).toContain(result);
        expect(DEFAULT_CONFIG.tiers.sonnet).not.toContain(result);
      }
    });

    it('regression: codex-cli inherit returns gpt-5.5 (not undefined)', () => {
      expect(resolveProviderModel('codex-cli', 'inherit')).toBe('gpt-5.5');
    });

    it('regression: PROVIDER_DEFAULTS.codex-cli is gpt-5.5 (not undefined)', () => {
      expect(PROVIDER_DEFAULTS['codex-cli']).toBe('gpt-5.5');
    });

    it('regression: deepseek-chat removed from KNOWN_PROVIDER_MODELS', () => {
      expect(KNOWN_PROVIDER_MODELS['deepseek'].has('deepseek-chat')).toBe(false);
    });

    it('regression: deepseek-reasoner removed from KNOWN_PROVIDER_MODELS', () => {
      expect(KNOWN_PROVIDER_MODELS['deepseek'].has('deepseek-reasoner')).toBe(false);
    });
  });
});
