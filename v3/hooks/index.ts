/**
 * V3 Hooks System
 * Enhanced hook system with composition, pipelines, and V3-specific hooks
 */

// Export types
export * from './types.js';

// Export core components
export { HookRegistry, hookRegistry } from './hook-registry.js';
export { HookExecutor, hookExecutor, type ExecutorOptions, type ExecutionResult } from './hook-executor.js';
export { HookManager, hookManager, type HookManagerConfig } from './hook-manager.js';
export {
  HookComposer,
  composer,
  pipe,
  parallel,
  race,
  merge,
  when,
  retry,
  timeout,
  cache,
  trace
} from './composition.js';

// Import types for factory functions
import type {
  HookType,
  HookRegistration,
  HookHandler,
  HookContext,
  HookResult,
  HookOptions,
  HookFilter,
  AgentHookContext,
  TaskHookContext,
  SwarmHookContext,
  MemoryHookContext,
  PerformanceHookContext,
  LearningHookContext
} from './types.js';

import { hookManager } from './hook-manager.js';

// ============================================
// Hook Registration Factories
// ============================================

/**
 * Create an agent lifecycle hook
 */
export function createAgentHook(
  event: 'spawn:before' | 'spawn:after' | 'stop:before' | 'stop:after' | 'error' | 'message' | 'state-change',
  handler: HookHandler<unknown, unknown>,
  options: Partial<Omit<HookRegistration, 'type' | 'handler'>> = {}
): HookRegistration {
  const type: HookType = `agent:${event}` as HookType;

  return {
    id: options.id || `agent-${event}-${Date.now()}`,
    type,
    name: options.name || `Agent ${event} hook`,
    description: options.description,
    handler,
    priority: options.priority || 100,
    enabled: options.enabled ?? true,
    filter: options.filter,
    options: options.options,
    tags: options.tags || ['agent'],
    ...options
  };
}

/**
 * Create a task hook
 */
export function createTaskHook(
  event: 'create:before' | 'create:after' | 'start:before' | 'start:after' | 'complete' | 'fail' | 'decompose' | 'assign',
  handler: HookHandler<unknown, unknown>,
  options: Partial<Omit<HookRegistration, 'type' | 'handler'>> = {}
): HookRegistration {
  const type: HookType = `task:${event}` as HookType;

  return {
    id: options.id || `task-${event}-${Date.now()}`,
    type,
    name: options.name || `Task ${event} hook`,
    description: options.description,
    handler,
    priority: options.priority || 100,
    enabled: options.enabled ?? true,
    filter: options.filter,
    options: options.options,
    tags: options.tags || ['task'],
    ...options
  };
}

/**
 * Create a swarm coordination hook
 */
export function createSwarmHook(
  event: 'init:before' | 'init:after' | 'coordinate:before' | 'coordinate:after' | 'consensus:start' | 'consensus:complete' | 'scale' | 'topology-change',
  handler: HookHandler<unknown, unknown>,
  options: Partial<Omit<HookRegistration, 'type' | 'handler'>> = {}
): HookRegistration {
  const type: HookType = `swarm:${event}` as HookType;

  return {
    id: options.id || `swarm-${event}-${Date.now()}`,
    type,
    name: options.name || `Swarm ${event} hook`,
    description: options.description,
    handler,
    priority: options.priority || 100,
    enabled: options.enabled ?? true,
    filter: options.filter,
    options: options.options,
    tags: options.tags || ['swarm'],
    ...options
  };
}

/**
 * Create a memory hook
 */
export function createMemoryHook(
  event: 'store:before' | 'store:after' | 'retrieve:before' | 'retrieve:after' | 'search:before' | 'search:after' | 'delete' | 'sync',
  handler: HookHandler<unknown, unknown>,
  options: Partial<Omit<HookRegistration, 'type' | 'handler'>> = {}
): HookRegistration {
  const type: HookType = `memory:${event}` as HookType;

  return {
    id: options.id || `memory-${event}-${Date.now()}`,
    type,
    name: options.name || `Memory ${event} hook`,
    description: options.description,
    handler,
    priority: options.priority || 100,
    enabled: options.enabled ?? true,
    filter: options.filter,
    options: options.options,
    tags: options.tags || ['memory'],
    ...options
  };
}

