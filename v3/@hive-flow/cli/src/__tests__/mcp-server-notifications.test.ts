import { describe, expect, it } from 'vitest';

import { buildHiveStatusNotification, classifyMCPClient } from '../mcp-server.js';

describe('MCP hive completion notifications', () => {
  it('classifies Claude and Codex MCP clients from initialize params', () => {
    expect(classifyMCPClient({ clientInfo: { name: 'claude-code', version: '2.1.157' } })).toBe('claude');
    expect(classifyMCPClient({ clientInfo: { name: 'codex-cli', version: '0.0.0' } })).toBe('codex');
    expect(classifyMCPClient({ clientInfo: { name: 'gemini-cli', version: '0.30.0' } })).toBe('gemini');
    expect(classifyMCPClient({ clientInfo: { name: 'cursor-agent', version: '1.0.0' } })).toBe('cursor');
    expect(classifyMCPClient({ clientInfo: { name: 'generic-mcp-client' } }, {})).toBe('unknown');
    expect(classifyMCPClient(null, {})).toBe('unknown');
  });

  it('falls back to runtime env markers when initialize params omit the caller', () => {
    expect(classifyMCPClient({}, { HIVE_FLOW_CLIENT_KIND: 'gemini' })).toBe('gemini');
    expect(classifyMCPClient({}, { HIVE_FLOW_CLIENT_KIND: 'cursor-cli' })).toBe('cursor');
    expect(classifyMCPClient({}, { CODEX_HOME: '/Users/test/.codex' })).toBe('codex');
    expect(classifyMCPClient({}, { GEMINI_API_KEY: 'configured' })).toBe('gemini');
    expect(classifyMCPClient({}, { CURSOR_API_KEY: 'configured' })).toBe('cursor');
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

  it('keeps Gemini and Cursor hive completion guidance CLI-specific', () => {
    const base = {
      hiveId: 'hive-456',
      queenId: 'queen-1',
      status: 'completed' as const,
      completedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      error: undefined,
    };

    const gemini = buildHiveStatusNotification(base, 'gemini');
    const cursor = buildHiveStatusNotification(base, 'cursor');

    expect(gemini.params.data.clientKind).toBe('gemini');
    expect(gemini.params.data.message).toContain('Gemini');
    expect(cursor.params.data.clientKind).toBe('cursor');
    expect(cursor.params.data.message).toContain('Cursor');
  });
});
