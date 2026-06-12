import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectSwarm } from '../swarm.js';

interface Fixture {
  projectRoot: string;
  storePath: string;
}

interface AgentLike {
  agentId: string;
  agentType: string;
  status: string;
  ownerSessionId?: string;
}

function setupFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-swarm-session-'));
  mkdirSync(join(projectRoot, '.hive-flow', 'agents'), { recursive: true });
  mkdirSync(join(projectRoot, '.hive-flow', 'data'), { recursive: true });
  return {
    projectRoot,
    storePath: join(projectRoot, '.hive-flow', 'agents', 'store.json'),
  };
}

function writeStoreDict(storePath: string, agents: Record<string, AgentLike>): void {
  writeFileSync(storePath, JSON.stringify({ version: '1.0', agents }), { mode: 0o600 });
}

describe('collectSwarm session scoping', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = setupFixture();
  });

  afterEach(() => {
    rmSync(fix.projectRoot, { recursive: true, force: true });
  });

  it('strictly counts only records owned by the current session when sessionId is present', async () => {
    writeStoreDict(fix.storePath, {
      mineBusy: {
        agentId: 'mine-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
      },
      mineIdle: {
        agentId: 'mine-idle',
        agentType: 'tester',
        status: 'idle',
        ownerSessionId: 'session-a',
      },
      otherBusy: {
        agentId: 'other-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-b',
      },
      unownedBusy: {
        agentId: 'unowned-busy',
        agentType: 'coder',
        status: 'busy',
      },
      emptyOwnerBusy: {
        agentId: 'empty-owner-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: '',
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot, sessionId: 'session-a' });

    expect(result.workersAlive).toBe(2);
    expect(result.workersExecuting).toBe(1);
    expect(result.agents.map((agent) => agent.id)).toEqual(['mine-busy', 'mine-idle']);
  });

  it('keeps count-all behavior when no sessionId is available', async () => {
    writeStoreDict(fix.storePath, {
      owned: {
        agentId: 'owned',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
      },
      other: {
        agentId: 'other',
        agentType: 'coder',
        status: 'idle',
        ownerSessionId: 'session-b',
      },
      unowned: {
        agentId: 'unowned',
        agentType: 'coder',
        status: 'idle',
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.workersAlive).toBe(3);
    expect(result.workersExecuting).toBe(1);
    expect(result.agents.map((agent) => agent.id)).toEqual(['owned', 'other', 'unowned']);
  });
});
