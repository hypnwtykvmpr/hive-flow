/**
 * V3 Anthropic (Claude) Provider
 *
 * Supports Claude 3.5, 3 Opus, Sonnet, and Haiku models.
 *
 * @module @claude-flow/providers/anthropic-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class AnthropicProvider extends BaseProvider {
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
//# sourceMappingURL=anthropic-provider.d.ts.map