/**
 * V3 Gemini CLI Subprocess Provider
 * Issues handled: #6715 (stdin close), #9009 (malformed JSON), #15874 (SIGKILL on timeout)
 * @module @hive-flow/providers/gemini-cli-provider
 */

import { spawn, ChildProcess, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMMessage, LLMTool, LLMToolCall, ModelInfo, ProviderCapabilities, HealthCheckResult,
  LLMProviderError, AuthenticationError, ProviderUnavailableError,
} from './types.js';
import { parseToolCallsFromContent, formatToolInstructions, flushToolCallsFromBuffer } from './tool-call-utils.js';
import {
  GEMINI_EXIT_CODES as EXIT, MAX_STDOUT_BYTES,
  GEMINI_MODELS, GEMINI_MODEL_DESCRIPTIONS, GEMINI_CAPABILITIES,
  GeminiJsonOutput,
} from './gemini-cli-constants.js';

const GEMINI_STDIN_PROMPT_THRESHOLD = 24_000;

export class GeminiCLIProvider extends BaseProvider {
  readonly name: LLMProvider = 'gemini-cli';

  readonly capabilities: ProviderCapabilities = GEMINI_CAPABILITIES;

  private binaryPath: string | null = null;
  private activeChildren: Set<ChildProcess> = new Set();

  constructor(options: BaseProviderOptions) { super(options); }

