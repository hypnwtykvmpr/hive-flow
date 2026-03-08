/**
 * Span Implementation
 * Lightweight span tracking without OTEL SDK dependency.
 *
 * Provides:
 * - Active spans with attributes, events, and status
 * - No-op span for zero-overhead when tracing is disabled
 * - Span serialization for export
 */

import { randomBytes } from 'node:crypto';
import { maskSensitiveData } from '../security/masking.js';
import type {
  ISpan,
  SpanAttributes,
  SpanEvent,
  SpanKind,
  SpanStatus,
  SerializedSpan,
} from './types.js';

// =============================================================================
// Span
// =============================================================================

export class Span implements ISpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly subsystem: string;

  private kind: SpanKind;
  private startTime: number;
  private endTime = 0;
  private status: SpanStatus = 'unset';
  private statusMessage?: string;
  private attrs: SpanAttributes = {};
  private spanEvents: SpanEvent[] = [];
  private recording = true;
  private parentSpanId?: string;
  private onEnd?: (span: Span) => void;

  constructor(
    name: string,
    subsystem: string,
    options?: {
      traceId?: string;
      parentSpanId?: string;
      kind?: SpanKind;
      attributes?: SpanAttributes;
      onEnd?: (span: Span) => void;
    },
  ) {
    this.name = name;
    this.subsystem = subsystem;
    this.traceId = options?.traceId ?? generateId(16);
    this.spanId = generateId(8);
    this.parentSpanId = options?.parentSpanId;
    this.kind = options?.kind ?? 'internal';
    this.startTime = Date.now();
    this.onEnd = options?.onEnd;

    if (options?.attributes) {
      this.attrs = { ...options.attributes };
    }
  }

  setAttribute(key: string, value: string | number | boolean): ISpan {
    if (this.recording) {
      this.attrs[key] = value;
    }
    return this;
  }

  setAttributes(attrs: SpanAttributes): ISpan {
    if (this.recording) {
      Object.assign(this.attrs, attrs);
    }
    return this;
  }

  addEvent(name: string, attributes?: SpanAttributes): ISpan {
    if (this.recording) {
      this.spanEvents.push({
        name,
        timestamp: Date.now(),
        attributes,
      });
    }
    return this;
  }

  setStatus(status: SpanStatus, message?: string): ISpan {
    if (this.recording) {
      this.status = status;
      this.statusMessage = message;
    }
    return this;
  }

  end(): void {
    if (!this.recording) return;
    this.endTime = Date.now();
    this.recording = false;
    if (this.status === 'unset') {
      this.status = 'ok';
    }
    this.onEnd?.(this);
  }

  isRecording(): boolean {
    return this.recording;
  }

  /** Serialize to a plain object for export/storage */
  serialize(): SerializedSpan {
    return {
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      kind: this.kind,
      startTime: this.startTime,
      endTime: this.endTime || Date.now(),
      durationMs: (this.endTime || Date.now()) - this.startTime,
      status: this.status,
      statusMessage: this.statusMessage,
      attributes: maskSensitiveData({ ...this.attrs }),
      events: this.spanEvents.map((event) => ({
        ...event,
        attributes: event.attributes ? maskSensitiveData({ ...event.attributes }) : undefined,
      })),
      subsystem: this.subsystem,
    };
  }
}

// =============================================================================
// No-Op Span (zero overhead when tracing is off)
// =============================================================================

const NOOP_SPAN: ISpan = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  name: 'noop',
  subsystem: 'noop',
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  end: () => {},
  isRecording: () => false,
};

export function getNoopSpan(): ISpan {
  return NOOP_SPAN;
}

// =============================================================================
// Helpers
// =============================================================================

function generateId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
