/**
 * V3 OpenRouter Provider
 *
 * OpenAI-compatible provider for OpenRouter's unified API gateway.
 * Supports 200+ models via provider/model naming (e.g. google/gemini-2.5-flash).
 *
 * @module @claude-flow/providers/openrouter-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class OpenRouterProvider extends BaseProvider {
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
    /** Accept any provider/model string since OpenRouter proxies hundreds of models. */
    validateModel(model: LLMModel): boolean;
    protected doHealthCheck(): Promise<HealthCheckResult>;
    private buildRequest;
    private transformResponse;
    private handleErrorResponse;
}
//# sourceMappingURL=openrouter-provider.d.ts.map