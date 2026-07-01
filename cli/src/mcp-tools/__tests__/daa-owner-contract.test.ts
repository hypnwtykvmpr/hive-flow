import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daaTools } from '../daa-tools.js';
import { operatorSessionEnvKeys } from '../session-id.js';

const createTool = daaTools.find(tool => tool.name === 'daa_agent_create')!;
const ORIGINAL_CWD = process.cwd();
const OWNER_ENV_KEYS = Array.from(new Set([
  ...operatorSessionEnvKeys(),
  'HIVE_FLOW_CLIENT_KIND',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_PROJECT_DIR',
  'HIVE_FLOW_AGENT_ID',
  'CLAUDE_AGENT_ID',
]));
const ORIGINAL_ENV = Object.fromEntries(
  OWNER_ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<string, string | undefined>;

function clearOwnerEnv(): void {
  for (const key of OWNER_ENV_KEYS) delete process.env[key];
}

function readDAAAgents(root: string): Record<string, Record<string, unknown>> {
  const storePath = join(root, '.hive-flow', 'daa', 'store.json');
  if (!existsSync(storePath)) return {};
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
    agents?: Record<string, Record<string, unknown>>;
  };
  return store.agents ?? {};
}

function writeRawAgentStore(root: string, agents: Record<string, Record<string, unknown>>): void {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents,
  }, null, 2), 'utf8');
}

describe('daa_agent_create owner contract', () => {
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hive-flow-daa-owner-'));
    process.chdir(tmpRoot);
    clearOwnerEnv();
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('refuses ownerless DAA agent creation before writing the DAA store', async () => {
    const result = await createTool.handler({
      id: 'daa-forged-owner',
      session_id: 'attacker-picked-session',
      ownerClientKind: 'codex',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: false,
      code: 'missing-owner-client-kind',
    });
    expect(readDAAAgents(tmpRoot)).toEqual({});
  });

  it('stamps DAA agents from the real assigning parent context', async () => {
    const result = await createTool.handler({
      id: 'daa-owned-agent',
      name: 'Owned DAA',
    }, {
      sessionId: 'opencode-context-session',
      clientKind: 'opencode',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agent: {
        id: 'daa-owned-agent',
        ownerSessionId: 'opencode-context-session',
        ownerClientKind: 'opencode',
        mode: 'full',
      },
    });
    expect(readDAAAgents(tmpRoot)['daa-owned-agent']).toMatchObject({
      ownerSessionId: 'opencode-context-session',
      ownerClientKind: 'opencode',
      mode: 'full',
    });
  });

  it('persists parent owner and mode as inert DAA metadata before stale ambient env', async () => {
    process.env.CODEX_SESSION_ID = 'stale-ambient-codex-session';
    writeRawAgentStore(tmpRoot, {
      daaParent: {
        agentId: 'daaParent',
        agentType: 'researcher',
        status: 'idle',
        health: 1,
        taskCount: 0,
        config: {},
        createdAt: new Date().toISOString(),
        ownerSessionId: 'opencode-daa-parent-session',
        ownerClientKind: 'opencode',
        mode: 'read-only',
      },
    });
    process.env.HIVE_FLOW_AGENT_ID = 'daaParent';

    const result = await createTool.handler({
      id: 'daa-readonly-child',
      name: 'DAA child',
    }, {
      sessionId: 'stale-ambient-codex-session',
      clientKind: 'codex',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agent: {
        id: 'daa-readonly-child',
        ownerSessionId: 'opencode-daa-parent-session',
        ownerClientKind: 'opencode',
        mode: 'read-only',
      },
    });
    expect(readDAAAgents(tmpRoot)['daa-readonly-child']).toMatchObject({
      ownerSessionId: 'opencode-daa-parent-session',
      ownerClientKind: 'opencode',
      mode: 'read-only',
    });
  });
});
