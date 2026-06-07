import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateLLMJury } from '../llm-jury.js';
import type { JuryContext } from '../types.js';

function ctx(command = 'custom-tool --maybe'): JuryContext {
  return {
    toolName: 'Bash',
    toolInput: { command },
    cwd: '/project',
  };
}

describe('LLM jury provider availability', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null immediately when the Anthropic provider key is unavailable', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_API_KEY', '');
    const startedAt = Date.now();

    const result = await evaluateLLMJury(ctx(), { timeoutMs: 12_000 });

    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});
