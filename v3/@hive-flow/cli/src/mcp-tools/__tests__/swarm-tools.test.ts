import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentTools } from '../agent-tools.js';
import { swarmTools } from '../swarm-tools.js';

const ORIGINAL_CWD = process.cwd();
const spawnTool = agentTools.find(tool => tool.name === 'agent_spawn')!;
const initTool = swarmTools.find(tool => tool.name === 'swarm_init')!;
const statusTool = swarmTools.find(tool => tool.name === 'swarm_status')!;
const healthTool = swarmTools.find(tool => tool.name === 'swarm_health')!;
const shutdownTool = swarmTools.find(tool => tool.name === 'swarm_shutdown')!;

describe('swarm MCP tools', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hive-flow-swarm-tools-'));
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('persists swarm_init and reports persisted status without simulated fields', async () => {
    const init = await initTool.handler({
      topology: 'hierarchical-mesh',
      maxAgents: 7,
    }) as Record<string, unknown>;

    expect(init.success).toBe(true);
    expect(String(init.swarmId)).toMatch(/^swarm-/);
    expect(existsSync(join(tmpRoot, '.hive-flow', 'swarms', 'store.json'))).toBe(true);

    const status = await statusTool.handler({ swarmId: init.swarmId }) as Record<string, unknown>;

    expect(status.simulated).toBeUndefined();
    expect(status).toMatchObject({
      success: true,
      swarmId: init.swarmId,
      status: 'running',
      topology: 'hierarchical-mesh',
      agentCount: 0,
      taskCount: 0,
    });
  });

  it('reports active agent counts from the real agent store', async () => {
    const init = await initTool.handler({ topology: 'mesh' }) as Record<string, unknown>;
    await spawnTool.handler({
      agentId: 'swarm-agent-1',
      agentType: 'tester',
      provider: 'anthropic',
    }, { sessionId: 'swarm-test-session', clientKind: 'codex' });

    const status = await statusTool.handler({ swarmId: init.swarmId }) as Record<string, unknown>;
    const agents = status.agents as Record<string, unknown>;

    expect(status.simulated).toBeUndefined();
    expect(status.agentCount).toBe(1);
    expect(agents.active).toBe(1);
    expect(agents.idle).toBe(1);
  });

  it('health uses real store state and never returns hardcoded simulated checks', async () => {
    const init = await initTool.handler({ topology: 'mesh' }) as Record<string, unknown>;
    await spawnTool.handler({
      agentId: 'swarm-health-agent',
      agentType: 'tester',
      provider: 'anthropic',
    }, { sessionId: 'swarm-health-session', clientKind: 'codex' });

    const health = await healthTool.handler({ swarmId: init.swarmId }) as Record<string, unknown>;
    const checks = health.checks as Array<{ name: string; message: string; status: string }>;

    expect(health.simulated).toBeUndefined();
    expect(health.status).toBe('healthy');
    expect(checks.map(check => check.message).join('\n')).not.toMatch(/\[SIMULATED\]/);
    expect(checks.find(check => check.name === 'agents')?.message).toContain('1 active agent');
  });

  it('swarm_shutdown marks a persisted swarm stopped', async () => {
    const init = await initTool.handler({ topology: 'mesh' }) as Record<string, unknown>;

    const stopped = await shutdownTool.handler({ swarmId: init.swarmId }) as Record<string, unknown>;
    const status = await statusTool.handler({ swarmId: init.swarmId }) as Record<string, unknown>;

    expect(stopped).toMatchObject({
      success: true,
      swarmId: init.swarmId,
      terminated: true,
      status: 'stopped',
    });
    expect(status.status).toBe('stopped');
  });
});
