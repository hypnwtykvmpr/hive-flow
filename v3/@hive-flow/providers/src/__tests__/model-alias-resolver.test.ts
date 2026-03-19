import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveProviderModel,
  PROVIDER_ALIAS_MAP,
  PROVIDER_DEFAULTS,
  KNOWN_PROVIDER_MODELS,
  CLAUDE_ALIASES,
} from '../model-alias-resolver.js';

describe('resolveProviderModel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Claude alias mapping', () => {
    it('maps opus to gemini-3.1-pro-preview for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'opus')).toBe('gemini-3.1-pro-preview');
    });

    it('maps sonnet to gemini-3.1-pro-preview for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'sonnet')).toBe('gemini-3.1-pro-preview');
    });

    it('maps haiku to gemini-3.1-pro-preview for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'haiku')).toBe('gemini-3.1-pro-preview');
    });

    it('maps opus to gpt-5.4 for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'opus')).toBe('gpt-5.4');
    });

    it('maps sonnet to gpt-5.4 for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'sonnet')).toBe('gpt-5.4');
    });

    it('maps haiku to gpt-5.4 for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'haiku')).toBe('gpt-5.4');
    });

    it('maps inherit to undefined for codex-cli (use config.toml)', () => {
      expect(resolveProviderModel('codex-cli', 'inherit')).toBeUndefined();
    });

    it('maps all aliases to auto for cursor-cli', () => {
      expect(resolveProviderModel('cursor-cli', 'opus')).toBe('auto');
      expect(resolveProviderModel('cursor-cli', 'sonnet')).toBe('auto');
      expect(resolveProviderModel('cursor-cli', 'haiku')).toBe('auto');
    });
  });

  describe('DeepSeek alias mapping', () => {
    it('maps opus to deepseek-reasoner for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'opus')).toBe('deepseek-reasoner');
    });

    it('maps sonnet to deepseek-reasoner for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'sonnet')).toBe('deepseek-reasoner');
    });

    it('maps haiku to deepseek-reasoner for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'haiku')).toBe('deepseek-reasoner');
    });

    it('maps inherit to deepseek-reasoner for deepseek', () => {
      expect(resolveProviderModel('deepseek', 'inherit')).toBe('deepseek-reasoner');
    });

    it('returns deepseek-reasoner as default for undefined model', () => {
      expect(resolveProviderModel('deepseek', undefined)).toBe('deepseek-reasoner');
    });

    it('passes through known deepseek model names', () => {
      expect(resolveProviderModel('deepseek', 'deepseek-chat')).toBe('deepseek-chat');
      expect(resolveProviderModel('deepseek', 'deepseek-reasoner')).toBe('deepseek-reasoner');
    });
  });

  describe('provider defaults (no model specified)', () => {
    it('returns gemini-3.1-pro-preview for gemini-cli with undefined model', () => {
      expect(resolveProviderModel('gemini-cli', undefined)).toBe('gemini-3.1-pro-preview');
    });

    it('returns undefined for codex-cli with undefined model', () => {
      expect(resolveProviderModel('codex-cli', undefined)).toBeUndefined();
    });

    it('returns auto for cursor-cli with undefined model', () => {
      expect(resolveProviderModel('cursor-cli', undefined)).toBe('auto');
    });

    it('returns provider default for empty string model', () => {
      expect(resolveProviderModel('gemini-cli', '')).toBe('gemini-3.1-pro-preview');
    });
  });

  describe('auto model handling', () => {
    it('maps auto to provider default for gemini-cli', () => {
      expect(resolveProviderModel('gemini-cli', 'auto')).toBe('gemini-3.1-pro-preview');
    });

    it('maps auto to undefined for codex-cli', () => {
      expect(resolveProviderModel('codex-cli', 'auto')).toBeUndefined();
    });

    it('maps auto to auto for cursor-cli', () => {
      expect(resolveProviderModel('cursor-cli', 'auto')).toBe('auto');
    });
  });

  describe('provider-native model passthrough', () => {
    it('passes through known gemini model names', () => {
      expect(resolveProviderModel('gemini-cli', 'gemini-2.5-pro')).toBe('gemini-2.5-pro');
    });

    it('passes through known codex model names', () => {
      expect(resolveProviderModel('codex-cli', 'gpt-5.3-codex')).toBe('gpt-5.3-codex');
    });

    it('passes through known cursor model names', () => {
      expect(resolveProviderModel('cursor-cli', 'composer-1.5')).toBe('composer-1.5');
    });
  });

  describe('cross-provider model detection', () => {
    it('returns default when gemini model used with codex provider', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveProviderModel('codex-cli', 'gemini-2.5-pro');
      expect(result).toBeUndefined(); // codex default
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('belongs to gemini-cli'));
    });

    it('returns default when codex model used with gemini provider', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveProviderModel('gemini-cli', 'gpt-5.3-codex');
      expect(result).toBe('gemini-3.1-pro-preview'); // gemini default
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('belongs to codex-cli'));
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

  describe('unknown model handling', () => {
    it('passes through unknown model with warning', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = resolveProviderModel('gemini-cli', 'some-unknown-model');
      expect(result).toBe('some-unknown-model');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown model'));
    });
  });

  describe('exports', () => {
    it('exports CLAUDE_ALIASES with correct values', () => {
      expect(CLAUDE_ALIASES).toContain('haiku');
      expect(CLAUDE_ALIASES).toContain('sonnet');
      expect(CLAUDE_ALIASES).toContain('opus');
      expect(CLAUDE_ALIASES).toContain('inherit');
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
});
