import { describe, expect, it } from 'vitest';
import { requestSpawn, onAgentComplete, type SwarmState } from '../intake.js';

describe('swarm intake', () => {
  it('swarm intake: 0-149 working -> accepted-running', () => {
    const state: SwarmState = { working: new Set<string>(), queue: [] as string[], rejections: [] };
    for (let i = 1; i <= 149; i++) state.working.add(`a${i}`);
    const r = requestSpawn(state, 'a150', { maxAgents: 150, queueDepth: 30 });
    expect(r.accepted).toBe(true);
    expect((r as any).status).toBe('running');
    expect((r as any).agentId).toBe('a150');
    expect((r as any).position).toBe(0);
    expect(state.working.size).toBe(150);
  });

  it('swarm intake: 150 working + queue < 30 -> accepted-queued', () => {
    const state: SwarmState = { working: new Set<string>(), queue: [] as string[], rejections: [] };
    for (let i = 1; i <= 150; i++) state.working.add(`w${i}`);
    const r = requestSpawn(state, 'q1', { maxAgents: 150, queueDepth: 30 });
    expect(r.accepted).toBe(true);
    expect((r as any).status).toBe('queued');
    expect((r as any).agentId).toBe('q1');
    expect((r as any).position).toBe(1);
    expect((r as any).advisory).toMatch(/Set a poll\/wait timer/);
    expect(state.queue.length).toBe(1);
  });

  it('swarm intake: 150 working + 30 queued -> rejected (code: busy:queue-full)', () => {
    const state: SwarmState = {
      working: new Set<string>(),
      queue: Array.from({ length: 30 }, (_, i) => `q${i}`),
      rejections: [],
    };
    for (let i = 1; i <= 150; i++) state.working.add(`w${i}`);
    const r = requestSpawn(state, 'overflow', { maxAgents: 150, queueDepth: 30 });
    expect(r.accepted).toBe(false);
    expect((r as any).code).toBe('busy:queue-full');
    expect((r as any).workingCount).toBe(150);
    expect((r as any).queuedCount).toBe(30);
    expect((r as any).capacity).toBe(180);
    expect((r as any).advisory).toMatch(/Set a timer and retry/);
    expect(state.queue.length).toBe(30);
    expect(state.working.size).toBe(150);
    expect(state.rejections.length).toBe(1);
  });

  it('swarm: completing a working agent promotes head of FIFO queue', () => {
    const state: SwarmState = {
      working: new Set<string>(['w1', 'w2']),
      queue: ['q1', 'q2', 'q3'],
      rejections: [],
    };
    const r = onAgentComplete(state, 'w1');
    expect(r.promoted).toBe('q1');
    expect(state.working.has('q1')).toBe(true);
    expect(state.queue).toEqual(['q2', 'q3']);
  });
});
