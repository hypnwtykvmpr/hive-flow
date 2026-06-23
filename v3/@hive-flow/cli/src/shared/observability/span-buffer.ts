/**
 * Span Buffer
 * Circular buffer for in-memory span storage.
 *
 * Adapted from CodeMachine-CLI's storage.ts pattern.
 * Keeps recent spans for diagnostics, bug reports, and export.
 */

import type { SerializedSpan } from './types.js';
import type { Span } from './span.js';

export class SpanBuffer {
  private buffer: SerializedSpan[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  /** Add a completed span to the buffer */
  add(span: Span): void {
    const serialized = span.serialize();
    this.buffer.push(serialized);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  /** Get all buffered spans */
  getAll(): SerializedSpan[] {
    return [...this.buffer];
  }

  /** Get spans filtered by subsystem */
  getBySubsystem(subsystem: string): SerializedSpan[] {
    return this.buffer.filter(s => s.subsystem === subsystem);
  }

  /** Get spans filtered by trace ID */
  getByTraceId(traceId: string): SerializedSpan[] {
    return this.buffer.filter(s => s.traceId === traceId);
  }

  /** Get only error spans */
  getErrors(): SerializedSpan[] {
    return this.buffer.filter(s => s.status === 'error');
  }

  /** Get slow spans (above threshold in ms) */
  getSlow(thresholdMs: number): SerializedSpan[] {
    return this.buffer.filter(s => s.durationMs > thresholdMs);
  }

  /** Get current buffer size */
  get size(): number {
    return this.buffer.length;
  }

  /** Clear the buffer */
  clear(): void {
    this.buffer.length = 0;
  }

  /** Export buffer as JSON string */
  toJSON(): string {
    return JSON.stringify(this.buffer, null, 2);
  }
}
