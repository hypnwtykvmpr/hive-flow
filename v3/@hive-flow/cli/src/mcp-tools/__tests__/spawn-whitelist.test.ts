import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_AGENT_TYPES } from '../../agents/roster.js';
import { agentCommand } from '../../commands/agent.js';
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
    };

    expect(status).toMatchObject({
      id: 'status-implementer',
      agentId: 'status-implementer',
      agentType: 'implementer',
      status: 'idle',
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

  it('agent_pool scale stamps every grown pool agent with a real parent owner', async () => {
    clearOwnerEnv();
    process.env.OPENCODE_THREAD_ID = 'pool-parent-session';
    process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

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
    expect(agents).toHaveLength(2);
    expect(agents.every(agent => agent.ownerSessionId === 'pool-parent-session')).toBe(true);
    expect(agents.every(agent => agent.ownerClientKind === 'opencode')).toBe(true);
    expect(agents.every(agent => agent.mode === 'full')).toBe(true);
  });
});
