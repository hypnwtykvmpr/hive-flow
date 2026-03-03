/**
 * Layered Context Assembler
 *
 * Builds a final LLMRequest by layering system prompts, RAG results,
 * current turn context, and conversation history with strict token budgeting.
 *
 * Created with ❤️ by ruv.io
 */

import { LLMProvider, LLMModel, ProviderManager } from '@claude-flow/providers';
import {
  LLMMessage,
  LLMRequest,
  AssembleOptions,
  ContextLayer,
} from './types.js';
import { TokenEstimator } from './token-estimator.js';
import { RoleNormalizer } from './role-normalizer.js';

/**
 * Interface for memory backend used by the assembler
 */
export interface MemoryBackend {
  getMessages(sessionId: string): Promise<LLMMessage[]>;
}

/**
 * Interface for RAG service used by the assembler
 */
export interface RAGService {
  search(query: string, limit?: number): Promise<string[]>;
}

/**
 * Builds a provider-ready {@link LLMRequest} from multiple context sources.
 *
 * Layers are assembled in priority order (system → history → RAG → current
 * turn) and pruned from lowest to highest priority when the total token estimate
 * exceeds the provider's context window. Conversation history is compressed with
 * an Anchor + Recency strategy once it grows beyond `compressionThreshold`.
 */
export class LayeredAssembler {
  private estimator: TokenEstimator;

  constructor(
    private providerManager: ProviderManager,
    private memoryBackend?: MemoryBackend,
    private ragService?: RAGService
  ) {
    this.estimator = new TokenEstimator();
  }

  /**
   * Assemble a token-budgeted {@link LLMRequest} for the given provider and model.
   *
   * Fetches conversation history from `memoryBackend` and optional RAG results
   * from `ragService`, then prunes lower-priority layers to stay within the
   * provider's context window. Roles are normalised for the target provider
   * before the request is returned.
   *
   * @param userMessage - The current user turn content.
   * @param provider - Target LLM provider identifier.
   * @param model - Target model identifier within the provider.
   * @param options - Optional overrides for system prompt, RAG, token budget, etc.
   */
  async assemble(
    userMessage: string,
    provider: LLMProvider,
    model: LLMModel,
    options: AssembleOptions = {}
  ): Promise<LLMRequest> {
    const layers: ContextLayer[] = [];

    // 1. System Layer (Priority 0)
    const systemPrompt = options.systemPrompt || 'You are a helpful AI assistant.';
    layers.push({
      name: 'system',
      priority: 0,
      messages: [{ role: 'system', content: systemPrompt }],
      tokenEstimate: this.estimator.estimateString(systemPrompt),
    });

    // 2. Turn Layer (Priority 1)
    const turnMessage: LLMMessage = { role: 'user', content: userMessage };
    layers.push({
      name: 'turn',
      priority: 1,
      messages: [turnMessage],
      tokenEstimate: this.estimator.estimateMessage(turnMessage),
    });

    // 3. RAG Layer (Priority 2)
    if (options.includeRag && this.ragService && options.ragQuery) {
      const ragResults = await this.ragService.search(options.ragQuery);
      const ragContent = ragResults.join('\n\n');
      const ragMessage: LLMMessage = {
        role: 'system',
        content: `RAG Context:\n${ragContent}`,
        name: 'rag_context',
      };
      layers.push({
        name: 'rag',
        priority: 2,
        messages: [ragMessage],
        tokenEstimate: this.estimator.estimateMessage(ragMessage),
      });
    } else if (options.ragResults && options.ragResults.length > 0) {
      const ragContent = options.ragResults.join('\n\n');
      const ragMessage: LLMMessage = {
        role: 'system',
        content: `RAG Context:\n${ragContent}`,
        name: 'rag_context',
      };
      layers.push({
        name: 'rag',
        priority: 2,
        messages: [ragMessage],
        tokenEstimate: this.estimator.estimateMessage(ragMessage),
      });
    }

    // 4. History Layer (Priority 3)
    if (options.sessionId && this.memoryBackend) {
      const fullHistory = await this.memoryBackend.getMessages(options.sessionId);
      const compressedHistory = this.compressHistory(fullHistory, options);
      layers.push({
        name: 'history',
        priority: 3,
        messages: compressedHistory,
        tokenEstimate: this.estimator.estimateMessages(compressedHistory),
      });
    }

    // Budgeting & Pruning
    const maxTokens = options.maxTokens || this.getProviderMaxTokens(provider, model);
    const finalMessages = this.budgetAndPrune(layers, maxTokens);

    // Normalize roles for the provider
    const normalizedMessages = finalMessages.map(msg => ({
      ...msg,
      role: RoleNormalizer.normalize(msg.role, provider) as any,
    }));

    return {
      messages: normalizedMessages,
      model,
    };
  }

  /**
   * Compresses history using Anchor + Recency strategy.
   */
  private compressHistory(messages: LLMMessage[], options: AssembleOptions): LLMMessage[] {
    const threshold = options.compressionThreshold || 20;
    const anchorCount = options.anchorCount || 5;
    const recentCount = options.recentCount || 10;

    if (messages.length <= threshold) {
      return messages;
    }

    const anchors = messages.slice(0, anchorCount);
    const recent = messages.slice(-recentCount);
    const omittedCount = messages.length - anchorCount - recentCount;

    const summaryMessage: LLMMessage = {
      role: 'system',
      content: `[... Omitted ${omittedCount} messages for brevity ...]`,
      name: 'history_summary',
    };

    return [...anchors, summaryMessage, ...recent];
  }

  /**
   * Prunes layers based on priority if they exceed the token budget.
   */
  private budgetAndPrune(layers: ContextLayer[], maxTokens: number): LLMMessage[] {
    // Sort layers by priority (lower priority number = higher priority)
    const sortedLayers = [...layers].sort((a, b) => a.priority - b.priority);

    let totalTokens = sortedLayers.reduce((acc, layer) => acc + layer.tokenEstimate, 0);

    // Prune from highest priority number (lowest importance) to lowest priority number
    for (let i = sortedLayers.length - 1; i >= 0; i--) {
      if (totalTokens <= maxTokens) break;

      const layer = sortedLayers[i];
      // Never prune system layer (priority 0) unless it's the only one and still too big
      if (layer.priority === 0 && sortedLayers.length > 1) continue;

      totalTokens -= layer.tokenEstimate;
      sortedLayers.splice(i, 1);
    }

    // Re-flatten messages in priority order (0, 3, 2, 1? No, usually chronological)
    // Actually, usually: System (0), History (3), RAG (2), Turn (1)
    const result: LLMMessage[] = [];

    // System layer first
    const systemLayer = sortedLayers.find(l => l.name === 'system');
    if (systemLayer) result.push(...systemLayer.messages);

    // History next
    const historyLayer = sortedLayers.find(l => l.name === 'history');
    if (historyLayer) result.push(...historyLayer.messages);

    // RAG next
    const ragLayer = sortedLayers.find(l => l.name === 'rag');
    if (ragLayer) result.push(...ragLayer.messages);

    // Current turn last
    const turnLayer = sortedLayers.find(l => l.name === 'turn');
    if (turnLayer) result.push(...turnLayer.messages);

    return result;
  }

  private getProviderMaxTokens(provider: LLMProvider, model: LLMModel): number {
    const p = this.providerManager.getProvider(provider);
    if (!p) return 4096; // Default safe limit

    // Try to get model specific context window
    const modelInfo = (p.capabilities as any).maxContextLength?.[model] || (p.capabilities as any).contextWindow || 4096;
    return modelInfo;
  }
}
