/**
 * Provider Registry
 * Plugin-based AI provider management with auto-discovery and health checks.
 *
 * Inspired by CodeMachine-CLI's EngineRegistry pattern but adapted for
 * Hive Flow's event-driven architecture.
 *
 * Features:
 * - Type-safe provider registration with metadata
 * - Auto-discovery from ~/.claude/providers/ directory
 * - Health checks (API key presence + endpoint reachability)
 * - Event emission for provider lifecycle changes
 * - Default provider selection by priority
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IEventBus } from '../core/interfaces/event.interface.js';

// =============================================================================
// Types
// =============================================================================

/** Supported provider types */
export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'ollama'
  | 'deepseek'
  | 'openrouter'
  | 'custom';

/** Provider health status */
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** Provider capability flags */
export interface ProviderCapabilities {
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  codeExecution: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

/** Provider metadata */
export interface ProviderMetadata {
  id: string;
  name: string;
  type: ProviderType;
  version: string;
  description?: string;
  /** Lower number = higher priority (used for default selection) */
  priority: number;
  /** Available model IDs */
  models: string[];
  capabilities: ProviderCapabilities;
  /** Environment variable name for API key */
  apiKeyEnvVar?: string;
  /** Base URL for API requests */
  baseUrl?: string;
  /** Additional config */
  config?: Record<string, unknown>;
}

/** A registered provider module */
export interface ProviderModule {
  metadata: ProviderMetadata;
  /** Optional lifecycle hook called on registration */
  onRegister?(): void;
  /** Optional lifecycle hook called on unregistration */
  onUnregister?(): void;
  /** Optional custom health check */
  healthCheck?(): Promise<ProviderHealthStatus>;
}

/** Health check result */
export interface ProviderHealthResult {
  providerId: string;
  status: ProviderHealthStatus;
  hasApiKey: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt: string;
}

/** Provider registry configuration */
export interface ProviderRegistryConfig {
  /** Directory to scan for provider configs (default: ~/.claude/providers) */
  discoveryDir?: string;
  /** Whether to auto-discover on initialize (default: true) */
  autoDiscover?: boolean;
  /** Health check timeout in ms (default: 5000) */
  healthCheckTimeoutMs?: number;
}

/** Provider events emitted through EventBus */
export const ProviderEvents = {
  REGISTERED: 'provider:registered',
  UNREGISTERED: 'provider:unregistered',
  HEALTH_CHECKED: 'provider:health-checked',
  DISCOVERY_COMPLETE: 'provider:discovery-complete',
} as const;

// =============================================================================
// Built-in Provider Definitions
// =============================================================================

const BUILTIN_PROVIDERS: ProviderModule[] = [
  {
    metadata: {
      id: 'anthropic',
      name: 'Anthropic',
      type: 'anthropic',
      version: '1.0.0',
      description: 'Anthropic Claude models (Opus, Sonnet, Haiku)',
      priority: 1,
      models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        codeExecution: false,
        contextWindow: 200000,
        maxOutputTokens: 64000,
      },
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com',
    },
  },
  {
    metadata: {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      version: '1.0.0',
      description: 'OpenAI GPT and Codex models',
      priority: 2,
      models: ['gpt-4o', 'gpt-4-turbo', 'o3-mini'],
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        codeExecution: true,
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },
      apiKeyEnvVar: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com',
    },
  },
  {
    metadata: {
      id: 'google',
      name: 'Google AI',
      type: 'google',
      version: '1.0.0',
      description: 'Google Gemini models',
      priority: 3,
      models: ['gemini-2.0-flash', 'gemini-2.0-pro'],
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        codeExecution: true,
        contextWindow: 1000000,
        maxOutputTokens: 8192,
      },
      apiKeyEnvVar: 'GOOGLE_API_KEY',
      baseUrl: 'https://generativelanguage.googleapis.com',
    },
  },
  {
    metadata: {
      id: 'mistral',
      name: 'Mistral AI',
      type: 'mistral',
      version: '1.0.0',
      description: 'Mistral AI models',
      priority: 4,
      models: ['mistral-large', 'mistral-medium', 'codestral'],
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: false,
        codeExecution: false,
        contextWindow: 128000,
        maxOutputTokens: 8192,
      },
      apiKeyEnvVar: 'MISTRAL_API_KEY',
      baseUrl: 'https://api.mistral.ai',
    },
  },
  {
    metadata: {
      id: 'ollama',
      name: 'Ollama (Local)',
      type: 'ollama',
      version: '1.0.0',
      description: 'Local models via Ollama',
      priority: 10,
      models: ['llama3', 'codellama', 'deepseek-coder'],
      capabilities: {
        streaming: true,
        toolUse: false,
        vision: false,
        codeExecution: false,
        contextWindow: 8192,
        maxOutputTokens: 4096,
      },
      baseUrl: 'http://localhost:11434',
    },
  },
  {
    metadata: {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'deepseek',
      version: '1.0.0',
      description: 'DeepSeek AI models (V4 Pro and V4 Flash)',
      priority: 5,
      models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: false,
        codeExecution: false,
        contextWindow: 1000000,
        maxOutputTokens: 32768,
      },
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      baseUrl: 'https://api.deepseek.com',
    },
  },
  {
    metadata: {
      id: 'openrouter',
      name: 'OpenRouter',
      type: 'openrouter' as ProviderType,
      version: '1.0.0',
      description: 'OpenRouter API gateway — 200+ models from multiple providers',
      priority: 6,
      models: [
        'xiaomi/mimo-v2.5-pro', 'x-ai/grok-4.3', 'minimax/minimax-m3',
        'moonshotai/kimi-k2.6', 'qwen/qwen3.7-plus', 'z-ai/glm-5.1',
        'qwen/qwen3.6-plus', 'nvidia/nemotron-3-super-120b-a12b:free', 'deepseek/deepseek-v4-flash',
      ],
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        codeExecution: false,
        contextWindow: 1048576,
        maxOutputTokens: 65536,
      },
      apiKeyEnvVar: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
    },
  },
];

