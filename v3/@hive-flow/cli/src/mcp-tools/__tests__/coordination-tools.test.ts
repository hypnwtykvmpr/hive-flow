import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coordinationTools } from '../coordination-tools.js';

const ORIGINAL_CWD = process.cwd();

function tool(name: string) {
  const found = coordinationTools.find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing coordination tool ${name}`);
  return found;
}

describe('coordination MCP tools', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hive-flow-coordination-tools-'));
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('records orchestration plans without pretending to dispatch provider tasks', async () => {
    await tool('coordination_node').handler({ action: 'add', nodeId: 'agent-a' });
    const result = await tool('coordination_orchestrate').handler({
      task: 'Audit wiring',
      agents: ['agent-a'],
      strategy: 'parallel',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      task: 'Audit wiring',
      agents: ['agent-a'],
      strategy: 'parallel',
      status: 'recorded',
      executed: false,
    });
    expect(String(result.message)).toMatch(/recorded in local state/i);
    expect(String(result.message)).toMatch(/no provider agent task dispatch/i);

    const storePath = join(tmpRoot, '.hive-flow', 'coordination', 'store.json');
    expect(existsSync(storePath)).toBe(true);
    const store = JSON.parse(readFileSync(storePath, 'utf-8')) as {
      orchestrations?: Record<string, { task?: string; status?: string }>;
    };
    expect(Object.values(store.orchestrations ?? {})).toEqual([
      expect.objectContaining({ task: 'Audit wiring', status: 'recorded' }),
    ]);
  });

  it('returns deterministic store-derived metrics instead of simulated random values', async () => {
    await tool('coordination_node').handler({ action: 'add', nodeId: 'agent-a' });
    await tool('coordination_node').handler({ action: 'add', nodeId: 'agent-b' });
    await tool('coordination_load_balance').handler({ action: 'distribute', task: 'first' });
    await tool('coordination_orchestrate').handler({ task: 'Plan docs', agents: ['agent-a'] });

    const result = await tool('coordination_metrics').handler({ metric: 'all' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      metrics: {
        latency: {
          available: false,
          unit: 'ms',
        },
        throughput: {
          available: false,
          unit: 'ops/s',
        },
        availability: {
          activeNodes: 2,
          totalNodes: 2,
          inactiveNodes: 0,
          availabilityRatio: 1,
          syncStatus: 'healthy',
        },
        load: {
          totalLoad: 1,
          maxLoad: 1,
          minLoad: 0,
        },
        orchestration: {
          recorded: 1,
        },
      },
    });
    expect(result).not.toHaveProperty('simulated');
    expect(JSON.stringify(result)).not.toMatch(/SIMULATED|Math\.random/i);
  });

  it('returns explicit unavailable latency metrics when no latency samples exist', async () => {
    const result = await tool('coordination_metrics').handler({ metric: 'latency' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      metric: 'latency',
      data: {
        available: false,
        unit: 'ms',
      },
    });
    expect(JSON.stringify(result)).toContain('No real latency samples');
    expect(result).not.toHaveProperty('simulated');
  });
});
