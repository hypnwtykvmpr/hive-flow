/**
 * Observability Manager
 * Central coordinator for tracing, metrics, and span export.
 *
 * Provides:
 * - Lazy initialization via env vars (CLAUDE_FLOW_TRACE)
 * - Named subsystem tracers
 * - Span buffering for diagnostics
 * - Metrics collection with summaries
 * - File and console export
 * - EventBus integration
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IEventBus } from '../core/interfaces/event.interface.js';
import type {
  ObservabilityConfig,
  TraceLevel,
  ExporterType,
  SubsystemName,
} from './types.js';
import { ObservabilityEvents, Subsystems } from './types.js';
import { Tracer } from './tracer.js';
import { SpanBuffer } from './span-buffer.js';
import { MetricsCollector } from './metrics-collector.js';
import type { Span } from './span.js';

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: ObservabilityConfig = {
  enabled: false,
  level: 0,
  exporter: 'none',
  outputDir: '.claude-flow/traces',
  serviceName: 'claude-flow',
  slowThresholdMs: 5000,
  maxBufferedSpans: 100,
  maxBufferedMetrics: 1000,
};

// =============================================================================
// Environment Variable Parsing
// =============================================================================

function parseTraceLevel(value: string | undefined): TraceLevel {
  if (!value) return 0;
  const n = parseInt(value, 10);
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (value.toLowerCase() === 'true') return 1;
  return 0;
}

function parseExporter(value: string | undefined): ExporterType {
  if (!value) return 'file';
  const v = value.toLowerCase();
  if (['console', 'file', 'json', 'none'].includes(v)) return v as ExporterType;
  return 'file';
}

/**
 * Load configuration from environment variables.
 *
 * Env vars:
 * - CLAUDE_FLOW_TRACE: Trace level (0/1/2)
 * - CLAUDE_FLOW_TRACE_EXPORTER: Exporter type (console/file/json/none)
 * - CLAUDE_FLOW_TRACE_DIR: Output directory for file exporter
 * - CLAUDE_FLOW_SERVICE_NAME: Service name in spans
 * - CLAUDE_FLOW_TRACE_SLOW_THRESHOLD: Slow op threshold in ms
 */
function loadConfigFromEnv(): ObservabilityConfig {
  const level = parseTraceLevel(process.env.CLAUDE_FLOW_TRACE);
  return {
    enabled: level > 0,
    level,
    exporter: parseExporter(process.env.CLAUDE_FLOW_TRACE_EXPORTER),
    outputDir: process.env.CLAUDE_FLOW_TRACE_DIR ?? DEFAULT_CONFIG.outputDir,
    serviceName: process.env.CLAUDE_FLOW_SERVICE_NAME ?? DEFAULT_CONFIG.serviceName,
    slowThresholdMs: parseInt(process.env.CLAUDE_FLOW_TRACE_SLOW_THRESHOLD ?? '', 10)
      || DEFAULT_CONFIG.slowThresholdMs,
    maxBufferedSpans: DEFAULT_CONFIG.maxBufferedSpans,
    maxBufferedMetrics: DEFAULT_CONFIG.maxBufferedMetrics,
  };
}

// =============================================================================
// Observability Manager
// =============================================================================

export class ObservabilityManager {
  private config: ObservabilityConfig;
  private spanBuffer: SpanBuffer;
  private metricsCollector: MetricsCollector;
  private initialized = false;

  constructor(
    private eventBus?: IEventBus,
    config?: Partial<ObservabilityConfig>,
  ) {
    const envConfig = loadConfigFromEnv();
    this.config = { ...envConfig, ...config };
    this.spanBuffer = new SpanBuffer(this.config.maxBufferedSpans);
    this.metricsCollector = new MetricsCollector(this.config.maxBufferedMetrics);
  }

