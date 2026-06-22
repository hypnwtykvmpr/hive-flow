/**
 * Regression tests for secure high-frequency ID generation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookRegistry } from '../registry/index.js';
import { ReasoningBank, type GuidancePattern } from '../reasoningbank/index.js';
import { SwarmCommunication } from '../swarm/index.js';
import { HookEvent, HookPriority } from '../types.js';

function forceLegacyIdCollision(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
}

function makePattern(strategy: string): GuidancePattern {
  return {
    id: `external-${strategy}`,
    strategy,
    domain: 'testing',
    embedding: new Float32Array(384).fill(0.1),
    quality: 0.9,
    usageCount: 1,
    successCount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
  };
}

describe('secure ID generation regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps hook registry registrations unique in a tight loop', () => {
    forceLegacyIdCollision();
    const registry = new HookRegistry();
    const ids = new Set<string>();

    for (let i = 0; i < 250; i++) {
      ids.add(
        registry.register(
          HookEvent.PreEdit,
          () => ({ success: true }),
          HookPriority.Normal,
          { name: `hook-${i}` }
        )
      );
    }

    expect(ids.size).toBe(250);
    expect(registry.size).toBe(250);
    expect(registry.getForEvent(HookEvent.PreEdit)).toHaveLength(250);
  });

  it('creates a fresh default swarm agent ID for each communication instance', async () => {
    const first = new SwarmCommunication({ autoBroadcastPatterns: false });
    const second = new SwarmCommunication({ autoBroadcastPatterns: false });

    await first.initialize();
    await second.initialize();

    expect(first.getStats().agentId).not.toBe(second.getStats().agentId);

    await first.shutdown();
    await second.shutdown();
  });

  it('keeps swarm message and coordination IDs unique under high-frequency calls', async () => {
    forceLegacyIdCollision();
    const swarm = new SwarmCommunication({
      agentId: 'agent-under-test',
      agentName: 'tester',
      autoBroadcastPatterns: false,
      consensusTimeout: 100000,
    });
    await swarm.initialize();

    const messageIds = new Set<string>();
    const broadcastIds = new Set<string>();
    const consensusIds = new Set<string>();
    const handoffIds = new Set<string>();

    for (let i = 0; i < 50; i++) {
      messageIds.add((await swarm.sendMessage('agent-under-test', `message-${i}`)).id);
      broadcastIds.add((await swarm.broadcastPattern(makePattern(`pattern-${i}`))).id);
      consensusIds.add((await swarm.initiateConsensus(`question-${i}`, ['yes', 'no'], 100000)).id);
      handoffIds.add(
        (await swarm.initiateHandoff('agent-under-test', `handoff-${i}`, {
          filesModified: [],
          patternsUsed: [],
          decisions: [],
          blockers: [],
          nextSteps: [],
        })).id
      );
    }

    expect(messageIds.size).toBe(50);
    expect(broadcastIds.size).toBe(50);
    expect(consensusIds.size).toBe(50);
    expect(handoffIds.size).toBe(50);
    expect(swarm.getMessages({ limit: 1000 }).map((message) => message.id)).toHaveLength(200);
    expect(swarm.getPatternBroadcasts()).toHaveLength(50);
    expect(swarm.getPendingConsensus()).toHaveLength(50);
    expect(swarm.getPendingHandoffs()).toHaveLength(50);

    await swarm.shutdown();
  });

  it('stores reasoning patterns with unique IDs in a tight loop', async () => {
    forceLegacyIdCollision();
    const reasoningBank = new ReasoningBank({
      useMockEmbeddings: true,
      dimensions: 384,
      dedupThreshold: 1,
    });
    await reasoningBank.initialize();

    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const result = await reasoningBank.storePattern(
        `Unique regression strategy ${i}`,
        'testing'
      );
      expect(result.action).toBe('created');
      ids.add(result.id);
    }

    expect(ids.size).toBe(50);
    expect(reasoningBank.getStats().shortTermCount).toBe(50);
  });
});
