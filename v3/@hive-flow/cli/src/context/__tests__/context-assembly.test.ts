import { describe, expect, it } from 'vitest';
import type { ProviderManager } from '@hive-flow/providers';
import { LayeredAssembler } from '../LayeredAssembler.js';
import { RoleNormalizer } from '../role-normalizer.js';
import { TokenEstimator } from '../token-estimator.js';
import type { LLMMessage } from '../types.js';

function providerManager(contextWindow = 10_000): ProviderManager {
  return {
    getProvider: () => ({
      capabilities: {
        contextWindow,
        maxContextLength: {
          'test-model': contextWindow,
        },
      },
    }),
  } as unknown as ProviderManager;
}

describe('CLI context assembly helpers', () => {
  it('estimates text and multimodal message tokens deterministically', () => {
    const estimator = new TokenEstimator();

    expect(estimator.estimateString('abcd')).toBe(1);
    expect(estimator.estimateString('abcde')).toBe(2);
    expect(
      estimator.estimateMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'hello world' },
          { type: 'image', imageUrl: 'file://screenshot.png' },
        ],
      })
    ).toBe(1007);
  });

  it('normalizes provider-specific roles', () => {
    expect(RoleNormalizer.normalize('assistant', 'google')).toBe('model');
    expect(RoleNormalizer.normalize('tool', 'gemini-cli')).toBe('function_response');
    expect(RoleNormalizer.normalize('assistant', 'anthropic')).toBe('assistant');
  });

  it('assembles system, compressed history, RAG, and turn layers in send order', async () => {
    const history: LLMMessage[] = [
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'old assistant' },
      { role: 'user', content: 'old user' },
      { role: 'assistant', content: 'recent assistant' },
    ];

    const assembler = new LayeredAssembler(
      providerManager(),
      {
        getMessages: async () => history,
      },
      undefined
    );

    const request = await assembler.assemble('current turn', 'anthropic', 'test-model', {
      systemPrompt: 'system prompt',
      sessionId: 'session-1',
      ragResults: ['retrieved fact'],
      compressionThreshold: 2,
      anchorCount: 1,
      recentCount: 1,
    });

    expect(request.model).toBe('test-model');
    expect(request.messages.map(message => message.content)).toEqual([
      'system prompt',
      'anchor user',
      '[... Omitted 2 messages for brevity ...]',
      'recent assistant',
      'RAG Context:\nretrieved fact',
      'current turn',
    ]);
  });

  it('prunes lower-priority layers when context budget is tight', async () => {
    const assembler = new LayeredAssembler(providerManager(), undefined, undefined);

    const request = await assembler.assemble('current turn', 'anthropic', 'test-model', {
      systemPrompt: 'system prompt',
      ragResults: ['retrieved fact'],
      maxTokens: 4,
    });

    expect(request.messages).toEqual([{ role: 'system', content: 'system prompt' }]);
  });
});
