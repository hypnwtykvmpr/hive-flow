import { describe, expect, it } from 'vitest';
import { requestSpawn, onAgentComplete, type SwarmState } from '../intake.js';

describe('swarm intake', () => {
  it('swarm intake: 0-49 working → accepted-running', () => {
    const state: SwarmState = { working: new Set<string>(), queue: [] as string[], rejections: [] };
    for (let i = 1; i <= 49; i++) state.working.add(`a${i}`);
    const r = requestSpawn(state, 'a50', { maxAgents: 50, queueDepth: 10 });
    expect(r.accepted).toBe(true);
    expect((r as any).status).toBe('running');
    expect((r as any).agentId).toBe('a50');
    expect((r as any).position).toBe(0);
    expect(state.working.size).toBe(50);
  });

  it('swarm intake: 50 working + queue < 10 → accepted-queued', () => {
    const state: SwarmState = { working: new Set<string>(), queue: [] as string[], rejections: [] };
    for (let i = 1; i <= 50; i++) state.working.add(`w${i}`);
    const r = requestSpawn(state, 'q1', { maxAgents: 50, queueDepth: 10 });
    expect(r.accepted).toBe(true);
    expect((r as any).status).toBe('queued');
    expect((r as any).agentId).toBe('q1');
    expect((r as any).position).toBe(1);
    expect((r as any).advisory).toMatch(/Set a poll\/wait timer/);
    expect(state.queue.length).toBe(1);
  });

  it('swarm intake: 50 working + 10 queued → rejected (code: busy:queue-full)', () => {
    const state: SwarmState = {
      working: new Set<string>(),
      queue: Array.from({ length: 10 }, (_, i) => `q${i}`),
      rejections: [],
    };
    for (let i = 1; i <= 50; i++) state.working.add(`w${i}`);
    const r = requestSpawn(state, 'overflow', { maxAgents: 50, queueDepth: 10 });
    expect(r.accepted).toBe(false);
    expect((r as any).code).toBe('busy:queue-full');
    expect((r as any).workingCount).toBe(50);
    expect((r as any).queuedCount).toBe(10);
    expect((r as any).capacity).toBe(60);
    expect((r as any).advisory).toMatch(/Set a timer and retry/);
    expect(state.queue.length).toBe(10);
    expect(state.working.size).toBe(50);
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
