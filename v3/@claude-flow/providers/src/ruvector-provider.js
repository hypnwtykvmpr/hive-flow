/**
 * V3 RuVector Provider (via @ruvector/ruvllm)
 *
 * Self-learning LLM orchestration with:
 * - SONA adaptive learning
 * - HNSW vector memory
 * - FastGRNN intelligent routing
 * - SIMD inference optimization
 * - Local model execution (free)
 *
 * @module @claude-flow/providers/ruvector-provider
 */
import { BaseProvider } from './base-provider.js';
import { ProviderUnavailableError, LLMProviderError, } from './types.js';
export class RuVectorProvider extends BaseProvider {
    name = 'ruvector';
    capabilities = {
        supportedModels: [
            // RuVector-managed models
            'ruvector-auto', // Auto-selects best model
            'ruvector-fast', // Optimized for speed
            'ruvector-quality', // Optimized for quality
            'ruvector-balanced', // Balanced speed/quality
            // Local models via ruvLLM or Ollama fallback
            'llama3.2',
            'mistral',
            'phi-4',
            'deepseek-coder',
            'codellama',
            'qwen2.5',
            'qwen2.5:0.5b', // CPU-friendly Qwen
            'qwen2.5:1.5b',
            'smollm:135m', // SmolLM models
            'smollm:360m',
            'tinyllama',
        ],
        maxContextLength: {
            'ruvector-auto': 128000,
            'ruvector-fast': 32000,
            'ruvector-quality': 128000,
            'ruvector-balanced': 64000,
            'llama3.2': 128000,
            'mistral': 32000,
            'phi-4': 16000,
            'deepseek-coder': 16000,
            'codellama': 16000,
            'qwen2.5': 32000,
        },
        maxOutputTokens: {
            'ruvector-auto': 8192,
            'ruvector-fast': 4096,
            'ruvector-quality': 8192,
            'ruvector-balanced': 8192,
            'llama3.2': 8192,
            'mistral': 8192,
            'phi-4': 4096,
            'deepseek-coder': 8192,
            'codellama': 8192,
            'qwen2.5': 8192,
        },
        supportsStreaming: true,
        supportsToolCalling: true,
        supportsSystemMessages: true,
        supportsVision: false,
        supportsAudio: false,
        supportsFineTuning: true, // SONA self-learning
        supportsEmbeddings: true, // HNSW
        supportsBatching: true,
        rateLimit: {
            requestsPerMinute: 10000, // Local - no rate limit
            tokensPerMinute: 10000000,
            concurrentRequests: 100,
        },
        // Free - local execution with SONA optimization
        pricing: {
            'ruvector-auto': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'ruvector-fast': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'ruvector-quality': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'ruvector-balanced': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'llama3.2': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'mistral': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'phi-4': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'deepseek-coder': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'codellama': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
            'qwen2.5': { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
        },
    };
    baseUrl = 'http://localhost:3000'; // ruvLLM default port
    ollamaUrl = 'http://localhost:11434';
    ruvectorConfig = {};
    ruvllm; // Dynamic import of @ruvector/ruvllm
    useOllamaFallback = false;
    ruvllmAvailable = false;
    constructor(options) {
        super(options);
        this.ruvectorConfig = options.config.providerOptions || {};
    }
    async doInitialize() {
        // Configure URLs from options
        this.baseUrl = this.config.apiUrl || 'http://localhost:3000';
        this.ollamaUrl = this.config.providerOptions?.ollamaUrl || 'http://localhost:11434';
        // Try to dynamically import @ruvector/ruvllm native module
        try {
            this.ruvllm = await import('@ruvector/ruvllm').catch(() => null);
            if (this.ruvllm) {
                this.logger.info('RuVector ruvLLM native module loaded');
                this.ruvllmAvailable = true;
            }
        }
        catch {
            this.logger.debug('RuVector ruvLLM native module not available');
        }
        // Check if RuVector HTTP server is running
        const health = await this.doHealthCheck();
        if (health.healthy) {
            this.logger.info('RuVector server connected');
            return;
        }
        // Fallback: Check if Ollama is running for local model execution
        try {
            const ollamaHealth = await fetch(`${this.ollamaUrl}/api/tags`, {
                signal: AbortSignal.timeout(3000),
            });
            if (ollamaHealth.ok) {
                this.useOllamaFallback = true;
                this.logger.info('Using Ollama as fallback for local model execution');
            }
        }
        catch {
            this.logger.warn('Neither RuVector nor Ollama available. Provider may not work.');
        }
    }
    async doComplete(request) {
        // Use Ollama fallback if RuVector server isn't available
        if (this.useOllamaFallback) {
            return this.completeWithOllama(request);
        }
        const ruvectorRequest = this.buildRuvectorQuery(request);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeout || 120000);
        try {
            // Use ruvLLM's /query endpoint (not OpenAI-compatible)
            const response = await fetch(`${this.baseUrl}/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
                },
                body: JSON.stringify(ruvectorRequest),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) {
                await this.handleErrorResponse(response);
            }
            const data = await response.json();
            return this.transformResponse(data, request);
        }
        catch (error) {
            clearTimeout(timeout);
            // Auto-fallback to Ollama on connection error
            if (error instanceof Error && (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed'))) {
                this.useOllamaFallback = true;
                this.logger.info('RuVector connection failed, falling back to Ollama');
                return this.completeWithOllama(request);
            }
            throw this.transformError(error);
        }
    }
    /**
     * Fallback completion using Ollama API
     */
    async completeWithOllama(request) {
        const model = request.model || this.config.model;
        const ollamaRequest = {
            model,
            messages: request.messages.map((msg) => ({
                role: msg.role === 'tool' ? 'assistant' : msg.role,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            })),
            stream: false,
            options: {
                temperature: request.temperature ?? this.config.temperature ?? 0.7,
                num_predict: request.maxTokens || this.config.maxTokens || 2048,
            },
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeout || 120000);
        try {
            const response = await fetch(`${this.ollamaUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ollamaRequest),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok) {
                const errorText = await response.text();
                throw new LLMProviderError(`Ollama error: ${errorText}`, `OLLAMA_${response.status}`, 'ruvector', response.status, true);
            }
            const data = await response.json();
            const promptTokens = data.prompt_eval_count || this.estimateTokens(JSON.stringify(request.messages));
            const completionTokens = data.eval_count || this.estimateTokens(data.message?.content || '');
            return {
                id: `ruvector-ollama-${Date.now()}`,
                model: model,
                provider: 'ruvector',
                content: data.message?.content || '',
                usage: {
                    promptTokens,
                    completionTokens,
                    totalTokens: promptTokens + completionTokens,
                },
                cost: {
                    promptCost: 0,
                    completionCost: 0,
                    totalCost: 0,
                    currency: 'USD',
                },
                finishReason: 'stop',
                metadata: {
                    backend: 'ollama',
                    sona: { enabled: false },
                },
            };
        }
        catch (error) {
            clearTimeout(timeout);
            throw this.transformError(error);
        }
    }
    async *doStreamComplete(request) {
        const ruvectorRequest = this.buildRequest(request, true);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), (this.config.timeout || 120000) * 2);
        try {
            const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
                },
                body: JSON.stringify(ruvectorRequest),
                signal: controller.signal,
            });
            if (!response.ok) {
                await this.handleErrorResponse(response);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let promptTokens = 0;
            let completionTokens = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]')
                            continue;
                        try {
                            const chunk = JSON.parse(data);
                            if (chunk.content) {
                                yield {
                                    type: 'content',
                                    delta: { content: chunk.content },
                                };
                            }
                            if (chunk.done && chunk.usage) {
                                promptTokens = chunk.usage.prompt_tokens;
                                completionTokens = chunk.usage.completion_tokens;
                                yield {
                                    type: 'done',
                                    usage: {
                                        promptTokens,
                                        completionTokens,
                                        totalTokens: promptTokens + completionTokens,
                                    },
                                    cost: {
                                        promptCost: 0,
                                        completionCost: 0,
                                        totalCost: 0,
                                        currency: 'USD',
                                    },
                                };
                            }
                        }
                        catch {
                            // Ignore parse errors
                        }
                    }
                    else if (line.trim() && !line.startsWith(':')) {
                        // Direct JSON response (non-SSE)
                        try {
                            const chunk = JSON.parse(line);
                            if (chunk.content) {
                                yield {
                                    type: 'content',
                                    delta: { content: chunk.content },
                                };
                            }
                        }
                        catch {
                            // Ignore
                        }
                    }
                }
            }
            // Ensure done event is sent
            if (completionTokens === 0) {
                yield {
                    type: 'done',
                    usage: {
                        promptTokens: this.estimateTokens(JSON.stringify(request.messages)),
                        completionTokens: 100,
                        totalTokens: this.estimateTokens(JSON.stringify(request.messages)) + 100,
                    },
                    cost: { promptCost: 0, completionCost: 0, totalCost: 0, currency: 'USD' },
                };
            }
        }
        catch (error) {
            clearTimeout(timeout);
            throw this.transformError(error);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async listModels() {
        try {
            const response = await fetch(`${this.baseUrl}/v1/models`);
            if (!response.ok) {
                return this.capabilities.supportedModels;
            }
            const data = await response.json();
            return data.data?.map((m) => m.id) || this.capabilities.supportedModels;
        }
        catch {
            return this.capabilities.supportedModels;
        }
    }
    async getModelInfo(model) {
        const descriptions = {
            'ruvector-auto': 'Auto-selects optimal model with SONA learning',
            'ruvector-fast': 'Optimized for speed with FastGRNN routing',
            'ruvector-quality': 'Highest quality with full SONA adaptation',
            'ruvector-balanced': 'Balanced speed and quality',
            'llama3.2': 'Meta Llama 3.2 via RuVector',
            'mistral': 'Mistral 7B via RuVector',
            'phi-4': 'Microsoft Phi-4 via RuVector',
            'deepseek-coder': 'DeepSeek Coder via RuVector',
            'codellama': 'Code Llama via RuVector',
            'qwen2.5': 'Qwen 2.5 via RuVector',
        };
        return {
            model,
            name: model,
            description: descriptions[model] || 'RuVector-managed local model',
            contextLength: this.capabilities.maxContextLength[model] || 32000,
            maxOutputTokens: this.capabilities.maxOutputTokens[model] || 4096,
            supportedFeatures: [
                'chat',
                'completion',
                'local',
                'self-learning',
                'sona',
                'hnsw-memory',
            ],
            pricing: { promptCostPer1k: 0, completionCostPer1k: 0, currency: 'USD' },
        };
    }
    async doHealthCheck() {
        try {
            const response = await fetch(`${this.baseUrl}/health`);
            if (response.ok) {
                const data = await response.json();
                return {
                    healthy: true,
                    timestamp: new Date(),
                    details: {
                        server: 'ruvector',
                        sona: data.sona ?? false,
                        hnsw: data.hnsw ?? false,
                        local: true,
                    },
                };
            }
            return {
                healthy: false,
                error: `HTTP ${response.status}`,
                timestamp: new Date(),
            };
        }
        catch (error) {
            return {
                healthy: false,
                error: error instanceof Error ? error.message : 'RuVector server not reachable',
                timestamp: new Date(),
                details: {
                    hint: 'Start RuVector server: npx @ruvector/ruvllm serve',
                },
            };
        }
    }
    /**
     * Build ruvLLM native API query format
     * See: https://github.com/ruvnet/ruvector/tree/main/examples/ruvLLM
     */
    buildRuvectorQuery(request) {
        // ruvLLM uses simple query format, not OpenAI-compatible
        const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
        const systemPrompt = request.messages.find(m => m.role === 'system');
        let query = '';
        if (systemPrompt) {
            query += `[System]: ${typeof systemPrompt.content === 'string' ? systemPrompt.content : JSON.stringify(systemPrompt.content)}\n\n`;
        }
        query += typeof lastUserMessage?.content === 'string'
            ? lastUserMessage.content
            : JSON.stringify(lastUserMessage?.content || '');
        return {
            query,
            session_id: request.requestId,
        };
    }
    buildRequest(request, stream = false) {
        const ruvectorRequest = {
            model: request.model || this.config.model,
            messages: request.messages.map((msg) => ({
                role: msg.role === 'tool' ? 'assistant' : msg.role,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            })),
            stream,
        };
        if (request.temperature !== undefined || this.config.temperature !== undefined) {
            ruvectorRequest.temperature = request.temperature ?? this.config.temperature;
        }
        if (request.maxTokens || this.config.maxTokens) {
            ruvectorRequest.max_tokens = request.maxTokens || this.config.maxTokens;
        }
        if (request.topP !== undefined || this.config.topP !== undefined) {
            ruvectorRequest.top_p = request.topP ?? this.config.topP;
        }
        // SONA options
        if (this.ruvectorConfig.enableSona !== false) {
            ruvectorRequest.sona_options = {
                enabled: true,
                learning_rate: this.ruvectorConfig.sonaLearningRate || 0.01,
                adapt_on_response: true,
            };
        }
        // Router options
        if (this.ruvectorConfig.enableFastGrnn !== false) {
            ruvectorRequest.router_options = {
                strategy: this.ruvectorConfig.routerStrategy || 'balanced',
                fallback_models: ['llama3.2', 'mistral', 'phi-4'],
            };
        }
        return ruvectorRequest;
    }
    transformResponse(data, request) {
        const model = request.model || this.config.model;
        return {
            id: data.id || `ruvector-${Date.now()}`,
            model: (data.model || model),
            provider: 'custom',
            content: data.content,
            usage: {
                promptTokens: data.usage?.prompt_tokens || 0,
                completionTokens: data.usage?.completion_tokens || 0,
                totalTokens: data.usage?.total_tokens || 0,
            },
            cost: {
                promptCost: 0,
                completionCost: 0,
                totalCost: 0,
                currency: 'USD',
            },
            finishReason: data.done ? 'stop' : 'length',
            metadata: {
                sona: data.sona_metrics,
                router: data.router_metrics,
            },
        };
    }
    async handleErrorResponse(response) {
        const errorText = await response.text();
        let errorData;
        try {
            errorData = JSON.parse(errorText);
        }
        catch {
            errorData = { error: errorText };
        }
        const message = errorData.error || 'Unknown error';
        if (response.status === 0 || message.includes('connection')) {
            throw new ProviderUnavailableError('custom', {
                message,
                hint: 'Start RuVector server: npx @ruvector/ruvllm serve',
            });
        }
        throw new LLMProviderError(message, `RUVECTOR_${response.status}`, 'custom', response.status, true, errorData);
    }
    /**
     * Get SONA learning metrics
     */
    async getSonaMetrics() {
        try {
            const response = await fetch(`${this.baseUrl}/v1/sona/metrics`);
            if (response.ok) {
                return await response.json();
            }
        }
        catch {
            // Ignore
        }
        return {
            enabled: false,
            adaptationsApplied: 0,
            qualityScore: 0,
            patternsLearned: 0,
        };
    }
    /**
     * Trigger SONA learning from a conversation
     */
    async triggerSonaLearning(conversationId) {
        try {
            const response = await fetch(`${this.baseUrl}/v1/sona/learn`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conversation_id: conversationId }),
            });
            return response.ok;
        }
        catch {
            return false;
        }
    }
    /**
     * Search HNSW memory for similar patterns
     */
    async searchMemory(query, limit = 5) {
        try {
            const response = await fetch(`${this.baseUrl}/v1/hnsw/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, limit }),
            });
            if (response.ok) {
                return await response.json();
            }
        }
        catch {
            // Ignore
        }
        return [];
    }
}
//# sourceMappingURL=ruvector-provider.js.map