/**
 * Observability Module
 * Lightweight tracing, metrics, and diagnostics for Claude Flow.
 *
 * Inspired by CodeMachine-CLI's OTEL stack but implemented without
 * OTEL SDK dependencies. Uses Claude Flow's EventBus for event propagation.
 *
 * @module @claude-flow/shared/observability
 */

// Types
export type {
  TraceLevel,
  ExporterType,
  ObservabilityConfig,
  SpanStatus,
  SpanKind,
  SpanAttributes,
  SpanEvent,
  SerializedSpan,
  ISpan,
  MetricType,
  MetricEntry,
  MetricSummary,
  SubsystemName,
} from './types.js';

export { Subsystems, ObservabilityEvents } from './types.js';

// Span
export { Span, getNoopSpan } from './span.js';

// Tracer
export { Tracer } from './tracer.js';

// Span Buffer
export { SpanBuffer } from './span-buffer.js';

// Metrics Collector
export { MetricsCollector } from './metrics-collector.js';

// Manager
export { ObservabilityManager } from './manager.js';
