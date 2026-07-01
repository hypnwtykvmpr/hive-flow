import { afterEach, describe, expect, it } from 'vitest';
import { UnifiedSwarmCoordinator } from '@hive-flow/cli/swarm';

const coordinators: UnifiedSwarmCoordinator[] = [];

describe('CA-1 swarm seam', () => {
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.shutdown()));
  });

  it('initializes, spawns, lists, terminates, and shuts down through UnifiedSwarmCoordinator', async () => {
    const coordinator = new UnifiedSwarmCoordinator({
      topology: { type: 'mesh', maxAgents: 4 },
      consensus: { algorithm: 'gossip', threshold: 0.5, timeoutMs: 200, maxRounds: 1, requireQuorum: false },
      maxAgents: 4,
      heartbeatIntervalMs: 60_000,
      healthCheckIntervalMs: 60_000,
      autoScaling: false,
      autoRecovery: false,
    });
    coordinators.push(coordinator);

    await coordinator.initialize();
    expect(coordinator.getTopology()).toBe('mesh');

    const spawned = await coordinator.spawnAgent({
      type: 'coder',
      name: 'ca1-e2e-coder',
      capabilities: ['code-generation', 'testing'],
      domain: 'core',
    });
    expect(spawned.spawned).toBe(true);

    const listed = coordinator.listAgents({ type: 'coder' });
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: spawned.agentId,
          name: 'ca1-e2e-coder',
          status: 'idle',
        }),
      ])
    );

    const terminated = await coordinator.terminateAgent(spawned.agentId, {
      force: true,
      reason: 'ca1-e2e-complete',
    });
    expect(terminated.terminated).toBe(true);
    expect(coordinator.listAgents({ type: 'coder' })).toHaveLength(0);
  });
});
