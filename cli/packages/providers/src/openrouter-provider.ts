/**
 * V3 OpenRouter Provider
 *
 * OpenAI-compatible provider for OpenRouter's unified API gateway.
 * Supports 200+ models via provider/model naming (e.g. xiaomi/mimo-v2.5-pro).
 *
 * @module @hive-flow/providers/openrouter-provider
 */

import { BaseProvider, BaseProviderOptions } from './base-provider.js';
import {
  LLMProvider, LLMModel, LLMRequest, LLMResponse, LLMStreamEvent,
  ModelInfo, ProviderCapabilities, HealthCheckResult, CostEstimate,
  AuthenticationError, RateLimitError, ModelNotFoundError, LLMProviderError,
} from './types.js';
import { resolveProviderModel } from './model-alias-resolver.js';

interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

interface OpenRouterResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenRouterStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

const DEFAULT_MODELS: LLMModel[] = [
  'xiaomi/mimo-v2.5-pro', 'x-ai/grok-4.3', 'minimax/minimax-m3',
  'moonshotai/kimi-k2.6', 'qwen/qwen3.7-plus', 'z-ai/glm-5.2',
  'qwen/qwen3.6-plus', 'nvidia/nemotron-3-super-120b-a12b:free', 'deepseek/deepseek-v4-flash',
];

// Public OpenRouter pricing per 1K tokens (input / output) for DEFAULT_MODELS.
// These are the static published prices; dynamic per-request cost comes from
// usage data in the response when available (see transformResponse).
const p = (prompt: number, completion: number) =>
  ({ promptCostPer1k: prompt, completionCostPer1k: completion, currency: 'USD' as const });

const DEFAULT_PRICING: Record<string, { promptCostPer1k: number; completionCostPer1k: number; currency: string }> = {
  'xiaomi/mimo-v2.5-pro':                   p(0.0005, 0.002),
  'x-ai/grok-4.3':                          p(0.003,  0.015),
  'minimax/minimax-m3':                      p(0.0004, 0.0016),
  'moonshotai/kimi-k2.6':                   p(0.0005, 0.0025),
  'qwen/qwen3.7-plus':                       p(0.0005, 0.002),
  'z-ai/glm-5.2':                            p(0.0012, 0.0041),
  'qwen/qwen3.6-plus':                       p(0.0005, 0.002),
  'nvidia/nemotron-3-super-120b-a12b:free':  p(0,      0),
  'deepseek/deepseek-v4-flash':              p(0.00014, 0.00028),
};

export class OpenRouterProvider extends BaseProvider {
  readonly name: LLMProvider = 'openrouter';
  readonly capabilities: ProviderCapabilities = {
    supportedModels: [...DEFAULT_MODELS],
    maxContextLength: {
      'xiaomi/mimo-v2.5-pro': 1048576, 'x-ai/grok-4.3': 1000000, 'minimax/minimax-m3': 1048576,
      'moonshotai/kimi-k2.6': 262144, 'qwen/qwen3.7-plus': 1000000, 'z-ai/glm-5.2': 1000000,
      'qwen/qwen3.6-plus': 1000000, 'nvidia/nemotron-3-super-120b-a12b:free': 262144, 'deepseek/deepseek-v4-flash': 1000000,
    },
    maxOutputTokens: {
      'xiaomi/mimo-v2.5-pro': 32768, 'x-ai/grok-4.3': 32768, 'minimax/minimax-m3': 32768,
      'moonshotai/kimi-k2.6': 32768, 'qwen/qwen3.7-plus': 32768, 'z-ai/glm-5.2': 32768,
      'qwen/qwen3.6-plus': 32768, 'nvidia/nemotron-3-super-120b-a12b:free': 32768, 'deepseek/deepseek-v4-flash': 32768,
    },
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsSystemMessages: true,
    supportsVision: true,
    supportsAudio: false,
    supportsFineTuning: false,
    supportsEmbeddings: false,
    supportsBatching: false,
    rateLimit: { requestsPerMinute: 200, tokensPerMinute: 10000000, concurrentRequests: 50 },
    // Pricing for DEFAULT_MODELS populated from public OpenRouter docs.
    // Models added at runtime via listModels() will not have pricing entries;
    // callers should treat a missing entry as unavailable (not zero).
    pricing: { ...DEFAULT_PRICING },
  };

  private baseUrl = 'https://openrouter.ai/api/v1';
  private headers: Record<string, string> = {};
  private modelMetadataCache: Map<string, number> = new Map();
  private metadataCacheTime = 0;
  private refreshInFlight: Promise<void> | null = null;

  constructor(options: BaseProviderOptions) {
    super(options);
  }

