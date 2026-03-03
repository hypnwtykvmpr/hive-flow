/**
 * V3 Codex CLI Subprocess Provider
 *
 * Wraps OpenAI's Codex CLI (Rust binary) as a subprocess provider.
 * Auth: ChatGPT subscription OAuth by default (no API key needed).
 * CI/headless auth via CODEX_API_KEY environment variable.
 *
 * @module @claude-flow/providers/codex-cli-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class CodexCLIProvider extends BaseProvider {
    readonly name: LLMProvider;
    readonly capabilities: ProviderCapabilities;
    private binaryPath;
    private activeProcesses;
    private defaultTimeout;
    constructor(options: BaseProviderOptions);
    protected doInitialize(): Promise<void>;
    protected validateConfig(): void;
    protected doComplete(request: LLMRequest): Promise<LLMResponse>;
    protected doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    listModels(): Promise<LLMModel[]>;
    getModelInfo(model: LLMModel): Promise<ModelInfo>;
    protected doHealthCheck(): Promise<HealthCheckResult>;
    destroy(): void;
    private findBinary;
    private ensureBinary;
    private spawnCodex;
    private parseNestedErrorMessage;
    private parseLine;
    private mapCodexError;
}
//# sourceMappingURL=codex-cli-provider.d.ts.map