import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_AGENT_TYPES } from '../../agents/roster.js';
import { agentCommand } from '../../commands/agent.js';
import { buildMCPToolContextForCall } from '../../mcp-server.js';
import { agentTools } from '../agent-tools.js';
import { operatorSessionEnvKeys } from '../session-id.js';

const spawnTool = agentTools.find(tool => tool.name === 'agent_spawn')!;
const poolTool = agentTools.find(tool => tool.name === 'agent_pool')!;
const listTool = agentTools.find(tool => tool.name === 'agent_list')!;
const statusTool = agentTools.find(tool => tool.name === 'agent_status')!;
const updateTool = agentTools.find(tool => tool.name === 'agent_update')!;
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

const PARENT_KINDS = ['claude', 'codex', 'gemini', 'cursor', 'antigravity', 'opencode', 'forgecode'] as const;
type ParentKind = typeof PARENT_KINDS[number];

function clearOwnerEnv(): void {
  for (const key of OWNER_ENV_KEYS) delete process.env[key];
}

function readSpawnedTypes(root: string): string[] {
  const storePath = join(root, '.hive-flow', 'agents', 'store.json');
  if (!existsSync(storePath)) return [];
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
    agents?: Record<string, { agentType?: string }>;
  };
  return Object.values(store.agents ?? {}).map(agent => String(agent.agentType));
}

function readAgentRecord(root: string, agentId: string): Record<string, unknown> | undefined {
  const storePath = join(root, '.hive-flow', 'agents', 'store.json');
  if (!existsSync(storePath)) return undefined;
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
    agents?: Record<string, Record<string, unknown>>;
  };
  return store.agents?.[agentId];
}

function readAgentRecords(root: string): Array<Record<string, unknown>> {
  const storePath = join(root, '.hive-flow', 'agents', 'store.json');
  if (!existsSync(storePath)) return [];
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
    agents?: Record<string, Record<string, unknown>>;
  };
  return Object.values(store.agents ?? {});
}

function writeRawAgentStore(root: string, agents: Record<string, Record<string, unknown>>): void {
  const storeDir = join(root, '.hive-flow', 'agents');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'store.json'), JSON.stringify({
    version: '3.0.0',
    agents,
  }, null, 2), 'utf8');
}

function writeTaskTracking(root: string, taskId: string, tracking: Record<string, unknown>): void {
  const tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({
    taskId,
    ...tracking,
  }, null, 2), 'utf8');
}

