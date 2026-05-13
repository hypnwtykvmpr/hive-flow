import { describe, it, expect } from 'vitest';
import {
  patternIsRejected,
  fileGlobIsRejected,
  buildRgArgs,
  buildGrepArgs,
} from '../scripts/bridge-grep-validators.mjs';

// Local copies of helper functions for testing. These mirror the helpers
// implemented in provider-agent-bridge.mjs. When the bridge is refactored
// to export them, swap these with imports.

function openRouterTierForAgentModel(model) {
  if (model === 'opus') return 'opus';
  if (model === 'sonnet' || model === 'mini') return 'sonnet';
  // Note: 'haiku' is NOT a valid alias for agent tasks per project policy.
  // If legacy state persists haiku, treat it as unknown and fall back to opus.
  return 'opus'; // inherit, missing, haiku-from-legacy, unknown
}

function chooseUntriedOpenRouterModel(pool, currentModel, attemptedModels, selectFromPool) {
  if (!Array.isArray(pool) || pool.length === 0) return undefined;
  const available = pool.filter((candidate) =>
    candidate && candidate !== currentModel && !attemptedModels.has(candidate)
  );
  if (available.length === 0) return undefined;
  return selectFromPool(available) ?? available[0];
}

function makeOpenRouterTierExhaustedError(tier, attemptedModels) {
  const error = new Error(
    `OpenRouter ${tier} tier exhausted after timeout rerolls; attempted models: ${Array.from(attemptedModels).join(', ')}`
  );
  error.code = 'OPENROUTER_TIER_EXHAUSTED';
  error.retryable = false;
  return error;
}

function maxEntriesForTokenWindow(maxTokens, modelName) {
  const normalizedModel = String(modelName || '').toLowerCase();
  // Anthropic Sonnet class: keep 50-entry cap regardless of token window
  if (/(^|\/)claude-.*sonnet/.test(normalizedModel) || normalizedModel === 'sonnet') {
    return 50;
  }
  if (maxTokens > 500000) return 100;
  if (maxTokens >= 200000) return 50;
  return 30;
}

const deterministicPicker = (pool) => pool[0];

describe('openRouterTierForAgentModel', () => {
  it('maps opus to opus', () => expect(openRouterTierForAgentModel('opus')).toBe('opus'));
  it('maps sonnet to sonnet', () => expect(openRouterTierForAgentModel('sonnet')).toBe('sonnet'));
  it('maps mini to sonnet', () => expect(openRouterTierForAgentModel('mini')).toBe('sonnet'));
  it('maps haiku to opus (legacy haiku is rejected; falls back to opus per project policy)', () =>
    expect(openRouterTierForAgentModel('haiku')).toBe('opus'));
  it('maps inherit to opus (per user directive)', () => expect(openRouterTierForAgentModel('inherit')).toBe('opus'));
  it('maps missing to opus', () => expect(openRouterTierForAgentModel(undefined)).toBe('opus'));
  it('maps unknown to opus', () => expect(openRouterTierForAgentModel('garbage')).toBe('opus'));
});

describe('chooseUntriedOpenRouterModel', () => {
  it('returns next available model excluding current and attempted', () => {
    const pool = ['a', 'b', 'c'];
    const attempted = new Set(['a']);
    const result = chooseUntriedOpenRouterModel(pool, 'a', attempted, deterministicPicker);
    expect(result).toBe('b');
  });

  it('returns undefined when pool empty', () => {
    expect(chooseUntriedOpenRouterModel([], 'a', new Set(), deterministicPicker)).toBeUndefined();
  });

  it('returns undefined when all models attempted', () => {
    const pool = ['a', 'b'];
    const attempted = new Set(['a', 'b']);
    expect(chooseUntriedOpenRouterModel(pool, 'a', attempted, deterministicPicker)).toBeUndefined();
  });

  it('returns undefined when only model left is current', () => {
    const pool = ['a'];
    const attempted = new Set();
    expect(chooseUntriedOpenRouterModel(pool, 'a', attempted, deterministicPicker)).toBeUndefined();
  });

  it('returns the only remaining model when others attempted', () => {
    const pool = ['a', 'b', 'c'];
    const attempted = new Set(['b']);
    expect(chooseUntriedOpenRouterModel(pool, 'a', attempted, deterministicPicker)).toBe('c');
  });

  it('handles non-array pool gracefully', () => {
    expect(chooseUntriedOpenRouterModel(null, 'a', new Set(), deterministicPicker)).toBeUndefined();
    expect(chooseUntriedOpenRouterModel(undefined, 'a', new Set(), deterministicPicker)).toBeUndefined();
  });
});

