import { describe, it, expect } from 'vitest';
import { checkModelEnforcement, classifyTool, ToolRisk } from '../mcp-enforcement-gate.js';

describe('checkModelEnforcement', () => {
  it('blocks haiku for any agent_spawn', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'anthropic-cli', model: 'haiku' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/haiku/i);
  });

  it('allows mini for gemini-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: 'mini' });
    expect(r.allowed).toBe(true);
  });

  it('allows mini for codex-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'mini' });
    expect(r.allowed).toBe(true);
  });

  it('allows mini for queen_spawn_worker', () => {
    const r = checkModelEnforcement('queen_spawn_worker', { provider: 'codex-cli', model: 'mini' });
    expect(r.allowed).toBe(true);
  });

  it('blocks gpt-5.4 for codex-cli (rollout exception removed)', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'gpt-5.4' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('allows gpt-5.5 for codex-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'gpt-5.5' });
    expect(r.allowed).toBe(true);
  });

  it('blocks unknown model for gemini-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: 'gpt-4o' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gemini-3\.5-flash/i);
  });

  it('allows alias values for gemini-cli', () => {
    expect(checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: 'opus' }).allowed).toBe(true);
    expect(checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: 'sonnet' }).allowed).toBe(true);
    expect(checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: 'mini' }).allowed).toBe(true);
  });

  it('blocks openrouter without model', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'openrouter' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/mini/);  // error text must include mini
  });

  it('defaults deepseek to deepseek-v4-pro when no model', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'deepseek' });
    expect(r.allowed).toBe(true);
    expect(r.correctedInput?.model).toBe('deepseek-v4-pro');
  });

  it('does not enforce on non-spawn tools', () => {
    const r = checkModelEnforcement('memory_search', { model: 'haiku' });
    expect(r.allowed).toBe(true);
  });
});

describe('expanded coverage (real-world + edge + regression)', () => {
  // ---------------------------------------------------------------------------
  // Real-world coverage — every (provider × alias) combination behaves
  // consistently. Aliases (opus/sonnet/mini/inherit) must pass for every
  // provider, and haiku must be blocked universally.
  // ---------------------------------------------------------------------------
  const ALIASES = ['opus', 'sonnet', 'mini', 'inherit'] as const;
  const PROVIDERS = ['gemini-cli', 'codex-cli', 'cursor-cli', 'anthropic-cli', 'deepseek'] as const;

  for (const provider of PROVIDERS) {
    for (const alias of ALIASES) {
      it(`allows ${provider} + ${alias}`, () => {
        const r = checkModelEnforcement('agent_spawn', { provider, model: alias });
        expect(r.allowed).toBe(true);
      });
    }

    it(`blocks ${provider} + haiku (Rule 1 — universal haiku block)`, () => {
      const r = checkModelEnforcement('agent_spawn', { provider, model: 'haiku' });
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/haiku/i);
    });
  }

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  it('tool name with mcp__hive-flow__ prefix is correctly stripped', () => {
    const r = checkModelEnforcement('mcp__hive-flow__agent_spawn', { provider: 'gemini-cli', model: 'mini' });
    expect(r.allowed).toBe(true);
  });

  it('empty model with anthropic-cli defaults to sonnet', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'anthropic-cli' });
    expect(r.allowed).toBe(true);
    expect(r.correctedInput?.model).toBe('sonnet');
  });

  it('empty model with no provider defaults to anthropic-cli + sonnet', () => {
    const r = checkModelEnforcement('agent_spawn', {});
    expect(r.allowed).toBe(true);
    expect(r.correctedInput?.model).toBe('sonnet');
  });

  it('unknown tool name is not subject to enforcement', () => {
    const r = checkModelEnforcement('memory_search', { model: 'haiku' });
    expect(r.allowed).toBe(true);
  });

  it('queen_spawn_worker is also subject to enforcement', () => {
    const r = checkModelEnforcement('queen_spawn_worker', { provider: 'codex-cli', model: 'gpt-4o' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('OpenRouter with allow-listed direct model passes', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'openrouter', model: 'xiaomi/mimo-v2.5-pro' });
    expect(r.allowed).toBe(true);
  });

  it('OpenRouter with empty model still blocked', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'openrouter', model: '' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/mini/);
  });

  // ---------------------------------------------------------------------------
  // Regression prevention
  // ---------------------------------------------------------------------------
  it('regression: codex-cli + gpt-5.4 is blocked (rollout exception removed)', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'gpt-5.4' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('regression: codex-cli + gpt-5.3-codex is blocked', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'gpt-5.3-codex' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('regression: gemini-cli + gpt-5.5 is blocked (cross-provider)', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: 'gpt-5.5' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gemini-3\.5-flash/i);
  });

  it('regression: gemini-cli error mentions gemini-3.5-flash', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: 'foobar' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gemini-3\.5-flash/i);
  });

  it('regression: codex-cli error mentions gpt-5.5', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'foobar' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('regression: OpenRouter missing-model error mentions mini', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'openrouter' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/mini/);
  });

  it('regression: haiku is blocked for anthropic-cli (no exception)', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'anthropic-cli', model: 'haiku' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/haiku/i);
  });

  it('regression: deepseek default is deepseek-v4-pro, not deepseek-reasoner', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'deepseek' });
    expect(r.allowed).toBe(true);
    expect(r.correctedInput?.model).toBe('deepseek-v4-pro');
  });
});

