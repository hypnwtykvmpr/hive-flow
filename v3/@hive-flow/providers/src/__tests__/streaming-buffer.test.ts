import { describe, it, expect, vi } from 'vitest';
import { bufferStreamResponse } from '../streaming-buffer.js';
import type { ILLMProvider, LLMStreamEvent, LLMRequest, LLMResponse } from '../types.js';

function createMockProvider(events: LLMStreamEvent[]): ILLMProvider {
  return {
    name: 'custom' as any,
    config: { provider: 'custom' as any, model: 'test-model' },
    capabilities: {
      supportedModels: ['test-model'],
      maxContextLength: { 'test-model': 128000 },
      maxOutputTokens: { 'test-model': 4096 },
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsSystemMessages: true,
      supportsVision: false,
      supportsAudio: false,
      supportsFineTuning: false,
      supportsEmbeddings: false,
      supportsBatching: false,
      pricing: {},
    },
    async *streamComplete() {
      for (const event of events) yield event;
    },
    initialize: vi.fn(),
    complete: vi.fn(),
    listModels: vi.fn(),
    getModelInfo: vi.fn(),
    validateModel: vi.fn(),
    healthCheck: vi.fn(),
    getStatus: vi.fn(),
    estimateCost: vi.fn(),
    getUsage: vi.fn(),
    destroy: vi.fn(),
    // EventEmitter stubs
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(() => 10),
    listeners: vi.fn(() => []),
    rawListeners: vi.fn(() => []),
    listenerCount: vi.fn(() => 0),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    eventNames: vi.fn(() => []),
  } as unknown as ILLMProvider;
}

const baseRequest: LLMRequest = {
  messages: [{ role: 'user', content: 'Hello' }],
};

describe('bufferStreamResponse', () => {
  it('collects all content chunks into a single string', async () => {
    const events: LLMStreamEvent[] = [
      { type: 'content', delta: { content: 'Hello ' } },
      { type: 'content', delta: { content: 'world' } },
      { type: 'content', delta: { content: '!' } },
      { type: 'done' },
    ];
    const provider = createMockProvider(events);

    const result = await bufferStreamResponse(provider, baseRequest);

    expect(result.content).toBe('Hello world!');
    expect(result.provider).toBe('custom');
    expect(result.finishReason).toBe('stop');
    expect(result.id).toMatch(/^stream-\d+$/);
  });

  it('captures usage and cost from done event', async () => {
    const usage: LLMResponse['usage'] = {
      promptTokens: 10,
      completionTokens: 25,
      totalTokens: 35,
    };
    const cost: LLMResponse['cost'] = {
      promptCost: 0.001,
      completionCost: 0.003,
      totalCost: 0.004,
      currency: 'USD',
    };
    const events: LLMStreamEvent[] = [
      { type: 'content', delta: { content: 'Response' } },
      { type: 'done', usage, cost },
    ];
    const provider = createMockProvider(events);

    const result = await bufferStreamResponse(provider, baseRequest);

    expect(result.usage).toEqual(usage);
    expect(result.cost).toEqual(cost);
  });

  it('throws on error event and aborts buffering', async () => {
    const events: LLMStreamEvent[] = [
      { type: 'content', delta: { content: 'Partial ' } },
      { type: 'error', error: new Error('Provider connection lost') },
      { type: 'content', delta: { content: 'should not appear' } },
    ];
    const provider = createMockProvider(events);

    await expect(bufferStreamResponse(provider, baseRequest))
      .rejects.toThrow('Provider connection lost');
  });

  it('returns empty content for an empty stream (no error)', async () => {
    const events: LLMStreamEvent[] = [
      { type: 'done' },
    ];
    const provider = createMockProvider(events);

    const result = await bufferStreamResponse(provider, baseRequest);

    expect(result.content).toBe('');
    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it('handles a large stream (>1MB) without memory issues', async () => {
    const chunkSize = 1024;
    const chunkCount = 1100; // ~1.1MB total
    const chunk = 'x'.repeat(chunkSize);
    const events: LLMStreamEvent[] = [];
    for (let i = 0; i < chunkCount; i++) {
      events.push({ type: 'content', delta: { content: chunk } });
    }
    events.push({
      type: 'done',
      usage: { promptTokens: 100, completionTokens: chunkCount, totalTokens: 100 + chunkCount },
    });
    const provider = createMockProvider(events);

    const result = await bufferStreamResponse(provider, baseRequest);

    expect(result.content.length).toBe(chunkSize * chunkCount);
    expect(result.usage.completionTokens).toBe(chunkCount);
  });
});