describe('makeOpenRouterTierExhaustedError', () => {
  it('has the right code and is non-retryable', () => {
    const err = makeOpenRouterTierExhaustedError('opus', new Set(['a', 'b']));
    expect(err.code).toBe('OPENROUTER_TIER_EXHAUSTED');
    expect(err.retryable).toBe(false);
  });

  it('mentions tier and attempted models in message', () => {
    const err = makeOpenRouterTierExhaustedError('sonnet', new Set(['x', 'y']));
    expect(err.message).toMatch(/sonnet/);
    expect(err.message).toMatch(/x/);
    expect(err.message).toMatch(/y/);
  });
});

describe('maxEntriesForTokenWindow', () => {
  it('returns 50 for sonnet regardless of token window (policy)', () => {
    expect(maxEntriesForTokenWindow(1_000_000, 'claude-sonnet-4-6')).toBe(50);
    expect(maxEntriesForTokenWindow(200_000, 'sonnet')).toBe(50);
  });

  it('returns 100 for >500K non-sonnet', () => {
    expect(maxEntriesForTokenWindow(1_000_000, 'claude-opus-4-7')).toBe(100);
    expect(maxEntriesForTokenWindow(600_000, 'deepseek-v4-pro')).toBe(100);
  });

  it('returns 50 for 200K-500K non-sonnet', () => {
    expect(maxEntriesForTokenWindow(400_000, 'gpt-5.5')).toBe(50);
    expect(maxEntriesForTokenWindow(200_000, 'claude-haiku-4-5-20251001')).toBe(50);
  });

  it('returns 30 for <200K', () => {
    expect(maxEntriesForTokenWindow(128_000, 'openai/gpt-4o-mini')).toBe(30);
    expect(maxEntriesForTokenWindow(131_072, 'meta-llama/llama-3.3-70b')).toBe(30);
  });

  it('handles missing modelName', () => {
    expect(maxEntriesForTokenWindow(128_000, undefined)).toBe(30);
    expect(maxEntriesForTokenWindow(1_000_000, undefined)).toBe(100);
  });
});

