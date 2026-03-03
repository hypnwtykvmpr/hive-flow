/**
 * V3 Qwen API Provider
 *
 * OpenAI-compatible HTTP provider for Alibaba Cloud's Qwen models via DashScope.
 * Base URL: dashscope-intl.aliyuncs.com/compatible-mode/v1
 * Auth: QWEN_API_KEY or DASHSCOPE_API_KEY environment variable. Graceful if missing.
 *
 * @module @claude-flow/providers/qwen-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class QwenProvider extends BaseProvider {
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
//# sourceMappingURL=qwen-provider.d.ts.map