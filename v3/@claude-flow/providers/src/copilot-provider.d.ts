/**
 * V3 GitHub Copilot Provider
 *
 * OpenAI-compatible HTTP provider wrapping the copilot-api npm package,
 * which exposes GitHub Copilot as an OpenAI-compatible local server.
 *
 * Default endpoint: http://localhost:4141/v1 (copilot-api default port)
 * Auth: GITHUB_TOKEN environment variable (required for copilot-api).
 * Requires active GitHub Copilot subscription.
 *
 * Setup: npx copilot-api (starts local server)
 *
 * @module @claude-flow/providers/copilot-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class CopilotProvider extends BaseProvider {
    readonly name: LLMProvider;
    readonly capabilities: ProviderCapabilities;
    private baseUrl;
    private headers;
    constructor(options: BaseProviderOptions);
    /** Accept any model string since copilot-api proxies whatever Copilot supports. */
    validateModel(_model: LLMModel): boolean;
    protected doInitialize(): Promise<void>;
    protected doComplete(request: LLMRequest): Promise<LLMResponse>;
    protected doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    listModels(): Promise<LLMModel[]>;
    getModelInfo(model: LLMModel): Promise<ModelInfo>;
    protected doHealthCheck(): Promise<HealthCheckResult>;
    private buildRequest;
    private transformResponse;
    private handleErrorResponse;
    private transformCopilotError;
}
//# sourceMappingURL=copilot-provider.d.ts.map