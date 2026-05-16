/**
 * Swarm intake scheduler — §9.2 of status_runbook_authoritative.md
 *
 * Pure-logic module: no imports, no I/O, synchronous only.
 * Capacity values are always supplied by the caller via `env`; nothing is hardcoded here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpawnResponse =
  | { accepted: true;  status: 'running';  agentId: string; position: 0 }
  | { accepted: true;  status: 'queued';   agentId: string; position: number; advisory: string }
  | { accepted: false; code: 'busy:queue-full'; workingCount: number; queuedCount: number; capacity: number; advisory: string; retryAfterMs?: number };

export interface SwarmState {
  working: Set<string>;      // agentIds currently running
  queue: string[];           // agentIds waiting, FIFO
  rejections: Array<{ at: string; reason: 'queue-full' }>;
}

// ---------------------------------------------------------------------------
// Intake function
// ---------------------------------------------------------------------------

/**
 * Request a spawn slot for `agentId`.
 *
 * Three outcomes (all synchronous — no Promise):
 *   1. W < maxAgents              → accepted-running  (added to working set)
 *   2. W === maxAgents, Q < queueDepth → accepted-queued (pushed to queue, FIFO)
 *   3. W === maxAgents, Q === queueDepth → rejected busy:queue-full
 *
 * The scheduler is a gate, never a killer — it never terminates working agents.
 * Capacity is sourced from `env`; callers supply DEFAULT_MAX_AGENTS / DEFAULT_QUEUE_DEPTH.
 */
export function requestSpawn(
  state: SwarmState,
  agentId: string,
  env: { maxAgents: number; queueDepth: number },
): SpawnResponse {
  const W = state.working.size;
  const Q = state.queue.length;

  if (W < env.maxAgents) {
    state.working.add(agentId);
    return { accepted: true, status: 'running', agentId, position: 0 };
  }

  if (Q < env.queueDepth) {
    state.queue.push(agentId);
    const position = state.queue.length;
    return {
      accepted: true,
      status: 'queued',
      agentId,
      position,
      advisory:
        `Working set at capacity (${env.maxAgents}). Your agent is #${position} in queue of ${env.queueDepth} and will start when a working slot frees. Set a poll/wait timer; new spawns may be rejected until queue depth drops.`,
    };
  }

  // W === maxAgents && Q === queueDepth → hard cap reached
  state.rejections.push({ at: new Date().toISOString(), reason: 'queue-full' });
  return {
    accepted: false,
    code: 'busy:queue-full',
    workingCount: W,
    queuedCount: Q,
    capacity: env.maxAgents + env.queueDepth,
    advisory:
      `Total system at hard cap (${env.maxAgents + env.queueDepth}). Set a timer and retry after at least one agent completes. Recommended initial backoff: 30s. No agent was spawned or queued.`,
    retryAfterMs: 30_000,
  };
}

// ---------------------------------------------------------------------------
// Completion handler
// ---------------------------------------------------------------------------

/**
 * Remove `agentId` from the working set.
 * Promotes the head of the queue (FIFO) into the working set if non-empty.
 * Returns `{ promoted }` where `promoted` is the newly working agentId, or `undefined`.
 */
export function onAgentComplete(state: SwarmState, agentId: string): { promoted?: string } {
  state.working.delete(agentId);
  const next = state.queue.shift();
  if (next !== undefined) {
    state.working.add(next);
  }
  return { promoted: next };
}
