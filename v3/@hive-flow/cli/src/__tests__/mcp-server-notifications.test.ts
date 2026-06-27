import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildHiveStatusNotification,
  buildMCPToolContextForCall,
  classifyMCPClient,
  clientKindForMCPToolContext,
} from '../mcp-server.js';
import { operatorSessionEnvKeys } from '../mcp-tools/session-id.js';

const OWNER_ENV_KEYS = Array.from(new Set([
  ...operatorSessionEnvKeys(),
  'HIVE_FLOW_CLIENT_KIND',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PROJECT_DIR',
  'CODEX_HOME',
  'GEMINI_API_KEY',
  'CURSOR_API_KEY',
]));
const ORIGINAL_ENV = Object.fromEntries(
  OWNER_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;

function clearOwnerEnv(): void {
  for (const key of OWNER_ENV_KEYS) delete process.env[key];
}

describe('MCP hive completion notifications', () => {
  beforeEach(() => {
    clearOwnerEnv();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('classifies Claude and Codex MCP clients from initialize params', () => {
    expect(classifyMCPClient({ clientInfo: { name: 'claude-code', version: '2.1.157' } })).toBe('claude');
    expect(classifyMCPClient({ clientInfo: { name: 'codex-cli', version: '0.0.0' } })).toBe('codex');
    expect(classifyMCPClient({ clientInfo: { name: 'gemini-cli', version: '0.30.0' } })).toBe('gemini');
    expect(classifyMCPClient({ clientInfo: { name: 'cursor-agent', version: '1.0.0' } })).toBe('cursor');
    expect(classifyMCPClient({ clientInfo: { name: 'agy', version: '1.0.0' } })).toBe('antigravity');
    expect(classifyMCPClient({ clientInfo: { name: 'opencode', version: '1.0.0' } })).toBe('opencode');
    expect(classifyMCPClient({ clientInfo: { name: 'forgecode', version: '1.0.0' } })).toBe('forgecode');
    expect(classifyMCPClient({ clientInfo: { name: 'generic-mcp-client' } }, {})).toBe('unknown');
    expect(classifyMCPClient(null, {})).toBe('unknown');
  });

  it('falls back to runtime env markers when initialize params omit the caller', () => {
    expect(classifyMCPClient({}, { HIVE_FLOW_CLIENT_KIND: 'gemini', HIVE_FLOW_SESSION_ID: 'provider-session' })).toBe('gemini');
    expect(classifyMCPClient({}, { HIVE_FLOW_CLIENT_KIND: 'cursor-cli', HIVE_FLOW_SESSION_ID: 'provider-session' })).toBe('cursor');
    expect(classifyMCPClient({}, { HIVE_FLOW_CLIENT_KIND: 'gemini' })).toBe('unknown');
    expect(classifyMCPClient({}, { CODEX_HOME: '/Users/test/.codex' })).toBe('codex');
    expect(classifyMCPClient({}, { GEMINI_API_KEY: 'configured' })).toBe('gemini');
    expect(classifyMCPClient({}, { CURSOR_API_KEY: 'configured' })).toBe('cursor');
    expect(classifyMCPClient({}, { AGY_SESSION_ID: 'agy-session' })).toBe('antigravity');
    expect(classifyMCPClient({}, { OPENCODE_SESSION_ID: 'opencode-session' })).toBe('opencode');
    expect(classifyMCPClient({}, { FORGE_SESSION_ID: 'forge-session' })).toBe('forgecode');
    expect(classifyMCPClient({}, { CLAUDE_PROJECT_DIR: '/repo' })).toBe('claude');
  });

  it('prefers Claude Code runtime identity over stale initialize metadata', () => {
    expect(classifyMCPClient(
      { clientInfo: { name: 'codex-cli', version: '0.0.0' } },
      {
        HIVE_FLOW_CLIENT_KIND: 'codex',
        CODEX_THREAD_ID: 'codex-thread-from-reconnect',
        CLAUDE_PROJECT_DIR: '/repo',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 'claude-code-session',
      },
      { trustEnvFallback: false },
    )).toBe('claude');
  });

  it('does not trust ambient env markers for stdio MCP transport identity', () => {
    const reconnectEnv = {
      HIVE_FLOW_CLIENT_KIND: 'codex',
      CODEX_THREAD_ID: 'codex-thread-from-reconnect',
      CODEX_HOME: '/Users/test/.codex',
    };

    expect(classifyMCPClient({}, reconnectEnv, { trustEnvFallback: false })).toBe('unknown');
    expect(classifyMCPClient(null, reconnectEnv, { trustEnvFallback: false })).toBe('unknown');
    expect(classifyMCPClient({
      clientInfo: { name: 'opencode', version: '1.0.0' },
    }, reconnectEnv, { trustEnvFallback: false })).toBe('opencode');
  });

  it('uses a stable local default for unclassified MCP tool context', () => {
    expect(clientKindForMCPToolContext('unknown')).toBe('claude');
    expect(clientKindForMCPToolContext('codex')).toBe('codex');
    expect(clientKindForMCPToolContext('opencode')).toBe('opencode');
  });

  it('binds explicit owner session to classified Codex MCP calls', () => {
    expect(buildMCPToolContextForCall('mcp-1-local', 'codex', {
      session_id: 'codex-thread-owner',
    })).toEqual({
      sessionId: 'codex-thread-owner',
      clientKind: 'codex',
    });
  });

  it('does not bind explicit owner session for unclassified MCP calls', () => {
    expect(buildMCPToolContextForCall('mcp-1-local', 'unknown', {
      session_id: 'attacker-selected-owner',
    })).toEqual({
      sessionId: 'mcp-1-local',
      clientKind: 'claude',
    });
  });

  it('uses transport session for classified MCP calls without explicit owner session', () => {
    expect(buildMCPToolContextForCall('mcp-1-local', 'codex', {})).toEqual({
      sessionId: 'mcp-1-local',
      clientKind: 'codex',
    });
  });

  it('accepts sessionId alias when binding classified MCP tool context', () => {
    expect(buildMCPToolContextForCall('mcp-1-local', 'opencode', {
      sessionId: 'opencode-parent-session',
    })).toEqual({
      sessionId: 'opencode-parent-session',
      clientKind: 'opencode',
    });
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

  it('keeps Antigravity, OpenCode, and ForgeCode hive completion guidance CLI-specific', () => {
    const base = {
      hiveId: 'hive-789',
      queenId: 'queen-1',
      status: 'completed' as const,
      completedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      error: undefined,
    };

    const antigravity = buildHiveStatusNotification(base, 'antigravity');
    const opencode = buildHiveStatusNotification(base, 'opencode');
    const forgecode = buildHiveStatusNotification(base, 'forgecode');

    expect(antigravity.params.data.clientKind).toBe('antigravity');
    expect(antigravity.params.data.message).toContain('Antigravity');
    expect(opencode.params.data.clientKind).toBe('opencode');
    expect(opencode.params.data.message).toContain('OpenCode');
    expect(forgecode.params.data.clientKind).toBe('forgecode');
    expect(forgecode.params.data.message).toContain('ForgeCode');
  });
});
