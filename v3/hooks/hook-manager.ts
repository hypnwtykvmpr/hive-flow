/**
 * V3 Hook Manager
 * Central manager for all hook operations
 */

import { EventEmitter } from 'events';
import type {
  HookType,
  HookRegistration,
  HookContext,
  HookPayload,
  HookResult,
  HookFilter,
  HookStatistics,
  HookPipeline,
  PipelineStage,
  SideEffect,
  IHookManager,
  HookEvent,
  HookEventType
} from './types.js';
import { HookRegistry } from './hook-registry.js';
import { HookExecutor, ExecutionResult } from './hook-executor.js';
import { HookComposer } from './composition.js';

/**
 * Hook manager configuration
 */
export interface HookManagerConfig {
  /** Default timeout for hooks */
  defaultTimeout?: number;
  /** Whether to enable metrics collection */
  enableMetrics?: boolean;
  /** Whether to process side effects */
  processSideEffects?: boolean;
  /** Maximum concurrent executions */
  maxConcurrent?: number;
  /** Whether to emit events */
  emitEvents?: boolean;
}

/**
 * V3 Hook Manager
 * Central manager for hook registration, execution, and lifecycle
 */
export class HookManager extends EventEmitter implements IHookManager {
  private registry: HookRegistry;
  private executor: HookExecutor;
  private composer: HookComposer;
  private pipelines: Map<string, HookPipeline> = new Map();
  private config: HookManagerConfig;

  constructor(config: HookManagerConfig = {}) {
    super();

    this.config = {
      defaultTimeout: 30000,
      enableMetrics: true,
      processSideEffects: true,
      maxConcurrent: 100,
      emitEvents: true,
      ...config
    };

    this.registry = new HookRegistry();
    this.executor = new HookExecutor(this.registry, {
      defaultTimeout: this.config.defaultTimeout,
      collectMetrics: this.config.enableMetrics,
      processSideEffects: this.config.processSideEffects,
      sideEffectHandler: this.handleSideEffect.bind(this)
    });
    this.composer = new HookComposer();
  }

  // ============================================
  // Registration Methods
  // ============================================

  /**
   * Register a new hook
   */
  register(registration: HookRegistration): void {
    this.registry.register(registration);

    this.emitEvent('hook:registered', {
      hookId: registration.id,
      hookType: registration.type
    });
  }

  /**
   * Register multiple hooks at once
   */
  registerAll(registrations: HookRegistration[]): void {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  /**
   * Unregister a hook by ID
   */
  unregister(hookId: string): void {
    const hook = this.registry.getById(hookId);
    const removed = this.registry.unregister(hookId);

    if (removed && hook) {
      this.emitEvent('hook:unregistered', {
        hookId,
        hookType: hook.type
      });
    }
  }

  // ============================================
  // Execution Methods
  // ============================================

  /**
   * Execute hooks for a given type
   */
  async execute<T>(
    type: HookType,
    payload: T,
    context: Partial<HookContext> = {}
  ): Promise<HookResult<T>[]> {
    const fullContext = this.buildContext(type, context);

    this.emitEvent('hook:executing', {
      hookType: type,
      executionId: fullContext.executionId
    });

    const executionResults = await this.executor.executeAll<T, T>(type, payload, fullContext);

    this.emitEvent('hook:executed', {
      hookType: type,
      executionId: fullContext.executionId,
      resultCount: executionResults.length
    });

    return executionResults.map(er => er.result);
  }

  /**
   * Execute hooks in parallel
   */
  async executeParallel<T>(
    type: HookType,
    payload: T,
    context: Partial<HookContext> = {}
  ): Promise<HookResult<T>[]> {
    const fullContext = this.buildContext(type, context);
    const executionResults = await this.executor.executeParallel<T, T>(type, payload, fullContext);
    return executionResults.map(er => er.result);
  }

  /**
   * Execute hooks with race semantics
   */
  async executeRace<T>(
    type: HookType,
    payload: T,
    context: Partial<HookContext> = {}
  ): Promise<HookResult<T> | null> {
    const fullContext = this.buildContext(type, context);
    const result = await this.executor.executeRace<T, T>(type, payload, fullContext);
    return result?.result || null;
  }

  /**
   * Trigger a hook event (convenience method)
   */
  async trigger<T>(
    type: HookType,
    data: T,
    source: string = 'manual'
  ): Promise<HookResult<T>[]> {
    return this.execute(type, data, { source });
  }

  // ============================================
  // Pipeline Methods
  // ============================================

  /**
   * Create a new pipeline
   */
  createPipeline(config: Partial<HookPipeline>): HookPipeline {
    const pipeline: HookPipeline = {
      id: config.id || this.generatePipelineId(),
      name: config.name || 'Unnamed Pipeline',
      description: config.description,
      stages: config.stages || [],
      errorStrategy: config.errorStrategy || 'fail-fast',
      metrics: {
        executions: 0,
        avgDuration: 0,
        errorRate: 0,
        throughput: 0
      }
    };

    this.pipelines.set(pipeline.id, pipeline);

    return pipeline;
  }

  /**
   * Add stage to pipeline
   */
  addStage(pipelineId: string, stage: PipelineStage): void {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline ${pipelineId} not found`);
    }

    pipeline.stages.push(stage);
  }

  /**
   * Execute a pipeline
   */
  async executePipeline(
    pipelineId: string,
    payload: unknown,
    context: Partial<HookContext> = {}
  ): Promise<HookResult[]> {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline ${pipelineId} not found`);
    }

