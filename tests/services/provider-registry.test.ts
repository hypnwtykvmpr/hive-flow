/**
 * Provider Registry Tests
 * Tests for provider registration, auto-discovery, health checks, and queries.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProviderRegistry, ProviderEvents } from '../../cli/src/shared/services/provider-registry.js';
import type { ProviderModule, ProviderHealthResult } from '../../cli/src/shared/services/provider-registry.js';
import type { IEventBus } from '../../cli/src/shared/core/interfaces/event.interface.js';

// ─── Helpers ──────────────────────────────────────────────────────

function createMockEventBus(): IEventBus {
  const handlers = new Map<string, Set<Function>>();
  return {
    emit: vi.fn((event: string, data?: unknown) => {
      const set = handlers.get(event);
      if (set) set.forEach(fn => fn(data));
    }),
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)?.delete(handler);
    }),
    subscribe: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  } as unknown as IEventBus;
}

function createTestProvider(overrides: Partial<ProviderModule['metadata']> = {}): ProviderModule {
  return {
    metadata: {
      id: overrides.id ?? 'test-provider',
      name: overrides.name ?? 'Test Provider',
      type: overrides.type ?? 'custom',
      version: overrides.version ?? '1.0.0',
      description: overrides.description ?? 'A test provider',
      priority: overrides.priority ?? 50,
      models: overrides.models ?? ['test-model-1', 'test-model-2'],
      capabilities: overrides.capabilities ?? {
        streaming: true,
        toolUse: false,
        vision: false,
        codeExecution: false,
        contextWindow: 8192,
        maxOutputTokens: 4096,
      },
      apiKeyEnvVar: overrides.apiKeyEnvVar ?? 'TEST_API_KEY',
      baseUrl: overrides.baseUrl ?? 'https://api.test.com',
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;
  let eventBus: IEventBus;

  beforeEach(() => {
    eventBus = createMockEventBus();
    registry = new ProviderRegistry(eventBus, {
      discoveryDir: '/nonexistent/path', // Prevent actual filesystem reads
      autoDiscover: false,
    });
  });

  afterEach(() => {
    registry.clear();
  });

  describe('registration', () => {
    it('should register a provider', () => {
      const provider = createTestProvider();
      registry.register(provider);

      expect(registry.has('test-provider')).toBe(true);
      expect(registry.get('test-provider')).toBe(provider);
      expect(registry.size).toBe(1);
    });

    it('should emit REGISTERED event', () => {
      const provider = createTestProvider();
      registry.register(provider);

      expect(eventBus.emit).toHaveBeenCalledWith(
        ProviderEvents.REGISTERED,
        expect.objectContaining({ providerId: 'test-provider' }),
      );
    });

    it('should skip duplicate registrations silently', () => {
      const provider = createTestProvider();
      registry.register(provider);
      registry.register(provider);

      expect(registry.size).toBe(1);
    });

    it('should call onRegister hook', () => {
      const onRegister = vi.fn();
      const provider = { ...createTestProvider(), onRegister };
      registry.register(provider);

      expect(onRegister).toHaveBeenCalledOnce();
    });

    it('should unregister a provider', () => {
      const onUnregister = vi.fn();
      const provider = { ...createTestProvider(), onUnregister };
      registry.register(provider);

      const result = registry.unregister('test-provider');

      expect(result).toBe(true);
      expect(registry.has('test-provider')).toBe(false);
      expect(onUnregister).toHaveBeenCalledOnce();
      expect(eventBus.emit).toHaveBeenCalledWith(
        ProviderEvents.UNREGISTERED,
        expect.objectContaining({ providerId: 'test-provider' }),
      );
    });

    it('should return false for unregistering unknown provider', () => {
      expect(registry.unregister('unknown')).toBe(false);
    });
  });

  describe('queries', () => {
    beforeEach(() => {
      registry.register(createTestProvider({ id: 'a', priority: 2, type: 'anthropic', models: ['claude-3'] }));
      registry.register(createTestProvider({ id: 'b', priority: 1, type: 'openai', models: ['gpt-4'] }));
      registry.register(createTestProvider({
        id: 'c',
        priority: 3,
        type: 'custom',
        models: ['custom-1'],
        capabilities: {
          streaming: true,
          toolUse: true,
          vision: true,
          codeExecution: false,
          contextWindow: 200000,
          maxOutputTokens: 64000,
        },
      }));
    });

    it('should return all providers sorted by priority', () => {
      const all = registry.getAll();
      expect(all.map(p => p.metadata.id)).toEqual(['b', 'a', 'c']);
    });

    it('should return all IDs', () => {
      expect(registry.getAllIds()).toContain('a');
      expect(registry.getAllIds()).toContain('b');
      expect(registry.getAllIds()).toContain('c');
    });

    it('should return all metadata sorted by priority', () => {
      const metadata = registry.getAllMetadata();
      expect(metadata[0].id).toBe('b');
      expect(metadata[1].id).toBe('a');
    });

    it('should return default (highest-priority) provider', () => {
      expect(registry.getDefault()?.metadata.id).toBe('b');
    });

    it('should filter by type', () => {
      const anthropic = registry.getByType('anthropic');
      expect(anthropic).toHaveLength(1);
      expect(anthropic[0].metadata.id).toBe('a');
    });

    it('should find by model ID', () => {
      const found = registry.findByModel('gpt-4');
      expect(found?.metadata.id).toBe('b');
    });

    it('should return undefined for unknown model', () => {
      expect(registry.findByModel('nonexistent')).toBeUndefined();
    });

    it('should find providers with required capabilities', () => {
      const withVision = registry.findWithCapabilities({ vision: true });
      expect(withVision).toHaveLength(1);
      expect(withVision[0].metadata.id).toBe('c');

      const withStreaming = registry.findWithCapabilities({ streaming: true });
      expect(withStreaming).toHaveLength(3);

      const largeContext = registry.findWithCapabilities({ contextWindow: 100000 });
      expect(largeContext).toHaveLength(1);
      expect(largeContext[0].metadata.id).toBe('c');
    });
  });

  describe('health checks', () => {
    it('should report unhealthy for unknown provider', async () => {
      const result = await registry.checkHealth('unknown');
      expect(result.status).toBe('unhealthy');
      expect(result.hasApiKey).toBe(false);
    });

    it('should check API key presence', async () => {
      const provider = createTestProvider({ apiKeyEnvVar: 'TEST_PROVIDER_KEY' });
      registry.register(provider);

      // No API key set
      const result = await registry.checkHealth('test-provider');
      expect(result.status).toBe('degraded');
      expect(result.hasApiKey).toBe(false);
      expect(result.error).toContain('TEST_PROVIDER_KEY');
    });

    it('should report healthy when API key is present', async () => {
      process.env.HEALTH_CHECK_KEY = 'sk-test-123';
      const provider = createTestProvider({ apiKeyEnvVar: 'HEALTH_CHECK_KEY' });
      registry.register(provider);

      const result = await registry.checkHealth('test-provider');
      expect(result.status).toBe('healthy');
      expect(result.hasApiKey).toBe(true);

      delete process.env.HEALTH_CHECK_KEY;
    });

    it('should use custom health check if provided', async () => {
      const provider: ProviderModule = {
        ...createTestProvider(),
        healthCheck: vi.fn().mockResolvedValue('healthy'),
      };
      registry.register(provider);

      const result = await registry.checkHealth('test-provider');
      expect(result.status).toBe('healthy');
      expect(provider.healthCheck).toHaveBeenCalledOnce();
    });

    it('should handle custom health check failure', async () => {
      const provider: ProviderModule = {
        ...createTestProvider(),
        healthCheck: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };
      registry.register(provider);

      const result = await registry.checkHealth('test-provider');
      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('Connection refused');
    });

    it('should cache health results', async () => {
      const provider = createTestProvider();
      registry.register(provider);

      await registry.checkHealth('test-provider');
      const cached = registry.getCachedHealth('test-provider');
      expect(cached).toBeDefined();
      expect(cached?.providerId).toBe('test-provider');
    });

    it('should emit health check events', async () => {
      const provider = createTestProvider();
      registry.register(provider);

      await registry.checkHealth('test-provider');

      expect(eventBus.emit).toHaveBeenCalledWith(
        ProviderEvents.HEALTH_CHECKED,
        expect.objectContaining({ providerId: 'test-provider' }),
      );
    });

    it('should check all providers', async () => {
      registry.register(createTestProvider({ id: 'p1' }));
      registry.register(createTestProvider({ id: 'p2' }));

      const results = await registry.checkAllHealth();
      expect(results).toHaveLength(2);
      expect(results.map(r => r.providerId)).toContain('p1');
      expect(results.map(r => r.providerId)).toContain('p2');
    });

    it('should report healthy for providers without apiKeyEnvVar', async () => {
      const provider = createTestProvider({ apiKeyEnvVar: undefined });
      // Clear apiKeyEnvVar
      provider.metadata.apiKeyEnvVar = undefined;
      registry.register(provider);

      const result = await registry.checkHealth('test-provider');
      expect(result.status).toBe('healthy');
      expect(result.hasApiKey).toBe(true); // Local providers implicitly have "keys"
    });
  });

  describe('initialization with built-ins', () => {
    it('should register built-in providers on initialize', async () => {
      const freshRegistry = new ProviderRegistry(eventBus, {
        discoveryDir: '/nonexistent',
      });
      await freshRegistry.initialize(false);

      expect(freshRegistry.has('anthropic')).toBe(true);
      expect(freshRegistry.has('openai')).toBe(true);
      expect(freshRegistry.has('google')).toBe(true);
      expect(freshRegistry.has('mistral')).toBe(true);
      expect(freshRegistry.has('ollama')).toBe(true);
      expect(freshRegistry.has('deepseek')).toBe(true);
      expect(freshRegistry.has('openrouter')).toBe(true);
      expect(freshRegistry.size).toBe(7);
    });

    it('should be idempotent', async () => {
      const freshRegistry = new ProviderRegistry(eventBus, {
        discoveryDir: '/nonexistent',
      });
      await freshRegistry.initialize(false);
      await freshRegistry.initialize(false);

      expect(freshRegistry.size).toBe(7);
    });

    it('should have anthropic as default (priority 1)', async () => {
      const freshRegistry = new ProviderRegistry(eventBus, {
        discoveryDir: '/nonexistent',
      });
      await freshRegistry.initialize(false);

      expect(freshRegistry.getDefault()?.metadata.id).toBe('anthropic');
    });
  });

  describe('auto-discovery', () => {
    it('should handle non-existent discovery directory gracefully', async () => {
      const discovered = await registry.discoverProviders();
      expect(discovered).toBe(0);
    });

    it('should emit discovery complete event', async () => {
      await registry.discoverProviders();

      expect(eventBus.emit).toHaveBeenCalledWith(
        ProviderEvents.DISCOVERY_COMPLETE,
        expect.objectContaining({ discovered: 0 }),
      );
    });
  });

  describe('clear', () => {
    it('should remove all providers and reset state', () => {
      registry.register(createTestProvider({ id: 'a' }));
      registry.register(createTestProvider({ id: 'b' }));

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.has('a')).toBe(false);
    });
  });
});
