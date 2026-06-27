// v3/@hive-flow/cli/src/statusline/__tests__/stdin-workspace-launcher.test.ts
//
// Claude Code can invoke the statusline process from a cwd that is not the
// project checkout. The renderer must honor Claude's stdin workspace before
// falling back to process.cwd(), otherwise live swarm rows disappear.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function writeLiveAgentStore(projectRoot: string): void {
  const dir = join(projectRoot, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'store.json'),
    JSON.stringify({
      version: '1.0',
      agents: {
        'live-worker': {
          agentId: 'live-worker',
          agentType: 'verifier',
          status: 'busy',
          ownerSessionId: 'statusline-stdin-session',
          currentTaskPid: process.pid,
        },
      },
    }),
    'utf8',
  );
}

describe('statusline launcher workspace resolution', () => {
  let outsideCwd: string;
  let projectRoot: string;

  beforeEach(() => {
    outsideCwd = mkdtempSync(join(tmpdir(), 'hf-statusline-outside-cwd-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-statusline-project-'));
    writeLiveAgentStore(projectRoot);
  });

  afterEach(() => {
    rmSync(outsideCwd, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('uses Claude stdin workspace when process cwd is outside the repo', async () => {
    const previousCwd = process.cwd();
    process.chdir(outsideCwd);
    try {
      const output = await renderClaudeCodeStatusline({
        session_id: 'statusline-stdin-session',
        workspace: { current_dir: projectRoot, project_dir: projectRoot },
        model: { display_name: 'Opus 4.8' },
      });
      const plain = stripAnsi(output);
      expect(plain).toContain('Swarm ◉');
      expect(plain).toContain('[ 1/150]');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('statusline entrypoints do not override Claude stdin workspace with process.cwd()', () => {
    const entrypoints = [
      new URL('../../../bin/statusline.js', import.meta.url),
      new URL('../../commands/hooks.ts', import.meta.url),
      new URL('../../commands/statusline.ts', import.meta.url),
    ];

    for (const entrypoint of entrypoints) {
      const source = readFileSync(entrypoint, 'utf8');
      expect(source).not.toContain('renderClaudeCodeStatuslineWithMeta(stdinData, process.cwd())');
    }
  });
});
