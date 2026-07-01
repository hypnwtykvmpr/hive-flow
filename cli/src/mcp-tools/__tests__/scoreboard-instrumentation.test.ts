// v3/@hive-flow/cli/src/mcp-tools/__tests__/scoreboard-instrumentation.test.ts
//
// Phase 11.1 — MCP scoreboard instrumentation tests.
//
// The scoreboard recorders are mocked so these tests assert the instrumentation
// contract directly: correct provider mapping, correct event shape per
// lifecycle point, and — the load-bearing gate — that a recorder failure is
// swallowed so the underlying MCP operation never fails because recording did.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const recordPresenceEvent = vi.fn();
const recordProviderCall = vi.fn();

vi.mock('../../statusline/recorders/scoreboard.js', () => ({
  recordPresenceEvent: (...args: unknown[]) => recordPresenceEvent(...args),
  recordProviderCall: (...args: unknown[]) => recordProviderCall(...args),
}));

import {
  agentProviderToScore,
  agentProviderToHostCli,
  recordMcpAgentSpawn,
  recordMcpCallStart,
  recordMcpCallComplete,
  recordMcpCallFailed,
} from '../scoreboard-instrumentation.js';

beforeEach(() => {
  recordPresenceEvent.mockReset();
  recordProviderCall.mockReset();
  recordPresenceEvent.mockResolvedValue(undefined);
  recordProviderCall.mockResolvedValue(undefined);
});

describe('provider mapping', () => {
  it('maps every AgentProvider to the correct ScoreProvider', () => {
    expect(agentProviderToScore('anthropic')).toBe('claude');
    expect(agentProviderToScore('anthropic-cli')).toBe('claude');
    expect(agentProviderToScore('gemini-cli')).toBe('gemini');
    expect(agentProviderToScore('codex-cli')).toBe('codex');
    expect(agentProviderToScore('cursor-cli')).toBe('cursor');
    expect(agentProviderToScore('deepseek')).toBe('deepseek');
    expect(agentProviderToScore('openrouter')).toBe('openrouter');
  });

  it('maps unknown / undefined provider to "unknown"', () => {
    expect(agentProviderToScore('something-else')).toBe('unknown');
    expect(agentProviderToScore(undefined)).toBe('unknown');
  });

  it('maps every AgentProvider to a valid HostCli', () => {
    expect(agentProviderToHostCli('anthropic-cli')).toBe('claude-code');
    expect(agentProviderToHostCli('gemini-cli')).toBe('gemini');
    expect(agentProviderToHostCli('codex-cli')).toBe('codex');
    expect(agentProviderToHostCli('cursor-cli')).toBe('cursor-cli');
    // API-only providers have no host CLI -> hive-flow-daemon.
    expect(agentProviderToHostCli('deepseek')).toBe('hive-flow-daemon');
    expect(agentProviderToHostCli('openrouter')).toBe('hive-flow-daemon');
    expect(agentProviderToHostCli(undefined)).toBe('hive-flow-daemon');
  });
});

describe('event shape on success', () => {
  it('agent-spawn presence records the right kind, producer, and presenceKey', async () => {
    await recordMcpAgentSpawn({ agentId: 'a1', provider: 'codex-cli', model: 'gpt-5.5', nowMs: 1000 });
    expect(recordPresenceEvent).toHaveBeenCalledTimes(1);
    const ev = recordPresenceEvent.mock.calls[0][0];
    expect(ev).toMatchObject({
      event: 'agent-spawn',
      provider: 'codex',
      hostCli: 'codex',
      producerKind: 'mcp-tool',
      producerId: 'hive-flow:mcp-server',
      presenceKey: 'codex:a1',
      agentId: 'a1',
      model: 'gpt-5.5',
    });
    expect(ev.eventId).toBe('mcp-presence:codex:a1:1000');
  });

  it('call-start uses the taskId as eventId', async () => {
    await recordMcpCallStart({ taskId: 'task-xyz', agentId: 'a1', provider: 'gemini-cli' });
    expect(recordProviderCall).toHaveBeenCalledTimes(1);
    expect(recordProviderCall.mock.calls[0][0]).toMatchObject({
      event: 'call-start',
      eventId: 'task-xyz',
      provider: 'gemini',
      hostCli: 'gemini',
      producerKind: 'mcp-tool',
    });
  });

  it('call-complete correlates by taskId with countWeight 1', async () => {
    await recordMcpCallComplete({ taskId: 'task-xyz', agentId: 'a1', provider: 'codex-cli' });
    expect(recordProviderCall.mock.calls[0][0]).toMatchObject({
      event: 'call-complete',
      eventId: 'task-xyz',
      countWeight: 1,
    });
  });

  it('call-failed correlates by taskId', async () => {
    await recordMcpCallFailed({ taskId: 'task-xyz', agentId: 'a1', provider: 'codex-cli' });
    expect(recordProviderCall.mock.calls[0][0]).toMatchObject({
      event: 'call-failed',
      eventId: 'task-xyz',
    });
  });
});

describe('best-effort failure isolation', () => {
  it('swallows a recordProviderCall rejection (call-start)', async () => {
    recordProviderCall.mockRejectedValue(new Error('ledger lock contended'));
    await expect(
      recordMcpCallStart({ taskId: 't', agentId: 'a', provider: 'codex-cli' }),
    ).resolves.toBeUndefined();
  });

  it('swallows a recordProviderCall rejection (call-complete / call-failed)', async () => {
    recordProviderCall.mockRejectedValue(new Error('boom'));
    await expect(recordMcpCallComplete({ taskId: 't', agentId: 'a', provider: 'codex-cli' })).resolves.toBeUndefined();
    await expect(recordMcpCallFailed({ taskId: 't', agentId: 'a', provider: 'codex-cli' })).resolves.toBeUndefined();
  });

  it('swallows a recordPresenceEvent rejection (agent-spawn)', async () => {
    recordPresenceEvent.mockRejectedValue(new Error('disk full'));
    await expect(
      recordMcpAgentSpawn({ agentId: 'a', provider: 'codex-cli' }),
    ).resolves.toBeUndefined();
  });
});