function writeTaskResult(root: string, taskId: string, result: Record<string, unknown>): void {
  const tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${taskId}.result.json`), JSON.stringify(result, null, 2), 'utf8');
}

function writeActiveHiveRuntimeWorker(root: string): void {
  const hiveDir = join(root, '.hive-flow', 'hives', 'hive-c4');
  const tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(hiveDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(hiveDir, 'hive.json'),
    JSON.stringify({
      hiveId: 'hive-c4',
      status: 'active',
      createdAt: '2026-06-30T00:00:00.000Z',
      ownerSessionId: 'spawn-test-session',
      queenId: 'queen-c4',
      workers: [
        {
          agentId: 'worker-c4',
          role: 'investigator',
          status: 'busy',
          spawnedAt: '2026-06-30T00:01:00.000Z',
          taskId: 'task-c4',
          provider: 'deepseek',
          resolvedModel: 'deepseek-v4-pro',
        },
      ],
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(tasksDir, 'task-c4.json'),
    JSON.stringify({
      taskId: 'task-c4',
      agentId: 'worker-c4',
      status: 'running',
      pid: process.pid,
      provider: 'deepseek',
      resolvedModel: 'deepseek-v4-pro',
    }, null, 2),
    'utf8',
  );
}

function cliSpawnChoices(): string[] {
  const spawn = agentCommand.subcommands?.find(command => command.name === 'spawn');
  const typeOption = spawn?.options?.find(option => option.name === 'type');
  return [...((typeOption?.choices ?? []) as string[])].sort();
}

describe('agent_spawn canonical roster whitelist', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hive-flow-spawn-whitelist-'));
    process.chdir(tmpRoot);
    clearOwnerEnv();
    process.env.CODEX_SESSION_ID = 'spawn-test-session';
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

  it('enumerates the canonical 18 in the MCP schema and CLI spawn choices', () => {
    const agentTypeSchema = spawnTool.inputSchema.properties.agentType as {
      enum?: string[];
      description?: string;
    };

    expect([...(agentTypeSchema.enum ?? [])].sort()).toEqual([...CANONICAL_AGENT_TYPES].sort());
    expect(agentTypeSchema.description).toContain('bug-hunter');
    expect(cliSpawnChoices()).toEqual([...CANONICAL_AGENT_TYPES].sort());
  });

  it('accepts every canonical agent type through agent_spawn', async () => {
    for (const agentType of CANONICAL_AGENT_TYPES) {
      const result = await spawnTool.handler({
        agentId: `test-${agentType}`,
        agentType,
        provider: 'anthropic',
      }) as Record<string, unknown>;

      expect(result).toMatchObject({
        success: true,
        agentType,
      });
    }

    expect(new Set(readSpawnedTypes(tmpRoot))).toEqual(new Set(CANONICAL_AGENT_TYPES));
  });

  it('makes bug-hunter spawnable', async () => {
    const result = await spawnTool.handler({
      agentId: 'bug-hunter-gap-regression',
      agentType: 'bug-hunter',
      provider: 'anthropic',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentType: 'bug-hunter',
    });
    expect(readSpawnedTypes(tmpRoot)).toContain('bug-hunter');
  });

  it('stamps ownerSessionId and ownerClientKind on agent_spawn from session env before MCP context fallback', async () => {
    process.env.CODEX_SESSION_ID = 'codex-session';
    process.env.CODEX_THREAD_ID = 'codex-thread';
    process.env.CLAUDE_SESSION_ID = 'claude-session';
    process.env.HIVE_FLOW_SESSION_ID = 'provider-session';

    const result = await spawnTool.handler({
      agentId: 'owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }, { sessionId: 'context-session' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentId: 'owned-agent',
    });
    expect(readAgentRecord(tmpRoot, 'owned-agent')?.ownerSessionId).toBe('codex-session');
    expect(readAgentRecord(tmpRoot, 'owned-agent')?.ownerClientKind).toBe('codex');
  });

  it('uses CODEX_THREAD_ID for agent_spawn ownership when CODEX_SESSION_ID is absent', async () => {
    delete process.env.CODEX_SESSION_ID;
    process.env.CODEX_THREAD_ID = 'codex-thread-session';
    process.env.CLAUDE_SESSION_ID = 'claude-session';
    process.env.HIVE_FLOW_SESSION_ID = 'provider-session';

    const result = await spawnTool.handler({
      agentId: 'codex-thread-owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }, { sessionId: 'context-session' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentId: 'codex-thread-owned-agent',
    });
    expect(readAgentRecord(tmpRoot, 'codex-thread-owned-agent')?.ownerSessionId).toBe('codex-thread-session');
    expect(readAgentRecord(tmpRoot, 'codex-thread-owned-agent')?.ownerClientKind).toBe('codex');
  });

  it('requires MCP context client kind with context owner session when no session env exists', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const result = await spawnTool.handler({
      agentId: 'context-owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }, { sessionId: 'context-session' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.code).toBe('missing-owner-client-kind');
    expect(readAgentRecord(tmpRoot, 'context-owned-agent')).toBeUndefined();
  });

  it('uses MCP context clientKind for agent_spawn owner lane when no client env exists', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const result = await spawnTool.handler({
      agentId: 'context-codex-owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }, { sessionId: 'context-session', clientKind: 'codex' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentId: 'context-codex-owned-agent',
    });
    expect(readAgentRecord(tmpRoot, 'context-codex-owned-agent')?.ownerSessionId).toBe('context-session');
    expect(readAgentRecord(tmpRoot, 'context-codex-owned-agent')?.ownerClientKind).toBe('codex');
  });

  it('stamps restored Claude MCP calls when transport classification is unknown after compaction', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const input = {
      agentId: 'restored-claude-owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
      session_id: 'restored-claude-session',
      ownerClientKind: 'codex',
    };
    const context = buildMCPToolContextForCall(
      'mcp-1790000000000-deadbeef',
      'unknown',
      input,
    );

    const result = await spawnTool.handler(input, context) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentId: 'restored-claude-owned-agent',
    });
    expect(readAgentRecord(tmpRoot, 'restored-claude-owned-agent')).toMatchObject({
      ownerSessionId: 'restored-claude-session',
      ownerClientKind: 'claude',
    });
  });

  it('still refuses unclassified MCP transport ids without an explicit operator session', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const context = buildMCPToolContextForCall(
      'mcp-1790000000000-deadbeef',
      'unknown',
      {},
    );
    const result = await spawnTool.handler({
      agentId: 'unknown-transport-only-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }, context) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.code).toBe('missing-owner-session');
    expect(readAgentRecord(tmpRoot, 'unknown-transport-only-agent')).toBeUndefined();
  });

  it('inherits persisted parent owner for direct child agent_spawn before stale ambient env', async () => {
    clearOwnerEnv();
    process.env.CODEX_SESSION_ID = 'stale-ambient-codex-session';
    writeRawAgentStore(tmpRoot, {
      parentAgent: {
        agentId: 'parentAgent',
        agentType: 'researcher',
        status: 'idle',
        health: 1,
        taskCount: 0,
        config: {},
        createdAt: new Date().toISOString(),
        ownerSessionId: 'opencode-parent-session',
        ownerClientKind: 'opencode',
      },
    });
    process.env.HIVE_FLOW_AGENT_ID = 'parentAgent';

    const result = await spawnTool.handler({
      agentId: 'child-owned-by-parent',
      agentType: 'tester',
      provider: 'anthropic',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentId: 'child-owned-by-parent',
    });
    expect(readAgentRecord(tmpRoot, 'child-owned-by-parent')).toMatchObject({
      ownerSessionId: 'opencode-parent-session',
      ownerClientKind: 'opencode',
    });
  });

  it('derives ownerClientKind from explicit owner session instead of ambient MCP server env', async () => {
    delete process.env.CODEX_SESSION_ID;
    process.env.CODEX_THREAD_ID = 'codex-thread-from-reconnect';
    process.env.CLAUDE_SESSION_ID = 'claude-pane-session';
    process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

    const result = await spawnTool.handler({
      agentId: 'claude-session-owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
      session_id: 'claude-pane-session',
    }, { sessionId: 'mcp-transport-session', clientKind: 'codex' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentId: 'claude-session-owned-agent',
    });
    expect(readAgentRecord(tmpRoot, 'claude-session-owned-agent')?.ownerSessionId).toBe('claude-pane-session');
    expect(readAgentRecord(tmpRoot, 'claude-session-owned-agent')?.ownerClientKind).toBe('claude');
  });

  it('uses Claude runtime parent assignment over stale Codex reconnect metadata', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.CODEX_THREAD_ID = 'codex-thread-from-reconnect';
    process.env.HIVE_FLOW_CLIENT_KIND = 'codex';
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_SESSION_ID = 'actual-claude-code-session';

    const result = await spawnTool.handler({
      agentId: 'claude-runtime-owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
      session_id: 'actual-claude-code-session',
      ownerClientKind: 'codex',
    }, { sessionId: 'mcp-transport-session', clientKind: 'codex' }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentId: 'claude-runtime-owned-agent',
    });
    expect(readAgentRecord(tmpRoot, 'claude-runtime-owned-agent')?.ownerSessionId).toBe('actual-claude-code-session');
    expect(readAgentRecord(tmpRoot, 'claude-runtime-owned-agent')?.ownerClientKind).toBe('claude');
  });

  it('refuses Claude runtime labels when the requested owner session does not match parent evidence', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.CODEX_THREAD_ID = 'codex-thread-from-reconnect';
    process.env.HIVE_FLOW_CLIENT_KIND = 'codex';
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_SESSION_ID = 'actual-claude-code-session';

    const result = await spawnTool.handler({
      agentId: 'claude-runtime-mismatch-agent',
      agentType: 'tester',
      provider: 'anthropic',
      session_id: 'attacker-picked-session',
      ownerClientKind: 'claude',
    }, { sessionId: 'mcp-transport-session', clientKind: 'codex' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.code).toBe('missing-owner-client-kind');
    expect(readAgentRecord(tmpRoot, 'claude-runtime-mismatch-agent')).toBeUndefined();
  });

  it('refuses agent_spawn when an owner session exists but no parent owner kind can be resolved', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const result = await spawnTool.handler({
      agentId: 'owner-kind-missing-agent',
      agentType: 'tester',
      provider: 'anthropic',
      session_id: 'operator-session-without-kind',
      ownerClientKind: 'codex',
      client_kind: 'codex',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.code).toBe('missing-owner-client-kind');
    expect(readAgentRecord(tmpRoot, 'owner-kind-missing-agent')).toBeUndefined();
  });

  it('refuses client kind labels that have no parent session evidence', async () => {
    delete process.env.CODEX_SESSION_ID;
    process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

    const result = await spawnTool.handler({
      agentId: 'label-only-owner-agent',
      agentType: 'tester',
      provider: 'anthropic',
      session_id: 'attacker-selected-session',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.code).toBe('missing-owner-client-kind');
    expect(readAgentRecord(tmpRoot, 'label-only-owner-agent')).toBeUndefined();
  });

  it('refuses generated MCP transport ids as agent_spawn owner identity', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const result = await spawnTool.handler({
      agentId: 'mcp-transport-owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }, { sessionId: 'mcp-1790000000000-deadbeef' }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('owner session');
    expect(readAgentRecord(tmpRoot, 'mcp-transport-owned-agent')).toBeUndefined();
  });

  it('refuses agent_spawn when no owner session can be resolved', async () => {
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;

    const result = await spawnTool.handler({
      agentId: 'ownerless-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('owner session');
    expect(readAgentRecord(tmpRoot, 'ownerless-agent')).toBeUndefined();
  });

  it('persists top-level read-only-with-artifacts mode and strips config authority forgeries', async () => {
    const artifactDir = join(tmpRoot, '.tmp-audit', 'artifacts');
    mkdirSync(artifactDir, { recursive: true });

    const result = await spawnTool.handler({
      agentId: 'artifact-mode-agent',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'read-only-with-artifacts',
      artifactDir,
      config: {
        mode: 'full',
        accessMode: 'full',
        agentMode: 'full',
        artifactDir: tmpRoot,
        artifact_dir: tmpRoot,
        writeAuthority: 'source',
        retained: 'ok',
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      agentId: 'artifact-mode-agent',
      mode: 'read-only-with-artifacts',
      artifactDir: realpathSync.native(artifactDir),
    });
    const record = readAgentRecord(tmpRoot, 'artifact-mode-agent');
    expect(record?.mode).toBe('read-only-with-artifacts');
    expect(record?.artifactDir).toBe(realpathSync.native(artifactDir));
    expect(record?.writeAuthority).toBeUndefined();
    expect((record?.config as Record<string, unknown>)?.retained).toBe('ok');
    for (const key of ['mode', 'accessMode', 'agentMode', 'artifactDir', 'artifact_dir', 'writeAuthority']) {
      expect((record?.config as Record<string, unknown>)?.[key]).toBeUndefined();
    }
  });

  it('persists default/full modes canonically for new agents', async () => {
    const defaultAlias = await spawnTool.handler({
      agentId: 'default-mode-agent',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'default',
    }) as Record<string, unknown>;
    const omitted = await spawnTool.handler({
      agentId: 'omitted-mode-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }) as Record<string, unknown>;

    expect(defaultAlias).toMatchObject({ success: true, mode: 'full' });
    expect(omitted).toMatchObject({ success: true, mode: 'full' });
    expect(readAgentRecord(tmpRoot, 'default-mode-agent')?.mode).toBe('full');
    expect(readAgentRecord(tmpRoot, 'omitted-mode-agent')?.mode).toBe('full');
  });

  it('rejects invalid modes and invalid artifact directories before persistence', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hive-flow-outside-artifacts-'));
    const protectedDir = join(tmpRoot, '.hive-flow', 'agents');
    mkdirSync(protectedDir, { recursive: true });
    try {
      const invalidMode = await spawnTool.handler({
        agentId: 'invalid-mode-agent',
        agentType: 'tester',
        provider: 'anthropic',
        mode: 'write-everywhere',
      }) as Record<string, unknown>;
      const missingArtifactDir = await spawnTool.handler({
        agentId: 'missing-artifact-dir-agent',
        agentType: 'tester',
        provider: 'anthropic',
        mode: 'read-only-with-artifacts',
      }) as Record<string, unknown>;
      const outsideArtifactDir = await spawnTool.handler({
        agentId: 'outside-artifact-dir-agent',
        agentType: 'tester',
        provider: 'anthropic',
        mode: 'read-only-with-artifacts',
        artifactDir: outside,
      }) as Record<string, unknown>;
      const protectedArtifactDir = await spawnTool.handler({
        agentId: 'protected-artifact-dir-agent',
        agentType: 'tester',
        provider: 'anthropic',
        mode: 'read-only-with-artifacts',
        artifactDir: protectedDir,
      }) as Record<string, unknown>;
      const artifactWithoutMode = await spawnTool.handler({
        agentId: 'artifact-without-mode-agent',
        agentType: 'tester',
        provider: 'anthropic',
        artifactDir: protectedDir,
      }) as Record<string, unknown>;

      expect(invalidMode).toMatchObject({ success: false, code: 'invalid-agent-mode' });
      expect(missingArtifactDir).toMatchObject({ success: false, code: 'invalid-artifact-dir' });
      expect(outsideArtifactDir).toMatchObject({ success: false, code: 'invalid-artifact-dir' });
      expect(protectedArtifactDir).toMatchObject({ success: false, code: 'invalid-artifact-dir' });
      expect(artifactWithoutMode).toMatchObject({ success: false, code: 'invalid-artifact-dir' });
      for (const id of [
        'invalid-mode-agent',
        'missing-artifact-dir-agent',
        'outside-artifact-dir-agent',
        'protected-artifact-dir-agent',
        'artifact-without-mode-agent',
      ]) {
        expect(readAgentRecord(tmpRoot, id)).toBeUndefined();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('strips authority-looking config keys on agent_update without changing top-level mode', async () => {
    await spawnTool.handler({
      agentId: 'update-strip-agent',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'read-only',
    });

    const result = await updateTool.handler({
      agentId: 'update-strip-agent',
      config: {
        mode: 'full',
        accessMode: 'full',
        agentMode: 'full',
        artifactDir: tmpRoot,
        artifact_dir: tmpRoot,
        writeAuthority: 'source',
        retainedAfterUpdate: 'yes',
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, agentId: 'update-strip-agent' });
    const record = readAgentRecord(tmpRoot, 'update-strip-agent');
    expect(record?.mode).toBe('read-only');
    expect(record?.writeAuthority).toBeUndefined();
    expect((record?.config as Record<string, unknown>)?.retainedAfterUpdate).toBe('yes');
    for (const key of ['mode', 'accessMode', 'agentMode', 'artifactDir', 'artifact_dir', 'writeAuthority']) {
      expect((record?.config as Record<string, unknown>)?.[key]).toBeUndefined();
    }
  });

  it('floors child mode to read-only when the persisted parent is read-only', async () => {
    const parent = await spawnTool.handler({
      agentId: 'readonly-parent',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'read-only',
    }) as Record<string, unknown>;
    expect(parent).toMatchObject({ success: true, mode: 'read-only' });
    process.env.HIVE_FLOW_AGENT_ID = 'readonly-parent';

    const child = await spawnTool.handler({
      agentId: 'readonly-parent-child',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'full',
    }) as Record<string, unknown>;

    expect(child).toMatchObject({ success: true, mode: 'read-only' });
    expect(readAgentRecord(tmpRoot, 'readonly-parent-child')?.mode).toBe('read-only');
  });

  it('floors child mode to parent artifact mode and inherits the persisted artifactDir', async () => {
    const artifactDir = join(tmpRoot, '.tmp-audit', 'parent-artifacts');
    mkdirSync(artifactDir, { recursive: true });
    const parent = await spawnTool.handler({
      agentId: 'artifact-parent',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'read-only-with-artifacts',
      artifactDir,
    }) as Record<string, unknown>;
    expect(parent).toMatchObject({ success: true, mode: 'read-only-with-artifacts' });
    process.env.HIVE_FLOW_AGENT_ID = 'artifact-parent';

    const child = await spawnTool.handler({
      agentId: 'artifact-parent-child',
      agentType: 'tester',
      provider: 'anthropic',
    }) as Record<string, unknown>;

    expect(child).toMatchObject({
      success: true,
      mode: 'read-only-with-artifacts',
      artifactDir: realpathSync.native(artifactDir),
    });
    expect(readAgentRecord(tmpRoot, 'artifact-parent-child')).toMatchObject({
      mode: 'read-only-with-artifacts',
      artifactDir: realpathSync.native(artifactDir),
    });
  });

  it('allows an artifact-mode parent to narrow a child artifactDir inside the parent artifactDir', async () => {
    const parentArtifactDir = join(tmpRoot, '.tmp-audit', 'parent-artifacts');
    const childArtifactDir = join(parentArtifactDir, 'child');
    mkdirSync(childArtifactDir, { recursive: true });
    const parent = await spawnTool.handler({
      agentId: 'artifact-parent-narrow',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'read-only-with-artifacts',
      artifactDir: parentArtifactDir,
    }) as Record<string, unknown>;
    expect(parent).toMatchObject({ success: true });
    process.env.HIVE_FLOW_AGENT_ID = 'artifact-parent-narrow';

    const child = await spawnTool.handler({
      agentId: 'artifact-child-narrow',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'read-only-with-artifacts',
      artifactDir: childArtifactDir,
    }) as Record<string, unknown>;

    expect(child).toMatchObject({
      success: true,
      mode: 'read-only-with-artifacts',
      artifactDir: realpathSync.native(childArtifactDir),
    });
  });

  it('rejects an artifact-mode parent trying to spawn a child with an artifactDir outside the parent artifactDir', async () => {
    const parentArtifactDir = join(tmpRoot, '.tmp-audit', 'parent-artifacts');
    const siblingArtifactDir = join(tmpRoot, '.tmp-audit', 'sibling-artifacts');
    mkdirSync(parentArtifactDir, { recursive: true });
    mkdirSync(siblingArtifactDir, { recursive: true });
    const parent = await spawnTool.handler({
      agentId: 'artifact-parent-outside',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'read-only-with-artifacts',
      artifactDir: parentArtifactDir,
    }) as Record<string, unknown>;
    expect(parent).toMatchObject({ success: true });
    process.env.HIVE_FLOW_AGENT_ID = 'artifact-parent-outside';

    const child = await spawnTool.handler({
      agentId: 'artifact-child-outside',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'read-only-with-artifacts',
      artifactDir: siblingArtifactDir,
    }) as Record<string, unknown>;

    expect(child).toMatchObject({
      success: false,
      code: 'invalid-artifact-dir',
    });
    expect(readAgentRecord(tmpRoot, 'artifact-child-outside')).toBeUndefined();
  });

  it('refuses child spawn when the persisted parent store is corrupt', async () => {
    writeRawAgentStore(tmpRoot, {
      corruptParent: {
        agentId: 'corruptParent',
        agentType: 'tester',
        status: 'idle',
        health: 1,
        taskCount: 0,
        config: {},
        createdAt: new Date().toISOString(),
        ownerSessionId: 'spawn-test-session',
        ownerClientKind: 'codex',
        mode: 'read-only',
      },
    });
    const storePath = join(tmpRoot, '.hive-flow', 'agents', 'store.json');
    writeFileSync(storePath, '{not-json', 'utf8');
    process.env.HIVE_FLOW_AGENT_ID = 'corruptParent';

    const child = await spawnTool.handler({
      agentId: 'corrupt-parent-child',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'full',
    }) as Record<string, unknown>;

    expect(child).toMatchObject({
      success: false,
      code: 'missing-owner-session',
    });
    expect(readFileSync(storePath, 'utf8')).toBe('{not-json');
  });

  it('refuses child spawn when a parent agent id is present but has no persisted record', async () => {
    writeRawAgentStore(tmpRoot, {});
    process.env.HIVE_FLOW_AGENT_ID = 'missingParent';

    const child = await spawnTool.handler({
      agentId: 'missing-parent-child',
      agentType: 'tester',
      provider: 'anthropic',
      mode: 'full',
    }) as Record<string, unknown>;

    expect(child).toMatchObject({
      success: false,
      code: 'missing-owner-session',
    });
    expect(readAgentRecord(tmpRoot, 'missing-parent-child')).toBeUndefined();
  });

  it('lists spawned idle agents when status is all and supports canonical type filters', async () => {
    await spawnTool.handler({
      agentId: 'list-implementer',
      agentType: 'implementer',
      provider: 'anthropic',
    });
    await spawnTool.handler({
      agentId: 'list-verifier',
      agentType: 'verifier',
      provider: 'anthropic',
    });

    const allResult = await listTool.handler({ status: 'all' }) as {
      total: number;
      agents: Array<{ id?: string; agentId?: string; agentType?: string; status?: string }>;
      filters?: Record<string, unknown>;
    };
    expect(allResult.total).toBe(2);
    expect(allResult.filters?.status).toBe('all');
    expect(allResult.filters?.includeTerminated).toBe(true);
    expect(allResult.agents.map(agent => agent.agentId).sort()).toEqual(['list-implementer', 'list-verifier']);
    expect(allResult.agents.every(agent => agent.id === agent.agentId)).toBe(true);

    const implementers = await listTool.handler({ status: 'all', agentType: 'implementer' }) as {
      total: number;
      agents: Array<{ agentId?: string; agentType?: string }>;
      filters?: Record<string, unknown>;
    };
    expect(implementers.total).toBe(1);
    expect(implementers.filters?.agentType).toBe('implementer');
    expect(implementers.agents[0]).toMatchObject({
      agentId: 'list-implementer',
      agentType: 'implementer',
    });
  });

  it('lists live hive-runtime workers when no agent-store row exists', async () => {
    writeRawAgentStore(tmpRoot, {});
    writeActiveHiveRuntimeWorker(tmpRoot);

    const result = await listTool.handler({ projectRoot: tmpRoot }) as {
      total: number;
      agents: Array<{
        agentId?: string;
        agentType?: string;
        status?: string;
        source?: string;
        hiveId?: string;
        role?: string;
        createdAt?: string;
        provider?: string;
        resolvedModel?: string;
      }>;
    };

    expect(result.total).toBe(2);
    expect(result.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'queen-c4',
        agentType: 'coordinator',
        role: 'queen',
        status: 'idle',
        source: 'hive-runtime',
        hiveId: 'hive-c4',
        createdAt: '2026-06-30T00:00:00.000Z',
      }),
      expect.objectContaining({
        agentId: 'worker-c4',
        agentType: 'investigator',
        role: 'worker',
        status: 'busy',
        source: 'hive-runtime',
        hiveId: 'hive-c4',
        createdAt: '2026-06-30T00:01:00.000Z',
        provider: 'deepseek',
        resolvedModel: 'deepseek-v4-pro',
      }),
    ]));

    const active = await listTool.handler({ projectRoot: tmpRoot, status: 'active' }) as {
      total: number;
      agents: Array<{ agentId?: string }>;
      filters?: Record<string, unknown>;
    };
    expect(active.total).toBe(2);
    expect(active.filters?.status).toBe('active');
    expect(active.agents.map(agent => agent.agentId).sort()).toEqual(['queen-c4', 'worker-c4']);

    const investigators = await listTool.handler({ projectRoot: tmpRoot, agentType: 'investigator' }) as {
      total: number;
      agents: Array<{ agentId?: string; agentType?: string; role?: string; createdAt?: string }>;
      filters?: Record<string, unknown>;
    };
    expect(investigators.total).toBe(1);
    expect(investigators.filters?.agentType).toBe('investigator');
    expect(investigators.agents[0]).toMatchObject({
      agentId: 'worker-c4',
      agentType: 'investigator',
      role: 'worker',
      createdAt: '2026-06-30T00:01:00.000Z',
    });

    const coordinators = await listTool.handler({ projectRoot: tmpRoot, agentType: 'coordinator' }) as {
      total: number;
      agents: Array<{ agentId?: string; agentType?: string; role?: string; createdAt?: string }>;
      filters?: Record<string, unknown>;
    };
    expect(coordinators.total).toBe(1);
    expect(coordinators.filters?.agentType).toBe('coordinator');
    expect(coordinators.agents[0]).toMatchObject({
      agentId: 'queen-c4',
      agentType: 'coordinator',
      role: 'queen',
      createdAt: '2026-06-30T00:00:00.000Z',
    });
  });

  it('returns both id and agentId from agent_status for CLI display compatibility', async () => {
    await spawnTool.handler({
      agentId: 'status-implementer',
      agentType: 'implementer',
      provider: 'anthropic',
    });

    const status = await statusTool.handler({ agentId: 'status-implementer' }) as {
      id?: string;
      agentId?: string;
      agentType?: string;
      status?: string;
      runtime?: Record<string, unknown>;
    };

    expect(status).toMatchObject({
      id: 'status-implementer',
      agentId: 'status-implementer',
      agentType: 'implementer',
      status: 'idle',
      runtime: {
        status: 'idle',
        source: 'none',
        resultAvailable: false,
      },
    });
  });

  it('surfaces running task runtime from tracking files in agent_status', async () => {
    writeRawAgentStore(tmpRoot, {
      'runtime-agent': {
        agentId: 'runtime-agent',
        agentType: 'tester',
        status: 'busy',
        health: 100,
        taskCount: 1,
        config: {},
        createdAt: '2026-06-30T00:00:00.000Z',
        provider: 'deepseek',
        currentTaskId: 'task-runtime',
        currentTaskPid: process.pid,
      },
    });
    writeTaskTracking(tmpRoot, 'task-runtime', {
      agentId: 'runtime-agent',
      status: 'running',
      startedAt: '2026-06-30T00:01:00.000Z',
      pid: process.pid,
      deadlineAt: '2026-06-30T00:10:00.000Z',
    });

    const status = await statusTool.handler({ agentId: 'runtime-agent', projectRoot: tmpRoot }) as {
      currentTaskId?: string;
      currentTaskPid?: number;
      runtime?: Record<string, unknown>;
    };

    expect(status.currentTaskId).toBe('task-runtime');
    expect(status.currentTaskPid).toBe(process.pid);
    expect(status.runtime).toMatchObject({
      taskId: 'task-runtime',
      status: 'running',
      source: 'task-tracking',
      currentTaskId: 'task-runtime',
      currentTaskPid: process.pid,
      trackingStatus: 'running',
      trackingPid: process.pid,
      pidAlive: true,
      resultAvailable: false,
      deadlineAt: '2026-06-30T00:10:00.000Z',
      startedAt: '2026-06-30T00:01:00.000Z',
    });
  });

  it('prefers terminal result files over stale busy agent_status store state', async () => {
    writeRawAgentStore(tmpRoot, {
      'finished-agent': {
        agentId: 'finished-agent',
        agentType: 'tester',
        status: 'busy',
        health: 100,
        taskCount: 1,
        config: {},
        createdAt: '2026-06-30T00:00:00.000Z',
        provider: 'deepseek',
        currentTaskId: 'task-finished',
        currentTaskPid: process.pid,
      },
    });
    writeTaskTracking(tmpRoot, 'task-finished', {
      agentId: 'finished-agent',
      status: 'running',
      startedAt: '2026-06-30T00:02:00.000Z',
      pid: process.pid,
    });
    writeTaskResult(tmpRoot, 'task-finished', {
      success: true,
      result: 'done',
    });

    const status = await statusTool.handler({ agentId: 'finished-agent', projectRoot: tmpRoot }) as {
      status?: string;
      runtime?: Record<string, unknown>;
    };

    expect(status.status).toBe('busy');
    expect(status.runtime).toMatchObject({
      taskId: 'task-finished',
      status: 'completed',
      source: 'task-result',
      currentTaskId: 'task-finished',
      resultAvailable: true,
      resultSuccess: true,
    });
  });

  it('falls back to the newest task tracking file when agent_status store has no current task id', async () => {
    writeRawAgentStore(tmpRoot, {
      'tracking-only-agent': {
        agentId: 'tracking-only-agent',
        agentType: 'tester',
        status: 'idle',
        health: 100,
        taskCount: 1,
        config: {},
        createdAt: '2026-06-30T00:00:00.000Z',
        provider: 'deepseek',
      },
    });
    writeTaskTracking(tmpRoot, 'task-old', {
      agentId: 'tracking-only-agent',
      status: 'completed',
      startedAt: '2026-06-30T00:01:00.000Z',
    });
    writeTaskTracking(tmpRoot, 'task-new', {
      agentId: 'tracking-only-agent',
      status: 'failed',
      startedAt: '2026-06-30T00:03:00.000Z',
    });

    const status = await statusTool.handler({ agentId: 'tracking-only-agent', projectRoot: tmpRoot }) as {
      runtime?: Record<string, unknown>;
    };

    expect(status.runtime).toMatchObject({
      taskId: 'task-new',
      status: 'failed',
      source: 'task-tracking',
      trackingStatus: 'failed',
      resultAvailable: false,
      startedAt: '2026-06-30T00:03:00.000Z',
    });
  });

  it.each(['totally-made-up', 'coder'])('rejects non-canonical agent type %s', async (agentType) => {
    const result = await spawnTool.handler({
      agentId: `bad-${agentType}`,
      agentType,
      provider: 'anthropic',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: false,
      code: 'invalid-agent-type',
      retryable: false,
      nextActions: expect.arrayContaining([expect.stringMatching(/canonical agent types/i)]),
    });
    expect(String(result.error)).toContain('Valid agent types:');
    expect(String(result.error)).toContain('bug-hunter');
    expect(readSpawnedTypes(tmpRoot)).not.toContain(agentType);
  });

  it('rejects arbitrary non-canonical agent types without persisting them', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter(value => !CANONICAL_AGENT_TYPES.includes(value.trim() as typeof CANONICAL_AGENT_TYPES[number])),
        async (agentType) => {
          const result = await spawnTool.handler({
            agentId: `bad-${Buffer.from(agentType).toString('hex').slice(0, 24) || 'empty'}`,
            agentType,
            provider: 'anthropic',
          }) as Record<string, unknown>;

          expect(result).toMatchObject({
            success: false,
            code: 'invalid-agent-type',
            nextActions: expect.arrayContaining([expect.stringMatching(/agent_spawn/i)]),
          });
          expect(readSpawnedTypes(tmpRoot)).not.toContain(agentType);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('property: agent_spawn never persists without a complete parent owner stamp', async () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
    const token = fc.array(fc.constantFrom(...chars), { minLength: 3, maxLength: 18 }).map(parts => parts.join(''));
    const scenario = fc.constantFrom(
      'context-complete',
      'env-complete',
      'hive-env-complete',
      'input-session-only',
      'context-kind-only',
      'label-only-with-input-session',
      'forged-input-kind-only',
      'generated-transport-id',
    );
    const ownerKindWithEnvKey = fc.constantFrom(...PARENT_KINDS)
      .chain(kind => fc.tuple(fc.constant(kind), fc.constantFrom(...operatorSessionEnvKeys(kind))));

    await fc.assert(
      fc.asyncProperty(
        scenario,
        ownerKindWithEnvKey,
        token,
        token,
        fc.boolean(),
        async (mode, [kind, envKey], suffix, ownerSessionSuffix, mismatchLabel) => {
          clearOwnerEnv();
          const agentId = `prop-owner-${mode}-${kind}-${suffix}`;
          const ownerSessionId = `parent-${kind}-${ownerSessionSuffix}`;
          const mismatchedKind = PARENT_KINDS.find(candidate => candidate !== kind) ?? 'codex';
          const input: Record<string, unknown> = {
            agentId,
            agentType: 'tester',
            provider: 'anthropic',
            ownerClientKind: 'codex',
            client_kind: 'codex',
          };
          const context: Record<string, unknown> = {};

          let shouldPersist = false;
          let expectedOwnerSessionId = ownerSessionId;
          let expectedOwnerClientKind: ParentKind = kind;

          switch (mode) {
            case 'context-complete':
              context.sessionId = ownerSessionId;
              context.clientKind = kind;
              shouldPersist = true;
              break;
            case 'env-complete':
              process.env[envKey] = ownerSessionId;
              process.env.HIVE_FLOW_CLIENT_KIND = mismatchLabel ? mismatchedKind : kind;
              shouldPersist = true;
              break;
            case 'hive-env-complete':
              process.env.HIVE_FLOW_SESSION_ID = ownerSessionId;
              process.env.HIVE_FLOW_CLIENT_KIND = kind;
              shouldPersist = true;
              break;
            case 'input-session-only':
              input.session_id = ownerSessionId;
              break;
            case 'context-kind-only':
              context.clientKind = kind;
              break;
            case 'label-only-with-input-session':
              input.session_id = ownerSessionId;
              process.env.HIVE_FLOW_CLIENT_KIND = kind;
              break;
            case 'forged-input-kind-only':
              input.session_id = ownerSessionId;
              input.ownerClientKind = kind;
              input.client_kind = kind;
              break;
            case 'generated-transport-id':
              context.sessionId = `mcp-1790000000000-${suffix}`;
              context.clientKind = kind;
              expectedOwnerSessionId = '';
              break;
          }

          const result = await spawnTool.handler(input, context) as Record<string, unknown>;
          const record = readAgentRecord(tmpRoot, agentId);

          if (shouldPersist) {
            expect(result.success).toBe(true);
            expect(record?.ownerSessionId).toBe(expectedOwnerSessionId);
            expect(record?.ownerClientKind).toBe(expectedOwnerClientKind);
          } else {
            expect(result.success).toBe(false);
            expect(record).toBeUndefined();
          }
        },
      ),
      { seed: 20_625, numRuns: 96 },
    );
  });

  it('agent_pool scale refuses ownerless pool growth before persisting records', async () => {
    clearOwnerEnv();

    const result = await poolTool.handler({
      action: 'scale',
      targetSize: 2,
      agentType: 'tester',
      session_id: 'attacker-picked-session',
      ownerClientKind: 'codex',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      action: 'scale',
      success: false,
      code: 'missing-owner-client-kind',
    });
    expect(readAgentRecords(tmpRoot)).toHaveLength(0);
  });

  it('agent_pool scale stamps every grown pool agent with a real parent owner and inherited floor mode', async () => {
    clearOwnerEnv();
    process.env.CODEX_SESSION_ID = 'stale-ambient-codex-session';
    writeRawAgentStore(tmpRoot, {
      poolParent: {
        agentId: 'poolParent',
        agentType: 'researcher',
        status: 'idle',
        health: 1,
        taskCount: 0,
        config: {},
        createdAt: new Date().toISOString(),
        ownerSessionId: 'pool-parent-session',
        ownerClientKind: 'opencode',
        mode: 'read-only',
      },
    });
    process.env.HIVE_FLOW_AGENT_ID = 'poolParent';

    const result = await poolTool.handler({
      action: 'scale',
      targetSize: 2,
      agentType: 'tester',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      action: 'scale',
      targetSize: 2,
      added: expect.any(Array),
    });
    const agents = readAgentRecords(tmpRoot);
    const poolAgents = agents.filter(agent => agent.agentId !== 'poolParent');
    expect(poolAgents).toHaveLength(2);
    expect(poolAgents.every(agent => agent.ownerSessionId === 'pool-parent-session')).toBe(true);
    expect(poolAgents.every(agent => agent.ownerClientKind === 'opencode')).toBe(true);
    expect(poolAgents.every(agent => agent.mode === 'read-only')).toBe(true);
  });
});
