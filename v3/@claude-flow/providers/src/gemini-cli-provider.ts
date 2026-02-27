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

import { spawn, ChildProcess, execFile } from 'child_process';
import { createInterface } from 'readline';
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMMessage, ModelInfo, ProviderCapabilities, HealthCheckResult,
  LLMProviderError, AuthenticationError, ProviderUnavailableError,
} from './types.js';

/** Gemini CLI exit codes */
const EXIT = { Success: 0, Generic: 1, Auth: 41, Input: 42, Config: 52, Cancel: 130 } as const;

/** Shape returned by `gemini --output-format json` */
interface GeminiJsonOutput {
  response?: string;
  stats?: {
    models?: Record<string, {
      tokens?: { prompt?: number; candidates?: number; total?: number };
    }>;
  };
}

const SUPPORTED_MODELS: LLMModel[] = [
  'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'gemini-3-flash-preview', 'gemini-3.1-pro-preview',
];

const MODEL_DESCRIPTIONS: Record<string, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash - Fast and cost-effective',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite - Ultra-lightweight',
  'gemini-2.5-pro': 'Gemini 2.5 Pro - High capability reasoning',
  'gemini-3-flash-preview': 'Gemini 3 Flash Preview - Next-gen speed',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview - Next-gen reasoning',
};

function makePricing(prompt: number, completion: number) {
  return { promptCostPer1k: prompt, completionCostPer1k: completion, currency: 'USD' };
}

export class GeminiCLIProvider extends BaseProvider {
  readonly name: LLMProvider = 'gemini-cli';