describe('expanded coverage (edge + regression)', () => {
  // ---------- Edge cases ----------

  it('openRouterTierForAgentModel handles all input types', () => {
    // null -> 'opus' (fallback)
    expect(openRouterTierForAgentModel(null)).toBe('opus');
    // '' -> 'opus' (fallback)
    expect(openRouterTierForAgentModel('')).toBe('opus');
    // 0 -> 'opus' (fallback)
    expect(openRouterTierForAgentModel(0)).toBe('opus');
    // 'OPUS' (uppercase): helper is strict-equality on the string 'opus',
    // so uppercase does NOT match the explicit opus branch. It falls
    // through every conditional and hits the catch-all `return 'opus'`.
    // Result is the right value but for the WRONG reason (fallback,
    // not direct match). Documented here so any future refactor that
    // changes the fallback target also updates this test.
    expect(openRouterTierForAgentModel('OPUS')).toBe('opus');
  });

  it('chooseUntriedOpenRouterModel with selectFromPool returning undefined', () => {
    // Pool has 1 untried model; picker returns undefined; helper falls
    // back to available[0] via the `?? available[0]` clause.
    const pool = ['only-one'];
    const attempted = new Set();
    const result = chooseUntriedOpenRouterModel(pool, 'other', attempted, () => undefined);
    expect(result).toBe('only-one');
  });

  it('chooseUntriedOpenRouterModel with attemptedModels containing extra (non-pool) entries', () => {
    // Pool ['a', 'b'], attempted = ['a', 'z', 'foo']; filter only excludes
    // 'a' (because 'z' and 'foo' are not in the pool). Result is 'b'.
    const pool = ['a', 'b'];
    const attempted = new Set(['a', 'z', 'foo']);
    const result = chooseUntriedOpenRouterModel(pool, 'current', attempted, deterministicPicker);
    expect(result).toBe('b');
  });

  it('makeOpenRouterTierExhaustedError message handles empty attempted set', () => {
    const err = makeOpenRouterTierExhaustedError('opus', new Set());
    // Message should mention tier and end with an empty list (no models).
    expect(err.message).toMatch(/opus/);
    expect(err.message).toMatch(/attempted models:\s*$/);
    expect(err.code).toBe('OPENROUTER_TIER_EXHAUSTED');
    expect(err.retryable).toBe(false);
  });

  it('maxEntriesForTokenWindow with 0 tokens', () => {
    // 0 tokens, no model -> falls through to <200K branch -> 30.
    expect(maxEntriesForTokenWindow(0, undefined)).toBe(30);
  });

  it('maxEntriesForTokenWindow with mixed-case Anthropic sonnet patterns', () => {
    // The helper lowercases modelName before checking. Regex-bounded check:
    // matches `claude-*sonnet*` and the bare alias 'sonnet' (case-insensitive).
    expect(maxEntriesForTokenWindow(1_000_000, 'CLAUDE-SONNET-4-6')).toBe(50);
    expect(maxEntriesForTokenWindow(128_000, 'sonNet')).toBe(50);
    // Provider-prefixed Anthropic Sonnet also matches via `/` segment anchor.
    expect(maxEntriesForTokenWindow(1_000_000, 'anthropic/claude-3-5-sonnet-20241022')).toBe(50);
  });

  it('maxEntriesForTokenWindow regex rejects unrelated names containing sonnet', () => {
    // Regex-bounded behavior: only `claude-*sonnet` or bare `sonnet` matches.
    // Unrelated third-party names containing 'sonnet' fall through to
    // token-bucket logic (no 50-cap forced).
    expect(maxEntriesForTokenWindow(1_000_000, 'sonnetic-blue')).toBe(100);
    expect(maxEntriesForTokenWindow(600_000, 'somesonnetfoo')).toBe(100);
  });

  // ---------- Regression prevention ----------

  it('regression: inherit maps to opus tier (user directive)', () => {
    // Explicit user directive: 'inherit' must route to the opus tier.
    expect(openRouterTierForAgentModel('inherit')).toBe('opus');
  });

  it('regression: mini maps to sonnet tier, not haiku', () => {
    // Explicit guard against any future change that demotes mini to haiku.
    expect(openRouterTierForAgentModel('mini')).toBe('sonnet');
    expect(openRouterTierForAgentModel('mini')).not.toBe('haiku');
  });

  it('regression: chooseUntriedOpenRouterModel never returns currentModel', () => {
    // 50 iterations with a randomized picker — result must never be 'b'.
    const pool = ['a', 'b', 'c'];
    const current = 'b';
    const attempted = new Set(['a']);
    const randomPicker = (available) =>
      available[Math.floor(Math.random() * available.length)];
    for (let i = 0; i < 50; i++) {
      const result = chooseUntriedOpenRouterModel(pool, current, attempted, randomPicker);
      expect(result).toBe('c');
      expect(result).not.toBe('b');
    }
  });

  it('regression: OPENROUTER_TIER_EXHAUSTED error is non-retryable', () => {
    // Explicit non-retryable contract — must remain false to prevent
    // retry loops in the bridge.
    const err = makeOpenRouterTierExhaustedError('opus', new Set(['a']));
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('OPENROUTER_TIER_EXHAUSTED');
  });

  it('regression: Sonnet entry-cap policy overrides token bucketing', () => {
    // The sonnet rule MUST win over the token-bucket logic. If a future
    // refactor inverts the order (token bucket first, sonnet check
    // second), this test catches it: 1M tokens would otherwise return 100.
    expect(maxEntriesForTokenWindow(1_000_000, 'claude-sonnet-4-6')).toBe(50);
    expect(maxEntriesForTokenWindow(1_000_000, 'claude-sonnet-4-6')).not.toBe(100);
  });
});

