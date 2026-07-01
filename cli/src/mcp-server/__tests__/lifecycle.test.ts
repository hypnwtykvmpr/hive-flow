import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideCredentialHolderStartup,
  installStdioClientLifecycle,
  mcpServerRegistryDir,
  registerMcpServerProcess,
} from '../lifecycle.js';

const roots: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hf-mcp-lifecycle-'));
  roots.push(home);
  return home;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MCP stdio server lifecycle', () => {
  it('uses an existing daemon-owned credential holder as a client instead of bootstrapping another holder', () => {
    const decision = decideCredentialHolderStartup(
      { available: true, socketPath: '/tmp/hf-holder.sock', pid: 4242 },
      {},
    );

    expect(decision).toEqual({
      mode: 'client',
      reason: 'credential holder already serving',
      socketPath: '/tmp/hf-holder.sock',
      pid: 4242,
    });
  });

  it('refuses to bootstrap from ordinary MCP stdio processes when no holder is alive', () => {
    expect(decideCredentialHolderStartup(
      { available: false, socketPath: '/tmp/hf-holder.sock', reason: 'missing' },
      {},
    )).toMatchObject({
      mode: 'client',
      reason: 'credential holder unavailable; MCP server will run as a client without bootstrapping',
    });

    expect(decideCredentialHolderStartup(
      { available: false, socketPath: '/tmp/hf-holder.sock', reason: 'missing' },
      { HIVE_FLOW_CREDENTIAL_HOLDER_OWNER: '1' },
    )).toMatchObject({ mode: 'bootstrap' });
  });

  it('shuts down exactly once when the stdio client closes without a signal', () => {
    const stdin = new EventEmitter();
    const shutdown = vi.fn(async (_reason: string) => undefined);

    const uninstall = installStdioClientLifecycle(stdin, shutdown, { sessionId: 'mcp-test' });
    stdin.emit('close');
    stdin.emit('end');
    stdin.emit('error', new Error('after-close'));
    uninstall();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown.mock.calls[0][0]).toContain('stdin closed');
  });

  it('registers MCP server heartbeats under HIVE_FLOW_HOME for daemon reaping', () => {
    const hiveHome = makeHome();
    const registration = registerMcpServerProcess({
      env: { HIVE_FLOW_HOME: hiveHome },
      pid: 12345,
      ppid: 678,
      sessionId: 'mcp-test-session',
      now: () => new Date('2026-06-11T12:00:00.000Z'),
      heartbeatIntervalMs: 60_000,
    });

    try {
      expect(mcpServerRegistryDir({ HIVE_FLOW_HOME: hiveHome })).toBe(join(hiveHome, 'run', 'mcp-servers'));
      const record = JSON.parse(readFileSync(registration.path, 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({
        pid: 12345,
        ppid: 678,
        sessionId: 'mcp-test-session',
        lastHeartbeatAt: '2026-06-11T12:00:00.000Z',
      });
    } finally {
      registration.stop();
    }
  });
});
