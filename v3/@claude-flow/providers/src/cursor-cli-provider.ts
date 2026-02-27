/**
 * V3 Cursor Agent CLI Subprocess Provider
 *
 * Wraps the `cursor-agent` binary as a subprocess provider.
 * Uses --print flag for non-interactive mode (resolves TTY requirement).
 * Auth: CURSOR_API_KEY environment variable or --api-key flag.
 *
 * Invocation patterns:
 * - Non-streaming: cursor-agent --print --output-format json --model <model> "prompt"
 * - Streaming:     cursor-agent --print --output-format stream-json --stream-partial-output --model <model> "prompt"
 *
 * @module @claude-flow/providers/cursor-cli-provider
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { createInterface } from 'readline';
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMMessage, ModelInfo, ProviderCapabilities, HealthCheckResult,
  LLMProviderError, AuthenticationError, ProviderUnavailableError,
} from './types.js';

const CURSOR_MODELS: LLMModel[] = [
  'auto', 'composer-1.5', 'composer-1',
  'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2',
];

const MODEL_DESC: Record<string, string> = {
  'auto': 'Auto - Cursor selects optimal model',
  'composer-1.5': 'Composer 1.5 - Latest Cursor-native model',
  'composer-1': 'Composer 1 - Cursor-native model',
  'gpt-5.3-codex': 'GPT-5.3 Codex via Cursor - Flagship code model',
  'gpt-5.2-codex': 'GPT-5.2 Codex via Cursor - Previous-gen flagship',
  'gpt-5.2': 'GPT-5.2 via Cursor - General purpose',
};

const FREE = { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' };

function calcCost(prompt: number, completion: number, pricing: { promptCostPer1k: number; completionCostPer1k: number }) {
  const p = (prompt / 1000) * pricing.promptCostPer1k;
  const c = (completion / 1000) * pricing.completionCostPer1k;
  return { promptCost: p, completionCost: c, totalCost: p + c, currency: 'USD' };
}

export class CursorCLIProvider extends BaseProvider {
  readonly name: LLMProvider = 'cursor-cli';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: CURSOR_MODELS,
    maxContextLength: {
      'auto': 200000, 'composer-1.5': 200000, 'composer-1': 200000,
      'gpt-5.3-codex': 200000, 'gpt-5.2-codex': 200000, 'gpt-5.2': 200000,
    },
    maxOutputTokens: {
      'auto': 32768, 'composer-1.5': 32768, 'composer-1': 16384,
      'gpt-5.3-codex': 32768, 'gpt-5.2-codex': 32768, 'gpt-5.2': 16384,
    },
    supportsStreaming: true,
    supportsToolCalling: false,
    supportsSystemMessages: true,
    supportsVision: false,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 1000000, concurrentRequests: 5 },
    pricing: {
      'auto': FREE, 'composer-1.5': FREE, 'composer-1': FREE,
      'gpt-5.3-codex': FREE, 'gpt-5.2-codex': FREE, 'gpt-5.2': FREE,
    },
  };

  private binaryPath: string | null = null;
  private activeProcesses: Set<ChildProcess> = new Set();
  private defaultTimeout: number;

  constructor(options: BaseProviderOptions) {
    super(options);
    this.defaultTimeout = options.config.timeout || 120000;
  }

  protected validateConfig(): void {
    if (!this.config.model) this.config.model = 'auto';
    if (!this.validateModel(this.config.model)) {
      this.logger.warn(`Model ${this.config.model} may not be supported by ${this.name}`);
    }
  }

  protected async doInitialize(): Promise<void> {
    this.binaryPath = await this.findBinary();
    if (!this.binaryPath) {
      this.logger.warn('Cursor Agent CLI binary not found. Check ~/.local/bin/cursor-agent');
    } else {
      this.logger.info('Cursor Agent CLI found', { path: this.binaryPath });
    }
    const apiKey = this.config.apiKey || process.env.CURSOR_API_KEY;
    if (!apiKey) {
      this.logger.warn('CURSOR_API_KEY not set. Some models may require authentication.');
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages);
    const child = this.spawnCursor(prompt, model, false);

    return new Promise<LLMResponse>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new LLMProviderError('Request timed out', 'TIMEOUT', 'cursor-cli', undefined, true));
      }, this.defaultTimeout);

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        if (code !== 0 && !stdout.trim()) {
          reject(new LLMProviderError(
            stderr.trim() || `Exited with code ${code}`, 'EXECUTION_FAILED', 'cursor-cli', undefined, true
          ));
          return;
        }
        try { resolve(this.parseJsonOutput(stdout, model)); }
        catch (e) { reject(this.transformError(e instanceof Error ? e : new Error(String(e)))); }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        reject(this.transformError(err));
      });
    });
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages);
    const child = this.spawnCursor(prompt, model, true);
    const rl = createInterface({ input: child.stdout! });

    const queue: string[] = [];
    let done = false;
    let notify: (() => void) | null = null;
    const wake = () => { if (notify) { notify(); notify = null; } };

    rl.on('line', (line) => { queue.push(line); wake(); });
    child.on('close', () => { done = true; this.activeProcesses.delete(child); rl.close(); wake(); });
    child.on('error', () => { done = true; this.activeProcesses.delete(child); rl.close(); wake(); });

    const timer = setTimeout(() => { child.kill('SIGTERM'); done = true; wake(); }, this.defaultTimeout * 2);

    let promptTokens = 0;
    let completionTokens = 0;

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0 && !done) {
          await new Promise<void>((r) => { notify = r; });
          continue;
        }
        const line = queue.shift();
        if (!line?.trim()) continue;

        try {
          const evt = JSON.parse(line) as Record<string, unknown>;

          // Content delta events
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

          // Direct content delta
          if (evt.content && typeof evt.content === 'string') {
            yield { type: 'content', delta: { content: evt.content as string } };
          }

          // Result/completion event
          if (evt.type === 'result') {
            const usage = evt.usage as Record<string, number> | undefined;
            if (usage) {
              promptTokens = usage.input_tokens || usage.prompt_tokens || promptTokens;
              completionTokens = usage.output_tokens || usage.completion_tokens || completionTokens;
            }
          }
        } catch { /* non-JSON line */ }
      }

      const pricing = this.capabilities.pricing[model] || FREE;
      yield {
        type: 'done',
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        cost: calcCost(promptTokens, completionTokens, pricing),
      };
    } finally {
      clearTimeout(timer);
      if (!done) { child.kill('SIGTERM'); this.activeProcesses.delete(child); }
    }
  }

  async listModels(): Promise<LLMModel[]> { return [...CURSOR_MODELS]; }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    const pricing = this.capabilities.pricing[model];
    return {
      model, name: model,
      description: MODEL_DESC[model] || 'Cursor Agent model',
      contextLength: this.capabilities.maxContextLength[model] || 200000,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 32768,
      supportedFeatures: ['chat', 'code-generation', 'cli-subprocess'],
      pricing: pricing ? { ...pricing } : undefined,
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    if (!this.binaryPath) {
      const found = await this.findBinary();
      if (found) this.binaryPath = found;
    }
    if (!this.binaryPath) {
      return { healthy: false, error: 'Cursor Agent CLI binary not found', timestamp: new Date(),
        details: { hint: 'Install Cursor Agent from https://cursor.com' } };
    }
    return new Promise((resolve) => {
      execFile(this.binaryPath!, ['--version'], { timeout: 10000 }, (error, stdout) => {
        if (error) {
          resolve({ healthy: false, error: `cursor-agent --version failed: ${error.message}`, timestamp: new Date() });
          return;
        }
        const version = stdout.trim();
        resolve({ healthy: true, timestamp: new Date(),
          details: { version, binaryPath: this.binaryPath, authMethod: 'cursor-api-key' } });
      });
    });
  }

  destroy(): void {
    for (const p of this.activeProcesses) { try { p.kill('SIGTERM'); } catch { /* already dead */ } }
    this.activeProcesses.clear();
    super.destroy();
  }

  // -- Private helpers -------------------------------------------------------

  private findBinary(): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, ['cursor-agent'], (err, stdout) => {
        resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0] : null);
      });
    });
  }

  private ensureBinary(): void {
    if (!this.binaryPath) {
      throw new ProviderUnavailableError('cursor-cli', {
        message: 'Cursor Agent CLI binary not found',
        hint: 'Install Cursor Agent from https://cursor.com',
      });
    }
  }

  private spawnCursor(prompt: string, model: LLMModel, stream: boolean): ChildProcess {
    const args = [
      '--print',
      '--output-format', stream ? 'stream-json' : 'json',
      '--model', String(model),
      ...(stream ? ['--stream-partial-output'] : []),
      prompt,
    ];

    const env = { ...process.env };
    const apiKey = this.config.apiKey || process.env.CURSOR_API_KEY;
    if (apiKey) {
      args.unshift('--api-key', apiKey);
    }

    const child = spawn(this.binaryPath!, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.activeProcesses.add(child);
    child.stdin.end(); // Prevent hang
    return child;
  }

  private parseJsonOutput(stdout: string, model: LLMModel): LLMResponse {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      this.logger.warn('Cursor Agent returned non-JSON output; using raw text');
      const content = stdout.trim();
      if (!content) {
        throw new LLMProviderError('Cursor Agent returned empty output', 'EMPTY_RESPONSE', 'cursor-cli', undefined, true);
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
    const pricing = this.capabilities.pricing[model] || FREE;
    return {
      id: `cursor-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      model, provider: 'cursor-cli', content,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      cost: calcCost(promptTokens, completionTokens, pricing),
      finishReason: 'stop',
    };
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
