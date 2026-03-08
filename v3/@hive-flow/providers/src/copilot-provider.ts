/**
 * V3 GitHub Copilot Provider
 *
 * OpenAI-compatible HTTP provider wrapping the copilot-api npm package,
 * which exposes GitHub Copilot as an OpenAI-compatible local server.
 *
 * Default endpoint: http://localhost:4141/v1 (copilot-api default port)
 * Auth: GITHUB_TOKEN environment variable (required for copilot-api).
 * Requires active GitHub Copilot subscription.
 *
 * Setup: npx copilot-api (starts local server)
 *
 * @module @hive-flow/providers/copilot-provider
 */

import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  ModelInfo, ProviderCapabilities, HealthCheckResult,
  ProviderUnavailableError, LLMProviderError,
} from './types.js';

interface CopilotResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const ZERO_COST = { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' };

export class CopilotProvider extends BaseProvider {
  readonly name: LLMProvider = 'copilot';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: ['gpt-4o', 'claude-3.5-sonnet'],
    maxContextLength: { 'gpt-4o': 128000, 'claude-3.5-sonnet': 200000 },
    maxOutputTokens: { 'gpt-4o': 16384, 'claude-3.5-sonnet': 8192 },
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsSystemMessages: true,
    supportsVision: false,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 100, tokensPerMinute: 1000000, concurrentRequests: 10 },
    pricing: {
      'gpt-4o': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
      'claude-3.5-sonnet': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
    },
  };

  private baseUrl = 'http://localhost:4141/v1';
  private headers: Record<string, string> = {};

  constructor(options: BaseProviderOptions) { super(options); }

  /** Accept any model string since copilot-api proxies whatever Copilot supports. */
  validateModel(_model: LLMModel): boolean { return true; }

  protected async doInitialize(): Promise<void> {
    this.baseUrl = this.config.apiUrl || 'http://localhost:4141/v1';
    const token = this.config.apiKey || process.env.GITHUB_TOKEN;
    this.headers = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    };

    if (!token) {
      this.logger.warn(
        'GITHUB_TOKEN not set. copilot-api requires a GitHub token with Copilot access. ' +
        'Set GITHUB_TOKEN env var.'
      );
    }

    const health = await this.doHealthCheck();
    if (!health.healthy) {
      this.logger.warn(
        `copilot-api not running at ${this.baseUrl.replace('/v1', '')}. ` +
        'Start it with: npx copilot-api'
      );
    }
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout || 120000);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify(this.buildRequest(request)),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) await this.handleErrorResponse(response);
      return this.transformResponse((await response.json()) as CopilotResponse, request);
    } catch (error) {
      clearTimeout(timeout);
      throw this.transformCopilotError(error);
    }
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (this.config.timeout || 120000) * 2);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify(this.buildRequest(request, true)),
        signal: controller.signal,
      });
      if (!response.ok) await this.handleErrorResponse(response);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            const promptTokens = this.estimateTokens(JSON.stringify(request.messages));
            yield {
              type: 'done',
              usage: { promptTokens, completionTokens: 100, totalTokens: promptTokens + 100 },
              cost: { ...ZERO_COST },
            };
            continue;
          }
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta;
            if (delta?.content) yield { type: 'content', delta: { content: delta.content } };
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                yield { type: 'tool_call', delta: { toolCall: { id: tc.id, type: 'function', function: tc.function } } };
              }
            }
          } catch { /* ignore partial SSE chunk parse errors */ }
        }
      }
    } catch (error) {
      clearTimeout(timeout);
      throw this.transformCopilotError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async listModels(): Promise<LLMModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
      if (!response.ok) {
        this.logger.warn('Could not fetch models from copilot-api.');
        return this.capabilities.supportedModels;
      }
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id as LLMModel) || this.capabilities.supportedModels;
    } catch {
      return this.capabilities.supportedModels;
    }
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    return {
      model, name: model,
      description: 'Model via GitHub Copilot (subscription-included)',
      contextLength: this.capabilities.maxContextLength[model] || 128000,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 16384,
      supportedFeatures: ['chat', 'completion', 'tool_calling', 'copilot'],
      pricing: { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
      return {
        healthy: response.ok, timestamp: new Date(),
        details: { server: 'copilot-api', local: true },
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'copilot-api not reachable',
        timestamp: new Date(),
        details: { hint: `copilot-api not running at ${this.baseUrl.replace('/v1', '')}. Start with: npx copilot-api` },
      };
    }
  }

  private buildRequest(request: LLMRequest, stream = false): Record<string, unknown> {
    const messages = request.messages.map((msg) => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      ...(msg.name && { name: msg.name }),
      ...(msg.toolCallId && { tool_call_id: msg.toolCallId }),
      ...(msg.toolCalls && { tool_calls: msg.toolCalls }),
    }));
    const r: Record<string, unknown> = { model: request.model || this.config.model, messages, stream };

    const temp = request.temperature ?? this.config.temperature;
    const maxTok = request.maxTokens || this.config.maxTokens;
    const topP = request.topP ?? this.config.topP;
    const stop = request.stopSequences || this.config.stopSequences;
    if (temp !== undefined) r.temperature = temp;
    if (maxTok) r.max_tokens = maxTok;
    if (topP !== undefined) r.top_p = topP;
    if (stop) r.stop = stop;
    if (request.tools) { r.tools = request.tools; r.tool_choice = request.toolChoice; }
    return r;
  }

  private transformResponse(data: CopilotResponse, request: LLMRequest): LLMResponse {
    const choice = data.choices[0];
    return {
      id: data.id,
      model: (request.model || this.config.model) as LLMModel,
      provider: 'copilot',
      content: choice.message.content || '',
      toolCalls: choice.message.tool_calls,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      cost: { ...ZERO_COST },
      finishReason: choice.finish_reason,
    };
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    const errorText = await response.text();
    let errorData: { error?: { message?: string } };
    try { errorData = JSON.parse(errorText); } catch { errorData = { error: { message: errorText } }; }
    const message = errorData.error?.message || 'Unknown error';
    if (response.status === 0 || message.includes('connection')) {
      throw new ProviderUnavailableError('copilot', {
        message, hint: 'copilot-api not running. Start with: npx copilot-api',
      });
    }
    throw new LLMProviderError(
      message, `COPILOT_${response.status}`, 'copilot',
      response.status, response.status >= 500, errorData
    );
  }

  private transformCopilotError(error: unknown): LLMProviderError {
    if (error instanceof LLMProviderError) return error;
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
        return new ProviderUnavailableError('copilot', {
          originalError: error.message,
          hint: 'copilot-api not running. Start with: npx copilot-api',
        });
      }
    }
    return this.transformError(error);
  }
}
