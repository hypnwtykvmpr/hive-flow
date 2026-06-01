import { describe, expect, it } from 'vitest';

import { buildHiveStatusNotification, classifyMCPClient } from '../mcp-server.js';

describe('MCP hive completion notifications', () => {
  it('classifies Claude and Codex MCP clients from initialize params', () => {
    expect(classifyMCPClient({ clientInfo: { name: 'claude-code', version: '2.1.157' } })).toBe('claude');
    expect(classifyMCPClient({ clientInfo: { name: 'codex-cli', version: '0.0.0' } })).toBe('codex');
    expect(classifyMCPClient({ clientInfo: { name: 'generic-mcp-client' } }, {})).toBe('unknown');
    expect(classifyMCPClient(null, {})).toBe('unknown');
  });

  it('falls back to runtime env markers when initialize params omit the caller', () => {
    expect(classifyMCPClient({}, { CODEX_HOME: '/Users/test/.codex' })).toBe('codex');
    expect(classifyMCPClient({}, { CLAUDE_PROJECT_DIR: '/repo' })).toBe('claude');
  });

  it('emits standard MCP logging notifications for Codex hive completion', () => {
    const notification = buildHiveStatusNotification({
      hiveId: 'hive-123',
      queenId: 'queen-1',
      status: 'completed',
      completedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      error: undefined,
    }, 'codex');

    expect(notification).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: {
        level: 'info',
        logger: 'hive-flow',
        data: {
          type: 'hive_status_update',
          clientKind: 'codex',
          hiveId: 'hive-123',
          status: 'completed',
        },
      },
    });
    expect(notification.params.data.message).toContain('Codex should call hive_poll_workers');
    expect(notification.params).not.toHaveProperty('message');
  });

  it('marks failed hives as error-level and keeps Claude-specific guidance separate', () => {
    const notification = buildHiveStatusNotification({
      hiveId: 'hive-failed',
      queenId: 'queen-1',
      status: 'failed',
      completedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      error: 'worker failed',
    }, 'claude');

    expect(notification.params.level).toBe('error');
    expect(notification.params.data.clientKind).toBe('claude');
    expect(notification.params.data.message).toContain('asyncRewake hook');
    expect(notification.params.data.error).toBe('worker failed');
  });
});
