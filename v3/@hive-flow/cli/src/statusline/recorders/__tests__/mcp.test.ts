import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { updateMcpHealth } from '../mcp.js';
import { probeMcp } from '../../inline-collectors.js';
import { statuslinePaths } from '../../paths.js';
import { parseMcpSummary } from '../../refresher.js';
import type { McpSummary } from '../../types.js';

describe('statusline recorders/mcp', () => {
  let projectRoot: string;
  let homeDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-mcp-project-'));
    homeDir = mkdtempSync(join(tmpdir(), 'hf-mcp-home-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  function writeProjectMcp(servers: Record<string, object>): void {
    writeFileSync(join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  }

  function writeHomeClaude(servers: Record<string, object>): void {
    writeFileSync(join(homeDir, '.claude.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  }

  async function recordHealth(): Promise<McpSummary> {
    return updateMcpHealth({
      projectRoot,
      homeDir,
      observedAt: '2026-06-02T00:00:00.000Z',
    });
  }

  it('writes schema-compatible health.json parsed by the real refresher parser and inline probe', async () => {
    writeProjectMcp({
      'hive-flow': { command: 'node', args: ['mcp-server.js'] },
      filesystem: { command: 'fs' },
    });

    const written = await recordHealth();
    const healthPath = statuslinePaths(projectRoot).mcpHealth;
    const raw = JSON.parse(readFileSync(healthPath, 'utf8')) as unknown;
    const parsed = parseMcpSummary(raw);
    const probed = await probeMcp(healthPath);

    expect(written).toEqual(parsed);
    expect(parsed).toEqual({
      version: 1,
      observedAt: '2026-06-02T00:00:00.000Z',
      probeVersion: 1,
      source: 'setup-verify-json-rpc',
      total: 2,
      configured: 2,
      runtimeUp: 2,
      state: 'config-present',
      details: [
        { id: 'hive-flow', configured: true, runtime: 'up', reason: 'configured' },
        { id: 'filesystem', configured: true, runtime: 'up', reason: 'configured' },
      ],
    });
    expect(probed).toEqual(parsed);
  });

  it('writes a not-configured health file that the inline probe omits', async () => {
    const written = await recordHealth();
    const healthPath = statuslinePaths(projectRoot).mcpHealth;
    const raw = JSON.parse(readFileSync(healthPath, 'utf8')) as unknown;

    expect(existsSync(healthPath)).toBe(true);
    expect(written.total).toBe(0);
    expect(written.configured).toBe(0);
    expect(written.runtimeUp).toBe(0);
    expect(written.state).toBe('not-configured');
    expect(parseMcpSummary(raw)).toEqual(written);
    await expect(probeMcp(healthPath)).resolves.toBeUndefined();
  });

  it('counts MCP servers from project .mcp.json only', async () => {
    writeProjectMcp({
      'project-one': { command: 'one' },
      'project-two': { command: 'two' },
    });

    const summary = await recordHealth();

    expect(summary.total).toBe(2);
    expect(summary.configured).toBe(2);
    expect(summary.runtimeUp).toBe(2);
    expect(summary.state).toBe('config-present');
    expect(summary.details?.map((row) => row.id)).toEqual(['project-one', 'project-two']);
  });

  it('counts MCP servers from home .claude.json only', async () => {
    writeHomeClaude({
      'home-one': { command: 'one' },
      'home-two': { command: 'two' },
      'home-three': { command: 'three' },
    });

    const summary = await recordHealth();

    expect(summary.total).toBe(3);
    expect(summary.configured).toBe(3);
    expect(summary.runtimeUp).toBe(3);
    expect(summary.state).toBe('config-present');
    expect(summary.details?.map((row) => row.id)).toEqual(['home-one', 'home-two', 'home-three']);
  });

  it('merges project .mcp.json and home .claude.json without double-counting duplicate server ids', async () => {
    writeProjectMcp({
      'hive-flow': { command: 'project-hive-flow' },
      filesystem: { command: 'fs' },
    });
    writeHomeClaude({
      'hive-flow': { command: 'home-hive-flow' },
      playwright: { command: 'pw' },
    });

    const summary = await recordHealth();

    expect(summary.total).toBe(3);
    expect(summary.configured).toBe(3);
    expect(summary.runtimeUp).toBe(3);
    expect(summary.state).toBe('config-present');
    expect(summary.details?.map((row) => row.id)).toEqual([
      'hive-flow',
      'filesystem',
      'playwright',
    ]);
  });
});
