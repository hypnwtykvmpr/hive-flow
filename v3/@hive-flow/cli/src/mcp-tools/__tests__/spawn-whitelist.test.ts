import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANONICAL_AGENT_TYPES } from '../../agents/roster.js';
import { agentCommand } from '../../commands/agent.js';
import { agentTools } from '../agent-tools.js';

const spawnTool = agentTools.find(tool => tool.name === 'agent_spawn')!;
const listTool = agentTools.find(tool => tool.name === 'agent_list')!;
const statusTool = agentTools.find(tool => tool.name === 'agent_status')!;
const ORIGINAL_CWD = process.cwd();

function readSpawnedTypes(root: string): string[] {
  const storePath = join(root, '.hive-flow', 'agents', 'store.json');
  if (!existsSync(storePath)) return [];
  const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
    agents?: Record<string, { agentType?: string }>;
  };
  return Object.values(store.agents ?? {}).map(agent => String(agent.agentType));
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
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
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
});
