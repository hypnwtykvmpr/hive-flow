/**
 * V3 Abstract Base Provider
 *
 * Provides common functionality for all LLM providers:
 * - Circuit breaker protection
 * - Health monitoring
 * - Cost tracking
 * - Request metrics
 *
 * @module @claude-flow/providers/base-provider
 */
import { EventEmitter } from 'events';
import { ILLMProvider, LLMProvider, LLMProviderConfig, LLMRequest, LLMResponse, LLMStreamEvent, LLMModel, ModelInfo, ProviderCapabilities, HealthCheckResult, ProviderStatus, CostEstimate, UsageStats, UsagePeriod, LLMProviderError } from './types.js';
/**
 * Simple circuit breaker implementation
 */
declare class CircuitBreaker {
    private readonly name;
    private readonly threshold;
    private readonly resetTimeout;
    private failures;
    private lastFailure;
    private state;
    constructor(name: string, threshold?: number, resetTimeout?: number);
    execute<T>(fn: () => Promise<T>): Promise<T>;
    private onSuccess;
    private onFailure;
    getState(): string;
}
/**
 * Logger interface
 */
export interface ILogger {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, error?: unknown): void;
    debug(message: string, meta?: Record<string, unknown>): void;
}
/**
 * Console logger implementation
 */
export declare const consoleLogger: ILogger;
/**
 * Base provider options
 */
export interface BaseProviderOptions {
    logger?: ILogger;
    config: LLMProviderConfig;
    cacheTTL?: number;
    circuitBreakerOptions?: {
        threshold?: number;
        resetTimeout?: number;
    };
}
/**
 * Abstract base class for LLM providers
 */
export declare abstract class BaseProvider extends EventEmitter implements ILLMProvider {
    abstract readonly name: LLMProvider;
    abstract readonly capabilities: ProviderCapabilities;
    protected logger: ILogger;
    protected circuitBreaker: CircuitBreaker;
    protected healthCheckInterval?: ReturnType<typeof setInterval>;
    protected lastHealthCheck?: HealthCheckResult;
    protected requestCount: number;
    protected errorCount: number;
    protected totalTokens: number;
    protected totalCost: number;
    protected requestMetrics: Map<string, {
        timestamp: Date;
        model: string;
        tokens: number;
        cost?: number;
        latency: number;
    }>;
    config: LLMProviderConfig;
    constructor(options: BaseProviderOptions);
    /**
     * Initialize the provider
     */
    initialize(): Promise<void>;
    /**
     * Provider-specific initialization (override in subclass)
     */
    protected abstract doInitialize(): Promise<void>;
    /**
     * Validate provider configuration
     */
    protected validateConfig(): void;
    /**
     * Complete a request
     */
    complete(request: LLMRequest): Promise<LLMResponse>;
    /**
     * Provider-specific completion (override in subclass)
     */
    protected abstract doComplete(request: LLMRequest): Promise<LLMResponse>;
    /**
     * Stream complete a request
     */
    streamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    /**
     * Provider-specific stream completion (override in subclass)
     */
    protected abstract doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    /**
     * List available models
     */
    abstract listModels(): Promise<LLMModel[]>;
    /**
     * Get model information
     */
    abstract getModelInfo(model: LLMModel): Promise<ModelInfo>;
    /**
     * Validate if a model is supported
     */
    validateModel(model: LLMModel): boolean;
    /**
     * Perform health check
     */
    healthCheck(): Promise<HealthCheckResult>;
    /**
     * Provider-specific health check (override in subclass)
     */
    protected abstract doHealthCheck(): Promise<HealthCheckResult>;
    /**
     * Get provider status
     */
    getStatus(): ProviderStatus;
    /**
     * Get remaining rate limit (override in provider)
     */
    protected getRateLimitRemaining(): number | undefined;
    /**
     * Get rate limit reset time (override in provider)
     */
    protected getRateLimitReset(): Date | undefined;
    /**
     * Estimate cost for a request
     */
    estimateCost(request: LLMRequest): Promise<CostEstimate>;
    /**
     * Simple token estimation (4 chars ≈ 1 token)
     */
    protected estimateTokens(text: string): number;
    /**
     * Get usage statistics
     */
    getUsage(period?: UsagePeriod): Promise<UsageStats>;
    private getStartDate;
    private calculateAverageLatency;
    /**
     * Track successful request
     */
    protected trackRequest(request: LLMRequest, response: LLMResponse, latency: number): void;
    /**
     * Track streaming request
     */
    protected trackStreamRequest(request: LLMRequest, totalTokens: number, totalCost: number, latency: number): void;
    /**
     * Transform errors to provider errors
     */
    protected transformError(error: unknown): LLMProviderError;
    /**
     * Start periodic health checks
     */
    protected startHealthChecks(): void;
    /**
     * Clean up resources
     */
    destroy(): void;
}
export {};
//# sourceMappingURL=base-provider.d.ts.map