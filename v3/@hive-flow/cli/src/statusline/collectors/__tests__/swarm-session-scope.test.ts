import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  ownerSessionId?: unknown;
  currentTaskPid?: number;
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
    vi.restoreAllMocks();
  });

  it('counts current-session and unowned live records when sessionId is present', async () => {
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
      nullOwnerBusy: {
        agentId: 'null-owner-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: null,
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot, sessionId: 'session-a' });

    expect(result.workersAlive).toBe(5);
    expect(result.workersExecuting).toBe(4);
    expect(result.agents.map((agent) => agent.id)).toEqual([
      'mine-busy',
      'mine-idle',
      'unowned-busy',
      'empty-owner-busy',
      'null-owner-busy',
    ]);
  });

  it('combines session scoping with dead-pid exclusion', async () => {
    const deadPid = 424242;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0 && pid === deadPid) {
        const err = new Error('dead process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      mineBusy: {
        agentId: 'mine-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
      },
      mineDead: {
        agentId: 'mine-dead',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: deadPid,
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
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot, sessionId: 'session-a' });

    expect(killSpy).toHaveBeenCalledWith(deadPid, 0);
    expect(result.workersAlive).toBe(2);
    expect(result.workersExecuting).toBe(2);
    expect(result.agents.map((agent) => agent.id)).toEqual(['mine-busy', 'unowned-busy']);
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
