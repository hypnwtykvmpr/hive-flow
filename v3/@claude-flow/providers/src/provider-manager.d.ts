/**
 * V3 Provider Manager
 *
 * Orchestrates multiple LLM providers with:
 * - Load balancing (round-robin, latency-based, cost-based)
 * - Automatic failover
 * - Request caching
 * - Cost optimization
 *
 * @module @claude-flow/providers/provider-manager
 */
import { EventEmitter } from 'events';
import { ILLMProvider, LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent, ProviderManagerConfig, HealthCheckResult, CostEstimate, UsageStats, UsagePeriod } from './types.js';
import { ILogger } from './base-provider.js';
/**
 * Provider metrics for load balancing
 */
interface ProviderMetrics {
    latency: number;
    errorRate: number;
    cost: number;
    lastUsed: number;
}
/**
 * Provider Manager - Orchestrates multiple LLM providers
 */
export declare class ProviderManager extends EventEmitter {
    private config;
    private providers;
    private cache;
    private metrics;
    private roundRobinIndex;
    private logger;
    constructor(config: ProviderManagerConfig, logger?: ILogger);
    /**
     * Initialize all configured providers
     */
    initialize(): Promise<void>;
    /**
     * Create a provider instance
     */
    private createProvider;
    /**
     * Complete a request with automatic provider selection
     */
    complete(request: LLMRequest, preferredProvider?: LLMProvider): Promise<LLMResponse>;
    /**
     * Stream complete with automatic provider selection
     */
    streamComplete(request: LLMRequest, preferredProvider?: LLMProvider): AsyncIterable<LLMStreamEvent>;
    /**
     * Select provider based on load balancing strategy
     */
    private selectProvider;
    private selectRoundRobin;
    private selectLeastLoaded;
    private selectByLatency;
    private selectByCost;
    /**
     * Complete with fallback on failure
     */
    private completWithFallback;
    /**
     * Update provider metrics
     */
    private updateMetrics;
    /**
     * Get cached response
     */
    private getCached;
    /**
     * Set cached response
     */
    private setCached;
    /**
     * Generate cache key
     */
    private getCacheKey;
    /**
     * Get a specific provider
     */
    getProvider(name: LLMProvider): ILLMProvider | undefined;
    /**
     * List all available providers
     */
    listProviders(): LLMProvider[];
    /**
     * Health check all providers
     */
    healthCheck(): Promise<Map<LLMProvider, HealthCheckResult>>;
    /**
     * Estimate cost across providers
     */
    estimateCost(request: LLMRequest): Promise<Map<LLMProvider, CostEstimate>>;
    /**
     * Get aggregated usage statistics
     */
    getUsage(period?: UsagePeriod): Promise<UsageStats>;
    /**
     * Get provider metrics
     */
    getMetrics(): Map<LLMProvider, ProviderMetrics>;
    /**
     * Clear cache
     */
    clearCache(): void;
    /**
     * Destroy all providers
     */
    destroy(): void;
}
/**
 * Create and initialize a provider manager
 */
export declare function createProviderManager(config: ProviderManagerConfig, logger?: ILogger): Promise<ProviderManager>;
export {};
//# sourceMappingURL=provider-manager.d.ts.map