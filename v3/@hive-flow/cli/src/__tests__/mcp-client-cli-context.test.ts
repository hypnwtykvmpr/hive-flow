import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDefaultMCPContext, callMCPTool, getToolMetadata } from '../mcp-client.js';

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = {
  CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
  CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
  HIVE_FLOW_SESSION_ID: process.env.HIVE_FLOW_SESSION_ID,
  HIVE_FLOW_CLIENT_KIND: process.env.HIVE_FLOW_CLIENT_KIND,
  HIVE_FLOW_PROJECT_ROOT: process.env.HIVE_FLOW_PROJECT_ROOT,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key as keyof typeof ORIGINAL_ENV];
    } else {
      process.env[key as keyof typeof ORIGINAL_ENV] = value;
    }
  }
}

function clearSessionEnv(): void {
  delete process.env.CODEX_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.HIVE_FLOW_SESSION_ID;
  delete process.env.HIVE_FLOW_CLIENT_KIND;
  delete process.env.HIVE_FLOW_PROJECT_ROOT;
  delete process.env.CLAUDE_PROJECT_DIR;
}

function readAgent(root: string, agentId: string): Record<string, unknown> | undefined {
  const storePath = join(root, '.hive-flow', 'agents', 'store.json');
  if (!existsSync(storePath)) return undefined;
  const store = JSON.parse(readFileSync(storePath, 'utf-8')) as {
    agents?: Record<string, Record<string, unknown>>;
  };
  return store.agents?.[agentId];
}

describe('CLI MCP client owner context', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hive-flow-mcp-client-context-'));
    process.chdir(tmpRoot);
    clearSessionEnv();
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    restoreEnv();
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('generates a stable CLI owner context when no operator env is present', () => {
    const first = buildDefaultMCPContext();
    const second = buildDefaultMCPContext();

    expect(first.sessionId).toMatch(/^cli-[a-f0-9]{16}$/);
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.clientKind).toBe('claude');
  });

  it('does not override real Codex session ownership from env', () => {
    process.env.CODEX_THREAD_ID = 'codex-thread-session';

    const context = buildDefaultMCPContext();

    expect(context.sessionId).toBeUndefined();
    expect(context.clientKind).toBe('codex');
  });

  it('stamps installed CLI agent spawns with a deterministic owner instead of creating ownerless agents', async () => {
    const result = await callMCPTool<Record<string, unknown>>('agent_spawn', {
      agentId: 'cli-owned-agent',
      agentType: 'tester',
      provider: 'anthropic',
    });

    expect(result).toMatchObject({
      success: true,
      agentId: 'cli-owned-agent',
    });
    const agent = readAgent(tmpRoot, 'cli-owned-agent');
    expect(agent?.ownerSessionId).toMatch(/^cli-[a-f0-9]{16}$/);
    expect(agent?.ownerClientKind).toBe('claude');
  });

  it('registers permission guard MCP tools through the CLI registry', () => {
    expect(getToolMetadata('permission_guard_status')).toMatchObject({
      name: 'permission_guard_status',
      category: 'permission-guard',
    });
    expect(getToolMetadata('permission_guard_override')).toMatchObject({
      name: 'permission_guard_override',
      category: 'permission-guard',
    });
  });

  it('registers coverage router tools through the CLI registry', () => {
    expect(getToolMetadata('hooks/coverage-route')).toMatchObject({
      name: 'hooks/coverage-route',
      category: 'coverage',
    });
    expect(getToolMetadata('hooks/coverage-suggest')).toMatchObject({
      name: 'hooks/coverage-suggest',
      category: 'coverage',
    });
    expect(getToolMetadata('hooks/coverage-gaps')).toMatchObject({
      name: 'hooks/coverage-gaps',
      category: 'coverage',
    });
  });
});
