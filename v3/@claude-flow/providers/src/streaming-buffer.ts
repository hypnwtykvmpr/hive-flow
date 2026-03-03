/**
 * Buffer-and-return strategy for streaming providers.
 *
 * MCP protocol is request-response only — we can't stream events through.
 * This utility uses streaming internally (for resilience against timeouts)
 * but buffers all content and returns a complete LLMResponse.
 *
 * @module @claude-flow/providers/streaming-buffer
 */

import type { ILLMProvider, LLMRequest, LLMResponse } from './types.js';

export async function bufferStreamResponse(
  provider: ILLMProvider,
  request: LLMRequest
): Promise<LLMResponse> {
  const chunks: string[] = [];
  let usage: LLMResponse['usage'] | undefined;
  let cost: LLMResponse['cost'] | undefined;

  for await (const event of provider.streamComplete(request)) {
    switch (event.type) {
      case 'content':
        if (event.delta?.content) chunks.push(event.delta.content);
        break;
      case 'tool_call':
        // Tool call deltas are not buffered — provider agents are text-only
        break;
      case 'done':
        usage = event.usage;
        cost = event.cost;
        break;
      case 'error':
        throw event.error ?? new Error('Stream error');
    }
  }

  return {
    id: `stream-${Date.now()}`,
    model: request.model ?? provider.config.model,
    provider: provider.name,
    content: chunks.join(''),
    usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    cost,
    finishReason: 'stop',
  };
}