    const startTime = Date.now();
    const fullContext = this.buildContext('custom', { ...context, source: `pipeline:${pipelineId}` });
    const results: HookResult[] = [];
    let currentPayload = payload;

    this.emitEvent('pipeline:start', { pipelineId, stages: pipeline.stages.length });

    try {
      for (const stage of pipeline.stages) {
        // Check stage condition
        if (stage.condition && !stage.condition(fullContext)) {
          continue;
        }

        // Execute stage hooks
        const stagePayload: HookPayload = {
          data: currentPayload,
          context: fullContext,
          modifiable: true
        };

        let stageResults: HookResult[];

        if (stage.parallel) {
          // Execute hooks in parallel
          stageResults = await Promise.all(
            stage.hooks.map(hook =>
              hook.handler(stagePayload, fullContext)
            )
          );
        } else {
          // Execute hooks sequentially
          stageResults = [];
          for (const hook of stage.hooks) {
            const result = await hook.handler(stagePayload, fullContext);
            stageResults.push(result);

            if (result.modified && result.data !== undefined) {
              currentPayload = result.data;
              stagePayload.data = currentPayload;
            }

            if (!result.continue) {
              break;
            }
          }
        }

        // Apply transform if provided
        if (stage.transform) {
          stageResults = stageResults.map(stage.transform);
        }

        results.push(...stageResults);

        // Check for errors
        const hasError = stageResults.some(r => r.error);
        if (hasError) {
          if (pipeline.errorStrategy === 'fail-fast') {
            throw stageResults.find(r => r.error)!.error;
          } else if (stage.onError === 'abort') {
            break;
          }
        }
      }

      // Update pipeline metrics
      this.updatePipelineMetrics(pipeline, Date.now() - startTime, false);

      this.emitEvent('pipeline:complete', {
        pipelineId,
        duration: Date.now() - startTime,
        resultCount: results.length
      });

      return results;

    } catch (error) {
      this.updatePipelineMetrics(pipeline, Date.now() - startTime, true);

      this.emitEvent('pipeline:error', {
        pipelineId,
        error: (error as Error).message
      });

      if (pipeline.errorStrategy === 'rollback') {
        await this.rollbackPipeline(pipeline, results, fullContext);
      }

      throw error;
    }
  }

  /**
   * Get pipeline by ID
   */
  getPipeline(pipelineId: string): HookPipeline | undefined {
    return this.pipelines.get(pipelineId);
  }

  /**
   * Get all pipelines
   */
  getPipelines(): HookPipeline[] {
    return Array.from(this.pipelines.values());
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * Get hooks by type
   */
  getHooks(type: HookType): HookRegistration[] {
    return this.registry.getByType(type);
  }

  /**
   * Get hook by ID
   */
  getHook(hookId: string): HookRegistration | undefined {
    return this.registry.getById(hookId);
  }

  /**
   * Get hooks by tag
   */
  getHooksByTag(tag: string): HookRegistration[] {
    return this.registry.getByTag(tag);
  }

  /**
   * Get all registered hook types
   */
  getTypes(): HookType[] {
    return this.registry.getTypes();
  }

  /**
   * Get total hook count
   */
  getCount(): number {
    return this.registry.getCount();
  }

  // ============================================
  // State Management
  // ============================================

  /**
   * Enable/disable a hook
   */
  setEnabled(hookId: string, enabled: boolean): void {
    this.registry.setEnabled(hookId, enabled);
  }

  /**
   * Get hook statistics
   */
  getStatistics(hookId?: string): HookStatistics | HookStatistics[] {
    const stats = this.registry.getStatistics(hookId);
    return stats || [];
  }

  /**
   * Clear all hooks
   */
  clear(): void {
    this.registry.clear();
    this.pipelines.clear();
  }

  // ============================================
  // Convenience Methods
  // ============================================

  /**
   * Create a simple hook registration
   */
  on<T>(
    type: HookType,
    handler: (data: T, context: HookContext) => Promise<void> | void,
    options: { id?: string; priority?: number; tags?: string[] } = {}
  ): string {
    const id = options.id || `hook-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    this.register({
      id,
      type,
      name: id,
      priority: options.priority || 100,
      enabled: true,
      tags: options.tags,
      handler: async (payload, context) => {
        await handler(payload.data as T, context);
        return { continue: true, modified: false };
      }
    });

    return id;
  }

  /**
   * Remove a hook by ID (alias for unregister)
   */
  off(hookId: string): void {
    this.unregister(hookId);
  }

  /**
   * Register a one-time hook
   */
  once<T>(
    type: HookType,
    handler: (data: T, context: HookContext) => Promise<void> | void
  ): string {
    const id = `once-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    this.register({
      id,
      type,
      name: id,
      priority: 100,
      enabled: true,
      handler: async (payload, context) => {
        await handler(payload.data as T, context);
        // Unregister after execution
        setTimeout(() => this.unregister(id), 0);
        return { continue: true, modified: false };
      }
    });

    return id;
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Build full context
   */
  private buildContext(type: HookType, partial: Partial<HookContext>): HookContext {
    return {
      executionId: this.generateExecutionId(),
      hookType: type,
      timestamp: Date.now(),
      source: partial.source || 'hook-manager',
      ...partial
    };
  }

  /**
   * Handle side effects
   */
  private async handleSideEffect(effect: SideEffect, context: HookContext): Promise<void> {
    // Emit side effect for external handling
    this.emit('sideEffect', { effect, context });

    // Built-in side effect handling
    switch (effect.type) {
      case 'log':
        console.log(`[${effect.action}]`, effect.data);
        break;

      case 'notification':
        this.emit('notification', effect.data);
        break;

      case 'metric':
        this.emit('metric', { name: effect.action, ...effect.data });
        break;

      case 'event':
        this.emit(effect.action, effect.data);
        break;

      default:
        // Other side effects handled externally
        break;
    }
  }

  /**
   * Update pipeline metrics
   */
  private updatePipelineMetrics(
    pipeline: HookPipeline,
    duration: number,
    hasError: boolean
  ): void {
    const metrics = pipeline.metrics;

    metrics.executions++;
    metrics.avgDuration = ((metrics.avgDuration * (metrics.executions - 1)) + duration) / metrics.executions;

    if (hasError) {
      metrics.errorRate = ((metrics.errorRate * (metrics.executions - 1)) + 1) / metrics.executions;
    } else {
      metrics.errorRate = (metrics.errorRate * (metrics.executions - 1)) / metrics.executions;
    }

    metrics.lastExecution = Date.now();
  }

  /**
   * Rollback pipeline
   */
  private async rollbackPipeline(
    pipeline: HookPipeline,
    results: HookResult[],
    context: HookContext
  ): Promise<void> {
    // Implement rollback logic based on side effects
    // This is a placeholder for actual rollback implementation
    console.warn(`Rolling back pipeline ${pipeline.name}`);
  }

  /**
   * Emit hook event
   */
  private emitEvent(type: HookEventType, data?: unknown): void {
    if (!this.config.emitEvents) return;

    const event: HookEvent = {
      type,
      timestamp: Date.now(),
      data
    };

    this.emit(type, event);
    this.emit('hookEvent', event);
  }

  /**
   * Generate execution ID
   */
  private generateExecutionId(): string {
    return `exec-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Generate pipeline ID
   */
  private generatePipelineId(): string {
    return `pipe-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }
}

// Export singleton instance
export const hookManager = new HookManager();