  readonly capabilities: ProviderCapabilities = {
    supportedModels: SUPPORTED_MODELS,
    maxContextLength: {
      'gemini-2.5-flash': 1048576, 'gemini-2.5-flash-lite': 1048576,
      'gemini-2.5-pro': 1048576, 'gemini-3-flash-preview': 1048576,
      'gemini-3.1-pro-preview': 2097152,
    },
    maxOutputTokens: {
      'gemini-2.5-flash': 65536, 'gemini-2.5-flash-lite': 65536,
      'gemini-2.5-pro': 65536, 'gemini-3-flash-preview': 65536,
      'gemini-3.1-pro-preview': 65536,
    },
    supportsStreaming: true,
    supportsToolCalling: false,
    supportsSystemMessages: true,
    supportsVision: false,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 4000000, concurrentRequests: 5 },
    pricing: {
      'gemini-2.5-flash': makePricing(0.00015, 0.0006),
      'gemini-2.5-flash-lite': makePricing(0.0001, 0.0004),
      'gemini-2.5-pro': makePricing(0.00125, 0.01),
      'gemini-3-flash-preview': makePricing(0.0005, 0.003),
      'gemini-3.1-pro-preview': makePricing(0.002, 0.012),
    },
  };

  private binaryPath: string | null = null;
  private activeChildren: Set<ChildProcess> = new Set();

  constructor(options: BaseProviderOptions) {
    super(options);
  }

  /** Skip API key requirement — Gemini CLI uses Google account OAuth. */
  protected validateConfig(): void {
    if (!this.config.model) {
      this.config.model = 'gemini-2.5-flash';
    }
    if (!this.validateModel(this.config.model)) {
      this.logger.warn(`Model ${this.config.model} may not be supported by ${this.name}`);
    }
    if (this.config.temperature !== undefined &&
        (this.config.temperature < 0 || this.config.temperature > 2)) {
      throw new Error('Temperature must be between 0 and 2');
    }
  }

  protected async doInitialize(): Promise<void> {
    this.binaryPath = await this.findBinary();
    if (!this.binaryPath) {
      this.logger.warn(
        'Gemini CLI binary not found in PATH. Install: npm i -g @google/gemini-cli ' +
        'or see https://github.com/google-gemini/gemini-cli'
      );
    } else {
      this.logger.info(`Gemini CLI found at: ${this.binaryPath}`);
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages);
    const timeoutMs = this.config.timeout || 120000;
    const args = ['-p', prompt, '--output-format', 'json', '--model', model];

    return new Promise<LLMResponse>((resolve, reject) => {
      const child = spawn(this.binaryPath!, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      this.activeChildren.add(child);
      child.stdin.end(); // CRITICAL: prevent hang (#6715)

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      // CRITICAL: SIGKILL on timeout — Gemini CLI ignores SIGTERM (#15874)
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        this.activeChildren.delete(child);
        reject(new LLMProviderError(
          `Gemini CLI timed out after ${timeoutMs}ms`, 'TIMEOUT', 'gemini-cli', undefined, true
        ));
      }, timeoutMs);

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        if (code !== EXIT.Success) { reject(this.exitCodeToError(code, stderr)); return; }
        try { resolve(this.parseJsonOutput(stdout, model)); }
        catch (e) { reject(this.transformError(e instanceof Error ? e : new Error(String(e)))); }
      });

      child.on('error', (err: Error) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        reject(this.transformError(err));
      });
    });
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages);
    const timeoutMs = (this.config.timeout || 120000) * 2;
    const args = ['-p', prompt, '--output-format', 'stream-json', '--model', model];

    const child = spawn(this.binaryPath!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.activeChildren.add(child);
    child.stdin.end(); // CRITICAL (#6715)

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      this.activeChildren.delete(child);
    }, timeoutMs);

    const rl = createInterface({ input: child.stdout });
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as GeminiJsonOutput;
          if (evt.response) {
            yield { type: 'content', delta: { content: evt.response } };
          }
          if (evt.stats?.models) {
            const s = Object.values(evt.stats.models)[0];
            if (s?.tokens) {
              promptTokens = s.tokens.prompt || 0;
              completionTokens = s.tokens.candidates || 0;
            }
          }
        } catch { /* non-JSON line — skip */ }
      }

      const pricing = this.capabilities.pricing[model];
      const pCost = pricing ? (promptTokens / 1000) * pricing.promptCostPer1k : 0;
      const cCost = pricing ? (completionTokens / 1000) * pricing.completionCostPer1k : 0;

      yield {
        type: 'done',
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        cost: { promptCost: pCost, completionCost: cCost, totalCost: pCost + cCost, currency: 'USD' },
      };
    } finally {
      clearTimeout(timer);
      rl.close();
      if (!child.killed) child.kill('SIGKILL');
      this.activeChildren.delete(child);
    }
  }

  async listModels(): Promise<LLMModel[]> {
    return [...SUPPORTED_MODELS];
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    const p = this.capabilities.pricing[model];
    return {
      model, name: model,
      description: MODEL_DESCRIPTIONS[model] || 'Gemini CLI model',
      contextLength: this.capabilities.maxContextLength[model] || 1048576,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 65536,
      supportedFeatures: ['chat', 'completion', 'cli-subprocess'],
      pricing: p ? { promptCostPer1k: p.promptCostPer1k, completionCostPer1k: p.completionCostPer1k, currency: p.currency } : undefined,
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    if (!this.binaryPath) this.binaryPath = await this.findBinary();

    if (!this.binaryPath) {
      return {
        healthy: false, error: 'Gemini CLI binary not found in PATH',
        timestamp: new Date(),
        details: { hint: 'Install: npm i -g @google/gemini-cli' },
      };
    }

    try {
      const version = await this.runVersion();
      return {
        healthy: true, timestamp: new Date(),
        details: { binary: this.binaryPath, version, authMethod: 'google-oauth' },
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Failed to run gemini --version',
        timestamp: new Date(),
        details: { binary: this.binaryPath, hint: 'Gemini CLI installed but may not be functional' },
      };
    }
  }

  /** Kill active child processes and clean up. */
  destroy(): void {
    for (const child of this.activeChildren) {
      if (!child.killed) child.kill('SIGKILL');
    }
    this.activeChildren.clear();
    super.destroy();
  }

  // -- Private helpers --------------------------------------------------------

  /** Locate `gemini` binary in PATH. */
  private findBinary(): Promise<string | null> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(cmd, ['gemini'], (err, stdout) => {
        resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0] : null);
      });
    });
  }

  /** Run `gemini --version`. */
  private runVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.binaryPath!, ['--version'], { timeout: 10000 }, (err, out, serr) => {
        if (err) { reject(err); return; }
        resolve((out || serr).trim() || 'unknown');
      });
    });
  }

  /** Guard: throw if binary not found. */
  private ensureBinary(): void {
    if (!this.binaryPath) {
      throw new ProviderUnavailableError('gemini-cli', {
        message: 'Gemini CLI binary not found in PATH',
        hint: 'Install: npm i -g @google/gemini-cli',
      });
    }
  }

  /** Parse JSON from CLI stdout with malformed-JSON fallback (#9009). */
  private parseJsonOutput(stdout: string, model: LLMModel): LLMResponse {
    let parsed: GeminiJsonOutput;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      this.logger.warn('Gemini CLI returned malformed JSON; falling back to raw text');
      const content = stdout.trim();
      if (!content) {
        throw new LLMProviderError('Gemini CLI returned empty output', 'EMPTY_RESPONSE', 'gemini-cli', undefined, true);
      }
      return this.buildResponse(content, model, 0, 0);
    }

    let promptTokens = 0;
    let completionTokens = 0;
    if (parsed.stats?.models) {
      const s = Object.values(parsed.stats.models)[0];
      if (s?.tokens) {
        promptTokens = s.tokens.prompt || 0;
        completionTokens = s.tokens.candidates || 0;
      }
    }
    return this.buildResponse(parsed.response || '', model, promptTokens, completionTokens);
  }

  /** Build a standardized LLMResponse with cost tracking. */
  private buildResponse(
    content: string, model: LLMModel, promptTokens: number, completionTokens: number
  ): LLMResponse {
    const pricing = this.capabilities.pricing[model];
    const pCost = pricing ? (promptTokens / 1000) * pricing.promptCostPer1k : 0;
    const cCost = pricing ? (completionTokens / 1000) * pricing.completionCostPer1k : 0;
    return {
      id: `gemini-cli-${Date.now()}`, model, provider: 'gemini-cli', content,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      cost: { promptCost: pCost, completionCost: cCost, totalCost: pCost + cCost, currency: 'USD' },
      finishReason: 'stop',
    };
  }

  /** Map Gemini CLI exit codes to typed provider errors. */
  private exitCodeToError(code: number | null, stderr: string): LLMProviderError {
    const msg = stderr.trim() || `Gemini CLI exited with code ${code}`;
    switch (code) {
      case EXIT.Auth:
        return new AuthenticationError(
          `Gemini CLI auth failed: ${msg}. Run 'gemini auth' to re-authenticate.`,
          'gemini-cli', { exitCode: code }
        );
      case EXIT.Input:
        return new LLMProviderError(`Gemini CLI input error: ${msg}`, 'INVALID_INPUT', 'gemini-cli', undefined, false, { exitCode: code });
      case EXIT.Config:
        return new LLMProviderError(`Gemini CLI config error: ${msg}`, 'CONFIG_ERROR', 'gemini-cli', undefined, false, { exitCode: code });
      case EXIT.Cancel:
        return new LLMProviderError('Gemini CLI request was cancelled', 'CANCELLED', 'gemini-cli', undefined, true, { exitCode: code });
      default:
        return new LLMProviderError(msg, 'CLI_ERROR', 'gemini-cli', undefined, true, { exitCode: code });
    }
  }

  /**
   * Format LLMMessage[] into a single prompt string for the CLI.
   * System messages first, then user/assistant turns in order.
   */
  private formatMessages(messages: LLMMessage[]): string {
    const systemParts: string[] = [];
    const convParts: string[] = [];

    for (const msg of messages) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n');

      if (msg.role === 'system') {
        systemParts.push(text);
      } else {
        const label = msg.role === 'assistant' ? 'Assistant' : 'User';
        convParts.push(`${label}: ${text}`);
      }
    }

    const parts: string[] = [];
    if (systemParts.length > 0) parts.push(`System: ${systemParts.join('\n')}`);
    if (convParts.length > 0) parts.push(convParts.join('\n'));
    return parts.join('\n\n');
  }
}
