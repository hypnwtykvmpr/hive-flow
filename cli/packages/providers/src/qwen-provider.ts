/**
 * V3 Qwen API Provider
 *
 * OpenAI-compatible HTTP provider for Alibaba Cloud's Qwen models via DashScope.
 * Base URL: dashscope-intl.aliyuncs.com/compatible-mode/v1
 * Auth: strict config.apiKey hydration. Graceful if missing.
 *
 * @module @hive-flow/providers/qwen-provider
 */

import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  ModelInfo, ProviderCapabilities, HealthCheckResult,
  AuthenticationError, RateLimitError, ModelNotFoundError, LLMProviderError,
} from './types.js';
import {
  QWEN_CONTEXT_WINDOWS,
  QWEN_DEFAULT_MODEL,
  QWEN_MODEL_DESCRIPTIONS,
  QWEN_MODELS,
  QWEN_OUTPUT_LIMITS,
  QWEN_PRICING,
} from './qwen-model-constants.js';

interface QwenResponse {
  id: string;
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class QwenProvider extends BaseProvider {
  readonly name: LLMProvider = 'qwen';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: QWEN_MODELS,
    maxContextLength: QWEN_CONTEXT_WINDOWS,
    maxOutputTokens: QWEN_OUTPUT_LIMITS,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsSystemMessages: true,
    supportsVision: false,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 120, tokensPerMinute: 2000000, concurrentRequests: 10 },
    pricing: QWEN_PRICING,
  };

  private baseUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  private headers: Record<string, string> = {};

  constructor(options: BaseProviderOptions) { super(options); }

  protected validateConfig(): void {
    if (!this.config.model) this.config.model = QWEN_DEFAULT_MODEL;
    super.validateConfig();
  }

  protected async doInitialize(): Promise<void> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      this.logger.warn(
        'Qwen API key not configured. Set config.apiKey through the credential holder. ' +
        'Provider will report unhealthy until a key is provided.'
      );
    }
    this.baseUrl = this.config.apiUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    this.headers = {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      'Content-Type': 'application/json',
    };
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    this.ensureApiKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout || 60000);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify(this.buildRequest(request)),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) await this.handleErrorResponse(response);
      return this.transformResponse(await response.json() as QwenResponse, request);
    } catch (error) {
      clearTimeout(timer);
      throw this.transformError(error);
    }
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.ensureApiKey();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (this.config.timeout || 60000) * 2);
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
            const model = request.model || this.config.model;
            const pr = this.capabilities.pricing[model];
            yield {
              type: 'done',
              usage: { promptTokens, completionTokens: 100, totalTokens: promptTokens + 100 },
              cost: {
                promptCost: (promptTokens / 1000) * (pr?.promptCostPer1k ?? 0),
                completionCost: (100 / 1000) * (pr?.completionCostPer1k ?? 0),
                totalCost: (promptTokens / 1000) * (pr?.promptCostPer1k ?? 0) +
                  (100 / 1000) * (pr?.completionCostPer1k ?? 0),
                currency: 'USD',
              },
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
          } catch { /* ignore malformed SSE chunks */ }
        }
      }
    } catch (error) {
      clearTimeout(timer);
      throw this.transformError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(): Promise<LLMModel[]> { return [...QWEN_MODELS]; }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    return {
      model, name: model,
      description: QWEN_MODEL_DESCRIPTIONS[model] || 'Qwen model',
      contextLength: this.capabilities.maxContextLength[model] || 32768,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 8192,
      supportedFeatures: ['chat', 'completion', 'tool_calling'],
      pricing: this.capabilities.pricing[model],
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    if (!this.headers.Authorization) {
      return { healthy: false, error: 'Qwen API key not configured', timestamp: new Date(),
        details: { hint: 'Hydrate config.apiKey through the Hive Flow credential holder' } };
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
      return { healthy: response.ok, timestamp: new Date(),
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : 'Unknown error', timestamp: new Date() };
    }
  }

  private ensureApiKey(): void {
    if (!this.headers.Authorization) {
      throw new AuthenticationError(
        'Qwen API key not configured. Hydrate config.apiKey through the Hive Flow credential holder.', 'qwen'
      );
    }
  }

  private buildRequest(request: LLMRequest, stream = false): Record<string, unknown> {
    const req: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages: request.messages.map((msg) => ({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        ...(msg.name && { name: msg.name }),
        ...(msg.toolCallId && { tool_call_id: msg.toolCallId }),
        ...(msg.toolCalls && { tool_calls: msg.toolCalls }),
      })),
      stream,
    };
    if (request.temperature !== undefined || this.config.temperature !== undefined)
      req.temperature = request.temperature ?? this.config.temperature;
    if (request.maxTokens || this.config.maxTokens)
      req.max_tokens = request.maxTokens || this.config.maxTokens;
    if (request.topP !== undefined || this.config.topP !== undefined)
      req.top_p = request.topP ?? this.config.topP;
    if (request.frequencyPenalty !== undefined || this.config.frequencyPenalty !== undefined)
      req.frequency_penalty = request.frequencyPenalty ?? this.config.frequencyPenalty;
    if (request.presencePenalty !== undefined || this.config.presencePenalty !== undefined)
      req.presence_penalty = request.presencePenalty ?? this.config.presencePenalty;
    if (request.stopSequences || this.config.stopSequences)
      req.stop = request.stopSequences || this.config.stopSequences;
    if (request.tools) { req.tools = request.tools; req.tool_choice = request.toolChoice; }
    return req;
  }

  private transformResponse(data: QwenResponse, request: LLMRequest): LLMResponse {
    const choice = data.choices[0];
    const model = request.model || this.config.model;
    const pr = this.capabilities.pricing[model];
    const promptCost = (data.usage.prompt_tokens / 1000) * (pr?.promptCostPer1k ?? 0);
    const completionCost = (data.usage.completion_tokens / 1000) * (pr?.completionCostPer1k ?? 0);
    return {
      id: data.id, model: model as LLMModel, provider: 'qwen',
      content: choice.message.content || '',
      toolCalls: choice.message.tool_calls,
      usage: { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens },
      cost: { promptCost, completionCost, totalCost: promptCost + completionCost, currency: 'USD' },
      finishReason: choice.finish_reason as LLMResponse['finishReason'],
    };
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    const errorText = await response.text();
    let errorData: { error?: { message?: string } };
    try { errorData = JSON.parse(errorText); } catch { errorData = { error: { message: errorText } }; }
    const message = errorData.error?.message || 'Unknown error';
    switch (response.status) {
      case 401: throw new AuthenticationError(message, 'qwen', errorData);
      case 429: {
        const retryAfter = response.headers.get('retry-after');
        throw new RateLimitError(message, 'qwen', retryAfter ? parseInt(retryAfter, 10) : undefined, errorData);
      }
      case 404: throw new ModelNotFoundError(this.config.model, 'qwen', errorData);
      default: throw new LLMProviderError(
        message, `QWEN_${response.status}`, 'qwen', response.status, response.status >= 500, errorData
      );
    }
  }
}
