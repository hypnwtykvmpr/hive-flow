import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function stdinPayload(projectRoot: string, sessionId?: string): Record<string, unknown> {
  return {
    workspace: { current_dir: projectRoot, project_dir: projectRoot },
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 25,
      total_input_tokens: 25_000,
      total_output_tokens: 100,
      context_window_size: 200_000,
    },
  };
}

function writeSwarmStore(projectRoot: string, ownerSessionId?: string): void {
  writeJson(join(projectRoot, '.hive-flow', 'agents', 'store.json'), {
    version: '1.0',
    agents: {
      coder: {
        agentId: 'coder',
        agentType: 'coder',
        status: 'busy',
        currentTaskPid: process.pid,
        ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
      },
    },
  });
}

function writeHive(
  projectRoot: string,
  hiveId: string,
  ownerSessionId: string | undefined,
): void {
  writeJson(join(projectRoot, '.hive-flow', 'hives', hiveId, 'hive.json'), {
    hiveId,
    status: 'active',
    ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
    workers: [
      {
        workerId: `${hiveId}-worker`,
        agentId: `${hiveId}-worker`,
        status: 'busy',
        currentTaskPid: process.pid,
      },
    ],
  });
}

function swarmRow(rendered: string): string {
  const row = stripAnsi(rendered).split('\n').find((line) => line.includes('🪪 Swarm'));
  expect(row).toBeDefined();
  return row ?? '';
}

describe('statusline R7 swarm session tag', () => {
  let projectRoot: string;
  let home: string;
  let originalHome: string | undefined;
  let originalNoColor: string | undefined;
  let originalForceColor: string | undefined;
  let originalCodexSession: string | undefined;
  let originalCodexThread: string | undefined;
  let originalClaudeSession: string | undefined;
  let originalAgenticSession: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-statusline-r7-'));
    home = mkdtempSync(join(tmpdir(), 'hf-statusline-r7-home-'));
    originalHome = process.env.HIVE_FLOW_HOME;
    originalNoColor = process.env.NO_COLOR;
    originalForceColor = process.env.FORCE_COLOR;
    originalCodexSession = process.env.CODEX_SESSION_ID;
    originalCodexThread = process.env.CODEX_THREAD_ID;
    originalClaudeSession = process.env.CLAUDE_SESSION_ID;
    originalAgenticSession = process.env.HIVE_FLOW_SESSION_ID;
    process.env.HIVE_FLOW_HOME = home;
    process.env.FORCE_COLOR = '0';
    process.env.NO_COLOR = '1';
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;
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
    if (originalCodexSession === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = originalCodexSession;
    if (originalCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = originalCodexThread;
    if (originalClaudeSession === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = originalClaudeSession;
    if (originalAgenticSession === undefined) delete process.env.HIVE_FLOW_SESSION_ID;
    else process.env.HIVE_FLOW_SESSION_ID = originalAgenticSession;
  });

  it('annotates active hives split between the current session and other sessions', async () => {
    writeSwarmStore(projectRoot, 'sid-current');
    writeHive(projectRoot, 'hive-current', 'sid-current');
    writeHive(projectRoot, 'hive-other', 'sid-other');

    const row = swarmRow(await renderClaudeCodeStatusline(stdinPayload(projectRoot, 'sid-current'), projectRoot));

    expect(row).toContain('hives 1 this/1 other');
  });

  it('does not surface ownerless active hives in the session tag', async () => {
    writeSwarmStore(projectRoot, 'sid-current');
    writeHive(projectRoot, 'hive-current', 'sid-current');
    writeHive(projectRoot, 'hive-unowned', undefined);

    const row = swarmRow(await renderClaudeCodeStatusline(stdinPayload(projectRoot, 'sid-current'), projectRoot));

    expect(row).not.toContain('unowned');
    expect(row).not.toContain('hives');
  });

  it('omits ownerless hives instead of rendering an unowned bucket', async () => {
    writeSwarmStore(projectRoot, 'sid-current');
    writeHive(projectRoot, 'hive-unowned', undefined);

    const row = swarmRow(await renderClaudeCodeStatusline(stdinPayload(projectRoot, 'sid-current'), projectRoot));

    expect(row).not.toContain('unowned');
    expect(row).not.toContain('hives');
  });

  it('leaves the swarm row unchanged when there is no current session id', async () => {
    writeSwarmStore(projectRoot, 'sid-current');
    const baseline = swarmRow(await renderClaudeCodeStatusline(stdinPayload(projectRoot), projectRoot));

    writeHive(projectRoot, 'hive-current', 'sid-current');
    writeHive(projectRoot, 'hive-other', 'sid-other');
    const withHives = swarmRow(await renderClaudeCodeStatusline(stdinPayload(projectRoot), projectRoot));

    expect(withHives).toBe(baseline);
  });

  it('leaves the swarm row unchanged when every active hive belongs to the current session', async () => {
    writeSwarmStore(projectRoot, 'sid-current');
    const baseline = swarmRow(await renderClaudeCodeStatusline(stdinPayload(projectRoot, 'sid-current'), projectRoot));

    writeHive(projectRoot, 'hive-a', 'sid-current');
    writeHive(projectRoot, 'hive-b', 'sid-current');
    const withOwnedHives = swarmRow(
      await renderClaudeCodeStatusline(stdinPayload(projectRoot, 'sid-current'), projectRoot),
    );

    expect(withOwnedHives).toBe(baseline);
  });
});
