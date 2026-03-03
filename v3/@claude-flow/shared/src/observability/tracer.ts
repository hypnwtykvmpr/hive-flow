/**
 * Tracer
 * Named subsystem tracers with span management.
 *
 * Usage:
 *   const tracer = Tracer.get(Subsystems.AGENT);
 *   await tracer.withSpan('spawn-agent', async (span) => {
 *     span.setAttribute('agent.type', 'coder');
 *     // ... do work
 *   });
 */

import type { ISpan, SpanAttributes, SpanKind, SubsystemName } from './types.js';
import { Span, getNoopSpan } from './span.js';

export type SpanCallback = (span: Span) => void;

export class Tracer {
  private static tracers = new Map<string, Tracer>();
  private static enabled = false;
  private static onSpanEnd: SpanCallback | undefined;

  /** The current active span (for parent-child linking) */
  private activeSpan: ISpan | undefined;

  private constructor(readonly subsystem: SubsystemName) {}

  /**
   * Get or create a tracer for a subsystem.
   * Tracers are singletons per subsystem name.
   */
  static get(subsystem: SubsystemName): Tracer {
    let tracer = Tracer.tracers.get(subsystem);
    if (!tracer) {
      tracer = new Tracer(subsystem);
      Tracer.tracers.set(subsystem, tracer);
    }
    return tracer;
  }

  /**
   * Enable/disable all tracers globally.
   */
  static setEnabled(enabled: boolean): void {
    Tracer.enabled = enabled;
  }

  /**
   * Check if tracing is enabled.
   */
  static isEnabled(): boolean {
    return Tracer.enabled;
  }

  /**
   * Set a global callback for when spans end.
   * Used by ObservabilityManager to collect spans.
   */
  static setOnSpanEnd(callback: SpanCallback | undefined): void {
    Tracer.onSpanEnd = callback;
  }

  /**
   * Clear all tracers (for testing).
   */
  static clearAll(): void {
    Tracer.tracers.clear();
    Tracer.enabled = false;
    Tracer.onSpanEnd = undefined;
  }

  /**
   * Start a new span. Returns a no-op span if tracing is disabled.
   */
  startSpan(
    name: string,
    options?: {
      parentSpanId?: string;
      traceId?: string;
      kind?: SpanKind;
      attributes?: SpanAttributes;
    },
  ): ISpan {
    if (!Tracer.enabled) {
      return getNoopSpan();
    }

    // Capture parent before overwriting activeSpan (safe for concurrent withSpan calls)
    const parentSpan = this.activeSpan;

    const span = new Span(name, this.subsystem, {
      traceId: options?.traceId ?? (parentSpan as Span)?.traceId,
      parentSpanId: options?.parentSpanId ?? parentSpan?.spanId,
      kind: options?.kind,
      attributes: options?.attributes,
      onEnd: Tracer.onSpanEnd,
    });

    this.activeSpan = span;
    return span;
  }

  /**
   * Wrap an async function with a span.
   * The span is automatically ended when the function completes or throws.
   */
  async withSpan<T>(
    name: string,
    fn: (span: ISpan) => Promise<T>,
    options?: {
      attributes?: SpanAttributes;
      kind?: SpanKind;
    },
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      const result = await fn(span);
      span.setStatus('ok');
      return result;
    } catch (error) {
      const err = error as Error;
      span.setStatus('error', err.message);
      span.addEvent('exception', {
        'exception.type': err.name,
        'exception.message': err.message,
      });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Wrap a sync function with a span.
   */
  withSpanSync<T>(
    name: string,
    fn: (span: ISpan) => T,
    options?: {
      attributes?: SpanAttributes;
      kind?: SpanKind;
    },
  ): T {
    const span = this.startSpan(name, options);
    try {
      const result = fn(span);
      span.setStatus('ok');
      return result;
    } catch (error) {
      const err = error as Error;
      span.setStatus('error', err.message);
      span.addEvent('exception', {
        'exception.type': err.name,
        'exception.message': err.message,
      });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Get the current active span for this tracer.
   */
  getActiveSpan(): ISpan | undefined {
    return this.activeSpan;
  }
}
