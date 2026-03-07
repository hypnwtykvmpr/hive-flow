/**
 * Buffer-and-return strategy for streaming providers.
 *
 * MCP protocol is request-response only — we can't stream events through.
 * This utility uses streaming internally (for resilience against timeouts)
 * but buffers all content and returns a complete LLMResponse.
 *
 * @module @claude-flow/providers/streaming-buffer
 */

import type { ILLMProvider, LLMRequest, LLMResponse, LLMToolCall } from './types.js';

export async function bufferStreamResponse(
  provider: ILLMProvider,
  request: LLMRequest
): Promise<LLMResponse> {
  const chunks: string[] = [];
  const toolCallOrder: string[] = [];
  const toolCallMap = new Map<string, LLMToolCall>();
  let usage: LLMResponse['usage'] | undefined;
  let cost: LLMResponse['cost'] | undefined;

  for await (const event of provider.streamComplete(request)) {
    switch (event.type) {
      case 'content':
        if (event.delta?.content) chunks.push(event.delta.content);
        break;
      case 'tool_call':
        if (!event.delta?.toolCall) break;

        const toolCallDelta = event.delta.toolCall;
        const existingKey = toolCallDelta.id
          ? toolCallDelta.id
          : toolCallOrder[toolCallOrder.length - 1];
        const toolCallKey = existingKey ?? `stream-tool-${toolCallOrder.length}`;

        if (!toolCallMap.has(toolCallKey)) {
          toolCallOrder.push(toolCallKey);
          toolCallMap.set(toolCallKey, {
            id: toolCallDelta.id ?? toolCallKey,
            type: 'function',
            function: {
              name: '',
              arguments: '',
            },
          });
        }

        const toolCall = toolCallMap.get(toolCallKey)!;
        if (toolCallDelta.id) toolCall.id = toolCallDelta.id;
        if (toolCallDelta.function?.name) toolCall.function.name = toolCallDelta.function.name;
        if (typeof toolCallDelta.function?.arguments === 'string') {
          toolCall.function.arguments += toolCallDelta.function.arguments;
        }
        break;
      case 'done':
        usage = event.usage;
        cost = event.cost;
        break;
      case 'error':
        throw event.error ?? new Error('Stream error');
    }
  }

  const toolCalls = toolCallOrder
    .map((key) => toolCallMap.get(key))
    .filter((toolCall): toolCall is LLMToolCall => Boolean(toolCall));
  const hasToolCalls = toolCalls.length > 0;

  return {
    id: `stream-${Date.now()}`,
    model: request.model ?? provider.config.model,
    provider: provider.name,
    content: chunks.join(''),
    ...(hasToolCalls ? { toolCalls } : {}),
    usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    cost,
    finishReason: hasToolCalls ? 'tool_calls' : 'stop',
  };
}
