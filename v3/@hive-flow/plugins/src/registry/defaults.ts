/**
 * Shared Default Implementations
 *
 * Provides DefaultEventBus and DefaultLogger used across plugin registries.
 * Extracted to avoid duplication between plugin-registry.ts and enhanced-plugin-registry.ts.
 */

import { EventEmitter } from 'node:events';
import type { IEventBus, ILogger } from '../types/index.js';

// ============================================================================
// Default Event Bus
// ============================================================================

export class DefaultEventBus implements IEventBus {
  private emitter = new EventEmitter();

  emit(event: string, data?: unknown): void {
    this.emitter.emit(event, data);
  }

  on(event: string, handler: (data?: unknown) => void | Promise<void>): () => void {
    this.emitter.on(event, handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: (data?: unknown) => void | Promise<void>): void {
    this.emitter.off(event, handler);
  }

  once(event: string, handler: (data?: unknown) => void | Promise<void>): () => void {
    this.emitter.once(event, handler);
    return () => this.off(event, handler);
  }
}

// ============================================================================
// Default Logger
// ============================================================================

export class DefaultLogger implements ILogger {
  private context: Record<string, unknown> = {};

  constructor(context?: Record<string, unknown>) {
    if (context) this.context = context;
  }

  debug(message: string, ...args: unknown[]): void {
    console.debug(`[DEBUG]`, message, ...args, this.context);
  }

  info(message: string, ...args: unknown[]): void {
    console.info(`[INFO]`, message, ...args, this.context);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`[WARN]`, message, ...args, this.context);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`[ERROR]`, message, ...args, this.context);
  }

  child(context: Record<string, unknown>): ILogger {
    return new DefaultLogger({ ...this.context, ...context });
  }
}
