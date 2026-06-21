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

  it('counts only current-session records with live process evidence when sessionId is present', async () => {
    // A positive currentTaskPid is required for a busy agent to count as
    // executing (phantom-activity fix). Use process.pid (always alive) for the
    // four busy fixtures that should register as executing.
    const livePid = process.pid;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (signal === 0 && pid === livePid) return true;
      return true;
    }) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      mineBusy: {
        agentId: 'mine-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: livePid,
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
        currentTaskPid: livePid,
      },
      unownedBusy: {
        agentId: 'unowned-busy',
        agentType: 'coder',
        status: 'busy',
        currentTaskPid: livePid,
      },
      emptyOwnerBusy: {
        agentId: 'empty-owner-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: '',
        currentTaskPid: livePid,
      },
      nullOwnerBusy: {
        agentId: 'null-owner-busy',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: null,
        currentTaskPid: livePid,
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot, sessionId: 'session-a' });

    expect(killSpy).toHaveBeenCalled();
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
    expect(result.agents.map((agent) => agent.id)).toEqual(['mine-busy']);
  });

  it('combines session scoping with dead-pid exclusion', async () => {
    const deadPid = 424242;
    const livePid = process.pid;
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
        currentTaskPid: livePid,
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
        currentTaskPid: livePid,
      },
      unownedBusy: {
        agentId: 'unowned-busy',
        agentType: 'coder',
        status: 'busy',
        currentTaskPid: livePid,
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot, sessionId: 'session-a' });

    expect(killSpy).toHaveBeenCalledWith(deadPid, 0);
    expect(result.workersAlive).toBe(1);
    expect(result.workersExecuting).toBe(1);
    expect(result.agents.map((agent) => agent.id)).toEqual(['mine-busy']);
  });

  it('keeps all owned live records when no sessionId is available', async () => {
    const livePid = process.pid;
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeStoreDict(fix.storePath, {
      owned: {
        agentId: 'owned',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: livePid,
      },
      other: {
        agentId: 'other',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-b',
        currentTaskPid: livePid,
      },
      unowned: {
        agentId: 'unowned',
        agentType: 'coder',
        status: 'busy',
        currentTaskPid: livePid,
      },
    });

    const result = await collectSwarm({ projectRoot: fix.projectRoot });

    expect(result.workersAlive).toBe(2);
    expect(result.workersExecuting).toBe(2);
    expect(result.agents.map((agent) => agent.id)).toEqual(['owned', 'other']);
  });
});
