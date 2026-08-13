/**
 * V3 Anthropic CLI Subprocess Provider
 *
 * Spawns `claude -p` (headless print mode) subprocesses for agentic LLM calls.
 * Follows the GeminiCLIProvider pattern exactly: stdin prompt, JSON stdout, SIGKILL on timeout.
 *
 * @module @hive-flow/providers/anthropic-cli-provider
 */

import { spawn, ChildProcess, execFile } from 'child_process';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMMessage, LLMTool, LLMToolCall, ModelInfo, ProviderCapabilities, HealthCheckResult,
  LLMProviderError, ProviderUnavailableError,
} from './types.js';
import { parseToolCallsFromContent, formatToolInstructions } from './tool-call-utils.js';
import { ANTHROPIC_CLI_DEFAULT_MODEL } from './model-alias-resolver.js';

// ===== Constants =====

const MAX_STDOUT_BYTES = 50 * 1024 * 1024; // 50MB

/** Supported Claude models; pricing is populated only where independently known. */
const ANTHROPIC_CLI_MODELS: LLMModel[] = [
  ANTHROPIC_CLI_DEFAULT_MODEL,
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

const ANTHROPIC_CLI_MODEL_DESCRIPTIONS: Record<string, string> = {
  'claude-opus-5': 'Claude Opus 5 (current flagship agentic model)',
  'claude-fable-5': 'Claude Fable 5 (frontier, highest capability)',
  'claude-sonnet-5': 'Claude Sonnet 5 (current balanced agentic model)',
  'claude-opus-4-8': 'Claude Opus 4.8 (legacy flagship)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6 (legacy)',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5 (current)',
};

const ANTHROPIC_CLI_CAPABILITIES: ProviderCapabilities = {
  supportedModels: ANTHROPIC_CLI_MODELS,
  maxContextLength: {
    'claude-opus-5': 1000000,
    'claude-fable-5': 1000000,
    'claude-sonnet-5': 1000000,
    'claude-opus-4-8': 1000000,
    'claude-sonnet-4-6': 200000,
    'claude-haiku-4-5-20251001': 200000,
  },
  maxOutputTokens: {
    'claude-opus-5': 65536,       // 64K, verified from the running client
    'claude-fable-5': 131072,     // 128K
    'claude-sonnet-5': 131072,    // 128K
    'claude-opus-4-8': 131072,    // 128K
    'claude-sonnet-4-6': 65536,   // 64K
    'claude-haiku-4-5-20251001': 65536,   // 64K
  },
  supportsStreaming: false,
  supportsToolCalling: true,
  supportsSystemMessages: true,
  supportsVision: false,
  supportsAudio: false,
  supportsFineTuning: false,
  supportsEmbeddings: false,
  supportsBatching: false,
  pricing: {
    'claude-fable-5': { promptCostPer1k: 0.010, completionCostPer1k: 0.050, currency: 'USD' },
    'claude-sonnet-5': { promptCostPer1k: 0.003, completionCostPer1k: 0.015, currency: 'USD' },
    'claude-opus-4-8': { promptCostPer1k: 0.005, completionCostPer1k: 0.025, currency: 'USD' },
    'claude-sonnet-4-6': { promptCostPer1k: 0.003, completionCostPer1k: 0.015, currency: 'USD' },
    'claude-haiku-4-5-20251001': { promptCostPer1k: 0.001, completionCostPer1k: 0.005, currency: 'USD' },
  },
};

/** JSON output shape from `claude --print --output-format json` */
interface ClaudeJsonOutput {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  cost_usd?: number;
  total_cost?: number;
  input_tokens?: number;
  output_tokens?: number;
  /** @deprecated Legacy field names — kept for backwards compat */
  total_input_tokens?: number;
  total_init_tokens?: number;
  total_output_tokens?: number;
}

export class AnthropicCLIProvider extends BaseProvider {
  readonly name: LLMProvider = 'anthropic-cli';

  readonly capabilities: ProviderCapabilities = ANTHROPIC_CLI_CAPABILITIES;

  private binaryPath: string | null = null;
  private activeChildren: Set<ChildProcess> = new Set();

  constructor(options: BaseProviderOptions) { super(options); }

  protected validateConfig(): void {
    if (!this.config.model) {
      this.config.model = ANTHROPIC_CLI_DEFAULT_MODEL;
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
        'Claude CLI binary not found. Install Claude Code or set CLAUDE_PATH. ' +
        'See Claude Code documentation'
      );
    } else {
      this.logger.info(`Claude CLI found at: ${this.binaryPath}`);
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureBinary();
    const model = request.model || this.config.model;
    const systemPrompt = this.extractSystemPrompt(request.messages);
    const prompt = this.formatMessages(request.messages, request.tools, { includeSystem: false });
    const timeoutMs = request.timeout || this.config.timeout || 300000;
    const args = ['--print', '--output-format', 'json'];
    if (model) args.push('--model', model);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

    // Budget support: if budgetAllocation is set in metadata, pass --max-budget-usd
    const budgetAllocation = request.metadata?.budgetAllocation;
    if (budgetAllocation !== undefined && budgetAllocation !== null) {
      args.push('--max-budget-usd', String(budgetAllocation));
    }

    return new Promise<LLMResponse>((resolve, reject) => {
      let settled = false;
      const child = spawn(this.binaryPath!, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.minimalEnv(),
        detached: process.platform !== 'win32',
      });
      this.activeChildren.add(child);
      child.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          this.logger.warn('Claude stdin write error', { error: err.message });
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.terminateChild(child);
        this.activeChildren.delete(child);
        reject(new LLMProviderError(
          `Claude CLI timed out after ${timeoutMs}ms`, 'TIMEOUT', 'anthropic-cli', undefined, true
        ));
      }, timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        if (settled) return;
        timer.refresh();
        stdout += d.toString();
        if (stdout.length > MAX_STDOUT_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.terminateChild(child);
          this.activeChildren.delete(child);
          reject(new LLMProviderError(
            'Response exceeded maximum size (50MB)', 'RESPONSE_TOO_LARGE', 'anthropic-cli', undefined, false
          ));
        }
      });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        if (settled) return;
        settled = true;
        if (code !== 0 && code !== null) {
          reject(new LLMProviderError(
            stderr.trim() || `Claude CLI exited with code ${code}`,
            'CLI_ERROR', 'anthropic-cli', undefined, true, { exitCode: code }
          ));
          return;
        }
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

  protected async *doStreamComplete(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    throw new LLMProviderError(
      'Streaming is not supported by anthropic-cli provider. Use doComplete() instead.',
      'STREAMING_NOT_SUPPORTED', 'anthropic-cli', undefined, false
    );
  }

  async listModels(): Promise<LLMModel[]> {
    return [...ANTHROPIC_CLI_MODELS];
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    const p = this.capabilities.pricing[model];
    return {
      model, name: model,
      description: ANTHROPIC_CLI_MODEL_DESCRIPTIONS[model] || 'Claude CLI model',
      contextLength: this.capabilities.maxContextLength[model] || 200000,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 8192,
      supportedFeatures: ['chat', 'completion', 'cli-subprocess'],
      pricing: p ? { promptCostPer1k: p.promptCostPer1k, completionCostPer1k: p.completionCostPer1k, currency: p.currency } : undefined,
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    if (!this.binaryPath) this.binaryPath = await this.findBinary();

    if (!this.binaryPath) {
      return {
        healthy: false, error: 'Claude CLI binary not found',
        timestamp: new Date(),
        details: { hint: 'Install Claude Code or set CLAUDE_PATH' },
      };
    }

    try {
      const version = await this.runVersion();
      return {
        healthy: true, timestamp: new Date(),
        details: { binary: this.binaryPath, version },
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Failed to run claude --version',
        timestamp: new Date(),
        details: { binary: this.binaryPath, hint: 'Claude CLI found but may not be functional' },
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the claude binary.
   * Search order: CLAUDE_PATH env → ~/.claude/local/claude → which claude → /usr/local/bin/claude
   */
  private async findBinary(): Promise<string | null> {
    // 1. CLAUDE_PATH env var
    const envPath = process.env.CLAUDE_PATH;
    if (envPath && existsSync(envPath)) {
      return envPath;
    }

    // 2. ~/.claude/local/claude
    const localPath = join(homedir(), '.claude', 'local', 'claude');
    if (existsSync(localPath)) {
      return localPath;
    }

    // 3. which claude
    const whichResult = await this.whichBinary('claude');
    if (whichResult) return whichResult;

    // 4. /usr/local/bin/claude
    const globalPath = '/usr/local/bin/claude';
    if (existsSync(globalPath)) {
      return globalPath;
    }

    return null;
  }

  private whichBinary(name: string): Promise<string | null> {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(cmd, [name], (err, stdout) => {
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

  private minimalEnv(): Record<string, string | undefined> {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      TMPDIR: process.env.TMPDIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_PATH: process.env.CLAUDE_PATH,
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
      throw new ProviderUnavailableError('anthropic-cli', {
        message: 'Claude CLI binary not found',
        hint: 'Install Claude Code or set CLAUDE_PATH env var',
      });
    }
  }

  private parseJsonOutput(stdout: string, model: LLMModel): LLMResponse {
    let parsed: ClaudeJsonOutput;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Malformed JSON — treat raw stdout as text content
      this.logger.warn('Claude CLI returned malformed JSON; falling back to raw text');
      const content = stdout.trim();
      if (!content) {
        throw new LLMProviderError('Claude CLI returned empty output', 'EMPTY_RESPONSE', 'anthropic-cli', undefined, true);
      }
      const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'anthropic');
      return this.buildResponse(
        contentWithoutToolCalls, model, 0, 0, undefined,
        toolCalls.length > 0 ? toolCalls : undefined,
        toolCalls.length > 0 ? 'tool_calls' : undefined
      );
    }

    // Handle is_error responses
    if (parsed.is_error) {
      throw new LLMProviderError(
        parsed.result || 'Claude CLI returned an error',
        'CLI_ERROR', 'anthropic-cli', undefined, true
      );
    }

    const content = parsed.result || '';
    if (!content) {
      throw new LLMProviderError('Claude CLI returned empty result', 'EMPTY_RESPONSE', 'anthropic-cli', undefined, true);
    }

    const promptTokens = parsed.input_tokens || parsed.total_input_tokens || parsed.total_init_tokens || 0;
    const completionTokens = parsed.output_tokens || parsed.total_output_tokens || 0;
    const costUsd = parsed.cost_usd || parsed.total_cost || undefined;

    const { contentWithoutToolCalls, toolCalls } = parseToolCallsFromContent(content, 'anthropic');
    return this.buildResponse(
      contentWithoutToolCalls, model, promptTokens, completionTokens, costUsd,
      toolCalls.length > 0 ? toolCalls : undefined,
      toolCalls.length > 0 ? 'tool_calls' : undefined
    );
  }

  private buildResponse(
    content: string,
    model: LLMModel,
    promptTokens: number,
    completionTokens: number,
    reportedCost?: number,
    toolCalls?: LLMToolCall[],
    finishReason?: LLMResponse['finishReason'],
  ): LLMResponse {
    const pricing = this.capabilities.pricing[model];
    let pCost: number;
    let cCost: number;
    if (reportedCost !== undefined) {
      // Use reported cost from claude CLI, split proportionally
      const totalTokens = promptTokens + completionTokens;
      pCost = totalTokens > 0 ? reportedCost * (promptTokens / totalTokens) : 0;
      cCost = totalTokens > 0 ? reportedCost * (completionTokens / totalTokens) : reportedCost;
    } else {
      pCost = pricing ? (promptTokens / 1000) * pricing.promptCostPer1k : 0;
      cCost = pricing ? (completionTokens / 1000) * pricing.completionCostPer1k : 0;
    }
    return {
      id: `anthropic-cli-${Date.now()}`,
      model,
      provider: 'anthropic-cli',
      content,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      cost: { promptCost: pCost, completionCost: cCost, totalCost: pCost + cCost, currency: 'USD' },
      finishReason: finishReason ?? 'stop',
    };
  }

  private extractSystemPrompt(messages: LLMMessage[]): string {
    const systemParts: string[] = [];
    for (const msg of messages) {
      if (msg.role !== 'system') continue;
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n');
      if (text.trim()) systemParts.push(text);
    }
    return systemParts.join('\n\n');
  }

  private formatMessages(messages: LLMMessage[], tools?: LLMTool[], options: { includeSystem?: boolean } = {}): string {
    const systemParts: string[] = [];
    const convParts: string[] = [];
    const includeSystem = options.includeSystem !== false;

    for (const msg of messages) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n');

      if (msg.role === 'system') {
        if (includeSystem) systemParts.push(text);
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