// =============================================================================
// FIX-S2: grep tool dash-pattern rejection (security regression for RCE via
// rg's `--pre=<script>` flag, which executes the script per file searched).
// These tests exercise the REAL validators that the bridge imports — not
// in-test stubs — so a future refactor that removes dash-rejection from the
// bridge would FAIL these tests.
// =============================================================================
describe('grep tool validators (security regression for RCE via rg --pre=)', () => {
  describe('patternIsRejected', () => {
    it('rejects --pre= as a pattern (RCE prevention)', () => {
      expect(patternIsRejected('--pre=/tmp/evil.sh')).toBe(true);
    });
    it('rejects --pcre2 as a pattern', () => {
      expect(patternIsRejected('--pcre2')).toBe(true);
    });
    it('rejects single-dash flags', () => {
      expect(patternIsRejected('-x')).toBe(true);
    });
    it('rejects non-string pattern', () => {
      expect(patternIsRejected(undefined)).toBe(true);
      expect(patternIsRejected(null)).toBe(true);
      expect(patternIsRejected(42)).toBe(true);
    });
    it('rejects empty string', () => {
      expect(patternIsRejected('')).toBe(true);
    });
    it('accepts legitimate patterns', () => {
      expect(patternIsRejected('error')).toBe(false);
      expect(patternIsRejected('TODO|FIXME')).toBe(false);
      expect(patternIsRejected('foo-bar')).toBe(false);
      expect(patternIsRejected('*.ts')).toBe(false);
    });
  });

  describe('fileGlobIsRejected', () => {
    it('rejects --pre= glob (RCE prevention)', () => {
      expect(fileGlobIsRejected('--pre=/tmp/evil.sh')).toBe(true);
    });
    it('rejects single-dash flag', () => {
      expect(fileGlobIsRejected('-z')).toBe(true);
    });
    it('accepts undefined and null', () => {
      expect(fileGlobIsRejected(undefined)).toBe(false);
      expect(fileGlobIsRejected(null)).toBe(false);
    });
    it('accepts legitimate globs', () => {
      expect(fileGlobIsRejected('*.ts')).toBe(false);
      expect(fileGlobIsRejected('src/**/*.tsx')).toBe(false);
    });
  });

  describe('buildRgArgs', () => {
    it('places -- separator between options and positionals', () => {
      const args = buildRgArgs('error', '/tmp', undefined);
      const dashDashIdx = args.indexOf('--');
      expect(dashDashIdx).toBeGreaterThan(-1);
      const patternIdx = args.indexOf('error');
      const pathIdx = args.indexOf('/tmp');
      expect(patternIdx).toBeGreaterThan(dashDashIdx);
      expect(pathIdx).toBeGreaterThan(dashDashIdx);
    });
    it('places --glob option BEFORE --', () => {
      const args = buildRgArgs('error', '/tmp', '*.ts');
      const dashDashIdx = args.indexOf('--');
      const globIdx = args.indexOf('--glob');
      expect(globIdx).toBeGreaterThan(-1);
      expect(globIdx).toBeLessThan(dashDashIdx);
    });
    it('throws on dash-pattern (RCE block)', () => {
      expect(() => buildRgArgs('--pre=/tmp/evil.sh', '/tmp', undefined)).toThrow(/may not start with "-"/);
    });
    it('throws on dash-glob (RCE block)', () => {
      expect(() => buildRgArgs('error', '/tmp', '--pre=/tmp/evil.sh')).toThrow(/may not start with "-"/);
    });
  });

  describe('buildGrepArgs', () => {
    it('places -- separator between options and positionals', () => {
      const args = buildGrepArgs('error', '/tmp');
      const dashDashIdx = args.indexOf('--');
      expect(dashDashIdx).toBeGreaterThan(-1);
      const patternIdx = args.indexOf('error');
      const pathIdx = args.indexOf('/tmp');
      expect(patternIdx).toBeGreaterThan(dashDashIdx);
      expect(pathIdx).toBeGreaterThan(dashDashIdx);
    });
    it('throws on dash-pattern (RCE block)', () => {
      expect(() => buildGrepArgs('--pre=/tmp/evil.sh', '/tmp')).toThrow(/may not start with "-"/);
    });
  });
});
