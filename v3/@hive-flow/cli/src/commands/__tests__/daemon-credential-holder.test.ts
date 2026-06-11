import { describe, expect, it, vi } from 'vitest';
import {
  reapCredentialHolderAtSocket,
  reapStaleMcpServers,
  type CredentialHolderReapDeps,
  type McpServerReapDeps,
} from '../daemon.js';

describe('daemon credential holder lifecycle helpers', () => {
  it('reaps a serving credential holder when its PID is not protected by a running daemon', async () => {
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const unlinkSocket = vi.fn();
    let alive = true;
    const deps: CredentialHolderReapDeps = {
      pingCredentialHolder: vi.fn(async () => ({ available: true, socketPath: '/tmp/hf-holder.sock', pid: 86209 })),
      isProcessRunning: vi.fn((pid: number) => pid === 86209 && alive),
      killProcess: vi.fn((pid: number, signal: NodeJS.Signals) => {
        killCalls.push({ pid, signal });
        if (pid === 86209 && signal === 'SIGTERM') alive = false;
      }),
      sleep: vi.fn(async () => undefined),
      unlinkSocket,
    };

    const result = await reapCredentialHolderAtSocket('/tmp/hf-holder.sock', {
      protectedPids: [43512],
      deps,
    });

    expect(result).toEqual({
      checked: true,
      reaped: true,
      pid: 86209,
      socketPath: '/tmp/hf-holder.sock',
      reason: 'orphan credential holder reaped',
    });
    expect(killCalls).toEqual([{ pid: 86209, signal: 'SIGTERM' }]);
    expect(unlinkSocket).toHaveBeenCalledWith('/tmp/hf-holder.sock');
  });

  it('does not reap a holder owned by the protected daemon PID', async () => {
    const deps: CredentialHolderReapDeps = {
      pingCredentialHolder: vi.fn(async () => ({ available: true, socketPath: '/tmp/hf-holder.sock', pid: 43512 })),
      isProcessRunning: vi.fn(() => true),
      killProcess: vi.fn(),
      sleep: vi.fn(async () => undefined),
      unlinkSocket: vi.fn(),
    };

    const result = await reapCredentialHolderAtSocket('/tmp/hf-holder.sock', {
      protectedPids: [43512],
      deps,
    });

    expect(result).toMatchObject({
      checked: true,
      reaped: false,
      pid: 43512,
      reason: 'credential holder belongs to a protected daemon pid',
    });
    expect(deps.killProcess).not.toHaveBeenCalled();
    expect(deps.unlinkSocket).not.toHaveBeenCalled();
  });

  it('removes a stale credential holder socket when no holder responds', async () => {
    const deps: CredentialHolderReapDeps = {
      pingCredentialHolder: vi.fn(async () => ({
        available: false,
        socketPath: '/tmp/hf-holder.sock',
        reason: 'connect ECONNREFUSED /tmp/hf-holder.sock',
      })),
      isProcessRunning: vi.fn(() => false),
      killProcess: vi.fn(),
      sleep: vi.fn(async () => undefined),
      unlinkSocket: vi.fn(),
    };

    const result = await reapCredentialHolderAtSocket('/tmp/hf-holder.sock', { deps });

    expect(result).toEqual({
      checked: true,
      reaped: false,
      socketPath: '/tmp/hf-holder.sock',
      reason: 'credential holder is not serving; stale socket removed',
    });
    expect(deps.unlinkSocket).toHaveBeenCalledWith('/tmp/hf-holder.sock');
    expect(deps.killProcess).not.toHaveBeenCalled();
  });
});

