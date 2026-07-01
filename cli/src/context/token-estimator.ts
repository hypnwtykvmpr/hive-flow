/**
 * Token Estimator Utility
 *
 * Provides rough token counting for budgeting before sending to LLM.
 *
 * Created by Hive Flow
 */

import { LLMMessage, LLMContentPart } from './types.js';

export interface TokenEstimatorOptions {
  tokenizerType?: 'cl100k_base' | 'p50k_base' | 'llama' | 'anthropic' | 'default';
  charsPerToken?: number;
}

/**
 * Estimates the number of tokens in a string or array of messages.
 */
export class TokenEstimator {
  private charsPerToken: number;

  constructor(options: TokenEstimatorOptions = {}) {
    this.charsPerToken = options.charsPerToken ?? 4;
  }

  /**
   * Estimates tokens for a single string.
   */
  estimateString(text: string): number {
    if (!text) return 0;
    // Simple 4-chars-per-token heuristic for now
    // In production, we'd use tiktoken or similar
    return Math.ceil(text.length / this.charsPerToken);
  }

  /**
   * Estimates tokens for a single message.
   */
  estimateMessage(message: LLMMessage): number {
    let tokens = 0;

    // Base tokens for message structure (role, etc)
    tokens += 4;

    if (typeof message.content === 'string') {
      tokens += this.estimateString(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        tokens += this.estimateContentPart(part);
      }
    }

    // Add tokens for tool calls if present
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        tokens += 10; // Base tokens for tool call
        tokens += this.estimateString(call.function.name);
        tokens += this.estimateString(call.function.arguments);
      }
    }

    return tokens;
  }

  /**
   * Estimates tokens for an array of messages.
   */
  estimateMessages(messages: LLMMessage[]): number {
    return messages.reduce((acc, msg) => acc + this.estimateMessage(msg), 0);
  }

  private estimateContentPart(part: LLMContentPart): number {
    switch (part.type) {
      case 'text':
        return part.text ? this.estimateString(part.text) : 0;
      case 'image':
        return 1000; // Average tokens for an image
      case 'audio':
        return 500; // Average tokens for audio
      default:
        return 0;
    }
  }
}

/** Default global estimator instance */
export const estimator = new TokenEstimator();