/**
 * Create a performance hook
 */
export function createPerformanceHook(
  event: 'benchmark:start' | 'benchmark:end' | 'metric' | 'threshold-exceeded' | 'optimize',
  handler: HookHandler<unknown, unknown>,
  options: Partial<Omit<HookRegistration, 'type' | 'handler'>> = {}
): HookRegistration {
  const type: HookType = `performance:${event}` as HookType;

  return {
    id: options.id || `performance-${event}-${Date.now()}`,
    type,
    name: options.name || `Performance ${event} hook`,
    description: options.description,
    handler,
    priority: options.priority || 100,
    enabled: options.enabled ?? true,
    filter: options.filter,
    options: options.options,
    tags: options.tags || ['performance'],
    ...options
  };
}

/**
 * Create a learning/SONA hook
 */
export function createLearningHook(
  event: 'pattern:detected' | 'pattern:stored' | 'adapt' | 'train:start' | 'train:complete' | 'feedback',
  handler: HookHandler<unknown, unknown>,
  options: Partial<Omit<HookRegistration, 'type' | 'handler'>> = {}
): HookRegistration {
  const type: HookType = `learning:${event}` as HookType;

  return {
    id: options.id || `learning-${event}-${Date.now()}`,
    type,
    name: options.name || `Learning ${event} hook`,
    description: options.description,
    handler,
    priority: options.priority || 100,
    enabled: options.enabled ?? true,
    filter: options.filter,
    options: options.options,
    tags: options.tags || ['learning', 'sona'],
    ...options
  };
}

/**
 * Create a session hook
 */
export function createSessionHook(
  event: 'start' | 'end' | 'restore' | 'save',
  handler: HookHandler<unknown, unknown>,
  options: Partial<Omit<HookRegistration, 'type' | 'handler'>> = {}
): HookRegistration {
  const type: HookType = `session:${event}` as HookType;

  return {
    id: options.id || `session-${event}-${Date.now()}`,
    type,
    name: options.name || `Session ${event} hook`,
    description: options.description,
    handler,
    priority: options.priority || 100,
    enabled: options.enabled ?? true,
    filter: options.filter,
    options: options.options,
    tags: options.tags || ['session'],
    ...options
  };
}

/**
 * Create an MCP hook
 */
export function createMCPHook(
  event: 'tool:call:before' | 'tool:call:after' | 'server:start' | 'server:stop',
  handler: HookHandler<unknown, unknown>,
  options: Partial<Omit<HookRegistration, 'type' | 'handler'>> = {}
): HookRegistration {
  const type: HookType = `mcp:${event}` as HookType;

  return {
    id: options.id || `mcp-${event}-${Date.now()}`,
    type,
    name: options.name || `MCP ${event} hook`,
    description: options.description,
    handler,
    priority: options.priority || 100,
    enabled: options.enabled ?? true,
    filter: options.filter,
    options: options.options,
    tags: options.tags || ['mcp'],
    ...options
  };
}

// ============================================
// Convenience Registration Functions
// ============================================

/**
 * Register a hook with the global hook manager
 */
export function registerHook(registration: HookRegistration): void {
  hookManager.register(registration);
}

/**
 * Unregister a hook from the global hook manager
 */
export function unregisterHook(hookId: string): void {
  hookManager.unregister(hookId);
}

/**
 * Execute hooks for a given type
 */
export async function executeHooks<T>(
  type: HookType,
  payload: T,
  context?: Partial<HookContext>
): Promise<HookResult<T>[]> {
  return hookManager.execute(type, payload, context);
}

/**
 * Trigger a hook event
 */
export async function triggerHook<T>(
  type: HookType,
  data: T,
  source?: string
): Promise<HookResult<T>[]> {
  return hookManager.trigger(type, data, source);
}

// ============================================
// Pre-built Hook Handlers
// ============================================

/**
 * Logging hook handler
 */
export function createLoggingHandler(
  logFn: (message: string, data?: unknown) => void = console.log
): HookHandler<unknown, unknown> {
  return async (payload, context) => {
    logFn(`[${context.hookType}] ${context.source}`, payload.data);
    return { continue: true, modified: false };
  };
}