  /**
   * Initialize the observability system.
   * Safe to call multiple times (idempotent).
   */
  initialize(): void {
    if (this.initialized) return;

    Tracer.setEnabled(this.config.enabled);
    this.metricsCollector.setEnabled(this.config.enabled);

    if (this.config.enabled) {
      // Wire up span collection
      Tracer.setOnSpanEnd((span: Span) => {
        // Level 1: only capture errors and slow ops
        if (this.config.level === 1) {
          const serialized = span.serialize();
          const isError = serialized.status === 'error';
          const isSlow = serialized.durationMs > this.config.slowThresholdMs;
          if (!isError && !isSlow) return;
        }

        this.spanBuffer.add(span);
        this.eventBus?.emit(ObservabilityEvents.SPAN_ENDED, span.serialize());
      });
    }

    this.initialized = true;
  }

  /**
   * Shutdown: flush pending spans and clean up.
   */
  async shutdown(): Promise<void> {
    if (this.config.enabled && this.config.exporter !== 'none') {
      await this.flush();
    }
    Tracer.clearAll();
    this.initialized = false;
  }

  // ─── Tracers ──────────────────────────────────────────────────

  /** Get a tracer for a specific subsystem */
  getTracer(subsystem: SubsystemName): Tracer {
    return Tracer.get(subsystem);
  }

  // ─── Metrics ──────────────────────────────────────────────────

  /** Get the metrics collector */
  getMetrics(): MetricsCollector {
    return this.metricsCollector;
  }

  // ─── Span Buffer ──────────────────────────────────────────────

  /** Get the span buffer for diagnostics */
  getSpanBuffer(): SpanBuffer {
    return this.spanBuffer;
  }

  // ─── Export ───────────────────────────────────────────────────

  /**
   * Flush buffered spans to the configured exporter.
   */
  async flush(): Promise<void> {
    const spans = this.spanBuffer.getAll();
    const metrics = this.metricsCollector.getAllSummaries();

    if (spans.length === 0 && metrics.length === 0) return;

    switch (this.config.exporter) {
      case 'console':
        this.exportToConsole(spans, metrics);
        break;
      case 'file':
      case 'json':
        await this.exportToFile(spans, metrics);
        break;
      case 'none':
        break;
    }

    this.eventBus?.emit(ObservabilityEvents.EXPORT_FLUSHED, {
      spanCount: spans.length,
      metricCount: metrics.length,
    });
  }

  // ─── Configuration ────────────────────────────────────────────

  /** Get the current configuration */
  getConfig(): Readonly<ObservabilityConfig> {
    return { ...this.config };
  }

  /** Check if observability is enabled */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ─── Private Export Methods ───────────────────────────────────

  private exportToConsole(
    spans: ReturnType<SpanBuffer['getAll']>,
    metrics: ReturnType<MetricsCollector['getAllSummaries']>,
  ): void {
    if (spans.length > 0) {
      console.log(`[Observability] ${spans.length} spans:`);
      for (const span of spans) {
        const status = span.status === 'error' ? 'ERR' : 'OK';
        console.log(
          `  [${status}] ${span.subsystem}/${span.name} ` +
          `(${span.durationMs}ms) trace=${span.traceId.slice(0, 8)}`,
        );
      }
    }

    if (metrics.length > 0) {
      console.log(`[Observability] ${metrics.length} metrics:`);
      for (const m of metrics) {
        console.log(
          `  ${m.name} (${m.type}): count=${m.count} avg=${m.avg.toFixed(2)} ` +
          `min=${m.min} max=${m.max}`,
        );
      }
    }
  }

  private async exportToFile(
    spans: ReturnType<SpanBuffer['getAll']>,
    metrics: ReturnType<MetricsCollector['getAllSummaries']>,
  ): Promise<void> {
    try {
      await mkdir(this.config.outputDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `trace-${timestamp}.json`;
      const data = {
        serviceName: this.config.serviceName,
        exportedAt: new Date().toISOString(),
        spans,
        metrics,
      };

      await writeFile(
        join(this.config.outputDir, filename),
        JSON.stringify(data, null, 2),
      );
    } catch {
      // Don't fail the application if export fails
    }
  }
}
