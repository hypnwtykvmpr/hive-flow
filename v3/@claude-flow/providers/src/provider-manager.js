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
import { isLLMProviderError, } from './types.js';
import { consoleLogger } from './base-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { GoogleProvider } from './google-provider.js';
import { CohereProvider } from './cohere-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { RuVectorProvider } from './ruvector-provider.js';
import { LMStudioProvider } from './lm-studio-provider.js';
import { OpenRouterProvider } from './openrouter-provider.js';
import { GeminiCLIProvider } from './gemini-cli-provider.js';
import { CodexCLIProvider } from './codex-cli-provider.js';
import { DeepSeekProvider } from './deepseek-provider.js';
import { QwenProvider } from './qwen-provider.js';
import { QwenCLIProvider } from './qwen-cli-provider.js';
import { CursorCLIProvider } from './cursor-cli-provider.js';
import { CopilotProvider } from './copilot-provider.js';
/**
 * Provider Manager - Orchestrates multiple LLM providers
 */
export class ProviderManager extends EventEmitter {
    config;
    providers = new Map();
    cache = new Map();
    metrics = new Map();
    roundRobinIndex = 0;
    logger;
    constructor(config, logger) {
        super();
        this.config = config;
        this.logger = logger || consoleLogger;
    }
    /**
     * Initialize all configured providers
     */
    async initialize() {
        this.logger.info('Initializing provider manager', {
            providerCount: this.config.providers.length,
        });
        const initPromises = this.config.providers.map(async (providerConfig) => {
            try {
                const provider = this.createProvider(providerConfig);
                await provider.initialize();
                this.providers.set(providerConfig.provider, provider);
                this.metrics.set(providerConfig.provider, {
                    latency: 0,
                    errorRate: 0,
                    cost: 0,
                    lastUsed: 0,
                });
                this.logger.info(`Provider ${providerConfig.provider} initialized`);
            }
            catch (error) {
                this.logger.error(`Failed to initialize ${providerConfig.provider}`, error);
            }
        });
        await Promise.all(initPromises);
        this.logger.info('Provider manager initialized', {
            activeProviders: Array.from(this.providers.keys()),
        });
    }
    /**
     * Create a provider instance
     */
    createProvider(config) {
        const options = {
            config,
            logger: this.logger,
        };
        switch (config.provider) {
            case 'anthropic':
                return new AnthropicProvider(options);
            case 'openai':
                return new OpenAIProvider(options);
            case 'google':
                return new GoogleProvider(options);
            case 'cohere':
                return new CohereProvider(options);
            case 'ollama':
                return new OllamaProvider(options);
            case 'ruvector':
                return new RuVectorProvider(options);
            case 'lm-studio':
                return new LMStudioProvider(options);
            case 'openrouter':
                return new OpenRouterProvider(options);
            case 'gemini-cli':
                return new GeminiCLIProvider(options);
            case 'codex-cli':
                return new CodexCLIProvider(options);
            case 'deepseek':
                return new DeepSeekProvider(options);
            case 'qwen':
                return new QwenProvider(options);
            case 'qwen-cli':
                return new QwenCLIProvider(options);
            case 'cursor-cli':
                return new CursorCLIProvider(options);
            case 'copilot':
                return new CopilotProvider(options);
            default:
                throw new Error(`Unknown provider: ${config.provider}`);
        }
    }
    /**
     * Complete a request with automatic provider selection
     */
    async complete(request, preferredProvider) {
        // Check cache first
        if (this.config.cache?.enabled) {
            const cached = this.getCached(request);
            if (cached) {
                this.logger.debug('Cache hit', { requestId: request.requestId });
                return cached;
            }
        }
        // Select provider
        const provider = preferredProvider
            ? this.providers.get(preferredProvider)
            : await this.selectProvider(request);
        if (!provider) {
            throw new Error('No available providers');
        }
        const startTime = Date.now();
        try {
            const response = await provider.complete(request);
            this.updateMetrics(provider.name, Date.now() - startTime, false, response.cost?.totalCost || 0);
            // Cache response
            if (this.config.cache?.enabled) {
                this.setCached(request, response);
            }
            this.emit('complete', { provider: provider.name, response });
            return response;
        }
        catch (error) {
            this.updateMetrics(provider.name, Date.now() - startTime, true, 0);
            // Try fallback
            if (this.config.fallback?.enabled && isLLMProviderError(error)) {
                return this.completWithFallback(request, provider.name, error);
            }
            throw error;
        }
    }
    /**
     * Stream complete with automatic provider selection
     */
    async *streamComplete(request, preferredProvider) {
        const provider = preferredProvider
            ? this.providers.get(preferredProvider)
            : await this.selectProvider(request);
        if (!provider) {
            throw new Error('No available providers');
        }
        const startTime = Date.now();
        try {
            for await (const event of provider.streamComplete(request)) {
                yield event;
            }
            this.updateMetrics(provider.name, Date.now() - startTime, false, 0);
        }
        catch (error) {
            this.updateMetrics(provider.name, Date.now() - startTime, true, 0);
            throw error;
        }
    }
    /**
     * Select provider based on load balancing strategy
     */
    async selectProvider(request) {
        const availableProviders = Array.from(this.providers.values()).filter((p) => p.getStatus().available);
        if (availableProviders.length === 0) {
            // Try to use any provider
            return this.providers.values().next().value;
        }
        const strategy = this.config.loadBalancing?.strategy || 'round-robin';
        switch (strategy) {
            case 'round-robin':
                return this.selectRoundRobin(availableProviders);
            case 'least-loaded':
                return this.selectLeastLoaded(availableProviders);
            case 'latency-based':
                return this.selectByLatency(availableProviders);
            case 'cost-based':
                return this.selectByCost(availableProviders, request);
            default:
                return availableProviders[0];
        }
    }
    selectRoundRobin(providers) {
        const provider = providers[this.roundRobinIndex % providers.length];
        this.roundRobinIndex++;
        return provider;
    }
    selectLeastLoaded(providers) {
        return providers.reduce((best, current) => current.getStatus().currentLoad < best.getStatus().currentLoad ? current : best);
    }
    selectByLatency(providers) {
        return providers.reduce((best, current) => {
            const bestMetrics = this.metrics.get(best.name);
            const currentMetrics = this.metrics.get(current.name);
            return (currentMetrics?.latency || Infinity) < (bestMetrics?.latency || Infinity)
                ? current
                : best;
        });
    }
    async selectByCost(providers, request) {
        const estimates = await Promise.all(providers.map(async (p) => ({
            provider: p,
            cost: (await p.estimateCost(request)).estimatedCost.total,
        })));
        return estimates.reduce((best, current) => current.cost < best.cost ? current : best).provider;
    }
    /**
     * Complete with fallback on failure
     */
    async completWithFallback(request, failedProvider, originalError) {
        const maxAttempts = this.config.fallback?.maxAttempts || 2;
        let attempts = 0;
        let lastError = originalError;
        const remainingProviders = Array.from(this.providers.values()).filter((p) => p.name !== failedProvider);
        for (const provider of remainingProviders) {
            if (attempts >= maxAttempts)
                break;
            attempts++;
            this.logger.info(`Attempting fallback to ${provider.name}`, {
                attempt: attempts,
                originalProvider: failedProvider,
            });
            try {
                const response = await provider.complete(request);
                this.emit('fallback_success', {
                    originalProvider: failedProvider,
                    fallbackProvider: provider.name,
                    attempts,
                });
                return response;
            }
            catch (error) {
                if (isLLMProviderError(error)) {
                    lastError = error;
                }
            }
        }
        this.emit('fallback_exhausted', {
            originalProvider: failedProvider,
            attempts,
        });
        throw lastError;
    }
    /**
     * Update provider metrics
     */
    updateMetrics(provider, latency, error, cost) {
        const current = this.metrics.get(provider) || {
            latency: 0,
            errorRate: 0,
            cost: 0,
            lastUsed: 0,
        };
        // Exponential moving average for latency
        const alpha = 0.3;
        const newLatency = current.latency === 0 ? latency : alpha * latency + (1 - alpha) * current.latency;
        // Update error rate
        const errorWeight = error ? 1 : 0;
        const newErrorRate = alpha * errorWeight + (1 - alpha) * current.errorRate;
        this.metrics.set(provider, {
            latency: newLatency,
            errorRate: newErrorRate,
            cost: current.cost + cost,
            lastUsed: Date.now(),
        });
    }
    /**
     * Get cached response
     */
    getCached(request) {
        const key = this.getCacheKey(request);
        const entry = this.cache.get(key);
        if (!entry)
            return undefined;
        const ttl = this.config.cache?.ttl || 300000;
        if (Date.now() - entry.timestamp > ttl) {
            this.cache.delete(key);
            return undefined;
        }
        entry.hits++;
        return entry.response;
    }
    /**
     * Set cached response
     */
    setCached(request, response) {
        const key = this.getCacheKey(request);
        // Enforce max size
        const maxSize = this.config.cache?.maxSize || 1000;
        if (this.cache.size >= maxSize) {
            // Remove oldest entry
            const oldest = Array.from(this.cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
            if (oldest)
                this.cache.delete(oldest[0]);
        }
        this.cache.set(key, {
            response,
            timestamp: Date.now(),
            hits: 0,
        });
    }
    /**
     * Generate cache key
     */
    getCacheKey(request) {
        return JSON.stringify({
            messages: request.messages,
            model: request.model,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
        });
    }
    /**
     * Get a specific provider
     */
    getProvider(name) {
        return this.providers.get(name);
    }
    /**
     * List all available providers
     */
    listProviders() {
        return Array.from(this.providers.keys());
    }
    /**
     * Health check all providers
     */
    async healthCheck() {
        const results = new Map();
        await Promise.all(Array.from(this.providers.entries()).map(async ([name, provider]) => {
            const result = await provider.healthCheck();
            results.set(name, result);
        }));
        return results;
    }
    /**
     * Estimate cost across providers
     */
    async estimateCost(request) {
        const estimates = new Map();
        await Promise.all(Array.from(this.providers.entries()).map(async ([name, provider]) => {
            const estimate = await provider.estimateCost(request);
            estimates.set(name, estimate);
        }));
        return estimates;
    }
    /**
     * Get aggregated usage statistics
     */
    async getUsage(period = 'day') {
        let totalRequests = 0;
        let totalTokens = { prompt: 0, completion: 0, total: 0 };
        let totalCost = { prompt: 0, completion: 0, total: 0 };
        let totalErrors = 0;
        let totalLatency = 0;
        let count = 0;
        for (const provider of this.providers.values()) {
            const usage = await provider.getUsage(period);
            totalRequests += usage.requests;
            totalTokens.prompt += usage.tokens.prompt;
            totalTokens.completion += usage.tokens.completion;
            totalTokens.total += usage.tokens.total;
            totalCost.prompt += usage.cost.prompt;
            totalCost.completion += usage.cost.completion;
            totalCost.total += usage.cost.total;
            totalErrors += usage.errors;
            totalLatency += usage.averageLatency;
            count++;
        }
        const now = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 1);
        return {
            period: { start, end: now },
            requests: totalRequests,
            tokens: totalTokens,
            cost: { ...totalCost, currency: 'USD' },
            errors: totalErrors,
            averageLatency: count > 0 ? totalLatency / count : 0,
            modelBreakdown: {},
        };
    }
    /**
     * Get provider metrics
     */
    getMetrics() {
        return new Map(this.metrics);
    }
    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
        this.logger.info('Cache cleared');
    }
    /**
     * Destroy all providers
     */
    destroy() {
        for (const provider of this.providers.values()) {
            provider.destroy();
        }
        this.providers.clear();
        this.cache.clear();
        this.metrics.clear();
        this.removeAllListeners();
        this.logger.info('Provider manager destroyed');
    }
}
/**
 * Create and initialize a provider manager
 */
export async function createProviderManager(config, logger) {
    const manager = new ProviderManager(config, logger);
    await manager.initialize();
    return manager;
}
//# sourceMappingURL=provider-manager.js.map