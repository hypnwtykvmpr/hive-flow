/**
 * V3 DeepSeek Provider
 *
 * OpenAI-compatible HTTP provider for DeepSeek's API (api.deepseek.com/v1).
 * Supports DeepSeek-V3 (chat) and DeepSeek-R1 (reasoning).
 * Auth: DEEPSEEK_API_KEY environment variable. Graceful if missing.
 *
 * @module @claude-flow/providers/deepseek-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class DeepSeekProvider extends BaseProvider {
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
    private ensureApiKey;
    private buildRequest;
    private transformResponse;
    private handleErrorResponse;
}
//# sourceMappingURL=deepseek-provider.d.ts.map