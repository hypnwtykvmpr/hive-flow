/**
 * Observability Types
 * Type definitions for spans, metrics, and trace configuration.
 *
 * Zero-dependency design — no OTEL SDK required.
 * Uses Hive Flow's EventBus for event propagation.
 */

// =============================================================================
// Configuration
// =============================================================================

/** Trace level for tiered tracing */
export type TraceLevel = 0 | 1 | 2;
// 0 = Off (default), 1 = Minimal (errors + slow ops), 2 = Full (all spans)

/** Export destination for spans and metrics */
export type ExporterType = 'console' | 'file' | 'json' | 'none';

/** Observability configuration */
export interface ObservabilityConfig {
  enabled: boolean;
  level: TraceLevel;
  exporter: ExporterType;
  /** Directory for file exporter output */
  outputDir: string;
  /** Service name embedded in all spans */
  serviceName: string;
  /** Threshold in ms for "slow operation" in level 1 */
  slowThresholdMs: number;
  /** Max spans to keep in memory buffer */
  maxBufferedSpans: number;
  /** Max metrics entries to keep in memory */
  maxBufferedMetrics: number;
}

// =============================================================================
// Spans
// =============================================================================

/** Span status codes */
export type SpanStatus = 'ok' | 'error' | 'unset';

/** Span kind (matches OTEL convention) */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/** Span attributes (string-keyed, primitive values) */
export type SpanAttributes = Record<string, string | number | boolean | undefined>;

/** A span event (annotation at a point in time) */
export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: SpanAttributes;
}

/** A completed span (immutable after end()) */
export interface SerializedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: SpanAttributes;
  events: SpanEvent[];
  subsystem: string;
}

/** Active span interface (mutable until end() is called) */
export interface ISpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly subsystem: string;

  setAttribute(key: string, value: string | number | boolean): ISpan;
  setAttributes(attrs: SpanAttributes): ISpan;
  addEvent(name: string, attributes?: SpanAttributes): ISpan;
  setStatus(status: SpanStatus, message?: string): ISpan;
  end(): void;
  isRecording(): boolean;
}

// =============================================================================
// Metrics
// =============================================================================

/** Metric types */
export type MetricType = 'counter' | 'histogram' | 'gauge';

/** A single metric recording */
export interface MetricEntry {
  name: string;
  type: MetricType;
  value: number;
  subsystem: string;
  attributes?: SpanAttributes;
  timestamp: number;
}

/** Metric summary for a named metric */
export interface MetricSummary {
  name: string;
  type: MetricType;
  count: number;
  total: number;
  min: number;
  max: number;
  avg: number;
  lastValue: number;
  lastUpdated: number;
}

// =============================================================================
// Subsystems
// =============================================================================

/** Named subsystems for scoped tracing */
export const Subsystems = {
  CLI: 'hive-flow.cli',
  MCP: 'hive-flow.mcp',
  AGENT: 'hive-flow.agent',
  SWARM: 'hive-flow.swarm',
  MEMORY: 'hive-flow.memory',
  HOOKS: 'hive-flow.hooks',
  TASK: 'hive-flow.task',
  SESSION: 'hive-flow.session',
  PROCESS: 'hive-flow.process',
} as const;

export type SubsystemName = (typeof Subsystems)[keyof typeof Subsystems];

// =============================================================================
// Events emitted through EventBus
// =============================================================================

export const ObservabilityEvents = {
  SPAN_STARTED: 'observability:span-started',
  SPAN_ENDED: 'observability:span-ended',
  METRIC_RECORDED: 'observability:metric-recorded',
  EXPORT_FLUSHED: 'observability:export-flushed',
} as const;
