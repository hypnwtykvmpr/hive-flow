import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';
import { statuslinePaths } from '../paths.js';

interface GoldenCase {
  mustContain: string[];
  mustNotContain: string[];
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function readGolden(): Record<string, GoldenCase> {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'global-statusline-render.golden.json'), 'utf8'),
  ) as Record<string, GoldenCase>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function stdinPayload(cwd: string, model = 'Opus 4.8'): Record<string, unknown> {
  return {
    cwd,
    workspace: { current_dir: cwd, project_dir: cwd },
    model: { id: model.toLowerCase().replace(/\s+/g, '-'), display_name: model },
    context_window: {
      used_percentage: 31,
      total_input_tokens: 31_000,
      total_output_tokens: 1_200,
      context_window_size: 1_000_000,
    },
  };
}

function assertGolden(output: string, golden: GoldenCase): void {
  const plain = stripAnsi(output);
  expect(plain.trim()).not.toBe('');
  for (const fragment of golden.mustContain) {
    expect(plain).toContain(fragment);
  }
  for (const fragment of golden.mustNotContain) {
    expect(plain).not.toContain(fragment);
  }
}

describe('global Claude Code statusline render by session cwd', () => {
  let root: string;
  let home: string;
  let originalHiveHome: string | undefined;
  let originalNoColor: string | undefined;
  let originalForceColor: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-global-statusline-'));
    home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    originalHiveHome = process.env.HIVE_FLOW_HOME;
    originalNoColor = process.env.NO_COLOR;
    originalForceColor = process.env.FORCE_COLOR;
    process.env.HIVE_FLOW_HOME = home;
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '0';
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalHiveHome === undefined) delete process.env.HIVE_FLOW_HOME;
    else process.env.HIVE_FLOW_HOME = originalHiveHome;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  it('renders hive-flow, non-hive, and no-repo sessions relative to each cwd without throwing', async () => {
    const golden = readGolden();
    const hiveFlowRepo = join(root, 'hive-flow');
    const nonHiveRepo = join(root, 'other-repo');
    const noRepo = join(root, 'loose-dir');
    mkdirSync(hiveFlowRepo, { recursive: true });
    mkdirSync(nonHiveRepo, { recursive: true });
    mkdirSync(noRepo, { recursive: true });

    const paths = statuslinePaths(hiveFlowRepo);
    const observedAt = new Date().toISOString();
    writeJson(paths.cache, {
      version: 1,
      projectRoot: hiveFlowRepo,
      repoIdentity: hiveFlowRepo,
      displayName: 'hive-flow',
      projectKey: '0123456789abcdef',
      generatedAt: observedAt,
      sources: {},
      scoreboard: {
        agentsByProvider: {
          codex: { activeAgents: 2, idleAgents: 0, staleAgents: 0 },
        },
        callsByProvider: {},
        stale: false,
      },
      tests: {
        suite: {
          version: 1,
          eventId: 'suite-global',
          ts: observedAt,
          repoRoot: hiveFlowRepo,
          projectKey: '0123456789abcdef',
          runner: 'vitest',
          kind: 'suite',
          passed: 12,
          failed: 0,
          skipped: 0,
          total: 12,
          producerKind: 'wrapper',
          producerId: 'vitest',
        },
      },
      mcp: {
        version: 1,
        observedAt,
        probeVersion: 1,
        source: 'setup-verify-json-rpc',
        total: 2,
        configured: 2,
        runtimeUp: 1,
        state: 'config-present',
      },
      daemon: { running: true, health: 'healthy', observedAt },
    });

    assertGolden(
      await renderClaudeCodeStatusline(stdinPayload(hiveFlowRepo), process.cwd()),
      golden.hiveFlowRepo,
    );
    assertGolden(
      await renderClaudeCodeStatusline(stdinPayload(nonHiveRepo), process.cwd()),
      golden.nonHiveRepo,
    );
    assertGolden(
      await renderClaudeCodeStatusline(stdinPayload(noRepo, 'Fable 5'), process.cwd()),
      golden.noRepo,
    );
  });
});
