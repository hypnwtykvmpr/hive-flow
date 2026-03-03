/**
 * V3 OpenRouter Provider
 *
 * OpenAI-compatible provider for OpenRouter's unified API gateway.
 * Supports 200+ models via provider/model naming (e.g. google/gemini-2.5-flash).
 *
 * @module @claude-flow/providers/openrouter-provider
 */
import { BaseProvider } from './base-provider.js';
import { AuthenticationError, RateLimitError, ModelNotFoundError, LLMProviderError, } from './types.js';
const DEFAULT_MODELS = [
    'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b', 'deepseek/deepseek-chat-v3',
    'openai/gpt-4o-mini', 'mistralai/mistral-small-25',
];
const p = (prompt, completion) => ({ promptCostPer1k: prompt, completionCostPer1k: completion, currency: 'USD' });
export class OpenRouterProvider extends BaseProvider {
    name = 'openrouter';
    capabilities = {
        supportedModels: [...DEFAULT_MODELS],
        maxContextLength: {
            'google/gemini-2.5-flash': 1048576, 'meta-llama/llama-3.3-70b': 131072,
            'deepseek/deepseek-chat-v3': 131072, 'openai/gpt-4o-mini': 128000, 'mistralai/mistral-small-25': 32768,
        },
        maxOutputTokens: {
            'google/gemini-2.5-flash': 65536, 'meta-llama/llama-3.3-70b': 4096,
            'deepseek/deepseek-chat-v3': 8192, 'openai/gpt-4o-mini': 16384, 'mistralai/mistral-small-25': 8192,
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
        pricing: {
            'google/gemini-2.5-flash': p(0.00015, 0.0006),
            'meta-llama/llama-3.3-70b': p(0.00059, 0.00079),
            'deepseek/deepseek-chat-v3': p(0.0003, 0.00088),
            'openai/gpt-4o-mini': p(0.00015, 0.0006),
            'mistralai/mistral-small-25': p(0.0001, 0.0003),
        },
    };
    baseUrl = 'https://openrouter.ai/api/v1';
    headers = {};
    constructor(options) {
        super(options);
    }
    async doInitialize() {
        const apiKey = this.config.apiKey || process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            throw new AuthenticationError('OpenRouter API key is required. Set config.apiKey or OPENROUTER_API_KEY env var.', 'openrouter');
        }
        this.baseUrl = this.config.apiUrl || 'https://openrouter.ai/api/v1';
        this.headers = {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': this.config.providerOptions?.httpReferer || 'https://github.com/ruvnet/claude-flow',
            'X-Title': this.config.providerOptions?.xTitle || 'Claude Flow',
        };
    }
    async doComplete(request) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeout || 60000);
        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST', headers: this.headers,
                body: JSON.stringify(this.buildRequest(request)), signal: controller.signal,
            });
            clearTimeout(timer);
            if (!response.ok)
                await this.handleErrorResponse(response);
            const data = await response.json();
            return this.transformResponse(data, request);
        }
        catch (error) {
            clearTimeout(timer);
            throw this.transformError(error);
        }
    }
    async *doStreamComplete(request) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), (this.config.timeout || 60000) * 2);
        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST', headers: this.headers,
                body: JSON.stringify(this.buildRequest(request, true)), signal: controller.signal,
            });
            if (!response.ok)
                await this.handleErrorResponse(response);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.startsWith('data: '))
                        continue;
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
                                totalCost: (promptTokens / 1000) * (pr?.promptCostPer1k ?? 0) + (100 / 1000) * (pr?.completionCostPer1k ?? 0),
                                currency: 'USD',
                            },
                        };
                        continue;
                    }
                    try {
                        const delta = JSON.parse(data).choices?.[0]?.delta;
                        if (delta?.content)
                            yield { type: 'content', delta: { content: delta.content } };
                        if (delta?.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                yield { type: 'tool_call', delta: { toolCall: { id: tc.id, type: 'function', function: tc.function } } };
                            }
                        }
                    }
                    catch { /* ignore malformed SSE chunks */ }
                }
            }
        }
        catch (error) {
            clearTimeout(timer);
            throw this.transformError(error);
        }
        finally {
            clearTimeout(timer);
        }
    }
    async listModels() {
        try {
            const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
            if (!response.ok)
                return this.capabilities.supportedModels;
            const json = await response.json();
            if (json.data && Array.isArray(json.data)) {
                return json.data.map((entry) => entry.id);
            }
            return this.capabilities.supportedModels;
        }
        catch {
            return this.capabilities.supportedModels;
        }
    }
    async getModelInfo(model) {
        return {
            model, name: model,
            description: `OpenRouter model: ${model}`,
            contextLength: this.capabilities.maxContextLength[model] || 128000,
            maxOutputTokens: this.capabilities.maxOutputTokens[model] || 4096,
            supportedFeatures: ['chat', 'completion', 'tool_calling'],
            pricing: this.capabilities.pricing[model],
        };
    }
    /** Accept any provider/model string since OpenRouter proxies hundreds of models. */
    validateModel(model) {
        return this.capabilities.supportedModels.includes(model) || (typeof model === 'string' && model.includes('/'));
    }
    async doHealthCheck() {
        try {
            const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers });
            return {
                healthy: response.ok, timestamp: new Date(),
                ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
            };
        }
        catch (error) {
            return { healthy: false, error: error instanceof Error ? error.message : 'Unknown error', timestamp: new Date() };
        }
    }
    buildRequest(request, stream = false) {
        const req = {
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
        if (request.tools) {
            req.tools = request.tools;
            req.tool_choice = request.toolChoice;
        }
        return req;
    }
    transformResponse(data, request) {
        const choice = data.choices[0];
        const model = request.model || this.config.model;
        const pr = this.capabilities.pricing[model];
        const promptCost = (data.usage.prompt_tokens / 1000) * (pr?.promptCostPer1k ?? 0);
        const completionCost = (data.usage.completion_tokens / 1000) * (pr?.completionCostPer1k ?? 0);
        return {
            id: data.id,
            model: model,
            provider: 'openrouter',
            content: choice.message.content || '',
            toolCalls: choice.message.tool_calls,
            usage: {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
            },
            cost: { promptCost, completionCost, totalCost: promptCost + completionCost, currency: 'USD' },
            finishReason: choice.finish_reason,
        };
    }
    async handleErrorResponse(response) {
        const errorText = await response.text();
        let errorData;
        try {
            errorData = JSON.parse(errorText);
        }
        catch {
            errorData = { error: { message: errorText } };
        }
        const message = errorData.error?.message || 'Unknown error';
        switch (response.status) {
            case 401:
                throw new AuthenticationError(message, 'openrouter', errorData);
            case 429: {
                const retryAfter = response.headers.get('retry-after');
                throw new RateLimitError(message, 'openrouter', retryAfter ? parseInt(retryAfter) : undefined, errorData);
            }
            case 404:
                throw new ModelNotFoundError(this.config.model, 'openrouter', errorData);
            default:
                throw new LLMProviderError(message, `OPENROUTER_${response.status}`, 'openrouter', response.status, response.status >= 500, errorData);
        }
    }
}
//# sourceMappingURL=openrouter-provider.js.map