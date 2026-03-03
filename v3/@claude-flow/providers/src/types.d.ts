/**
 * V3 LLM Provider Types
 *
 * Unified type system for all LLM providers with enhanced
 * cost tracking, model capabilities, and error handling.
 *
 * @module @claude-flow/providers/types
 */
import { EventEmitter } from 'events';
export type LLMProvider = 'anthropic' | 'openai' | 'google' | 'cohere' | 'ollama' | 'ruvector' | 'openrouter' | 'lm-studio' | 'gemini-cli' | 'codex-cli' | 'deepseek' | 'qwen' | 'qwen-cli' | 'cursor-cli' | 'copilot' | 'litellm' | 'custom';
export type LLMModel = 'claude-3-5-sonnet-20241022' | 'claude-3-5-sonnet-latest' | 'claude-3-opus-20240229' | 'claude-3-sonnet-20240229' | 'claude-3-haiku-20240307' | 'gpt-4o' | 'gpt-4o-mini' | 'gpt-4-turbo' | 'gpt-4' | 'gpt-3.5-turbo' | 'o1-preview' | 'o1-mini' | 'o3-mini' | 'gemini-2.5-flash' | 'gemini-2.5-flash-lite' | 'gemini-2.5-pro' | 'gemini-3-flash-preview' | 'gemini-3.1-pro-preview' | 'gemini-2.0-flash' | 'gemini-1.5-pro' | 'gemini-1.5-flash' | 'gemini-pro' | 'command-r-plus' | 'command-r' | 'command-light' | 'command' | 'llama3.2' | 'llama3.1' | 'mistral' | 'mixtral' | 'codellama' | 'phi-4' | 'deepseek-coder' | 'gpt-5.3-codex' | 'gpt-5.2-codex' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex' | 'gpt-5-codex' | 'gpt-5-codex-mini' | 'deepseek-chat' | 'deepseek-reasoner' | 'qwen-max' | 'qwen-plus' | 'qwen-turbo' | 'qwen-long' | 'auto' | 'composer-1.5' | 'composer-1' | 'custom-model' | string;
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
export interface LLMProviderConfig {
    provider: LLMProvider;
    apiKey?: string;
    apiUrl?: string;
    model: LLMModel;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
    providerOptions?: Record<string, unknown>;
    sandbox?: boolean;
    timeout?: number;
    retryAttempts?: number;
    retryDelay?: number;
    enableStreaming?: boolean;
    enableCaching?: boolean;
    cacheTimeout?: number;
    enableCostOptimization?: boolean;
    maxCostPerRequest?: number;
    fallbackModels?: LLMModel[];
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
    toolChoice?: 'auto' | 'none' | 'required' | {
        type: 'function';
        function: {
            name: string;
        };
    };
    providerOptions?: Record<string, unknown>;
    costConstraints?: {
        maxCost?: number;
        preferredModels?: LLMModel[];
    };
    requestId?: string;
    metadata?: Record<string, unknown>;
}
export interface LLMResponse {
    id: string;
    model: LLMModel;
    provider: LLMProvider;
    content: string;
    toolCalls?: LLMToolCall[];
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    cost?: {
        promptCost: number;
        completionCost: number;
        totalCost: number;
        currency: string;
    };
    latency?: number;
    finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
    metadata?: Record<string, unknown>;
}
export interface LLMStreamEvent {
    type: 'content' | 'tool_call' | 'error' | 'done';
    delta?: {
        content?: string;
        toolCall?: Partial<LLMToolCall>;
    };
    error?: Error;
    usage?: LLMResponse['usage'];
    cost?: LLMResponse['cost'];
}
export interface ProviderCapabilities {
    supportedModels: LLMModel[];
    maxContextLength: Record<string, number>;
    maxOutputTokens: Record<string, number>;
    supportsStreaming: boolean;
    supportsToolCalling: boolean;
    supportsSystemMessages: boolean;
    supportsVision: boolean;
    supportsAudio: boolean;
    supportsFineTuning: boolean;
    supportsEmbeddings: boolean;
    supportsBatching: boolean;
    rateLimit?: {
        requestsPerMinute: number;
        tokensPerMinute: number;
        concurrentRequests: number;
    };
    pricing: Record<string, {
        promptCostPer1k: number;
        completionCostPer1k: number;
        currency: string;
    }>;
}
export declare class LLMProviderError extends Error {
    code: string;
    provider: LLMProvider;
    statusCode?: number | undefined;
    retryable: boolean;
    details?: unknown | undefined;
    constructor(message: string, code: string, provider: LLMProvider, statusCode?: number | undefined, retryable?: boolean, details?: unknown | undefined);
}
export declare class RateLimitError extends LLMProviderError {
    retryAfter?: number | undefined;
    constructor(message: string, provider: LLMProvider, retryAfter?: number | undefined, details?: unknown);
}
export declare class AuthenticationError extends LLMProviderError {
    constructor(message: string, provider: LLMProvider, details?: unknown);
}
export declare class ModelNotFoundError extends LLMProviderError {
    constructor(model: string, provider: LLMProvider, details?: unknown);
}
export declare class ProviderUnavailableError extends LLMProviderError {
    constructor(provider: LLMProvider, details?: unknown);
}
export interface ILLMProvider extends EventEmitter {
    readonly name: LLMProvider;
    readonly capabilities: ProviderCapabilities;
    config: LLMProviderConfig;
    initialize(): Promise<void>;
    complete(request: LLMRequest): Promise<LLMResponse>;
    streamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    listModels(): Promise<LLMModel[]>;
    getModelInfo(model: LLMModel): Promise<ModelInfo>;
    validateModel(model: LLMModel): boolean;
    healthCheck(): Promise<HealthCheckResult>;
    getStatus(): ProviderStatus;
    estimateCost(request: LLMRequest): Promise<CostEstimate>;
    getUsage(period?: UsagePeriod): Promise<UsageStats>;
    destroy(): void;
}
export interface ModelInfo {
    model: LLMModel;
    name: string;
    description: string;
    contextLength: number;
    maxOutputTokens: number;
    supportedFeatures: string[];
    pricing?: {
        promptCostPer1k: number;
        completionCostPer1k: number;
        currency: string;
    };
    deprecated?: boolean;
    recommendedReplacement?: LLMModel;
}
export interface HealthCheckResult {
    healthy: boolean;
    latency?: number;
    error?: string;
    timestamp: Date;
    details?: Record<string, unknown>;
}
export interface ProviderStatus {
    available: boolean;
    currentLoad: number;
    queueLength: number;
    activeRequests: number;
    rateLimitRemaining?: number;
    rateLimitReset?: Date;
}
export interface CostEstimate {
    estimatedPromptTokens: number;
    estimatedCompletionTokens: number;
    estimatedTotalTokens: number;
    estimatedCost: {
        prompt: number;
        completion: number;
        total: number;
        currency: string;
    };
    confidence: number;
}
export interface UsageStats {
    period: {
        start: Date;
        end: Date;
    };
    requests: number;
    tokens: {
        prompt: number;
        completion: number;
        total: number;
    };
    cost: {
        prompt: number;
        completion: number;
        total: number;
        currency: string;
    };
    errors: number;
    averageLatency: number;
    modelBreakdown: Record<string, {
        requests: number;
        tokens: number;
        cost: number;
    }>;
}
export type UsagePeriod = 'hour' | 'day' | 'week' | 'month' | 'all';
export type LoadBalancingStrategy = 'round-robin' | 'least-loaded' | 'latency-based' | 'cost-based';
export interface ProviderManagerConfig {
    providers: LLMProviderConfig[];
    defaultProvider?: LLMProvider;
    loadBalancing?: {
        enabled: boolean;
        strategy: LoadBalancingStrategy;
    };
    fallback?: {
        enabled: boolean;
        maxAttempts: number;
    };
    cache?: {
        enabled: boolean;
        ttl: number;
        maxSize: number;
    };
    costOptimization?: {
        enabled: boolean;
        maxCostPerRequest?: number;
    };
}
export declare function isLLMResponse(obj: unknown): obj is LLMResponse;
export declare function isLLMStreamEvent(obj: unknown): obj is LLMStreamEvent;
export declare function isLLMProviderError(error: unknown): error is LLMProviderError;
export declare function isRateLimitError(error: unknown): error is RateLimitError;
//# sourceMappingURL=types.d.ts.map