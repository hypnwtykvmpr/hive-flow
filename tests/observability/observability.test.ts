/**
 * Observability Module Tests
 * Tests for Span, Tracer, SpanBuffer, MetricsCollector, and ObservabilityManager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Span, getNoopSpan } from '../../v3/@claude-flow/shared/src/observability/span.js';
import { Tracer } from '../../v3/@claude-flow/shared/src/observability/tracer.js';
import { SpanBuffer } from '../../v3/@claude-flow/shared/src/observability/span-buffer.js';
import { MetricsCollector } from '../../v3/@claude-flow/shared/src/observability/metrics-collector.js';
import { ObservabilityManager } from '../../v3/@claude-flow/shared/src/observability/manager.js';
import { Subsystems, ObservabilityEvents } from '../../v3/@claude-flow/shared/src/observability/types.js';
import type { IEventBus } from '../../v3/@claude-flow/shared/src/core/interfaces/event.interface.js';

// ─── Helpers ──────────────────────────────────────────────────────

function createMockEventBus(): IEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  } as unknown as IEventBus;
}

// ─── Span Tests ───────────────────────────────────────────────────

describe('Span', () => {
  it('should create a span with name and subsystem', () => {
    const span = new Span('test-op', Subsystems.AGENT);
    expect(span.name).toBe('test-op');
    expect(span.subsystem).toBe(Subsystems.AGENT);
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.isRecording()).toBe(true);
  });

  it('should set attributes', () => {
    const span = new Span('test-op', Subsystems.CLI);
    span.setAttribute('key1', 'value1');
    span.setAttributes({ key2: 42, key3: true });

    const serialized = span.serialize();
    expect(serialized.attributes.key1).toBe('value1');
    expect(serialized.attributes.key2).toBe(42);
    expect(serialized.attributes.key3).toBe(true);
  });

  it('should add events', () => {
    const span = new Span('test-op', Subsystems.MCP);
    span.addEvent('started');
    span.addEvent('checkpoint', { step: 1 });

    const serialized = span.serialize();
    expect(serialized.events).toHaveLength(2);
    expect(serialized.events[0].name).toBe('started');
    expect(serialized.events[1].attributes?.step).toBe(1);
  });

  it('should set status', () => {
    const span = new Span('test-op', Subsystems.TASK);
    span.setStatus('error', 'something broke');

    const serialized = span.serialize();
    expect(serialized.status).toBe('error');
    expect(serialized.statusMessage).toBe('something broke');
  });

  it('should stop recording after end()', () => {
    const span = new Span('test-op', Subsystems.MEMORY);
    span.end();

    expect(span.isRecording()).toBe(false);
    // Further modifications should be no-ops
    span.setAttribute('should-not-appear', 'ignored');
    const serialized = span.serialize();
    expect(serialized.attributes['should-not-appear']).toBeUndefined();
  });

  it('should calculate duration on serialization', () => {
    const span = new Span('test-op', Subsystems.SWARM);
    // Simulate some time passing
    span.end();
    const serialized = span.serialize();
    expect(serialized.durationMs).toBeGreaterThanOrEqual(0);
    expect(serialized.endTime).toBeGreaterThanOrEqual(serialized.startTime);
  });

  it('should default status to ok when ending without explicit status', () => {
    const span = new Span('test-op', Subsystems.HOOKS);
    span.end();
    expect(span.serialize().status).toBe('ok');
  });

  it('should call onEnd callback', () => {
    const onEnd = vi.fn();
    const span = new Span('test-op', Subsystems.CLI, { onEnd });
    span.end();
    expect(onEnd).toHaveBeenCalledWith(span);
  });

  it('should use provided traceId and parentSpanId', () => {
    const span = new Span('child-op', Subsystems.AGENT, {
      traceId: 'abc123'.padEnd(32, '0'),
      parentSpanId: 'parent1234567890',
    });
    expect(span.traceId).toBe('abc123'.padEnd(32, '0'));
    expect(span.serialize().parentSpanId).toBe('parent1234567890');
  });

  it('end() is idempotent — calling twice does not fire onEnd twice', () => {
    const onEnd = vi.fn();
    const span = new Span('idem-op', Subsystems.CLI, { onEnd });
    span.end();
    span.end();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('addEvent() after end() is a no-op', () => {
    const span = new Span('closed-op', Subsystems.CLI);
    span.addEvent('before-end');
    span.end();
    span.addEvent('after-end');
    expect(span.serialize().events).toHaveLength(1);
    expect(span.serialize().events[0].name).toBe('before-end');
  });

  it('setStatus() after end() is a no-op', () => {
    const span = new Span('status-op', Subsystems.CLI);
    span.end(); // defaults to 'ok'
    span.setStatus('error', 'too late');
    expect(span.serialize().status).toBe('ok');
  });

  it('end() is idempotent - calling twice does not fire onEnd twice', () => {
    const onEnd = vi.fn();
    const span = new Span('idempotent-op', Subsystems.CLI, { onEnd });
    span.end();
    span.end();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('addEvent() after end() is a no-op', () => {
    const span = new Span('event-after-end-op', Subsystems.CLI);
    span.end();
    span.addEvent('late-event');
    expect(span.serialize().events).toHaveLength(0);
  });

  it('setStatus() after end() is a no-op', () => {
    const span = new Span('status-after-end-op', Subsystems.CLI);
    span.end();
    span.setStatus('error', 'late status');

    const serialized = span.serialize();
    expect(serialized.status).toBe('ok');
    expect(serialized.statusMessage).toBeUndefined();
  });
});

describe('NoopSpan', () => {
  it('should not record anything', () => {
    const span = getNoopSpan();
    expect(span.isRecording()).toBe(false);
    expect(span.setAttribute('key', 'value')).toBe(span);
    expect(span.addEvent('test')).toBe(span);
    expect(span.setStatus('error')).toBe(span);
    span.end(); // should not throw
  });
});

// ─── SpanBuffer Tests ─────────────────────────────────────────────

describe('SpanBuffer', () => {
  let buffer: SpanBuffer;

  beforeEach(() => {
    buffer = new SpanBuffer(5);
  });

  it('should add and retrieve spans', () => {
    const span = new Span('op1', Subsystems.CLI);
    span.end();
    buffer.add(span);

    expect(buffer.size).toBe(1);
    expect(buffer.getAll()).toHaveLength(1);
    expect(buffer.getAll()[0].name).toBe('op1');
  });

  it('should evict oldest spans when over capacity', () => {
    for (let i = 0; i < 7; i++) {
      const span = new Span(`op-${i}`, Subsystems.AGENT);
      span.end();
      buffer.add(span);
    }

    expect(buffer.size).toBe(5);
    // Oldest (op-0, op-1) should be evicted
    const names = buffer.getAll().map(s => s.name);
    expect(names).not.toContain('op-0');
    expect(names).not.toContain('op-1');
    expect(names).toContain('op-6');
  });

  it('should filter by subsystem', () => {
    const s1 = new Span('agent-op', Subsystems.AGENT);
    const s2 = new Span('cli-op', Subsystems.CLI);
    s1.end();
    s2.end();
    buffer.add(s1);
    buffer.add(s2);

    expect(buffer.getBySubsystem(Subsystems.AGENT)).toHaveLength(1);
    expect(buffer.getBySubsystem(Subsystems.CLI)).toHaveLength(1);
  });

  it('should filter by trace ID', () => {
    const traceId = '0'.repeat(32);
    const s1 = new Span('op1', Subsystems.CLI, { traceId });
    const s2 = new Span('op2', Subsystems.CLI);
    s1.end();
    s2.end();
    buffer.add(s1);
    buffer.add(s2);

    expect(buffer.getByTraceId(traceId)).toHaveLength(1);
  });

  it('should filter error spans', () => {
    const s1 = new Span('ok-op', Subsystems.CLI);
    s1.end();
    const s2 = new Span('err-op', Subsystems.CLI);
    s2.setStatus('error', 'failed');
    s2.end();

    buffer.add(s1);
    buffer.add(s2);

    expect(buffer.getErrors()).toHaveLength(1);
    expect(buffer.getErrors()[0].name).toBe('err-op');
  });

  it('should filter slow spans', () => {
    // We can't easily control duration in tests, but we can verify the filter
    const s1 = new Span('fast', Subsystems.CLI);
    s1.end(); // Should be ~0ms
    buffer.add(s1);

    expect(buffer.getSlow(1000)).toHaveLength(0);
  });

  it('should export as JSON', () => {
    const span = new Span('op1', Subsystems.CLI);
    span.end();
    buffer.add(span);

    const json = buffer.toJSON();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('op1');
  });

  it('should clear', () => {
    const span = new Span('op1', Subsystems.CLI);
    span.end();
    buffer.add(span);
    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});

// ─── MetricsCollector Tests ───────────────────────────────────────

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector(100);
    collector.setEnabled(true);
  });

  it('should record counters', () => {
    collector.counter('agent.spawned', Subsystems.AGENT);
    collector.counter('agent.spawned', Subsystems.AGENT);
    collector.counter('agent.spawned', Subsystems.AGENT, 3);

    const summary = collector.getSummary('agent.spawned');
    expect(summary).toBeDefined();
    expect(summary!.count).toBe(3);
    expect(summary!.total).toBe(5); // 1 + 1 + 3
    expect(summary!.type).toBe('counter');
  });

  it('should record histograms', () => {
    collector.histogram('task.duration', Subsystems.TASK, 100);
    collector.histogram('task.duration', Subsystems.TASK, 200);
    collector.histogram('task.duration', Subsystems.TASK, 50);

    const summary = collector.getSummary('task.duration');
    expect(summary!.min).toBe(50);
    expect(summary!.max).toBe(200);
    expect(summary!.avg).toBeCloseTo(116.67, 1);
  });

  it('should record gauges', () => {
    collector.gauge('agents.active', Subsystems.SWARM, 5);
    collector.gauge('agents.active', Subsystems.SWARM, 3);

    const summary = collector.getSummary('agents.active');
    expect(summary!.lastValue).toBe(3);
    expect(summary!.type).toBe('gauge');
  });

  it('should not record when disabled', () => {
    collector.setEnabled(false);
    collector.counter('ignored', Subsystems.CLI);
    expect(collector.size).toBe(0);
  });

  it('should return all entries', () => {
    collector.counter('a', Subsystems.CLI);
    collector.histogram('b', Subsystems.AGENT, 10);
    expect(collector.getEntries()).toHaveLength(2);
  });

  it('should return all summaries', () => {
    collector.counter('a', Subsystems.CLI);
    collector.histogram('b', Subsystems.AGENT, 10);
    expect(collector.getAllSummaries()).toHaveLength(2);
  });

  it('should prune old entries when over limit', () => {
    const smallCollector = new MetricsCollector(5);
    smallCollector.setEnabled(true);

    for (let i = 0; i < 10; i++) {
      smallCollector.counter(`metric-${i}`, Subsystems.CLI);
    }

    expect(smallCollector.size).toBe(5);
  });

  it('should clear', () => {
    collector.counter('a', Subsystems.CLI);
    collector.clear();
    expect(collector.size).toBe(0);
    expect(collector.getAllSummaries()).toHaveLength(0);
  });
});

// ─── Tracer Tests ─────────────────────────────────────────────────

describe('Tracer', () => {
  beforeEach(() => {
    Tracer.clearAll();
  });

  afterEach(() => {
    Tracer.clearAll();
  });

  it('should return singleton per subsystem', () => {
    const t1 = Tracer.get(Subsystems.AGENT);
    const t2 = Tracer.get(Subsystems.AGENT);
    expect(t1).toBe(t2);
  });

  it('should return different instances for different subsystems', () => {
    const t1 = Tracer.get(Subsystems.AGENT);
    const t2 = Tracer.get(Subsystems.CLI);
    expect(t1).not.toBe(t2);
  });

  it('should return noop span when disabled', () => {
    Tracer.setEnabled(false);
    const tracer = Tracer.get(Subsystems.AGENT);
    const span = tracer.startSpan('test');
    expect(span.isRecording()).toBe(false);
  });

  it('should return active span when enabled', () => {
    Tracer.setEnabled(true);
    const tracer = Tracer.get(Subsystems.AGENT);
    const span = tracer.startSpan('test');
    expect(span.isRecording()).toBe(true);
    expect(span.name).toBe('test');
    expect(span.subsystem).toBe(Subsystems.AGENT);
    span.end();
  });

  it('should wrap async function with span', async () => {
    Tracer.setEnabled(true);
    const ended: Span[] = [];
    Tracer.setOnSpanEnd((span) => ended.push(span));

    const tracer = Tracer.get(Subsystems.TASK);
    const result = await tracer.withSpan('async-op', async (span) => {
      span.setAttribute('key', 'value');
      return 42;
    });

    expect(result).toBe(42);
    expect(ended).toHaveLength(1);
    expect(ended[0].serialize().status).toBe('ok');
  });

  it('should capture errors in withSpan', async () => {
    Tracer.setEnabled(true);
    const ended: Span[] = [];
    Tracer.setOnSpanEnd((span) => ended.push(span));

    const tracer = Tracer.get(Subsystems.TASK);

    await expect(
      tracer.withSpan('failing-op', async () => {
        throw new Error('test error');
      }),
    ).rejects.toThrow('test error');

    expect(ended).toHaveLength(1);
    expect(ended[0].serialize().status).toBe('error');
    expect(ended[0].serialize().statusMessage).toBe('test error');
  });

  it('should wrap sync function with span', () => {
    Tracer.setEnabled(true);
    const tracer = Tracer.get(Subsystems.CLI);
    const result = tracer.withSpanSync('sync-op', (span) => {
      span.setAttribute('sync', true);
      return 'hello';
    });

    expect(result).toBe('hello');
  });

  it('should call onSpanEnd callback', () => {
    Tracer.setEnabled(true);
    const callback = vi.fn();
    Tracer.setOnSpanEnd(callback);

    const tracer = Tracer.get(Subsystems.CLI);
    const span = tracer.startSpan('test');
    span.end();

    expect(callback).toHaveBeenCalledOnce();
  });

  it('withSpanSync error path sets status to error and rethrows', () => {
    Tracer.setEnabled(true);
    const ended: Span[] = [];
    Tracer.setOnSpanEnd((span) => ended.push(span));

    const tracer = Tracer.get(Subsystems.TASK);

    expect(() =>
      tracer.withSpanSync('sync-fail', () => {
        throw new Error('sync error');
      }),
    ).toThrow('sync error');

    expect(ended).toHaveLength(1);
    expect(ended[0].serialize().status).toBe('error');
    expect(ended[0].serialize().statusMessage).toBe('sync error');
  });

  it('withSpanSync() error path sets status to error and rethrows', () => {
    Tracer.setEnabled(true);
    const ended: Span[] = [];
    Tracer.setOnSpanEnd((span) => ended.push(span));

    const tracer = Tracer.get(Subsystems.TASK);

    expect(() =>
      tracer.withSpanSync('sync-fail-2', () => {
        throw new Error('sync error 2');
      }),
    ).toThrow('sync error 2');

    expect(ended).toHaveLength(1);
    expect(ended[0].serialize().status).toBe('error');
    expect(ended[0].serialize().statusMessage).toBe('sync error 2');
  });
});

// ─── ObservabilityManager Tests ───────────────────────────────────

describe('ObservabilityManager', () => {
  let eventBus: IEventBus;

  beforeEach(() => {
    eventBus = createMockEventBus();
    Tracer.clearAll();
  });

  afterEach(() => {
    Tracer.clearAll();
  });

  it('should initialize as disabled by default', () => {
    const manager = new ObservabilityManager(eventBus);
    manager.initialize();
    expect(manager.isEnabled()).toBe(false);
  });

  it('should initialize as enabled with config override', () => {
    const manager = new ObservabilityManager(eventBus, { enabled: true, level: 2 });
    manager.initialize();
    expect(manager.isEnabled()).toBe(true);
    expect(Tracer.isEnabled()).toBe(true);
  });

  it('should provide subsystem tracers', () => {
    const manager = new ObservabilityManager(eventBus, { enabled: true, level: 2 });
    manager.initialize();

    const tracer = manager.getTracer(Subsystems.AGENT);
    expect(tracer.subsystem).toBe(Subsystems.AGENT);
  });

  it('should collect spans into buffer when enabled', () => {
    const manager = new ObservabilityManager(eventBus, { enabled: true, level: 2 });
    manager.initialize();

    const tracer = manager.getTracer(Subsystems.CLI);
    const span = tracer.startSpan('test-op');
    span.end();

    expect(manager.getSpanBuffer().size).toBe(1);
  });

  it('should emit SPAN_ENDED event', () => {
    const manager = new ObservabilityManager(eventBus, { enabled: true, level: 2 });
    manager.initialize();

    const tracer = manager.getTracer(Subsystems.CLI);
    const span = tracer.startSpan('test-op');
    span.end();

    expect(eventBus.emit).toHaveBeenCalledWith(
      ObservabilityEvents.SPAN_ENDED,
      expect.objectContaining({ name: 'test-op' }),
    );
  });

  it('should filter non-error, non-slow spans at level 1', () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 1,
      slowThresholdMs: 10000,
    });
    manager.initialize();

    const tracer = manager.getTracer(Subsystems.CLI);

    // Fast successful span — should be filtered out
    const fastSpan = tracer.startSpan('fast-op');
    fastSpan.end();

    // Error span — should be kept
    const errSpan = tracer.startSpan('err-op');
    errSpan.setStatus('error', 'failed');
    errSpan.end();

    expect(manager.getSpanBuffer().size).toBe(1);
    expect(manager.getSpanBuffer().getAll()[0].name).toBe('err-op');
  });

  it('should provide metrics collector', () => {
    const manager = new ObservabilityManager(eventBus, { enabled: true, level: 2 });
    manager.initialize();

    const metrics = manager.getMetrics();
    metrics.counter('test.count', Subsystems.CLI);
    expect(metrics.getSummary('test.count')?.count).toBe(1);
  });

  it('should be idempotent on initialize', () => {
    const manager = new ObservabilityManager(eventBus, { enabled: true, level: 2 });
    manager.initialize();
    manager.initialize();

    // Should not throw or double-register
    const tracer = manager.getTracer(Subsystems.CLI);
    expect(tracer).toBeDefined();
  });

  it('should shutdown cleanly', async () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 2,
      exporter: 'none',
    });
    manager.initialize();

    await manager.shutdown();
    expect(Tracer.isEnabled()).toBe(false);
  });

  it('should return config', () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 2,
      serviceName: 'test-service',
    });

    const config = manager.getConfig();
    expect(config.serviceName).toBe('test-service');
    expect(config.level).toBe(2);
  });

  it('should keep slow spans at level 1', () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 1,
      slowThresholdMs: -1, // -1ms threshold so any duration > -1 qualifies as slow
    });
    manager.initialize();

    const tracer = manager.getTracer(Subsystems.CLI);
    const span = tracer.startSpan('slow-op');
    span.end();

    expect(manager.getSpanBuffer().size).toBe(1);
    expect(manager.getSpanBuffer().getAll()[0].name).toBe('slow-op');
  });

  it('should emit EXPORT_FLUSHED on flush with data', async () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 2,
      exporter: 'none',
    });
    manager.initialize();

    const tracer = manager.getTracer(Subsystems.CLI);
    const span = tracer.startSpan('flush-test');
    span.end();

    await manager.flush();

    expect(eventBus.emit).toHaveBeenCalledWith(
      ObservabilityEvents.EXPORT_FLUSHED,
      expect.objectContaining({
        spanCount: expect.any(Number),
        metricCount: expect.any(Number),
      }),
    );
  });

  it('should short-circuit flush when buffer is empty', async () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 2,
      exporter: 'none',
    });
    manager.initialize();

    await manager.flush();

    // EXPORT_FLUSHED should NOT be emitted with empty buffer
    const flushCalls = (eventBus.emit as any).mock.calls.filter(
      (c: any[]) => c[0] === ObservabilityEvents.EXPORT_FLUSHED,
    );
    expect(flushCalls).toHaveLength(0);
  });

  it('level 1 keeps slow spans above threshold', () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 1,
      slowThresholdMs: 5,
    });
    manager.initialize();

    const tracer = manager.getTracer(Subsystems.CLI);
    const span = tracer.startSpan('slow-above-threshold-op');
    (span as any).startTime = Date.now() - 25;
    span.end();

    expect(manager.getSpanBuffer().size).toBe(1);
    expect(manager.getSpanBuffer().getAll()[0].name).toBe('slow-above-threshold-op');
  });

  it('flush() emits EXPORT_FLUSHED event', async () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 2,
      exporter: 'none',
    });
    manager.initialize();

    const tracer = manager.getTracer(Subsystems.CLI);
    const span = tracer.startSpan('flush-event-op');
    span.end();

    await manager.flush();

    expect(eventBus.emit).toHaveBeenCalledWith(
      ObservabilityEvents.EXPORT_FLUSHED,
      expect.objectContaining({
        spanCount: expect.any(Number),
        metricCount: expect.any(Number),
      }),
    );
  });

  it('flush() short-circuits when buffer is empty', async () => {
    const manager = new ObservabilityManager(eventBus, {
      enabled: true,
      level: 2,
      exporter: 'none',
    });
    manager.initialize();

    await manager.flush();

    const flushedCalls = (eventBus.emit as any).mock.calls.filter(
      (c: any[]) => c[0] === ObservabilityEvents.EXPORT_FLUSHED,
    );
    expect(flushedCalls).toHaveLength(0);
  });
});
