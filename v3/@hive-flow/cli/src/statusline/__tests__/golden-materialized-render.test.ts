import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';
import { statuslinePaths } from '../paths.js';

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function stdinPayload(projectRoot: string): Record<string, unknown> {
  return {
    workspace: { current_dir: projectRoot, project_dir: projectRoot },
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 42,
      total_input_tokens: 42_000,
      total_output_tokens: 3_000,
      context_window_size: 200_000,
    },
  };
}

describe('statusline golden render from materialized producer files', () => {
  let projectRoot: string;
  let home: string;
  let originalHome: string | undefined;
  let originalNoColor: string | undefined;
  let originalForceColor: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-statusline-golden-'));
    home = mkdtempSync(join(tmpdir(), 'hf-statusline-golden-home-'));
    originalHome = process.env.HIVE_FLOW_HOME;
    originalNoColor = process.env.NO_COLOR;
    originalForceColor = process.env.FORCE_COLOR;
    process.env.HIVE_FLOW_HOME = home;
    process.env.FORCE_COLOR = '0';
    process.env.NO_COLOR = '1';
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HIVE_FLOW_HOME;
    else process.env.HIVE_FLOW_HOME = originalHome;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  it('renders an 8-row box with Memory Embeddings/Memories/storage/Tests/MCP from producer-shaped files', async () => {
    const paths = statuslinePaths(projectRoot);
    const observedAt = '2026-06-02T12:00:00.000Z';

    writeJson(paths.scoreboardCurrent, {
      agentsByProvider: {
        codex: { activeAgents: 1, idleAgents: 0, staleAgents: 0 },
      },
      callsByProvider: {},
      stale: false,
      lastUpdatedAt: observedAt,
    });
    writeJson(join(projectRoot, '.hive-flow', 'agents', 'store.json'), {
      version: '1.0',
      agents: {
        coder: { agentId: 'coder', agentType: 'coder', status: 'busy' },
        queen: { agentId: 'queen', agentType: 'queen', status: 'idle' },
      },
    });
    writeJson(paths.memoryStats, {
      sourceDescription: 'hivememory',
      embeddings: { count: 12, source: 'hivememory', observedAt },
      memories: { count: 34, source: 'hivememory', observedAt },
      dbSizeBytes: 8192,
    });
    writeJson(paths.testsCurrent, {
      suite: {
        version: 1,
        eventId: 'suite-golden',
        ts: observedAt,
        repoRoot: projectRoot,
        projectKey: '0123456789abcdef',
        runner: 'vitest',
        kind: 'suite',
        passed: 3655,
        failed: 0,
        skipped: 0,
        total: 3655,
        producerKind: 'wrapper',
        producerId: 'pnpm',
      },
    });
    writeJson(paths.mcpHealth, {
      version: 1,
      observedAt,
      probeVersion: 1,
      source: 'setup-verify-json-rpc',
      total: 3,
      configured: 3,
      runtimeUp: 2,
      state: 'config-present',
      details: [
        { id: 'hive-flow', configured: true, runtime: 'up', reason: 'configured' },
        { id: 'filesystem', configured: true, runtime: 'up', reason: 'configured' },
        { id: 'github', configured: true, runtime: 'down', reason: 'not-running' },
      ],
    });
    writeJson(paths.attentionCurrent, {
      unresolved: [
        {
          id: 'attn-golden',
          ts: observedAt,
          severity: 'warn',
          source: 'test',
          message: 'golden attention row',
        },
      ],
    });
    writeJson(join(projectRoot, '.hive-flow', 'daemon-state.json'), {
      running: true,
      pid: 12345,
    });

    const output = await renderClaudeCodeStatusline(stdinPayload(projectRoot), projectRoot);
    const plainLines = stripAnsi(output).split('\n');

    expect(plainLines).toHaveLength(8);
    const memoryRow = plainLines.find((line) => line.includes('Memory'));
    expect(memoryRow).toBeDefined();
    expect(memoryRow).toContain('Embeddings 12');
    expect(memoryRow).toContain('Memories 34');
    expect(memoryRow).toContain('8KB');
    expect(memoryRow).toContain('Tests 3655');
    expect(memoryRow).toMatch(/MCP\s+2\/3/);
  });

  it('omits Memory/Tests/MCP instead of faking them when materialized files are absent', async () => {
    mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });

    const output = await renderClaudeCodeStatusline(stdinPayload(projectRoot), projectRoot);
    const plain = stripAnsi(output);

    expect(plain).not.toContain('Memory');
    expect(plain).not.toContain('Embeddings');
    expect(plain).not.toContain('Memories');
    expect(plain).not.toContain('Tests');
    expect(plain).not.toContain('MCP');
    expect(plain).not.toMatch(/MCP\s+0\/0/);
  });
});
