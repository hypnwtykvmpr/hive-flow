/**
 * Provider MCP Tools for CLI
 *
 * Tool definitions for checking CLI provider availability,
 * sending completions, and listing model alias mappings.
 */

import type { MCPTool } from './types.js';
import type { LLMMessage } from '@claude-flow/providers';

export const providerTools: MCPTool[] = [
  {
    name: 'provider_status',
    description: 'Check CLI provider availability and health',
    category: 'provider',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['gemini-cli', 'codex-cli', 'cursor-cli'],
          description: 'Specific provider to check (all if omitted)',
        },
      },
    },
    handler: async (input) => {
      const providers = input.provider
        ? [input.provider as string]
        : ['gemini-cli', 'codex-cli', 'cursor-cli'];

      const results = await Promise.allSettled(providers.map(async (name) => {
        const start = Date.now();
        const { createProviderManager } = await import('@claude-flow/providers');
        let manager: Awaited<ReturnType<typeof createProviderManager>> | null = null;
        try {
          manager = await createProviderManager({
            providers: [{ provider: name as 'gemini-cli' | 'codex-cli' | 'cursor-cli', model: 'auto' }],
          });
          const provider = manager.getProvider(name as 'gemini-cli' | 'codex-cli' | 'cursor-cli');
          if (!provider) {
            return { name, available: false, healthy: false, error: 'Failed to initialize' };
          }
          const health = await provider.healthCheck();
          return {
            name,
            available: true,
            healthy: health.healthy,
            latency: Date.now() - start,
            binaryPath: health.details?.binaryPath || health.details?.binary,
            version: health.details?.version,
            error: health.error,
          };
        } catch (err) {
          return {
            name,
            available: false,
            healthy: false,
            error: (err as Error).message,
            latency: Date.now() - start,
          };
        } finally {
          if (manager) try { manager.destroy(); } catch { /* cleanup best-effort */ }
        }
      }));

      return {
        providers: results.map((r) =>
          r.status === 'fulfilled'
            ? r.value
            : { name: 'unknown', available: false, healthy: false, error: (r.reason as Error).message }
        ),
        checkedAt: new Date().toISOString(),
      };
    },
  },
  {
    name: 'provider_complete',
    description: 'Send a prompt to a CLI provider and get a completion',
    category: 'provider',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['gemini-cli', 'codex-cli', 'cursor-cli'],
          description: 'Provider to use',
        },
        prompt: { type: 'string', description: 'Prompt text' },
        model: { type: 'string', description: 'Model name or Claude alias (haiku/sonnet/opus)' },
        systemPrompt: { type: 'string', description: 'Optional system prompt' },
      },
      required: ['provider', 'prompt'],
    },
    handler: async (input) => {
      const prompt = (input.prompt as string) || '';
      if (!prompt.trim()) {
        return { success: false, error: 'Prompt must be a non-empty string.' };
      }

      const providerName = input.provider as 'gemini-cli' | 'codex-cli' | 'cursor-cli';
      const { createProviderManager, resolveProviderModel } = await import('@claude-flow/providers');
      const resolvedModel = resolveProviderModel(providerName, input.model as string | undefined);

      let manager: Awaited<ReturnType<typeof createProviderManager>> | null = null;
      try {
        manager = await createProviderManager({
          providers: [{ provider: providerName, model: resolvedModel || 'auto' }],
        });
        const provider = manager.getProvider(providerName);
        if (!provider) {
          return { success: false, provider: providerName, error: `Provider '${providerName}' failed to initialize.` };
        }

        const messages: LLMMessage[] = [];
        if (input.systemPrompt) {
          messages.push({ role: 'system', content: input.systemPrompt as string });
        }
        messages.push({ role: 'user', content: prompt });

        const result = await provider.complete({ messages, model: resolvedModel });
        return {
          success: true,
          provider: providerName,
          text: result.content,
          model: result.model,
          resolvedModel,
          usage: result.usage,
          cost: result.cost,
        };
      } catch (err) {
        const error = err as Error & { code?: string; retryable?: boolean };
        return {
          success: false,
          provider: providerName,
          error: error.message,
          code: error.code,
          retryable: error.retryable,
        };
      } finally {
        if (manager) try { manager.destroy(); } catch { /* cleanup best-effort */ }
      }
    },
  },
  {
    name: 'provider_models',
    description: 'List models and alias mappings for CLI providers',
    category: 'provider',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Filter by provider name' },
      },
    },
    handler: async (input) => {
      const {
        PROVIDER_ALIAS_MAP,
        KNOWN_PROVIDER_MODELS,
        PROVIDER_DEFAULTS,
        CLAUDE_ALIASES,
      } = await import('@claude-flow/providers');

      const allProviders = Object.keys(PROVIDER_ALIAS_MAP) as Array<keyof typeof PROVIDER_ALIAS_MAP>;
      const filtered = input.provider
        ? allProviders.filter((p) => p === input.provider)
        : allProviders;

      const providers = filtered.map((name) => ({
        name,
        default: PROVIDER_DEFAULTS[name],
        aliases: PROVIDER_ALIAS_MAP[name],
        knownModels: Array.from(KNOWN_PROVIDER_MODELS[name]),
      }));

      return {
        providers,
        claudeAliases: [...CLAUDE_ALIASES],
      };
    },
  },
];
