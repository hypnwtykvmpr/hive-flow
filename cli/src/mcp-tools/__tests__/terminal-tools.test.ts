/**
 * Tests for terminal-tools.ts
 *
 * Covers: module structure, handler existence, create/list/execute/close/history
 * operations, not-found errors, and command recording (no real execution).
 *
 * The node:fs layer is mocked so tests run without touching the filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fs mock ───────────────────────────────────────────────────────────────────
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { terminalTools } from '../terminal-tools.js';
import * as nodeFs from 'node:fs';

// ── helpers ───────────────────────────────────────────────────────────────────

function getHandler(name: string) {
  const tool = terminalTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler;
}

function makeStoreJson(sessions: Record<string, unknown> = {}): string {
  return JSON.stringify({ sessions, version: '3.0.0' });
}

function makeSession(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: 'Test Terminal',
    status: 'active',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    workingDir: '/tmp',
    history: [],
    env: {},
    ...overrides,
  };
}

// ── module-level checks ───────────────────────────────────────────────────────

describe('terminalTools module', () => {
  it('exports an array', () => {
    expect(Array.isArray(terminalTools)).toBe(true);
  });

  it('exports exactly 5 tools', () => {
    expect(terminalTools.length).toBe(5);
  });

  const expectedNames = [
    'terminal_create',
    'terminal_execute',
    'terminal_list',
    'terminal_close',
    'terminal_history',
  ];

  it.each(expectedNames)('has tool "%s"', (name) => {
    expect(terminalTools.some(t => t.name === name)).toBe(true);
  });

  it('every tool has a name, description, inputSchema and handler', () => {
    for (const tool of terminalTools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('every tool belongs to the "terminal" category', () => {
    for (const tool of terminalTools) {
      expect(tool.category).toBe('terminal');
    }
  });
});

// ── terminal_create ───────────────────────────────────────────────────────────

describe('terminal_create handler', () => {
  const handler = getHandler('terminal_create');

  beforeEach(() => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    vi.mocked(nodeFs.writeFileSync).mockReset();
  });

  it('creates a session with default name when no name provided', async () => {
    const result = await handler({}) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(typeof result.sessionId).toBe('string');
    expect(String(result.sessionId)).toMatch(/^term-/);
  });

  it('creates a session with the provided name', async () => {
    const result = await handler({ name: 'My Session' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.name).toBe('My Session');
  });

  it('creates a session with the provided workingDir', async () => {
    const result = await handler({ workingDir: '/home/user/project' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.workingDir).toBe('/home/user/project');
  });

  it('returns status "active" for a new session', async () => {
    const result = await handler({ name: 'Active Session' }) as Record<string, unknown>;
    expect(result.status).toBe('active');
  });

  it('persists by calling writeFileSync', async () => {
    await handler({ name: 'Persist Test' });
    expect(vi.mocked(nodeFs.writeFileSync)).toHaveBeenCalled();
  });
});

// ── terminal_execute ──────────────────────────────────────────────────────────

describe('terminal_execute handler', () => {
  const handler = getHandler('terminal_execute');

  beforeEach(() => {
    vi.mocked(nodeFs.writeFileSync).mockReset();
  });

  it('records a command and returns simulated: true (no real execution)', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({ 'term-1': makeSession('term-1') })
    );
    const result = await handler({ sessionId: 'term-1', command: 'ls -la' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.command).toBe('ls -la');
  });

  it('creates a default session when no sessionId is provided', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    const result = await handler({ command: 'echo hello' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(typeof result.sessionId).toBe('string');
  });

  it('does NOT execute the command (output is STATE TRACKING message)', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({ 'term-2': makeSession('term-2') })
    );
    const result = await handler({ sessionId: 'term-2', command: 'cat /etc/passwd' }) as Record<string, unknown>;
    expect(String(result.output)).toMatch(/STATE TRACKING/i);
  });

  it('records exitCode 0 for simulated commands', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({ 'term-3': makeSession('term-3') })
    );
    const result = await handler({ sessionId: 'term-3', command: 'pwd' }) as Record<string, unknown>;
    expect(result.exitCode).toBe(0);
  });
});

// ── terminal_list ─────────────────────────────────────────────────────────────

describe('terminal_list handler', () => {
  const handler = getHandler('terminal_list');

  it('returns empty list when no sessions exist', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    const result = await handler({}) as Record<string, unknown>;
    expect(result.total).toBe(0);
    expect(Array.isArray(result.sessions)).toBe(true);
  });

  it('returns all sessions when status is "all"', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({
        A: makeSession('A', { status: 'active' }),
        B: makeSession('B', { status: 'closed' }),
      })
    );
    const result = await handler({ status: 'all' }) as Record<string, unknown>;
    expect(result.total).toBe(2);
  });

  it('filters by status "active"', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({
        A: makeSession('A', { status: 'active' }),
        B: makeSession('B', { status: 'closed' }),
      })
    );
    const result = await handler({ status: 'active' }) as Record<string, unknown>;
    expect(result.total).toBe(1);
    expect(result.active).toBe(1);
  });

  it('does not include history by default', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({
        A: makeSession('A', {
          history: [{ command: 'ls', output: 'file.txt', timestamp: '', exitCode: 0 }],
        }),
      })
    );
    const result = await handler({}) as Record<string, unknown>;
    const sessions = result.sessions as Array<Record<string, unknown>>;
    expect(sessions[0].history).toBeUndefined();
    expect(typeof sessions[0].historyLength).toBe('number');
  });

  it('includes history when includeHistory is true', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({
        A: makeSession('A', {
          history: [{ command: 'ls', output: 'file.txt', timestamp: '', exitCode: 0 }],
        }),
      })
    );
    const result = await handler({ includeHistory: true }) as Record<string, unknown>;
    const sessions = result.sessions as Array<Record<string, unknown>>;
    expect(Array.isArray(sessions[0].history)).toBe(true);
  });
});

// ── terminal_close ────────────────────────────────────────────────────────────

describe('terminal_close handler', () => {
  const handler = getHandler('terminal_close');

  beforeEach(() => {
    vi.mocked(nodeFs.writeFileSync).mockReset();
  });

  it('returns error when session not found', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    const result = await handler({ sessionId: 'nonexistent' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not found/i);
  });

  it('closes an existing session', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({ 'term-4': makeSession('term-4', { status: 'active' }) })
    );
    const result = await handler({ sessionId: 'term-4' }) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('term-4');
    expect(typeof result.closedAt).toBe('string');
  });

  it('persists the closed state', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({ 'term-5': makeSession('term-5') })
    );
    await handler({ sessionId: 'term-5' });
    expect(vi.mocked(nodeFs.writeFileSync)).toHaveBeenCalled();
  });
});

// ── terminal_history ──────────────────────────────────────────────────────────

describe('terminal_history handler', () => {
  const handler = getHandler('terminal_history');

  it('returns error when specific session not found', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    const result = await handler({ sessionId: 'ghost' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not found/i);
  });

  it('returns history for a known session', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    const hist = [
      { command: 'ls', output: 'a.txt', timestamp: new Date().toISOString(), exitCode: 0 },
      { command: 'pwd', output: '/tmp', timestamp: new Date().toISOString(), exitCode: 0 },
    ];
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({ 'term-6': makeSession('term-6', { history: hist }) })
    );
    const result = await handler({ sessionId: 'term-6' }) as Record<string, unknown>;
    expect(result.total).toBe(2);
    expect(Array.isArray(result.history)).toBe(true);
  });

  it('returns combined history from all sessions when no sessionId given', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    const hist1 = [{ command: 'ls', output: '', timestamp: new Date(1000).toISOString(), exitCode: 0 }];
    const hist2 = [{ command: 'pwd', output: '', timestamp: new Date(2000).toISOString(), exitCode: 0 }];
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({
        A: makeSession('A', { history: hist1 }),
        B: makeSession('B', { history: hist2 }),
      })
    );
    const result = await handler({}) as Record<string, unknown>;
    expect(Array.isArray(result.history)).toBe(true);
    // Both entries should appear
    expect((result.history as unknown[]).length).toBe(2);
  });

  it('respects the limit parameter', async () => {
    vi.mocked(nodeFs.existsSync).mockReturnValue(true);
    const hist = Array.from({ length: 10 }, (_, i) => ({
      command: `cmd-${i}`,
      output: '',
      timestamp: new Date(i * 1000).toISOString(),
      exitCode: 0,
    }));
    vi.mocked(nodeFs.readFileSync).mockReturnValue(
      makeStoreJson({ 'term-7': makeSession('term-7', { history: hist }) })
    );
    const result = await handler({ sessionId: 'term-7', limit: 3 }) as Record<string, unknown>;
    expect((result.history as unknown[]).length).toBeLessThanOrEqual(3);
  });
});
