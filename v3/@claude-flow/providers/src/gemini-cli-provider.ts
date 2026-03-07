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
  LLMMessage, LLMTool, LLMToolCall, ModelInfo, ProviderCapabilities, HealthCheckResult,
  LLMProviderError, AuthenticationError, ProviderUnavailableError,
} from './types.js';

/** Gemini CLI exit codes */
const EXIT = { Success: 0, Generic: 1, Auth: 41, Input: 42, Config: 52, Cancel: 130 } as const;

/** Safety limit to prevent unbounded stdout accumulation */
const MAX_STDOUT_BYTES = 50 * 1024 * 1024; // 50 MB

/** Shape returned by `gemini --output-format json` (batch mode) */
interface GeminiJsonOutput {
  response?: string;
  // stream-json events use type-based wrapping
  type?: string;
  content?: string;
  message?: { content?: string };
  stats?: {
    models?: Record<string, {
      tokens?: { prompt?: number; candidates?: number; total?: number };
    }>;
  };
}

const SUPPORTED_MODELS: LLMModel[] = [
  'auto',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'gemini-3-flash-preview', 'gemini-3.1-pro-preview',
];

const MODEL_DESCRIPTIONS: Record<string, string> = {
  'auto': 'Auto - Gemini CLI selects optimal model',
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
      'auto': 1048576,
      'gemini-2.5-flash': 1048576, 'gemini-2.5-flash-lite': 1048576,
      'gemini-2.5-pro': 1048576, 'gemini-3-flash-preview': 1048576,
      'gemini-3.1-pro-preview': 2097152,
    },
    maxOutputTokens: {
      'auto': 65536,
      'gemini-2.5-flash': 65536, 'gemini-2.5-flash-lite': 65536,
      'gemini-2.5-pro': 65536, 'gemini-3-flash-preview': 65536,
      'gemini-3.1-pro-preview': 65536,
    },
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsSystemMessages: true,
    supportsVision: false,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 60, tokensPerMinute: 4000000, concurrentRequests: 5 },
    pricing: {
      'auto': makePricing(0, 0),
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
      this.config.model = 'auto';
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
      const binaryOk = await this.checkBinaryRunnable();
      if (!binaryOk) {
        this.logger.warn('Gemini CLI found but failed to run. You may need to run "gemini auth" in a terminal.');
      }
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const prompt = this.formatMessages(request.messages, request.tools);
    const timeoutMs = request.timeout || this.config.timeout || 120000;
    const args = ['--output-format', 'json'];
    // Omit --model when 'auto' or undefined — let Gemini CLI pick its own default
    if (model && model !== 'auto') {
      args.push('--model', model);
    }
    // --sandbox requires Docker; only enable if explicitly configured
    // --sandbox requires Docker; opt-in only to avoid breaking Docker-absent environments
    if (this.config.sandbox === true) {
      args.push('--sandbox');
    }

    return new Promise<LLMResponse>((resolve, reject) => {
      let settled = false;
      const child = spawn(this.binaryPath!, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.minimalEnv(),
      });
      this.activeChildren.add(child);
      // Handle stdin EPIPE gracefully (child may exit before reading)
      child.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          this.logger.warn('Gemini stdin write error', { error: err.message });
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();

      let stdout = '';
      let stderr = '';

      // CRITICAL: SIGKILL on timeout — Gemini CLI ignores SIGTERM (#15874)
      // Declare timer before listeners that reference it
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        this.activeChildren.delete(child);
        reject(new LLMProviderError(
          `Gemini CLI timed out after ${timeoutMs}ms`, 'TIMEOUT', 'gemini-cli', undefined, true
        ));
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > MAX_STDOUT_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          this.activeChildren.delete(child);
          reject(new LLMProviderError(
            'Response exceeded maximum size (50MB)', 'RESPONSE_TOO_LARGE', 'gemini-cli', undefined, false
          ));
        }
      });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        if (settled) return;
        settled = true;
        if (code !== EXIT.Success) { reject(this.exitCodeToError(code, stderr)); return; }
        try { resolve(this.parseJsonOutput(stdout, model)); }
        catch (e) { reject(this.transformError(e instanceof Error ? e : new Error(String(e)))); }
      });

      child.on('error', (err: Error) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
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
    const timeoutMs = (request.timeout || this.config.timeout || 120000) * 2;
    const args = ['--output-format', 'stream-json'];
    if (model && model !== 'auto') {
      args.push('--model', model);
    }
    // --sandbox requires Docker; opt-in only to avoid breaking Docker-absent environments
    if (this.config.sandbox === true) {
      args.push('--sandbox');
    }

    const child = spawn(this.binaryPath!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.minimalEnv(),
    });
    this.activeChildren.add(child);
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        this.logger.warn('Gemini stdin write error', { error: err.message });
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      this.activeChildren.delete(child);
    }, timeoutMs);

    const rl = createInterface({ input: child.stdout });
    let promptTokens = 0;
    let completionTokens = 0;
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Buffer for tool_call detection: emit content and tool_call events as complete blocks appear
    let contentBuffer = '';
    let streamToolCallCount = 0;
    const toolCallBlockRe = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;

    const flushToolCallsFromBuffer = (): LLMStreamEvent[] => {
      const events: LLMStreamEvent[] = [];
      let match: RegExpExecArray | null;
      let lastEnd = 0;
      toolCallBlockRe.lastIndex = 0;
      while ((match = toolCallBlockRe.exec(contentBuffer)) !== null) {
        const before = contentBuffer.slice(lastEnd, match.index);
        if (before.length > 0) {
          events.push({ type: 'content', delta: { content: before } });
        }

        const parsedCall = this.parseToolCallPayload(match[1].trim());
        if (parsedCall) {
          streamToolCallCount += 1;
          events.push({
            type: 'tool_call',
            delta: {
              toolCall: {
                id: `gemini-tool-${Date.now()}-${streamToolCallCount}`,
                type: 'function',
                function: parsedCall,
              },
            },
          });
        } else {
          // Unparseable tool payload: preserve model output as plain content.
          events.push({ type: 'content', delta: { content: match[0] } });
        }
        lastEnd = match.index + match[0].length;
      }

      contentBuffer = contentBuffer.slice(lastEnd);
      return events;
    };

    // Capture exit code eagerly — close may fire before readline finishes
    let exitCode: number | null = null;
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('close', (code: number | null) => { exitCode = code; resolve(code); });
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as GeminiJsonOutput;
          // Handle both batch-style (response field) and stream-json (type-based) events
          const text = evt.response
            || (evt.type === 'message' && evt.message?.content)
            || (evt.type === 'message' && evt.content)
            || evt.content;
          if (text) {
            contentBuffer += text;
            for (const event of flushToolCallsFromBuffer()) {
              yield event;
            }
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

      // Emit any remaining buffer as content
      if (contentBuffer.length > 0) {
        yield { type: 'content', delta: { content: contentBuffer } };
      }

      // Surface timeout as an error event instead of silent empty completion
      if (timedOut) {
        yield {
          type: 'error',
          error: new LLMProviderError(
            `Gemini CLI streaming timed out after ${timeoutMs}ms`, 'TIMEOUT', 'gemini-cli', undefined, true
          ),
        };
        return;
      }

      // Check exit code after stream ends — auth errors (exit 41) would otherwise be swallowed
      // Use eagerly-captured exit code, or await if close hasn't fired yet
      if (exitCode === null) await exitPromise;
      if (exitCode !== null && exitCode !== EXIT.Success) {
        yield { type: 'error', error: this.exitCodeToError(exitCode, stderr) };
        return;
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
      supportedFeatures: ['chat', 'completion', 'cli-subprocess', 'tool_calling'],
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
        resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0].trim() : null);
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

  /** Check if the binary runs under our minimal env (does NOT verify auth — just binary health). */
  private checkBinaryRunnable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.binaryPath!, ['--version'], { timeout: 10000, env: this.minimalEnv() }, (err) => {
        resolve(!err);
      });
    });
  }

  private minimalEnv(): Record<string, string | undefined> {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      TMPDIR: process.env.TMPDIR,
      // Auth: support all Gemini auth modes (OAuth, API key, Vertex AI)
      GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
      GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      // Proxy: required for subscription auth through corporate proxies
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      no_proxy: process.env.no_proxy,
    };
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
      const { contentWithoutToolCalls, toolCalls } = this.parseToolCallsFromContent(content);
      return this.buildResponse(
        contentWithoutToolCalls, model, 0, 0,
        toolCalls.length > 0 ? toolCalls : undefined,
        toolCalls.length > 0 ? 'tool_calls' : undefined
      );
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
    const content = parsed.response || parsed.message?.content || parsed.content || '';
    if (!content) {
      throw new LLMProviderError('Gemini returned empty response', 'EMPTY_RESPONSE', 'gemini-cli', undefined, true);
    }
    const { contentWithoutToolCalls, toolCalls } = this.parseToolCallsFromContent(content);
    if (!contentWithoutToolCalls && toolCalls.length === 0) {
      throw new LLMProviderError('Gemini returned empty response', 'EMPTY_RESPONSE', 'gemini-cli', undefined, true);
    }
    return this.buildResponse(
      contentWithoutToolCalls, model, promptTokens, completionTokens,
      toolCalls.length > 0 ? toolCalls : undefined,
      toolCalls.length > 0 ? 'tool_calls' : undefined
    );
  }

  /** Build a standardized LLMResponse with cost tracking. */
  private buildResponse(
    content: string,
    model: LLMModel,
    promptTokens: number,
    completionTokens: number,
    toolCalls?: LLMToolCall[],
    finishReason?: LLMResponse['finishReason']
  ): LLMResponse {
    const pricing = this.capabilities.pricing[model];
    const pCost = pricing ? (promptTokens / 1000) * pricing.promptCostPer1k : 0;
    const cCost = pricing ? (completionTokens / 1000) * pricing.completionCostPer1k : 0;
    return {
      id: `gemini-cli-${Date.now()}`,
      model,
      provider: 'gemini-cli',
      content,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      cost: { promptCost: pCost, completionCost: cCost, totalCost: pCost + cCost, currency: 'USD' },
      finishReason: finishReason ?? 'stop',
    };
  }

  /** Map Gemini CLI exit codes to typed provider errors. */
  private exitCodeToError(code: number | null, stderr: string): LLMProviderError {
    const filtered = stderr.split('\n')
      .filter(line => !line.includes('Loaded cached credentials'))
      .join('\n');
    const msg = filtered.trim() || `Gemini CLI exited with code ${code}`;
    switch (code) {
      case EXIT.Auth:
        return new AuthenticationError(
          `Gemini CLI auth failed: ${msg}. Run 'gemini auth' to re-authenticate.`,
          'gemini-cli', { exitCode: code }
        );
      case EXIT.Input:
        return new LLMProviderError(
          `Gemini CLI: empty or invalid prompt (exit code 42). Ensure prompt is non-empty.`,
          'INVALID_INPUT', 'gemini-cli', undefined, false, { exitCode: code }
        );
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
   * If tools are provided, appends a structured tool schema section and usage instructions.
   */
  private formatMessages(messages: LLMMessage[], tools?: LLMTool[]): string {
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

    if (tools && tools.length > 0) {
      const toolsXml = tools.map((tool) => {
        const name = this.escapeXml(tool.function.name);
        const description = this.escapeXml(tool.function.description || '');
        const parameters = this.escapeXml(JSON.stringify(tool.function.parameters));
        return [
          '<tool>',
          `  <name>${name}</name>`,
          `  <description>${description}</description>`,
          `  <parameters>${parameters}</parameters>`,
          '</tool>',
        ].join('\n');
      }).join('\n');

      parts.push(
        '<available_tools>',
        toolsXml,
        '</available_tools>',
        '',
        'If you decide to call a tool, respond with one or more <tool_call> XML blocks using this exact JSON payload format:',
        '<tool_call>',
        '{"name":"tool_name","arguments":{"param":"value"}}',
        '</tool_call>',
        'Do not wrap tool calls in markdown fences.'
      );
    }

    return parts.join('\n\n');
  }

  private escapeXml(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private parseToolCallPayload(raw: string): { name: string; arguments: string } | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Preferred format: JSON payload inside <tool_call>.
    try {
      const parsed = JSON.parse(trimmed) as { name?: unknown; arguments?: unknown };
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (!name) return null;
      const args = parsed.arguments === undefined
        ? '{}'
        : (typeof parsed.arguments === 'object' && parsed.arguments !== null
          ? JSON.stringify(parsed.arguments)
          : String(parsed.arguments));
      return { name, arguments: args };
    } catch {
      // Fall through to XML field extraction.
    }

    // Fallback format: nested XML tags inside <tool_call>.
    const nameMatch = trimmed.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
    if (!nameMatch) return null;
    const name = nameMatch[1].trim();
    if (!name) return null;

    const argsMatch = trimmed.match(/<arguments>\s*([\s\S]*?)\s*<\/arguments>/i);
    if (!argsMatch) return { name, arguments: '{}' };

    const rawArgs = argsMatch[1].trim();
    if (!rawArgs) return { name, arguments: '{}' };
    try {
      const parsedArgs = JSON.parse(rawArgs) as unknown;
      return {
        name,
        arguments: typeof parsedArgs === 'object' && parsedArgs !== null
          ? JSON.stringify(parsedArgs)
          : String(parsedArgs),
      };
    } catch {
      return { name, arguments: rawArgs };
    }
  }

  /**
   * Extract <tool_call> blocks from model output. Returns cleaned content and parsed LLMToolCall[].
   */
  private parseToolCallsFromContent(content: string): { contentWithoutToolCalls: string; toolCalls: LLMToolCall[] } {
    const toolCalls: LLMToolCall[] = [];
    const blockRe = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    const textParts: string[] = [];

    while ((match = blockRe.exec(content)) !== null) {
      textParts.push(content.slice(lastIndex, match.index));
      lastIndex = match.index + match[0].length;
      const parsedCall = this.parseToolCallPayload(match[1].trim());
      if (!parsedCall) continue;
      toolCalls.push({
        id: `gemini-tool-${Date.now()}-${toolCalls.length + 1}`,
        type: 'function',
        function: parsedCall,
      });
    }
    textParts.push(content.slice(lastIndex));
    const contentWithoutToolCalls = textParts.join('').replace(/\n{3,}/g, '\n\n').trim();
    return { contentWithoutToolCalls, toolCalls };
  }
}