  protected async doInitialize(): Promise<void> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new AuthenticationError(
        'OpenRouter API key is required in config.apiKey. Hive Flow strict mode must hydrate API keys through the credential holder, not process.env.',
        'openrouter',
      );
    }
    this.baseUrl = this.config.apiUrl || 'https://openrouter.ai/api/v1';
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': (this.config.providerOptions?.httpReferer as string) || '',
      'X-Title': (this.config.providerOptions?.xTitle as string) || 'Hive Flow',
    };
  }

  protected async doComplete(request: LLMRequest): Promise<LLMResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout || 60000);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify(this.buildRequest(request)), signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) await this.handleErrorResponse(response);
      const data = await response.json() as OpenRouterResponse;
      return this.transformResponse(data, request);
    } catch (error) {
      clearTimeout(timer);
      throw this.transformError(error);
    }
  }

  protected async *doStreamComplete(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (this.config.timeout || 60000) * 2);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify(this.buildRequest(request, true)), signal: controller.signal,
      });
      if (!response.ok) await this.handleErrorResponse(response);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedContent = '';
      let usageFromStream: OpenRouterStreamChunk['usage'] | null = null;

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
            const promptTokens = usageFromStream?.prompt_tokens ?? this.estimateTokens(JSON.stringify(request.messages));
            const completionTokens = usageFromStream?.completion_tokens ?? this.estimateTokens(streamedContent);
            const totalTokens = usageFromStream?.total_tokens ?? promptTokens + completionTokens;
            const model = this.resolveRequestModel(request);
            const pr = this.capabilities.pricing[model];
            const cost = pr ? {
              promptCost: (promptTokens / 1000) * pr.promptCostPer1k,
              completionCost: (completionTokens / 1000) * pr.completionCostPer1k,
              totalCost: (promptTokens / 1000) * pr.promptCostPer1k + (completionTokens / 1000) * pr.completionCostPer1k,
              currency: 'USD',
            } : undefined;
            yield {
              type: 'done',
              usage: { promptTokens, completionTokens, totalTokens },
              ...(cost ? { cost } : {}),
            };
            continue;
          }
          try {
            const chunk = JSON.parse(data) as OpenRouterStreamChunk;
            if (chunk.usage) usageFromStream = chunk.usage;
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              streamedContent += delta.content;
              yield { type: 'content', delta: { content: delta.content } };
            }
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

  async listModels(): Promise<LLMModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
      if (!response.ok) return this.capabilities.supportedModels;
      const json = await response.json() as { data?: Array<{ id: string; context_length?: number }> };
      if (json.data && Array.isArray(json.data)) {
        // Populate metadata cache from API response
        this.modelMetadataCache.clear();
        for (const entry of json.data) {
          if (typeof entry.context_length === 'number' && entry.context_length > 0 && Number.isFinite(entry.context_length)) {
            this.modelMetadataCache.set(entry.id, entry.context_length);
          }
        }
        this.metadataCacheTime = Date.now();
        return json.data.map((entry) => entry.id as LLMModel);
      }
      return this.capabilities.supportedModels;
    } catch (err) {
      // listModels fetch failed — use static fallback
      return this.capabilities.supportedModels;
    }
  }

  async getModelInfo(model: LLMModel): Promise<ModelInfo> {
    const resolvedModel = this.resolveModel(model);
    return {
      model: resolvedModel as LLMModel, name: resolvedModel,
      description: `OpenRouter model: ${resolvedModel}`,
      contextLength: this.capabilities.maxContextLength[resolvedModel] || 128000,
      maxOutputTokens: this.capabilities.maxOutputTokens[resolvedModel] || 4096,
      supportedFeatures: ['chat', 'completion', 'tool_calling'],
      pricing: this.capabilities.pricing[resolvedModel],
    };
  }

  async estimateCost(request: LLMRequest): Promise<CostEstimate> {
    const model = this.resolveRequestModel(request);
    const pricing = this.capabilities.pricing?.[model];

    if (!pricing) {
      return {
        estimatedPromptTokens: 0,
        estimatedCompletionTokens: 0,
        estimatedTotalTokens: 0,
        estimatedCost: { prompt: 0, completion: 0, total: 0, currency: 'USD' },
        confidence: 0,
      };
    }

    const promptTokens = this.estimateTokens(JSON.stringify(request.messages));
    const completionTokens = request.maxTokens || this.config.maxTokens || 1000;
    const promptCost = (promptTokens / 1000) * pricing.promptCostPer1k;
    const completionCost = (completionTokens / 1000) * pricing.completionCostPer1k;

    return {
      estimatedPromptTokens: promptTokens,
      estimatedCompletionTokens: completionTokens,
      estimatedTotalTokens: promptTokens + completionTokens,
      estimatedCost: {
        prompt: promptCost,
        completion: completionCost,
        total: promptCost + completionCost,
        currency: pricing.currency,
      },
      confidence: 0.7,
    };
  }

  /**
   * Resolve the context window length for a model.
   *
   * Resolution order:
   * 1. modelMetadataCache (populated by listModels from /models API)
   * 2. capabilities.maxContextLength (static defaults)
   * 3. 128000 (safe fallback)
   *
   * If the metadata cache is empty or stale (>5 min), triggers a background
   * listModels() refresh but returns immediately from static sources.
   */
  async getModelContextLength(model: string): Promise<number> {
    // 1. Check metadata cache (populated from /models API)
    const METADATA_TTL_MS = 5 * 60 * 1000; // 5 minutes
    if (this.modelMetadataCache.size > 0 && (Date.now() - this.metadataCacheTime) < METADATA_TTL_MS) {
      const cached = this.modelMetadataCache.get(model);
      if (cached !== undefined) return cached;
    }

    // 2. Check static capabilities
    const staticLength = this.capabilities.maxContextLength[model];
    if (staticLength !== undefined) return staticLength;

    // Trigger background refresh if cache is empty or stale (guarded against concurrent calls)
    if (this.modelMetadataCache.size === 0 || (Date.now() - this.metadataCacheTime) >= METADATA_TTL_MS) {
      if (!this.refreshInFlight) {
        this.refreshInFlight = this.listModels()
          .then(() => { /* cache populated */ })
          .catch(() => { /* best-effort refresh */ })
          .finally(() => { this.refreshInFlight = null; });
      }
    }

    // 3. Safe fallback
    return 128000;
  }

  /** Accept any provider/model string since OpenRouter proxies hundreds of models. */
  validateModel(model: LLMModel): boolean {
    return this.capabilities.supportedModels.includes(model) || (typeof model === 'string' && model.includes('/'));
  }

  protected async doHealthCheck(): Promise<HealthCheckResult> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
      return {
        healthy: response.ok, timestamp: new Date(),
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : 'Unknown error', timestamp: new Date() };
    }
  }

  private buildRequest(request: LLMRequest, stream = false): OpenRouterRequest {
    const req: OpenRouterRequest = {
      model: this.resolveRequestModel(request),
      messages: request.messages.map((msg) => ({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        ...(msg.name && { name: msg.name }),
        ...(msg.toolCallId && { tool_call_id: msg.toolCallId }),
        ...(msg.toolCalls && { tool_calls: msg.toolCalls }),
      })),
      stream,
    };
    if (stream) req.stream_options = { include_usage: true };
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
    if (request.tools) {
      req.tools = request.tools;
      req.tool_choice = request.toolChoice;
    }
    return req;
  }

  private transformResponse(data: OpenRouterResponse, request: LLMRequest): LLMResponse {
    const choice = data.choices[0];
    const model = this.resolveRequestModel(request);
    const pr = this.capabilities.pricing[model];
    const cost = pr ? {
      promptCost: (data.usage.prompt_tokens / 1000) * pr.promptCostPer1k,
      completionCost: (data.usage.completion_tokens / 1000) * pr.completionCostPer1k,
      totalCost: (data.usage.prompt_tokens / 1000) * pr.promptCostPer1k +
        (data.usage.completion_tokens / 1000) * pr.completionCostPer1k,
      currency: 'USD',
    } : undefined;

    return {
      id: data.id,
      model: model as LLMModel,
      provider: 'openrouter',
      content: choice.message.content || '',
      toolCalls: choice.message.tool_calls,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      ...(cost ? { cost } : {}),
      finishReason: choice.finish_reason,
    };
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    const errorText = await response.text();
    let errorData: { error?: { message?: string } };
    try { errorData = JSON.parse(errorText); } catch { errorData = { error: { message: errorText } }; }
    const message = errorData.error?.message || 'Unknown error';

    switch (response.status) {
      case 401:
        throw new AuthenticationError(message, 'openrouter', errorData);
      case 429: {
        const retryAfter = response.headers.get('retry-after');
        throw new RateLimitError(message, 'openrouter', retryAfter ? parseInt(retryAfter, 10) : undefined, errorData);
      }
      case 404:
        throw new ModelNotFoundError(this.config.model, 'openrouter', errorData);
      default:
        throw new LLMProviderError(message, `OPENROUTER_${response.status}`, 'openrouter', response.status, response.status >= 500, errorData);
    }
  }

  private resolveRequestModel(request: LLMRequest): string {
    return this.resolveModel(request.model || this.config.model);
  }

  private resolveModel(model: LLMModel | undefined): string {
    const resolved = resolveProviderModel('openrouter', model);
    if (!resolved) {
      throw new ModelNotFoundError(String(model || 'undefined'), 'openrouter');
    }
    return resolved;
  }
}
