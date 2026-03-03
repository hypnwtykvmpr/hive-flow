/**
 * V3 Cohere Provider
 *
 * Supports Command R+, Command R, and Command Light models.
 *
 * @module @claude-flow/providers/cohere-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class CohereProvider extends BaseProvider {
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
//# sourceMappingURL=cohere-provider.d.ts.map