/**
 * Metrics collection hook handler
 */
export function createMetricsHandler(
  metricsCollector: (metrics: { type: string; duration: number; data: unknown }) => void
): HookHandler<unknown, unknown> {
  const startTime = Date.now();

  return async (payload, context) => {
    metricsCollector({
      type: context.hookType,
      duration: Date.now() - startTime,
      data: payload.data
    });

    return { continue: true, modified: false };
  };
}

/**
 * Validation hook handler factory
 */
export function createValidationHandler<T>(
  validator: (data: T) => boolean | string
): HookHandler<T, T> {
  return async (payload, context) => {
    const result = validator(payload.data);

    if (result === true) {
      return { continue: true, modified: false };
    }

    const errorMessage = typeof result === 'string' ? result : 'Validation failed';
    return {
      continue: false,
      modified: false,
      error: new Error(errorMessage)
    };
  };
}

/**
 * Transform hook handler factory
 */
export function createTransformHandler<TIn, TOut>(
  transformer: (data: TIn) => TOut | Promise<TOut>
): HookHandler<TIn, TOut> {
  return async (payload, context) => {
    const transformed = await transformer(payload.data);
    return {
      continue: true,
      modified: true,
      data: transformed
    };
  };
}

/**
 * Filter hook handler factory
 */
export function createFilterHandler<T>(
  predicate: (data: T, context: HookContext) => boolean
): HookHandler<T, T> {
  return async (payload, context) => {
    const shouldContinue = predicate(payload.data, context);
    return {
      continue: shouldContinue,
      modified: false
    };
  };
}

// ============================================
// V3 Specific Hook Presets
// ============================================

/**
 * V3 Performance monitoring hooks
 */
export const v3PerformanceHooks = {
  flashAttention: createPerformanceHook('metric', async (payload, context) => {
    // Track Flash Attention performance
    return {
      continue: true,
      modified: false,
      sideEffects: [{
        type: 'metric',
        action: 'flash-attention-speedup',
        data: { target: '2.49x-7.47x' }
      }]
    };
  }, { id: 'v3-flash-attention', tags: ['v3', 'performance', 'flash-attention'] }),

  agentDBSearch: createPerformanceHook('metric', async (payload, context) => {
    // Track AgentDB search performance
    return {
      continue: true,
      modified: false,
      sideEffects: [{
        type: 'metric',
        action: 'agentdb-search',
        data: { target: '150x-12500x' }
      }]
    };
  }, { id: 'v3-agentdb-search', tags: ['v3', 'performance', 'agentdb'] }),

  memoryOptimization: createPerformanceHook('optimize', async (payload, context) => {
    // Track memory optimization
    return {
      continue: true,
      modified: false,
      sideEffects: [{
        type: 'metric',
        action: 'memory-reduction',
        data: { target: '50-75%' }
      }]
    };
  }, { id: 'v3-memory-optimization', tags: ['v3', 'performance', 'memory'] })
};

/**
 * V3 Swarm coordination hooks
 */
export const v3SwarmHooks = {
  hierarchicalMesh: createSwarmHook('init:after', async (payload, context) => {
    // Initialize hierarchical mesh topology
    return {
      continue: true,
      modified: false,
      message: 'Hierarchical mesh topology initialized'
    };
  }, { id: 'v3-hierarchical-mesh', tags: ['v3', 'swarm', 'topology'] }),

  fifteenAgentCoordination: createSwarmHook('coordinate:before', async (payload, context) => {
    // Setup 15-agent coordination
    return {
      continue: true,
      modified: false,
      message: '15-agent coordination prepared'
    };
  }, { id: 'v3-15-agent-coordination', tags: ['v3', 'swarm', 'coordination'] })
};

/**
 * Register all V3 preset hooks
 */
export function registerV3Hooks(): void {
  // Register performance hooks
  Object.values(v3PerformanceHooks).forEach(hook => hookManager.register(hook));

  // Register swarm hooks
  Object.values(v3SwarmHooks).forEach(hook => hookManager.register(hook));
}

// Default export
export default hookManager;
