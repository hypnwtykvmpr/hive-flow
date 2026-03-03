/**
 * V3 Cursor CLI Subprocess Provider
 *
 * Wraps the `cursor` binary (falling back to `cursor-agent`) as a subprocess provider.
 * Uses --print flag for non-interactive mode (resolves TTY requirement).
 * Auth: CURSOR_API_KEY environment variable or --api-key flag.
 *
 * Invocation patterns:
 * - Non-streaming: cursor --print --output-format json --model <model> "prompt"
 * - Streaming:     cursor --print --output-format stream-json --stream-partial-output --model <model> "prompt"
 *
 * @module @claude-flow/providers/cursor-cli-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class CursorCLIProvider extends BaseProvider {
    readonly name: LLMProvider;
    readonly capabilities: ProviderCapabilities;
    private binaryPath;
    private activeProcesses;
    private defaultTimeout;
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
    private whichBinary;
    private ensureBinary;
    private spawnCursor;
    private parseJsonOutput;
    private buildResponse;
    private formatMessages;
}
//# sourceMappingURL=cursor-cli-provider.d.ts.map