// =============================================================================
// Provider Registry
// =============================================================================

export class ProviderRegistry {
  private providers = new Map<string, ProviderModule>();
  private healthCache = new Map<string, ProviderHealthResult>();
  private initialized = false;
  private discoveryDir: string;
  private healthCheckTimeoutMs: number;

  constructor(
    private eventBus?: IEventBus,
    config?: ProviderRegistryConfig,
  ) {
    this.discoveryDir = config?.discoveryDir ?? join(homedir(), '.claude', 'providers');
    this.healthCheckTimeoutMs = config?.healthCheckTimeoutMs ?? 5000;
  }

  /**
   * Initialize the registry with built-in providers and optional auto-discovery.
   */
  async initialize(autoDiscover = true): Promise<void> {
    if (this.initialized) return;

    // Register built-in providers
    for (const provider of BUILTIN_PROVIDERS) {
      this.register(provider);
    }

    // Auto-discover custom providers from filesystem
    if (autoDiscover) {
      await this.discoverProviders();
    }

    this.initialized = true;
  }

  /**
   * Register a provider module.
   */
  register(provider: ProviderModule): void {
    const id = provider.metadata.id;

    if (this.providers.has(id)) {
      return; // Silently skip duplicates (built-in vs discovered)
    }

    this.providers.set(id, provider);
    provider.onRegister?.();

    this.eventBus?.emit(ProviderEvents.REGISTERED, {
      providerId: id,
      name: provider.metadata.name,
      type: provider.metadata.type,
    });
  }

  /**
   * Unregister a provider by ID.
   */
  unregister(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) return false;

    provider.onUnregister?.();
    this.providers.delete(id);
    this.healthCache.delete(id);