describe('daemon MCP stdio server lifecycle helpers', () => {
  const hiveFlowMcpCommand = () => `node ${process.cwd()}/bin/mcp-server.js`;

  it('reaps legacy MCP server processes that have no live heartbeat registry record', async () => {
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;
    const deps: McpServerReapDeps = {
      listProcesses: vi.fn(async () => [
        {
          pid: 9001,
          ppid: 100,
          stat: 'S',
          elapsedSeconds: 300,
          command: hiveFlowMcpCommand(),
        },
      ]),
      readRegistryRecord: vi.fn(() => null),
      removeRegistryRecord: vi.fn(),
      isProcessRunning: vi.fn((pid: number) => pid === 9001 && alive),
      killProcess: vi.fn((pid: number, signal: NodeJS.Signals) => {
        killCalls.push({ pid, signal });
        if (pid === 9001 && signal === 'SIGTERM') alive = false;
      }),
      sleep: vi.fn(async () => undefined),
    };

    const result = await reapStaleMcpServers({
      protectedPids: [process.pid],
      nowMs: Date.parse('2026-06-11T12:00:00.000Z'),
      deps,
    });

    expect(result).toMatchObject({ checked: 1, reaped: 1, skipped: 0 });
    expect(result.records[0]).toMatchObject({
      pid: 9001,
      reaped: true,
      reason: 'stale MCP server reaped',
    });
    expect(killCalls).toEqual([{ pid: 9001, signal: 'SIGTERM' }]);
    expect(deps.removeRegistryRecord).toHaveBeenCalledWith(9001);
  });

  it('does not reap a registered MCP server with a fresh heartbeat', async () => {
    const deps: McpServerReapDeps = {
      listProcesses: vi.fn(async () => [
        {
          pid: 9002,
          ppid: 100,
          stat: 'S',
          elapsedSeconds: 300,
          command: hiveFlowMcpCommand(),
        },
      ]),
      readRegistryRecord: vi.fn(() => ({
        pid: 9002,
        ppid: 100,
        sessionId: 'active-mcp',
        startedAt: '2026-06-11T11:59:00.000Z',
        lastHeartbeatAt: '2026-06-11T11:59:40.000Z',
        command: hiveFlowMcpCommand(),
      })),
      removeRegistryRecord: vi.fn(),
      isProcessRunning: vi.fn(() => true),
      killProcess: vi.fn(),
      sleep: vi.fn(async () => undefined),
    };

    const result = await reapStaleMcpServers({
      protectedPids: [process.pid],
      nowMs: Date.parse('2026-06-11T12:00:00.000Z'),
      staleMs: 60_000,
      deps,
    });

    expect(result).toMatchObject({ checked: 1, reaped: 0, skipped: 1 });
    expect(result.records[0]).toMatchObject({
      pid: 9002,
      reaped: false,
      reason: 'MCP server heartbeat is fresh',
    });
    expect(deps.killProcess).not.toHaveBeenCalled();
    expect(deps.removeRegistryRecord).not.toHaveBeenCalled();
  });

  it('does not reap a foreign bin/mcp-server.js process outside hive-flow', async () => {
    const deps: McpServerReapDeps = {
      listProcesses: vi.fn(async () => [
        {
          pid: 9003,
          ppid: 100,
          stat: 'S',
          elapsedSeconds: 300,
          command: 'node /other/project/bin/mcp-server.js',
        },
      ]),
      readRegistryRecord: vi.fn(() => null),
      removeRegistryRecord: vi.fn(),
      isProcessRunning: vi.fn(() => true),
      killProcess: vi.fn(),
      sleep: vi.fn(async () => undefined),
    };

    const result = await reapStaleMcpServers({
      protectedPids: [process.pid],
      nowMs: Date.parse('2026-06-11T12:00:00.000Z'),
      deps,
    });

    expect(result).toMatchObject({ checked: 0, reaped: 0, skipped: 0 });
    expect(deps.readRegistryRecord).not.toHaveBeenCalled();
    expect(deps.killProcess).not.toHaveBeenCalled();
    expect(deps.removeRegistryRecord).not.toHaveBeenCalled();
  });

  it('does not reap a different project install of @hive-flow/cli/bin/mcp-server.js', async () => {
    const deps: McpServerReapDeps = {
      listProcesses: vi.fn(async () => [
        {
          pid: 9006,
          ppid: 100,
          stat: 'S',
          elapsedSeconds: 300,
          command: 'node /other/project/node_modules/@hive-flow/cli/bin/mcp-server.js',
        },
      ]),
      readRegistryRecord: vi.fn(() => null),
      removeRegistryRecord: vi.fn(),
      isProcessRunning: vi.fn(() => true),
      killProcess: vi.fn(),
      sleep: vi.fn(async () => undefined),
    };

    const result = await reapStaleMcpServers({
      protectedPids: [process.pid],
      nowMs: Date.parse('2026-06-11T12:00:00.000Z'),
      deps,
    });

    expect(result).toMatchObject({ checked: 0, reaped: 0, skipped: 0 });
    expect(deps.readRegistryRecord).not.toHaveBeenCalled();
    expect(deps.killProcess).not.toHaveBeenCalled();
    expect(deps.removeRegistryRecord).not.toHaveBeenCalled();
  });

  it('does not reap a strict hive-flow MCP server while it is inside startup grace', async () => {
    const deps: McpServerReapDeps = {
      listProcesses: vi.fn(async () => [
        {
          pid: 9004,
          ppid: 100,
          stat: 'S',
          elapsedSeconds: 5,
          command: hiveFlowMcpCommand(),
        },
      ]),
      readRegistryRecord: vi.fn(() => null),
      removeRegistryRecord: vi.fn(),
      isProcessRunning: vi.fn(() => true),
      killProcess: vi.fn(),
      sleep: vi.fn(async () => undefined),
    };

    const result = await reapStaleMcpServers({
      protectedPids: [process.pid],
      nowMs: Date.parse('2026-06-11T12:00:00.000Z'),
      startupGraceMs: 20_000,
      deps,
    });

    expect(result).toMatchObject({ checked: 1, reaped: 0, skipped: 1 });
    expect(result.records[0]).toMatchObject({
      pid: 9004,
      reaped: false,
      reason: 'MCP server is inside startup grace',
    });
    expect(deps.killProcess).not.toHaveBeenCalled();
    expect(deps.removeRegistryRecord).not.toHaveBeenCalled();
  });

  it('does not reap a protected strict hive-flow MCP server even without a heartbeat', async () => {
    const deps: McpServerReapDeps = {
      listProcesses: vi.fn(async () => [
        {
          pid: 9005,
          ppid: 100,
          stat: 'S',
          elapsedSeconds: 300,
          command: hiveFlowMcpCommand(),
        },
      ]),
      readRegistryRecord: vi.fn(() => null),
      removeRegistryRecord: vi.fn(),
      isProcessRunning: vi.fn(() => true),
      killProcess: vi.fn(),
      sleep: vi.fn(async () => undefined),
    };

    const result = await reapStaleMcpServers({
      protectedPids: [9005],
      nowMs: Date.parse('2026-06-11T12:00:00.000Z'),
      deps,
    });

    expect(result).toMatchObject({ checked: 1, reaped: 0, skipped: 1 });
    expect(result.records[0]).toMatchObject({
      pid: 9005,
      reaped: false,
      reason: 'MCP server pid is protected',
    });
    expect(deps.readRegistryRecord).not.toHaveBeenCalled();
    expect(deps.killProcess).not.toHaveBeenCalled();
    expect(deps.removeRegistryRecord).not.toHaveBeenCalled();
  });
});
