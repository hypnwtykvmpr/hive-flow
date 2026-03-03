/**
 * V3 RuVector Provider (via @ruvector/ruvllm)
 *
 * Self-learning LLM orchestration with:
 * - SONA adaptive learning
 * - HNSW vector memory
 * - FastGRNN intelligent routing
 * - SIMD inference optimization
 * - Local model execution (free)
 *
 * @module @claude-flow/providers/ruvector-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class RuVectorProvider extends BaseProvider {
    readonly name: LLMProvider;
    readonly capabilities: ProviderCapabilities;
    private baseUrl;
    private ollamaUrl;
    private ruvectorConfig;
    private ruvllm;
    private useOllamaFallback;
    private ruvllmAvailable;
    constructor(options: BaseProviderOptions);
    protected doInitialize(): Promise<void>;
    protected doComplete(request: LLMRequest): Promise<LLMResponse>;
    /**
     * Fallback completion using Ollama API
     */
    private completeWithOllama;
    protected doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    listModels(): Promise<LLMModel[]>;
    getModelInfo(model: LLMModel): Promise<ModelInfo>;
    protected doHealthCheck(): Promise<HealthCheckResult>;
    /**
     * Build ruvLLM native API query format
     * See: https://github.com/ruvnet/ruvector/tree/main/examples/ruvLLM
     */
    private buildRuvectorQuery;
    private buildRequest;
    private transformResponse;
    private handleErrorResponse;
    /**
     * Get SONA learning metrics
     */
    getSonaMetrics(): Promise<{
        enabled: boolean;
        adaptationsApplied: number;
        qualityScore: number;
        patternsLearned: number;
    }>;
    /**
     * Trigger SONA learning from a conversation
     */
    triggerSonaLearning(conversationId: string): Promise<boolean>;
    /**
     * Search HNSW memory for similar patterns
     */
    searchMemory(query: string, limit?: number): Promise<Array<{
        id: string;
        similarity: number;
        content: string;
    }>>;
}
//# sourceMappingURL=ruvector-provider.d.ts.map