/**
 * V3 LM Studio Provider - OpenAI-compatible local inference via LM Studio.
 * Zero cost, supports any model the user loads in the LM Studio GUI.
 * @module @hive-flow/providers/lm-studio-provider
 */

import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  ModelInfo, ProviderCapabilities, HealthCheckResult,
  ProviderUnavailableError, LLMProviderError,
} from './types.js';

// OpenAI-compatible wire format (LM Studio uses the same request/response shape)

interface LMStudioRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
    name?: string; tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  }>;
  temperature?: number; max_tokens?: number; top_p?: number;
  frequency_penalty?: number; presence_penalty?: number;
  stop?: string[]; stream?: boolean;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

interface LMStudioResponse {
  id: string; object: string; created: number; model: string;
  choices: Array<{
    index: number;
    message: {
      role: string; content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const ZERO_COST = { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' };

export class LMStudioProvider extends BaseProvider {
  readonly name: LLMProvider = 'lm-studio';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: [],
    maxContextLength: {},
    maxOutputTokens: {},
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsSystemMessages: true,
    supportsVision: true, // Model-dependent
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 10000, tokensPerMinute: 10000000, concurrentRequests: 10 },
    pricing: {},
  };

  private baseUrl = 'http://localhost:1234/v1';
  private headers: Record<string, string> = {};

  constructor(options: BaseProviderOptions) { super(options); }

  protected async doInitialize(): Promise<void> {
    this.baseUrl = this.config.apiUrl || 'http://localhost:1234/v1';
    this.headers = {
      Authorization: `Bearer ${this.config.apiKey || 'lm-studio'}`,
      'Content-Type': 'application/json',
    };
    const health = await this.doHealthCheck();
    if (!health.healthy) {
      this.logger.warn(
        `LM Studio not running at ${this.baseUrl.replace('/v1', '')}. ` +
          'Start LM Studio and load a model to use this provider.'
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
      return this.transformResponse((await response.json()) as LMStudioResponse, request);
    } catch (error) {
      clearTimeout(timeout);
      throw this.transformLMStudioError(error);
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
      throw this.transformLMStudioError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async listModels(): Promise<LLMModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
      if (!response.ok) {
        this.logger.warn('Could not fetch models from LM Studio. Is a model loaded?');
        return [];
      }
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return data.data?.map((m) => m.id as LLMModel) || [];
    } catch {
      this.logger.warn('LM Studio not reachable. No models available.');
      return [];
    }
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    return {
      model, name: model,
      description: 'Model loaded in LM Studio (local inference)',
      contextLength: this.capabilities.maxContextLength[model] || 4096,
      maxOutputTokens: this.capabilities.maxOutputTokens[model] || 4096,
      supportedFeatures: ['chat', 'completion', 'tool_calling', 'local'],
      pricing: { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
    };
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
      return {
        healthy: response.ok, timestamp: new Date(),
        details: { server: 'lm-studio', local: true },
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'LM Studio not reachable',
        timestamp: new Date(),
        details: { hint: `LM Studio not running at ${this.baseUrl.replace('/v1', '')}. Start LM Studio and load a model.` },
      };
    }
  }

  /** Always true -- LM Studio models are user-loaded and not known ahead of time. */
  validateModel(_model: LLMModel): boolean { return true; }

  private buildRequest(request: LLMRequest, stream = false): LMStudioRequest {
    const messages = request.messages.map((msg) => ({
      role: msg.role as LMStudioRequest['messages'][0]['role'],
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      ...(msg.name && { name: msg.name }),
      ...(msg.toolCallId && { tool_call_id: msg.toolCallId }),
      ...(msg.toolCalls && { tool_calls: msg.toolCalls }),
    }));
    const r: LMStudioRequest = { model: request.model || this.config.model, messages, stream };

    const temp = request.temperature ?? this.config.temperature;
    const topP = request.topP ?? this.config.topP;
    const freqP = request.frequencyPenalty ?? this.config.frequencyPenalty;
    const presP = request.presencePenalty ?? this.config.presencePenalty;
    const maxTok = request.maxTokens || this.config.maxTokens;
    const stop = request.stopSequences || this.config.stopSequences;
    if (temp !== undefined) r.temperature = temp;
    if (maxTok) r.max_tokens = maxTok;
    if (topP !== undefined) r.top_p = topP;
    if (freqP !== undefined) r.frequency_penalty = freqP;
    if (presP !== undefined) r.presence_penalty = presP;
    if (stop) r.stop = stop;
    if (request.tools) { r.tools = request.tools; r.tool_choice = request.toolChoice; }
    return r;
  }

  private transformResponse(data: LMStudioResponse, request: LLMRequest): LLMResponse {
    const choice = data.choices[0];
    return {
      id: data.id,
      model: (request.model || this.config.model) as LLMModel,
      provider: 'lm-studio',
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
      throw new ProviderUnavailableError('lm-studio', {
        message, hint: 'LM Studio not running at localhost:1234. Start LM Studio and load a model.',
      });
    }
    throw new LLMProviderError(
      message, `LM_STUDIO_${response.status}`, 'lm-studio',
      response.status, response.status >= 500, errorData
    );
  }

  /** Transform errors with LM Studio-specific connection hints. */
  private transformLMStudioError(error: unknown): LLMProviderError {
    if (error instanceof LLMProviderError) return error;
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
        return new ProviderUnavailableError('lm-studio', {
          originalError: error.message,
          hint: 'LM Studio not running at localhost:1234. Start LM Studio and load a model.',
        });
      }
    }
    return this.transformError(error);
  }
}
