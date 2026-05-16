import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_MAX_AGENTS, DEFAULT_QUEUE_DEPTH } from '@hive-flow/shared/core';

export interface SwarmSnapshot {
  working: number;
  queued: number;
  capacity: number;
  queueDepth: number;
  busy: boolean;
}

type AgentRecord = { status?: string };
type StoreJson = { agents?: Record<string, AgentRecord> };

const STORE_CANDIDATES = [
  join(process.cwd(), '.hive-flow', 'agents', 'store.json'),
  join(homedir(), '.hive-flow', 'agents', 'store.json'),
];

export async function collectSwarmSnapshot(): Promise<SwarmSnapshot> {
  const capacity = DEFAULT_MAX_AGENTS;
  const queueDepth = DEFAULT_QUEUE_DEPTH;
  const empty: SwarmSnapshot = { working: 0, queued: 0, capacity, queueDepth, busy: false };

  const storePath = STORE_CANDIDATES.find(p => existsSync(p));
  if (!storePath) {
    return empty;
  }

  let data: StoreJson;
  try {
    const raw = await readFile(storePath, 'utf8');
    data = JSON.parse(raw) as StoreJson;
  } catch {
    return empty;
  }

  const agents = Object.values(data?.agents ?? {}) as AgentRecord[];
  let working = 0;
  let queued = 0;
  for (const agent of agents) {
    if (agent.status === 'working' || agent.status === 'running') {
      working++;
    } else if (agent.status === 'queued') {
      queued++;
    }
  }

  // busy is LIVE-derived: true only when both slots are simultaneously full right now
  const busy = working === capacity && queued === queueDepth;

  return { working, queued, capacity, queueDepth, busy };
}
