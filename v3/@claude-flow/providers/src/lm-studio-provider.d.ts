/**
 * V3 LM Studio Provider - OpenAI-compatible local inference via LM Studio.
 * Zero cost, supports any model the user loads in the LM Studio GUI.
 * @module @claude-flow/providers/lm-studio-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class LMStudioProvider extends BaseProvider {
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
    /** Always true -- LM Studio models are user-loaded and not known ahead of time. */
    validateModel(_model: LLMModel): boolean;
    private buildRequest;
    private transformResponse;
    private handleErrorResponse;
    /** Transform errors with LM Studio-specific connection hints. */
    private transformLMStudioError;
}
//# sourceMappingURL=lm-studio-provider.d.ts.map