  protected validateConfig(): void {
    if (!this.config.model) {
      this.config.model = 'gemini-3.1-pro-preview';
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
    const { args, stdinPrompt } = this.buildCliArgs('json', model, prompt);

    return new Promise<LLMResponse>((resolve, reject) => {
      let settled = false;
      const child = this.spawnCli(args);
      this.activeChildren.add(child);
      child.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          this.logger.warn('Gemini stdin write error', { error: err.message });
        }
      });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.terminateChild(child);
        this.activeChildren.delete(child);
        if (!stdout.trim() && !stderr.trim()) {
          reject(this.authOutputToError(
            'Gemini CLI produced no output before timeout; cached OAuth may be invalid or blocked in headless mode.',
            null,
          ));
          return;
        }
        reject(new LLMProviderError(
          `Gemini CLI timed out after ${timeoutMs}ms`, 'TIMEOUT', 'gemini-cli', undefined, true
        ));
      }, timeoutMs);

      const failWithAuth = (text: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.terminateChild(child);
        this.activeChildren.delete(child);
        reject(this.authOutputToError(text, null));
      };

      child.stdout.on('data', (d: Buffer) => {
        timer.refresh();
        const text = d.toString();
        if (this.isGeminiAuthOutput(text)) {
          failWithAuth(text);
          return;
        }
        stdout += text;
        if (stdout.length > MAX_STDOUT_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.terminateChild(child);
          this.activeChildren.delete(child);
          reject(new LLMProviderError(
            'Response exceeded maximum size (50MB)', 'RESPONSE_TOO_LARGE', 'gemini-cli', undefined, false
          ));
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        stderr += text;
        if (this.isGeminiAuthOutput(stderr)) failWithAuth(stderr);
      });

      if (stdinPrompt !== undefined) child.stdin.write(stdinPrompt);
      child.stdin.end();

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
    const { args, stdinPrompt } = this.buildCliArgs('stream-json', model, prompt);

    const child = this.spawnCli(args);
    this.activeChildren.add(child);
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        this.logger.warn('Gemini stdin write error', { error: err.message });
      }
    });
    if (stdinPrompt !== undefined) child.stdin.write(stdinPrompt);
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.terminateChild(child);
      this.activeChildren.delete(child);
    }, timeoutMs);

    const rl = createInterface({ input: child.stdout });
    let promptTokens = 0;
    let completionTokens = 0;
    let stderr = '';
    let authError: LLMProviderError | null = null;
    const failStreamWithAuth = (text: string) => {
      if (authError) return;
      authError = this.authOutputToError(text, null);
      this.terminateChild(child);
      this.activeChildren.delete(child);
    };
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (this.isGeminiAuthOutput(stderr)) failStreamWithAuth(stderr);
    });

    let contentBuffer = '';
    let streamToolCallCount = 0;
    let exitCode: number | null = null;
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('close', (code: number | null) => { exitCode = code; resolve(code); });
    });

    try {
      for await (const line of rl) {
        timer.refresh();
        if (!line.trim()) continue;
        if (this.isGeminiAuthOutput(line)) {
          failStreamWithAuth(line);
          continue;
        }
        try {
          const evt = JSON.parse(line) as GeminiJsonOutput;
          const text = evt.response
            || (evt.type === 'message' && evt.message?.content)
            || (evt.type === 'message' && evt.content)
            || evt.content;
          if (text) {
            contentBuffer += text;
            const flushed = flushToolCallsFromBuffer(contentBuffer, 'gemini', streamToolCallCount);
            contentBuffer = flushed.remainingBuffer;
            streamToolCallCount = flushed.count;
            for (const event of flushed.events) {
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

      if (contentBuffer.length > 0) {
        yield { type: 'content', delta: { content: contentBuffer } };
      }

      if (authError) {
        yield { type: 'error', error: authError };
        return;
      }

      if (timedOut) {
        if (!contentBuffer.trim() && !stderr.trim() && promptTokens === 0 && completionTokens === 0) {
          yield {
            type: 'error',
            error: this.authOutputToError(
              'Gemini CLI produced no output before timeout; cached OAuth may be invalid or blocked in headless mode.',
              null,
            ),
          };
          return;
        }
        yield {
          type: 'error',
          error: new LLMProviderError(
            `Gemini CLI streaming timed out after ${timeoutMs}ms`, 'TIMEOUT', 'gemini-cli', undefined, true
          ),
        };
        return;
      }

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
      this.terminateChild(child);
      this.activeChildren.delete(child);
    }
  }

  async listModels(): Promise<LLMModel[]> {
    return [...GEMINI_MODELS];
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    const p = this.capabilities.pricing[model];
    return {
      model, name: model,
      description: GEMINI_MODEL_DESCRIPTIONS[model] || 'Gemini CLI model',
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

  destroy(): void {
    for (const child of this.activeChildren) {
      this.terminateChild(child);
    }
    this.activeChildren.clear();
    super.destroy();
  }

  private spawnCli(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.binaryPath!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.minimalEnv(),
      cwd: process.cwd(),
      detached: process.platform !== 'win32',
    });
  }

  private terminateChild(child: ChildProcess): void {
    if (process.platform !== 'win32' && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process may already have exited; fall back to the direct handle.
      }
    }
    if (!child.killed) child.kill('SIGKILL');
  }

  private findBinary(): Promise<string | null> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(cmd, ['gemini'], (err, stdout) => {
        resolve(!err && stdout.trim() ? stdout.trim().split('\n')[0].trim() : null);
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
      GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
      GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
      no_proxy: process.env.no_proxy,
      ...(this.config.env || {}),
    };
  }

  private ensureBinary(): void {
    if (!this.binaryPath) {
      throw new ProviderUnavailableError('gemini-cli', {
        message: 'Gemini CLI binary not found in PATH',
        hint: 'Install: npm i -g @google/gemini-cli',
      });
    }
  }

  private buildCliArgs(
    outputFormat: 'json' | 'stream-json',
    model: LLMModel,
    prompt: string
  ): { args: string[]; stdinPrompt?: string } {
    const args = ['--output-format', outputFormat, '--skip-trust'];
    if (model && model !== 'auto') args.push('--model', model);
    if (this.config.sandbox === true) args.push('--sandbox');

    if (prompt.length > GEMINI_STDIN_PROMPT_THRESHOLD) {
      args.push('--prompt', '');
      return { args, stdinPrompt: prompt };
    }

    args.push('--prompt', prompt);
    return { args };
  }

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
      const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'gemini');
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
    const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'gemini');
    if (!contentWithoutToolCalls && toolCalls.length === 0) {
      throw new LLMProviderError('Gemini returned empty response', 'EMPTY_RESPONSE', 'gemini-cli', undefined, true);
    }
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

  private exitCodeToError(code: number | null, stderr: string): LLMProviderError {
    const filtered = stderr.split('\n')
      .filter(line => !line.includes('Loaded cached credentials'))
      .join('\n');
    if (this.isGeminiAuthOutput(filtered)) {
      return this.authOutputToError(filtered, code);
    }
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

  private isGeminiAuthOutput(text: string): boolean {
    const relevant = text.split('\n')
      .filter(line => !/loaded cached credentials/i.test(line))
      .join('\n');
    if (!relevant.trim()) return false;

    return /opening authentication page/i.test(relevant)
      || /authentication page/i.test(relevant)
      || /\[Y\/n\]/i.test(relevant)
      || /requires sign-?in/i.test(relevant)
      || /not authenticated/i.test(relevant)
      || /oauth.*(?:required|expired|invalid|failed|sign-?in|auth)/i.test(relevant);
  }

  private authOutputToError(text: string, code: number | null): AuthenticationError {
    const filtered = text.split('\n')
      .filter(line => !/loaded cached credentials/i.test(line))
      .join('\n')
      .trim();
    return new AuthenticationError(
      `Gemini CLI requires sign-in. Run gemini in a terminal and complete Google OAuth (or set GEMINI_API_KEY/GOOGLE_API_KEY). Details: ${filtered || `exit code ${code}`}`,
      'gemini-cli',
      { exitCode: code },
    );
  }

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
      parts.push(...formatToolInstructions(tools));
    }

    return parts.join('\n\n');
  }
}
