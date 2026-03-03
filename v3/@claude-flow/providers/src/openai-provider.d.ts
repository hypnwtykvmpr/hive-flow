/**
 * V3 OpenAI Provider
 *
 * Supports GPT-4o, GPT-4, o1, and other OpenAI models.
 *
 * @module @claude-flow/providers/openai-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class OpenAIProvider extends BaseProvider {
    readonly name: LLMProvider;
    readonly capabilities: ProviderCapabilities;
    private baseUrl;
    private headers;
    constructor(options: BaseProviderOptions);
    protected doInitialize(): Promise<void>;
    protected doComplete(request: LLMRequest): Promise<LLMResponse>;
    protected doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    listModels(): Promise<LLMModel[]>;
    getModelInfo(model: LLMModel): Promise<ModelInfo>;
    protected doHealthCheck(): Promise<HealthCheckResult>;
    private buildRequest;
    private transformResponse;
    private handleErrorResponse;
}
//# sourceMappingURL=openai-provider.d.ts.map