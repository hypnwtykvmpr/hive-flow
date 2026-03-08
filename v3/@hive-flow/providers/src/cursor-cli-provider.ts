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
 * @module @hive-flow/providers/cursor-cli-provider
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { createInterface } from 'readline';
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMMessage, LLMTool, LLMToolCall, ModelInfo, ProviderCapabilities, HealthCheckResult,
  LLMProviderError, ProviderUnavailableError,
} from './types.js';
import { parseToolCallsFromContent, formatToolInstructions, flushToolCallsFromBuffer } from './tool-call-utils.js';

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

/** Safety limit to prevent unbounded stdout accumulation */
const MAX_STDOUT_BYTES = 50 * 1024 * 1024; // 50 MB

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
    supportsToolCalling: true,
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
      this.logger.warn('Cursor CLI binary not found. Install Cursor from https://cursor.com or check PATH for `cursor` / `cursor-agent`.');
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
    const prompt = this.formatMessages(request.messages, request.tools);
    const child = this.spawnCursor(prompt, model, false);

    return new Promise<LLMResponse>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      // Declare timer before listeners that reference it
      const timeoutMs = request.timeout || this.defaultTimeout;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        this.activeProcesses.delete(child);
        reject(new LLMProviderError(`Request timed out after ${timeoutMs}ms`, 'TIMEOUT', 'cursor-cli', undefined, true));
      }, timeoutMs);

      child.stdout!.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > MAX_STDOUT_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          this.activeProcesses.delete(child);
          reject(new LLMProviderError(
            'Response exceeded maximum size (50MB)', 'RESPONSE_TOO_LARGE', 'cursor-cli', undefined, false
          ));
        }
      });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        if (settled) return;
        settled = true;
        if (code !== 0 && !stdout.trim()) {
          reject(new LLMProviderError(
            stderr.trim() || `Exited with code ${code}`, 'EXECUTION_FAILED', 'cursor-cli', undefined, true
          ));
          return;
        }
        if (code !== 0 && stdout.trim()) {
          this.logger.warn('Cursor CLI exited with non-zero code but returned stdout; parsing response', { code, stderr: stderr.slice(-500) });
        }
        try {
          resolve(this.parseJsonOutput(stdout, model));
        } catch (e) {
          reject(this.transformError(e instanceof Error ? e : new Error(String(e))));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        if (settled) return;
        settled = true;
        reject(this.transformError(err));
      });
    });
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages, request.tools);
    const child = this.spawnCursor(prompt, model, true);
    const rl = createInterface({ input: child.stdout! });

    const queue: string[] = [];
    let done = false;
    let spawnError: Error | null = null;
    let notify: (() => void) | null = null;
    const wake = () => { if (notify) { notify(); notify = null; } };

    rl.on('line', (line) => { queue.push(line); wake(); });
    child.on('close', () => { done = true; this.activeProcesses.delete(child); rl.close(); wake(); });
    child.on('error', (err) => { spawnError = err; done = true; this.activeProcesses.delete(child); rl.close(); wake(); });

    const streamTimeoutMs = (request.timeout || this.defaultTimeout) * 2;
    const timer = setTimeout(() => { child.kill('SIGKILL'); done = true; wake(); }, streamTimeoutMs);

    let promptTokens = 0;
    let completionTokens = 0;

    // Buffer for tool_call detection: emit content and tool_call events as complete blocks appear
    let contentBuffer = '';
    let streamToolCallCount = 0;

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
            if (text) {
              contentBuffer += text;
              const flushed = flushToolCallsFromBuffer(contentBuffer, 'cursor', streamToolCallCount);
              contentBuffer = flushed.remainingBuffer;
              streamToolCallCount = flushed.count;
              for (const event of flushed.events) {
                yield event;
              }
            }
            const usage = msg.usage as Record<string, number> | undefined;
            if (usage) {
              promptTokens = usage.inputTokens || usage.input_tokens || 0;
              completionTokens = usage.outputTokens || usage.output_tokens || 0;
            }
          }

          // Direct content delta
          if (evt.content && typeof evt.content === 'string') {
            contentBuffer += evt.content;
            const flushed = flushToolCallsFromBuffer(contentBuffer, 'cursor', streamToolCallCount);
            contentBuffer = flushed.remainingBuffer;
            streamToolCallCount = flushed.count;
            for (const event of flushed.events) {
              yield event;
            }
          }

          // Result/completion event
          if (evt.type === 'result') {
            const usage = evt.usage as Record<string, number> | undefined;
            if (usage) {
              promptTokens = usage.inputTokens || usage.input_tokens || usage.prompt_tokens || promptTokens;
              completionTokens = usage.outputTokens || usage.output_tokens || usage.completion_tokens || completionTokens;
            }
          }
        } catch { /* non-JSON line */ }
      }

      // Emit any remaining buffer as content
      if (contentBuffer.length > 0) {
        yield { type: 'content', delta: { content: contentBuffer } };
      }

      // Surface spawn errors instead of silently completing
      if (spawnError) {
        yield { type: 'error', error: this.transformError(spawnError) };
        return;
      }

      const pricing = this.capabilities.pricing[model] || FREE;
      yield {
        type: 'done',
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        cost: calcCost(promptTokens, completionTokens, pricing),
      };
    } finally {
      clearTimeout(timer);
      rl.close();
      if (!done) { child.kill('SIGKILL'); this.activeProcesses.delete(child); }
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
          resolve({ healthy: false, error: `cursor --version failed: ${error.message}`, timestamp: new Date() });
          return;
        }
        const version = stdout.trim();
        resolve({ healthy: true, timestamp: new Date(),
          details: { version, binaryPath: this.binaryPath, authMethod: 'cursor-api-key' } });
      });
    });
  }

  destroy(): void {
    for (const p of this.activeProcesses) { try { p.kill('SIGKILL'); } catch { /* already dead */ } }
    this.activeProcesses.clear();
    super.destroy();
  }

  // -- Private helpers -------------------------------------------------------

  private async findBinary(): Promise<string | null> {
    // Try cursor-agent first to avoid collision with the Cursor editor launcher binary
    for (const name of ['cursor-agent', 'cursor']) {
      const found = await this.whichBinary(name);
      if (found) return found;
    }
    return null;
  }

  private whichBinary(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, [name], (err, stdout) => {
        resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0].trim() : null);
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
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new LLMProviderError(
        'Prompt is empty after formatting messages',
        'INVALID_REQUEST',
        'cursor-cli',
        400,
        false
      );
    }
    // Guard against ARG_MAX: prompt is passed as positional arg
    const promptBytes = Buffer.byteLength(trimmed, 'utf8');
    if (promptBytes > 200_000) {
      throw new LLMProviderError(
        `Prompt too long for CLI argument (${promptBytes} bytes, max ~200KB). Reduce prompt size.`,
        'INPUT_TOO_LARGE', 'cursor-cli', 400, false
      );
    }

    // When binaryPath is 'cursor' (Electron launcher), the headless agent is a subcommand.
    // When binaryPath is 'cursor-agent', flags are top-level.
    const isCursorLauncher = this.binaryPath!.endsWith('/cursor') || this.binaryPath!.endsWith('\\cursor');
    const args = [
      ...(isCursorLauncher ? ['agent'] : []),
      '--print',
      '--trust',  // Prevent workspace trust prompt blocking non-interactive mode
      '--force',  // Required for file writes in --print mode
      '--output-format', stream ? 'stream-json' : 'json',
      '--model', String(model),
      ...(stream ? ['--stream-partial-output'] : []),
      trimmed,
    ];

    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      TMPDIR: process.env.TMPDIR,
      // Config discovery
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      // Proxy: required for subscription auth through corporate proxies
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      no_proxy: process.env.no_proxy,
    };
    // Windows requires these for Cursor to find config/auth
    if (process.platform === 'win32') {
      env.APPDATA = process.env.APPDATA;
      env.LOCALAPPDATA = process.env.LOCALAPPDATA;
      env.USERPROFILE = process.env.USERPROFILE;
      env.SystemRoot = process.env.SystemRoot;
      env.TEMP = process.env.TEMP;
    }
    const apiKey = this.config.apiKey || process.env.CURSOR_API_KEY;
    if (apiKey) {
      env.CURSOR_API_KEY = apiKey;  // Pass via env var, not CLI args (security: --api-key visible in ps)
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
      const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'cursor');
      return this.buildResponse(
        contentWithoutToolCalls, model, 0, 0,
        toolCalls.length > 0 ? toolCalls : undefined,
        toolCalls.length > 0 ? 'tool_calls' : undefined
      );
    }

    const raw = parsed.result ?? parsed.response ?? parsed.content ?? '';
    const content = (typeof raw === 'string' ? raw : String(raw)).trim();
    if (!content) {
      throw new LLMProviderError('Cursor Agent returned empty response', 'EMPTY_RESPONSE', 'cursor-cli', undefined, true);
    }
    const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'cursor');
    if (!contentWithoutToolCalls && toolCalls.length === 0) {
      throw new LLMProviderError('Cursor Agent returned empty response', 'EMPTY_RESPONSE', 'cursor-cli', undefined, true);
    }

    const usage = (parsed.usage ?? {}) as Record<string, number>;
    const promptTokens = usage.inputTokens || usage.input_tokens || usage.prompt_tokens || 0;
    const completionTokens = usage.outputTokens || usage.output_tokens || usage.completion_tokens || 0;

    return this.buildResponse(
      contentWithoutToolCalls, model, promptTokens, completionTokens,
      toolCalls.length > 0 ? toolCalls : undefined,
      toolCalls.length > 0 ? 'tool_calls' : undefined
    );
  }

  private buildResponse(
    content: string,
    model: LLMModel,
    promptTokens: number,
    completionTokens: number,
    toolCalls?: LLMToolCall[],
    finishReason?: LLMResponse['finishReason']
  ): LLMResponse {
    const pricing = this.capabilities.pricing[model] || FREE;
    return {
      id: `cursor-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      model, provider: 'cursor-cli', content,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      cost: calcCost(promptTokens, completionTokens, pricing),
      finishReason: finishReason || 'stop',
    };
  }

  private formatMessages(messages: LLMMessage[], tools?: LLMTool[]): string {
    const systemParts: string[] = [];
    const convParts: string[] = [];
    for (const msg of messages) {
      const content = msg.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n')
            : '';
      if (msg.role === 'system') {
        systemParts.push(text);
      } else {
        convParts.push(`${msg.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
      }
    }
    const parts: string[] = [];
    if (systemParts.length > 0) parts.push(`System: ${systemParts.join('\n')}`);
    if (convParts.length > 0) parts.push(convParts.join('\n'));

    if (tools && tools.length > 0) {
      parts.push(...formatToolInstructions(tools));
    }

    return parts.join('\n\n');
  }

}