    this.eventBus?.emit(ProviderEvents.UNREGISTERED, { providerId: id });
    return true;
  }

  /**
   * Get a provider by ID.
   */
  get(id: string): ProviderModule | undefined {
    return this.providers.get(id);
  }

  /**
   * Get all registered providers, sorted by priority.
   */
  getAll(): ProviderModule[] {
    return Array.from(this.providers.values())
      .sort((a, b) => a.metadata.priority - b.metadata.priority);
  }

  /**
   * Get all provider IDs.
   */
  getAllIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get all provider metadata, sorted by priority.
   */
  getAllMetadata(): ProviderMetadata[] {
    return this.getAll().map(p => p.metadata);
  }

  /**
   * Check if a provider is registered.
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Get the default (highest-priority) provider.
   */
  getDefault(): ProviderModule | undefined {
    return this.getAll()[0];
  }

  /**
   * Get providers by type.
   */
  getByType(type: ProviderType): ProviderModule[] {
    return this.getAll().filter(p => p.metadata.type === type);
  }

  /**
   * Find providers that support a specific model.
   */
  findByModel(modelId: string): ProviderModule | undefined {
    return this.getAll().find(p => p.metadata.models.includes(modelId));
  }

  /**
   * Find providers with specific capabilities.
   */
  findWithCapabilities(required: Partial<ProviderCapabilities>): ProviderModule[] {
    return this.getAll().filter(p => {
      const caps = p.metadata.capabilities;
      for (const [key, value] of Object.entries(required)) {
        const k = key as keyof ProviderCapabilities;
        if (typeof value === 'boolean' && value && !caps[k]) return false;
        if (typeof value === 'number' && (caps[k] as number) < value) return false;
      }
      return true;
    });
  }

  // ─── Health Checks ──────────────────────────────────────────────

  /**
   * Run health check for a single provider.
   * Checks API key presence and optionally endpoint reachability.
   */
  async checkHealth(id: string): Promise<ProviderHealthResult> {
    const provider = this.providers.get(id);
    if (!provider) {
      return {
        providerId: id,
        status: 'unhealthy',
        hasApiKey: false,
        error: `Provider '${id}' not registered`,
        checkedAt: new Date().toISOString(),
      };
    }

    const startTime = Date.now();

    // Check for API key
    const apiKeyEnvVar = provider.metadata.apiKeyEnvVar;
    const hasApiKey = apiKeyEnvVar ? !!process.env[apiKeyEnvVar] : true; // Local providers don't need keys

    // Use custom health check if available
    if (provider.healthCheck) {
      try {
        const status = await Promise.race([
          provider.healthCheck(),
          new Promise<ProviderHealthStatus>((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), this.healthCheckTimeoutMs)
          ),
        ]);

        const result: ProviderHealthResult = {
          providerId: id,
          status,
          hasApiKey,
          latencyMs: Date.now() - startTime,
          checkedAt: new Date().toISOString(),
        };

        this.healthCache.set(id, result);
        this.eventBus?.emit(ProviderEvents.HEALTH_CHECKED, result);
        return result;
      } catch (err) {
        const result: ProviderHealthResult = {
          providerId: id,
          status: 'unhealthy',
          hasApiKey,
          latencyMs: Date.now() - startTime,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        };

        this.healthCache.set(id, result);
        this.eventBus?.emit(ProviderEvents.HEALTH_CHECKED, result);
        return result;
      }
    }

    // Default health check: API key presence
    const status: ProviderHealthStatus = hasApiKey ? 'healthy' : 'degraded';
    const result: ProviderHealthResult = {
      providerId: id,
      status,
      hasApiKey,
      latencyMs: Date.now() - startTime,
      error: hasApiKey ? undefined : `Missing env var: ${apiKeyEnvVar}`,
      checkedAt: new Date().toISOString(),
    };

    this.healthCache.set(id, result);
    this.eventBus?.emit(ProviderEvents.HEALTH_CHECKED, result);
    return result;
  }

  /**
   * Run health checks for all registered providers.
   */
  async checkAllHealth(): Promise<ProviderHealthResult[]> {
    const results: ProviderHealthResult[] = [];
    for (const id of this.providers.keys()) {
      results.push(await this.checkHealth(id));
    }
    return results;
  }

  /**
   * Get cached health result for a provider.
   */
  getCachedHealth(id: string): ProviderHealthResult | undefined {
    return this.healthCache.get(id);
  }

  // ─── Auto-Discovery ─────────────────────────────────────────────

  /**
   * Discover and register providers from the discovery directory.
   * Reads JSON config files from ~/.claude/providers/ and creates
   * ProviderModule instances.
   */
  async discoverProviders(): Promise<number> {
    let discovered = 0;

    try {
      const files = await readdir(this.discoveryDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      for (const file of jsonFiles) {
        try {
          const content = await readFile(join(this.discoveryDir, file), 'utf8');
          const config = JSON.parse(content);

          if (!config.id || !config.name || !config.type) {
            continue; // Skip invalid configs
          }

          const provider: ProviderModule = {
            metadata: {
              id: config.id,
              name: config.name,
              type: config.type as ProviderType,
              version: config.version ?? '0.0.0',
              description: config.description,
              priority: config.priority ?? 50,
              models: config.models ?? [],
              capabilities: {
                streaming: config.capabilities?.streaming ?? false,
                toolUse: config.capabilities?.toolUse ?? false,
                vision: config.capabilities?.vision ?? false,
                codeExecution: config.capabilities?.codeExecution ?? false,
                contextWindow: config.capabilities?.contextWindow ?? 4096,
                maxOutputTokens: config.capabilities?.maxOutputTokens ?? 2048,
              },
              apiKeyEnvVar: config.apiKeyEnvVar,
              baseUrl: config.baseUrl,
              config: config.config,
            },
          };

          this.register(provider);
          discovered++;
        } catch {
          // Skip files that fail to parse
        }
      }
    } catch {
      // Discovery directory doesn't exist — fine
    }

    this.eventBus?.emit(ProviderEvents.DISCOVERY_COMPLETE, {
      discovered,
      total: this.providers.size,
    });

    return discovered;
  }

  // ─── Utilities ──────────────────────────────────────────────────

  /**
   * Get provider count.
   */
  get size(): number {
    return this.providers.size;
  }

  /**
   * Clear all providers and health cache (for testing).
   */
  clear(): void {
    this.providers.clear();
    this.healthCache.clear();
    this.initialized = false;
  }
}
