import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performanceTools } from '../performance-tools.js';

type AnyResult = Record<string, any>;

function tool(name: string) {
  const candidate = performanceTools.find(t => t.name === name);
  if (!candidate) throw new Error(`missing performance tool ${name}`);
  return candidate;
}

describe('performance MCP simulated response truth labels', () => {
  it('does not mark reports fully real when latency and throughput are placeholders', async () => {
    const originalCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'hf-perf-report-'));
    process.chdir(dir);
    try {
      const result = await tool('performance_report').handler({ format: 'summary' }) as AnyResult;

      expect(result._real).toBe(false);
      expect(result.realFields).toContain('cpu');
      expect(result.syntheticFields).toEqual(['latency', 'throughput']);
      expect(result.warning).toMatch(/latency and throughput are synthetic/i);
      expect(result.throughputMeasured).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('labels synthetic bottleneck detection as unmeasured simulation', async () => {
    const result = await tool('performance_bottleneck').handler({}) as AnyResult;

    expect(result.simulated).toBe(true);
    expect(result.measured).toBe(false);
    expect(result.source).toBe('simulated-performance-placeholder');
    expect(result.warning).toMatch(/Synthetic performance response/i);
    expect(result.status).toMatch(/^\[SIMULATED\]/);
  });

  it('labels synthetic profiling as unmeasured simulation', async () => {
    const result = await tool('performance_profile').handler({ target: 'memory', duration: 1 }) as AnyResult;

    expect(result.simulated).toBe(true);
    expect(result.measured).toBe(false);
    expect(result.source).toBe('simulated-performance-placeholder');
    expect(result.warning).toMatch(/no external profiler/i);
  });

  it('does not claim simulated optimizations were applied', async () => {
    const result = await tool('performance_optimize').handler({ target: 'latency', aggressive: true }) as AnyResult;

    expect(result.simulated).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.status).toBe('[SIMULATED] planned-not-applied');
    expect(result.applied).toEqual([]);
    expect(result.plannedOptimizations.length).toBeGreaterThan(0);
    expect(result.estimatedImprovements).toBeDefined();
    expect(result.warning).toMatch(/No performance optimizations were applied/i);
  });

  it('marks mixed real/synthetic performance metrics at field level', async () => {
    const result = await tool('performance_metrics').handler({ metric: 'all' }) as AnyResult;

    expect(result._real).toBe(false);
    expect(result.realFields).toEqual(['metrics.cpu', 'metrics.memory']);
    expect(result.syntheticFields).toEqual(['metrics.latency', 'metrics.throughput']);
    expect(result.metrics.cpu._real).toBe(true);
    expect(result.metrics.memory._real).toBe(true);
    expect(result.metrics.latency._real).toBe(false);
    expect(result.metrics.latency.simulated).toBe(true);
    expect(result.metrics.throughput._real).toBe(false);
    expect(result.metrics.throughput.simulated).toBe(true);
  });

  it('labels single latency/throughput metric queries as simulated', async () => {
    const latency = await tool('performance_metrics').handler({ metric: 'latency' }) as AnyResult;
    const throughput = await tool('performance_metrics').handler({ metric: 'throughput' }) as AnyResult;

    expect(latency._real).toBe(false);
    expect(latency.simulated).toBe(true);
    expect(latency.source).toBe('synthetic-latency-placeholder');
    expect(throughput._real).toBe(false);
    expect(throughput.simulated).toBe(true);
    expect(throughput.source).toBe('synthetic-throughput-placeholder');
  });
});
