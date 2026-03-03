/**
 * V3 Gemini CLI Subprocess Provider
 *
 * Wraps the `gemini` CLI binary as a subprocess instead of HTTP requests.
 * Auth: Google account OAuth via Gemini CLI — no API key needed.
 *
 * Known issues handled:
 * - #6715:  stdin must be closed immediately or process hangs
 * - #9009:  JSON output can be malformed; fallback to raw text
 * - #15874: Gemini CLI ignores SIGTERM; use SIGKILL on timeout
 *
 * @module @claude-flow/providers/gemini-cli-provider
 */
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import { LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent, ModelInfo, ProviderCapabilities, HealthCheckResult } from './types.js';
export declare class GeminiCLIProvider extends BaseProvider {
    readonly name: LLMProvider;
    readonly capabilities: ProviderCapabilities;
    private binaryPath;
    private activeChildren;
    constructor(options: BaseProviderOptions);
    /** Skip API key requirement — Gemini CLI uses Google account OAuth. */
    protected validateConfig(): void;
    protected doInitialize(): Promise<void>;
    protected doComplete(request: LLMRequest): Promise<LLMResponse>;
    protected doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
    listModels(): Promise<LLMModel[]>;
    getModelInfo(model: LLMModel): Promise<ModelInfo>;
    protected doHealthCheck(): Promise<HealthCheckResult>;
    /** Kill active child processes and clean up. */
    destroy(): void;
    /** Locate `gemini` binary in PATH. */
    private findBinary;
    /** Run `gemini --version`. */
    private runVersion;
    /** Check if the binary runs under our minimal env (does NOT verify auth — just binary health). */
    private checkBinaryRunnable;
    private minimalEnv;
    /** Guard: throw if binary not found. */
    private ensureBinary;
    /** Parse JSON from CLI stdout with malformed-JSON fallback (#9009). */
    private parseJsonOutput;
    /** Build a standardized LLMResponse with cost tracking. */
    private buildResponse;
    /** Map Gemini CLI exit codes to typed provider errors. */
    private exitCodeToError;
    /**
     * Format LLMMessage[] into a single prompt string for the CLI.
     * System messages first, then user/assistant turns in order.
     */
    private formatMessages;
}
//# sourceMappingURL=gemini-cli-provider.d.ts.map