// =============================================================================
// FIX-C1, FIX-C2, FIX-C3: Normalization, empty-model, and queen_mission_assign
// =============================================================================
describe('FIX-C1: provider/model normalization (case + whitespace bypass defeats)', () => {
  it('blocks uppercase provider CODEX-CLI with non-top-tier model', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'CODEX-CLI', model: 'gpt-3.5-turbo' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('blocks whitespace-padded provider " codex-cli " with non-top-tier model', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: ' codex-cli ', model: 'gpt-3.5-turbo' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('blocks uppercase provider GEMINI-CLI with non-top-tier model', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'GEMINI-CLI', model: 'gpt-4o' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gemini-3\.5-flash/i);
  });

  it('blocks mixed-case haiku model "HAIKU"', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'anthropic-cli', model: 'HAIKU' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/haiku/i);
  });

  it('blocks whitespace-padded model " haiku "', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'anthropic-cli', model: ' haiku ' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/haiku/i);
  });

  it('allows mixed-case alias OPUS for codex-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'OPUS' });
    expect(r.allowed).toBe(true);
  });

  it('allows whitespace-padded alias " sonnet " for gemini-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: ' sonnet ' });
    expect(r.allowed).toBe(true);
  });

  it('correctedInput preserves original case (not normalized form)', () => {
    // anthropic-cli with no model defaults to sonnet. Provider case in
    // correctedInput must equal the original (i.e., callers downstream get
    // their input back intact).
    const r = checkModelEnforcement('agent_spawn', { provider: 'ANTHROPIC-CLI' });
    expect(r.allowed).toBe(true);
    expect(r.correctedInput?.provider).toBe('ANTHROPIC-CLI');
    expect(r.correctedInput?.model).toBe('sonnet');
  });
});

describe('FIX-C2: empty-string model no longer counts as a valid alias', () => {
  it('blocks gemini-cli with empty-string model (was bug, now closed)', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: '' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gemini-3\.5-flash/i);
  });

  it('blocks codex-cli with empty-string model', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: '' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('blocks gemini-cli with whitespace-only model', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: '   ' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gemini-3\.5-flash/i);
  });

  it('deepseek with empty-string model still gets defaulted to deepseek-v4-pro', () => {
    // `!input.model` is truthy for '' so Rule 5 still fires.
    const r = checkModelEnforcement('agent_spawn', { provider: 'deepseek', model: '' });
    expect(r.allowed).toBe(true);
    expect(r.correctedInput?.model).toBe('deepseek-v4-pro');
  });

  it('anthropic-cli with empty-string model still gets defaulted to sonnet', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'anthropic-cli', model: '' });
    expect(r.allowed).toBe(true);
    expect(r.correctedInput?.model).toBe('sonnet');
  });
});

