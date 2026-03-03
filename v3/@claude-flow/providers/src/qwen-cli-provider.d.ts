/**
 * V3 Qwen CLI Subprocess Provider
 *
 * Wraps the `qwen` CLI binary (Qwen Code v0.10.6+) as a subprocess provider.
 * Auth: Local Qwen OAuth — no API key needed.
 *
 * Invocation patterns:
 * - Non-streaming: qwen "prompt" --output-format json -m <model>
 * - Streaming:     qwen "prompt" --output-format stream-json -m <model>
 *
 * @module @claude-flow/providers/qwen-cli-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class QwenCLIProvider extends BaseProvider {
    readonly name: LLMProvider;
    readonly capabilities: ProviderCapabilities;
    private binaryPath;
    private activeChildren;
    constructor(options: BaseProviderOptions);
    protected validateConfig(): void;
    protected doInitialize(): Promise<void>;
    protected doComplete(request: LLMRequest): Promise<LLMResponse>;
    protected doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    listModels(): Promise<LLMModel[]>;
    getModelInfo(model: LLMModel): Promise<ModelInfo>;
    protected doHealthCheck(): Promise<HealthCheckResult>;
    destroy(): void;
    private findBinary;
    private runVersion;
    private ensureBinary;
    private parseJsonOutput;
    private buildResponse;
    private exitCodeToError;
    private formatMessages;
}
//# sourceMappingURL=qwen-cli-provider.d.ts.map