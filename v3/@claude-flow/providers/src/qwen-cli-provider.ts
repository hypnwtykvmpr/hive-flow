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

import { spawn, ChildProcess, execFile } from 'child_process';
import { createInterface } from 'readline';
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMMessage, ModelInfo, ProviderCapabilities, HealthCheckResult,
  LLMProviderError, ProviderUnavailableError,
} from './types.js';

const SUPPORTED_MODELS: LLMModel[] = ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'];

const MODEL_DESC: Record<string, string> = {
  'qwen-max': 'Qwen Max via CLI - Flagship model',
  'qwen-plus': 'Qwen Plus via CLI - Balanced',
  'qwen-turbo': 'Qwen Turbo via CLI - Fast',
  'qwen-long': 'Qwen Long via CLI - Ultra-long context',
};

const p = (prompt: number, completion: number) =>
  ({ promptCostPer1k: prompt, completionCostPer1k: completion, currency: 'USD' });

export class QwenCLIProvider extends BaseProvider {
  readonly name: LLMProvider = 'qwen-cli';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: SUPPORTED_MODELS,
    maxContextLength: {
      'qwen-max': 32768, 'qwen-plus': 131072, 'qwen-turbo': 131072, 'qwen-long': 10000000,
    },
    maxOutputTokens: {
      'qwen-max': 8192, 'qwen-plus': 8192, 'qwen-turbo': 8192, 'qwen-long': 8192,
    },
    supportsStreaming: true,
    supportsToolCalling: false,
    supportsSystemMessages: true,
    supportsVision: false,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 2000000, concurrentRequests: 5 },
    pricing: {
      'qwen-max': p(0.0016, 0.0064),
      'qwen-plus': p(0.0004, 0.0012),
      'qwen-turbo': p(0.0002, 0.0006),
      'qwen-long': p(0.00005, 0.0002),
    },
  };

  private binaryPath: string | null = null;
  private activeChildren: Set<ChildProcess> = new Set();

  constructor(options: BaseProviderOptions) { super(options); }

  protected validateConfig(): void {
    if (!this.config.model) this.config.model = 'qwen-turbo';
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
        'Qwen CLI binary not found in PATH. Install: npm i -g @qwen-code/qwen-code'
      );
    } else {
      this.logger.info(`Qwen CLI found at: ${this.binaryPath}`);
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages);
    const timeoutMs = this.config.timeout || 120000;
    const args = [prompt, '--output-format', 'json', '-m', model];

    return new Promise<LLMResponse>((resolve, reject) => {
      const child = spawn(this.binaryPath!, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      this.activeChildren.add(child);
      child.stdin.end(); // Prevent hang

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        this.activeChildren.delete(child);
        reject(new LLMProviderError(
          `Qwen CLI timed out after ${timeoutMs}ms`, 'TIMEOUT', 'qwen-cli', undefined, true
        ));
      }, timeoutMs);

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        if (code !== 0) { reject(this.exitCodeToError(code, stderr)); return; }
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
    const args = [prompt, '--output-format', 'stream-json', '-m', model];

    const child = spawn(this.binaryPath!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.activeChildren.add(child);
    child.stdin.end();

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
          const evt = JSON.parse(line) as Record<string, unknown>;

          // Handle assistant message events (content)
          if (evt.type === 'assistant' && evt.message) {
            const msg = evt.message as Record<string, unknown>;
            const content = msg.content;
            const text = Array.isArray(content)
              ? (content as Array<{ text?: string }>).map((p) => p.text || '').join('')
              : typeof content === 'string' ? content : '';
            if (text) yield { type: 'content', delta: { content: text } };
            const usage = msg.usage as Record<string, number> | undefined;
            if (usage) {
              promptTokens = usage.input_tokens || 0;
              completionTokens = usage.output_tokens || 0;
            }
          }

          // Handle result events (completion)
          if (evt.type === 'result') {
            const result = (evt.result || '') as string;
            if (result && !promptTokens) yield { type: 'content', delta: { content: result } };
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

  async listModels(): Promise<LLMModel[]> { return [...SUPPORTED_MODELS]; }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    const pr = this.capabilities.pricing[model];
    return {
      model, name: model,
      description: MODEL_DESC[model] || 'Qwen CLI model',
      contextLength: this.capabilities.maxContextLength[model] || 32768,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 8192,
      supportedFeatures: ['chat', 'completion', 'cli-subprocess'],
      pricing: pr ? { ...pr } : undefined,
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    if (!this.binaryPath) this.binaryPath = await this.findBinary();
    if (!this.binaryPath) {
      return { healthy: false, error: 'Qwen CLI binary not found in PATH', timestamp: new Date(),
        details: { hint: 'Install: npm i -g @qwen-code/qwen-code' } };
    }
    try {
      const version = await this.runVersion();
      return { healthy: true, timestamp: new Date(),
        details: { binary: this.binaryPath, version, authMethod: 'qwen-oauth' } };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : 'Failed to run qwen --version',
        timestamp: new Date(), details: { binary: this.binaryPath } };
    }
  }

  destroy(): void {
    for (const child of this.activeChildren) { if (!child.killed) child.kill('SIGKILL'); }
    this.activeChildren.clear();
    super.destroy();
  }

  // -- Private helpers -------------------------------------------------------

  private findBinary(): Promise<string | null> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(cmd, ['qwen'], (err, stdout) => {
        resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0] : null);
      });
    });
  }

  private runVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.binaryPath!, ['--version'], { timeout: 10000 }, (err, out, serr) => {
        if (err) { reject(err); return; }
        resolve((out || serr).trim() || 'unknown');
      });
    });
  }

  private ensureBinary(): void {
    if (!this.binaryPath) {
      throw new ProviderUnavailableError('qwen-cli', {
        message: 'Qwen CLI binary not found in PATH',
        hint: 'Install: npm i -g @qwen-code/qwen-code',
      });
    }
  }

  private parseJsonOutput(stdout: string, model: LLMModel): LLMResponse {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      this.logger.warn('Qwen CLI returned non-JSON output; using raw text');
      const content = stdout.trim();
      if (!content) {
        throw new LLMProviderError('Qwen CLI returned empty output', 'EMPTY_RESPONSE', 'qwen-cli', undefined, true);
      }
      return this.buildResponse(content, model, 0, 0);
    }

    const content = ((parsed.result ?? parsed.response ?? parsed.content ?? '') as string);
    const usage = (parsed.usage ?? {}) as Record<string, number>;
    const promptTokens = usage.input_tokens || usage.prompt_tokens || 0;
    const completionTokens = usage.output_tokens || usage.completion_tokens || 0;

    return this.buildResponse(content, model, promptTokens, completionTokens);
  }

  private buildResponse(content: string, model: LLMModel, promptTokens: number, completionTokens: number): LLMResponse {
    const pricing = this.capabilities.pricing[model];
    const pCost = pricing ? (promptTokens / 1000) * pricing.promptCostPer1k : 0;
    const cCost = pricing ? (completionTokens / 1000) * pricing.completionCostPer1k : 0;
    return {
      id: `qwen-cli-${Date.now()}`, model, provider: 'qwen-cli', content,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      cost: { promptCost: pCost, completionCost: cCost, totalCost: pCost + cCost, currency: 'USD' },
      finishReason: 'stop',
    };
  }

  private exitCodeToError(code: number | null, stderr: string): LLMProviderError {
    const msg = stderr.trim() || `Qwen CLI exited with code ${code}`;
    return new LLMProviderError(msg, 'CLI_ERROR', 'qwen-cli', undefined, true, { exitCode: code });
  }

  private formatMessages(messages: LLMMessage[]): string {
    const systemParts: string[] = [];
    const convParts: string[] = [];
    for (const msg of messages) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n');
      if (msg.role === 'system') { systemParts.push(text); }
      else { convParts.push(`${msg.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`); }
    }
    const parts: string[] = [];
    if (systemParts.length > 0) parts.push(`System: ${systemParts.join('\n')}`);
    if (convParts.length > 0) parts.push(convParts.join('\n'));
    return parts.join('\n\n');
  }
}
