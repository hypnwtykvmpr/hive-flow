/**
 * @hive-flow/providers
 *
 * Multi-LLM Provider System for Hive Flow V3
 *
 * Supports:
 * - Anthropic (Claude 3.5, 3 Opus, Sonnet, Haiku)
 * - OpenAI (GPT-4o, o1, GPT-4, GPT-3.5)
 * - Google (Gemini 2.0, 1.5 Pro, Flash)
 * - Cohere (Command R+, R, Light)
 * - Ollama (Local: Llama, Mistral, CodeLlama, Phi)
 *
 * Features:
 * - Load balancing (round-robin, latency, cost-based)
 * - Automatic failover
 * - Request caching
 * - Cost optimization (85%+ savings with intelligent routing)
 * - Circuit breaker protection
 * - Health monitoring
 *
 * @module @hive-flow/providers
 */

// Export types
export * from './types.js';

// Export base provider
export { BaseProvider, consoleLogger } from './base-provider.js';
export type { BaseProviderOptions, ILogger } from './base-provider.js';

// Export providers
export { AnthropicProvider } from './anthropic-provider.js';
export { OpenAIProvider } from './openai-provider.js';
export { GoogleProvider } from './google-provider.js';
export { CohereProvider } from './cohere-provider.js';
export { OllamaProvider } from './ollama-provider.js';
export { LMStudioProvider } from './lm-studio-provider.js';
export { OpenRouterProvider } from './openrouter-provider.js';
export { GeminiCLIProvider } from './gemini-cli-provider.js';
export { CodexCLIProvider } from './codex-cli-provider.js';
export { DeepSeekProvider } from './deepseek-provider.js';
export { QwenProvider } from './qwen-provider.js';
export { QwenCLIProvider } from './qwen-cli-provider.js';
export { CursorCLIProvider } from './cursor-cli-provider.js';
export { CopilotProvider } from './copilot-provider.js';
export { AnthropicCLIProvider } from './anthropic-cli-provider.js';

// Export provider manager
export { ProviderManager, createProviderManager } from './provider-manager.js';

// Export agentic wrapper
export { AgenticWrapper } from './agentic-wrapper.js';
export type { AgenticProvider, AgenticOptions, AgenticResult, AgenticToolEvent } from './agentic-wrapper.js';

// Export streaming buffer utility
export { bufferStreamResponse } from './streaming-buffer.js';

// Export shared tool-call utilities
export { escapeXml, parseToolCallPayload, parseToolCallsFromContent, formatToolInstructions, flushToolCallsFromBuffer } from './tool-call-utils.js';

// Export model alias resolver
export { resolveProviderModel, resolveProviderModelOrOpus, PROVIDER_ALIAS_MAP, KNOWN_PROVIDER_MODELS, CLAUDE_ALIASES, PROVIDER_DEFAULTS, DEFAULT_CONTEXT_WINDOWS, getModelContextLength } from './model-alias-resolver.js';
export type { ClaudeAlias, CLIProviderName } from './model-alias-resolver.js';

// Export OpenRouter model config
export {
  loadOpenRouterConfig, selectFromPool, isModelAllowed, resetOpenRouterConfigCache,
  getModelContextLength as getOpenRouterModelContextLength,
  DEFAULT_CONTEXT_WINDOWS as OR_DEFAULT_CONTEXT_WINDOWS,
} from './openrouter-model-config.js';
export type { OpenRouterTierPoolConfig, OpenRouterModelConfig } from './openrouter-model-config.js';
