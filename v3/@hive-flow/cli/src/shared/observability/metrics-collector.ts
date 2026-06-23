/**
 * Metrics Collector
 * Lightweight metrics collection for counters, histograms, and gauges.
 *
 * No OTEL dependency — stores metrics in memory with summary statistics.
 */

import type {
  MetricEntry,
  MetricSummary,
  MetricType,
  SpanAttributes,
  SubsystemName,
} from './types.js';

export class MetricsCollector {
  private entries: MetricEntry[] = [];
  private summaries = new Map<string, MetricSummary>();
  private maxEntries: number;
  private enabled = false;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  /** Enable/disable metrics collection */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Record a counter increment */
  counter(
    name: string,
    subsystem: SubsystemName,
    value = 1,
    attributes?: SpanAttributes,
  ): void {
    this.record(name, 'counter', value, subsystem, attributes);
  }

  /** Record a histogram value (e.g., latency) */
  histogram(
    name: string,
    subsystem: SubsystemName,
    value: number,
    attributes?: SpanAttributes,
  ): void {
    this.record(name, 'histogram', value, subsystem, attributes);
  }

  /** Record a gauge value (e.g., active agents) */
  gauge(
    name: string,
    subsystem: SubsystemName,
    value: number,
    attributes?: SpanAttributes,
  ): void {
    this.record(name, 'gauge', value, subsystem, attributes);
  }

  /** Get all recorded entries */
  getEntries(): MetricEntry[] {
    return [...this.entries];
  }

  /** Get summary for a named metric */
  getSummary(name: string): MetricSummary | undefined {
    return this.summaries.get(name);
  }

  /** Get all summaries */
  getAllSummaries(): MetricSummary[] {
    return Array.from(this.summaries.values());
  }

  /** Get summaries filtered by subsystem */
  getSummariesBySubsystem(subsystem: SubsystemName): MetricSummary[] {
    return this.getAllSummaries().filter(s =>
      this.entries.some(e => e.name === s.name && e.subsystem === subsystem),
    );
  }

  /** Get the current entry count */
  get size(): number {
    return this.entries.length;
  }

  /** Clear all entries and summaries */
  clear(): void {
    this.entries = [];
    this.summaries.clear();
  }

  // ─── Private ──────────────────────────────────────────────────

  private record(
    name: string,
    type: MetricType,
    value: number,
    subsystem: SubsystemName,
    attributes?: SpanAttributes,
  ): void {
    if (!this.enabled) return;

    const entry: MetricEntry = {
      name,
      type,
      value,
      subsystem,
      attributes,
      timestamp: Date.now(),
    };

    this.entries.push(entry);

    // Prune if over limit
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    // Update summary
    this.updateSummary(name, type, value);
  }

  private updateSummary(name: string, type: MetricType, value: number): void {
    const existing = this.summaries.get(name);

    if (existing) {
      existing.count++;
      existing.total += value;
      existing.min = Math.min(existing.min, value);
      existing.max = Math.max(existing.max, value);
      existing.avg = existing.total / existing.count;
      existing.lastValue = value;
      existing.lastUpdated = Date.now();
    } else {
      this.summaries.set(name, {
        name,
        type,
        count: 1,
        total: value,
        min: value,
        max: value,
        avg: value,
        lastValue: value,
        lastUpdated: Date.now(),
      });
    }
  }
}
