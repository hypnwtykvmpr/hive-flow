/**
 * V3 Context Assembly Types
 *
 * Created with ❤️ by ruv.io
 */

import type { LLMProvider, LLMModel } from '@claude-flow/providers';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentPart[];
  name?: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMContentPart {
  type: 'text' | 'image' | 'audio';
  text?: string;
  imageUrl?: string;
  imageBase64?: string;
  audioUrl?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: LLMModel;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  stream?: boolean;
  tools?: LLMTool[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AssembleOptions {
  sessionId?: string;
  maxTokens?: number; // Override provider default
  includeRag?: boolean;
  ragQuery?: string;
  compressionThreshold?: number; // Default: 20 turns
  anchorCount?: number;      // Default: 5 turns
  recentCount?: number;      // Default: 10 turns
  systemPrompt?: string;
  ragResults?: string[];
}

export interface ContextLayer {
  name: string;
  priority: number; // Lower = higher priority (System = 0, Turn = 1, RAG = 2, History = 3)
  messages: LLMMessage[];
  tokenEstimate: number;
}