describe('FIX-C3: queen_mission_assign classification', () => {
  it('queen_mission_assign is classified CRITICAL', () => {
    expect(classifyTool('queen_mission_assign')).toBe(ToolRisk.CRITICAL);
  });

  it('mcp__hive-flow__queen_mission_assign (prefixed) is CRITICAL', () => {
    expect(classifyTool('mcp__hive-flow__queen_mission_assign')).toBe(ToolRisk.CRITICAL);
  });

  it('queen_mission_assign is also subject to model enforcement', () => {
    const r = checkModelEnforcement('queen_mission_assign', { provider: 'codex-cli', model: 'gpt-4o' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('queen_mission_assign blocks haiku', () => {
    const r = checkModelEnforcement('queen_mission_assign', { provider: 'anthropic-cli', model: 'haiku' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/haiku/i);
  });
});

describe('G2: agent_task_async dispatch gating', () => {
  it('agent_task_async is classified CRITICAL', () => {
    expect(classifyTool('agent_task_async')).toBe(ToolRisk.CRITICAL);
  });

  it('mcp__hive-flow__agent_task_async (prefixed) is CRITICAL', () => {
    expect(classifyTool('mcp__hive-flow__agent_task_async')).toBe(ToolRisk.CRITICAL);
  });

  it('agent_task_async has classification parity with agent_task', () => {
    expect(classifyTool('agent_task_async')).toBe(classifyTool('agent_task'));
    expect(classifyTool('mcp__hive-flow__agent_task_async')).toBe(classifyTool('mcp__hive-flow__agent_task'));
  });

  it('agent_task_async is subject to model enforcement', () => {
    const r = checkModelEnforcement('agent_task_async', { provider: 'codex-cli', model: 'gpt-4o' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('mcp__hive-flow__agent_task_async is subject to model enforcement', () => {
    const r = checkModelEnforcement('mcp__hive-flow__agent_task_async', { provider: 'anthropic-cli', model: 'haiku' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/haiku/i);
  });

  it('agent_task_async has model-enforcement parity with agent_task', () => {
    const asyncResult = checkModelEnforcement('agent_task_async', { provider: 'deepseek' });
    const syncResult = checkModelEnforcement('agent_task', { provider: 'deepseek' });
    expect(asyncResult.allowed).toBe(syncResult.allowed);
    expect(asyncResult.correctedInput?.model).toBe(syncResult.correctedInput?.model);
  });
});

// =============================================================================
// FIX-S5: Unicode-hyphen normalization in gate. Without NFKC + explicit
// hyphen-variant replacement, `'codex‐cli'.toLowerCase()` retains U+2010 and
// fails the strict equality against `'codex-cli'` (U+002D), bypassing the
// per-provider top-tier check.
// =============================================================================
describe('FIX-S5: Unicode-hyphen normalization (no enforcement bypass via homoglyphs)', () => {
  it('SEC-5: rejects Unicode-hyphen (U+2010) provider variant for codex-cli', () => {
    // 'codex‐cli' uses U+2010; would have bypassed prior to FIX-S5
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex‐cli', model: 'gpt-3.5-turbo' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/codex-cli requires gpt-5\.5/i);
  });

  it('SEC-5: rejects en-dash (U+2013) provider variant for codex-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex–cli', model: 'gpt-3.5-turbo' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('SEC-5: rejects minus-sign (U+2212) provider variant for codex-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex−cli', model: 'gpt-3.5-turbo' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('SEC-5: rejects Unicode-hyphen variant for gemini-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini‐cli', model: 'gpt-4o' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gemini-3\.5-flash/i);
  });

  it('SEC-5: rejects em-dash (U+2014) provider variant for codex-cli', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex—cli', model: 'gpt-3.5-turbo' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('SEC-5: rejects Unicode-hyphen in model string ("gpt‐5.4" for codex-cli)', () => {
    // Attacker tries to obfuscate a stale top-tier name by using a homoglyph
    // hyphen inside the model. After normalization this becomes "gpt-5.4"
    // which is still NOT the allowed top tier ("gpt-5.5"), so it's blocked.
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'gpt‐5.4' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/gpt-5\.5/i);
  });

  it('SEC-5: still allows ASCII codex-cli (regression — normalization must not break the happy path)', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'codex-cli', model: 'gpt-5.5' });
    expect(r.allowed).toBe(true);
  });

  it('SEC-5: still allows ASCII gemini-cli (regression — normalization must not break the happy path)', () => {
    const r = checkModelEnforcement('agent_spawn', { provider: 'gemini-cli', model: 'gemini-3.5-flash' });
    expect(r.allowed).toBe(true);
  });
});
