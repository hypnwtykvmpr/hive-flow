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
export declare function bufferStreamResponse(provider: ILLMProvider, request: LLMRequest): Promise<LLMResponse>;
//# sourceMappingURL=streaming-buffer.d.ts.map