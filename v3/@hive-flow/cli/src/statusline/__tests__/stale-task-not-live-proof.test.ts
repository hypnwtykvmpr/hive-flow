// v3/@hive-flow/cli/src/statusline/__tests__/stale-task-not-live-proof.test.ts
//
// PROOF 3 — STATUSLINE STALE-TASK-NOT-LIVE: the Swarm row is driven by the
// agent store (.hive-flow/agents/store.json), NOT by stale task-metadata files
// or their sibling .result.json files.
//
// This test encodes the REQUIRED corrected behavior per the statusboard-fix spec.
//
// Scenario: a project has:
//   - .hive-flow/agents/store.json with NO live agents (all terminal/absent)
//   - .hive-flow/tasks/<id>.json task-metadata files (stale)
//   - .hive-flow/tasks/<id>.result.json sibling result files (stale)
//
// The renderer MUST:
//   a. NOT treat task-metadata or .result.json presence as "agents are active".
//   b. NOT render "◉" in the Swarm row for this state.
//   c. Omit the Swarm row unless a non-terminal agent has live process evidence.
//
// Three sub-cases are tested:
//   1. store.json has zero live agents + stale task files → Swarm row OMITTED.
//   2. store.json has idle-only agents + stale task files → Swarm row OMITTED.
//   3. store.json ABSENT (no agents dir) + task files present → no Swarm row.
//
// Harness conventions follow claude-code-renderer.test.ts:
//   - mkdtempSync for isolation
//   - writeFileSync for fixtures
//   - renderClaudeCodeStatusline as the system under test
//   - stripAnsi helper

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function stdinFor(projectRoot: string): Record<string, unknown> {
  return {
    workspace: { current_dir: projectRoot, project_dir: projectRoot },
    session_id: 'session-a',
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 15,
      total_input_tokens: 15_000,
      total_output_tokens: 2_000,
      context_window_size: 200_000,
    },
  };
}

/**
 * Write stale task-metadata and result files under .hive-flow/tasks/.
 * These simulate tasks that completed/were dispatched but whose metadata files
 * still exist on disk — a normal condition after agent completion.
 */
function writeStaleTaskFiles(projectRoot: string, taskIds: string[]): void {
  const tasksDir = join(projectRoot, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  for (const taskId of taskIds) {
    // Task tracking metadata file (e.g. <taskId>.json).
    writeFileSync(
      join(tasksDir, `${taskId}.json`),
      JSON.stringify({
        taskId,
        agentId: `agent-for-${taskId}`,
        provider: 'codex-cli',
        status: 'running',
        createdAt: new Date(Date.now() - 600_000).toISOString(), // 10 min ago
      }),
      'utf8',
    );

    // Sibling result file (<taskId>.result.json) — written by the agent on completion.
    writeFileSync(
      join(tasksDir, `${taskId}.result.json`),
      JSON.stringify({
        taskId,
        status: 'complete',
        output: 'task output here',
        completedAt: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
      }),
      'utf8',
    );
  }
}

/**
 * Write .hive-flow/agents/store.json with the given agent records.
 * Pass an empty object for agents to simulate zero live agents.
 */
function writeAgentStore(
  projectRoot: string,
  agents: Record<string, { agentId: string; agentType: string; status: string; ownerSessionId?: string; currentTaskPid?: number }>,
): void {
  const dir = join(projectRoot, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'store.json'),
    JSON.stringify({ version: '1.0', agents }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Proof 3 — stale task-metadata files do not make Swarm row show executing', () => {
  let projectRoot: string;
  let originalForceColor: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-stale-task-proof-'));
    originalForceColor = process.env.FORCE_COLOR;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '0';
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  it('sub-case 1: store.json empty + stale task/result files → Swarm row omitted entirely', async () => {
    // Zero live agents in store.
    writeAgentStore(projectRoot, {});

    // Several stale task-metadata + result files still on disk.
    writeStaleTaskFiles(projectRoot, ['task-001', 'task-002', 'task-003']);

    const output = await renderClaudeCodeStatusline(stdinFor(projectRoot), projectRoot);
    const plain = stripAnsi(output);

    // SPEC: no live agents in store → Swarm row must NOT appear.
    expect(plain).not.toContain('Swarm');
    // SPEC: "◉" must not appear — stale tasks do not count as executing.
    expect(plain).not.toContain('◉');
    // SPEC: "○" must not appear either — there are NO agents at all.
    // (The "○" is only shown when queens > 0 with zero worker total.)
    // The key assertion is that the stale .result.json files did not inflate
    // the executing count.
    expect(plain).not.toContain('Swarm ◉');
  });

  it('sub-case 1b: store.json with ALL terminal agents + stale tasks → Swarm row omitted', async () => {
    // All agents are in terminal states — normalizeAgentStatus drops them.
    writeAgentStore(projectRoot, {
      'old-1': { agentId: 'old-1', agentType: 'coder', status: 'terminated' },
      'old-2': { agentId: 'old-2', agentType: 'tester', status: 'complete' },
      'old-3': { agentId: 'old-3', agentType: 'reviewer', status: 'failed' },
      'old-4': { agentId: 'old-4', agentType: 'planner', status: 'cancelled' },
    });

    // Matching stale task + result files.
    writeStaleTaskFiles(projectRoot, ['task-old-1', 'task-old-2', 'task-old-3', 'task-old-4']);

    const output = await renderClaudeCodeStatusline(stdinFor(projectRoot), projectRoot);
    const plain = stripAnsi(output);

    // SPEC: all agents terminal → live count is zero → Swarm row omitted.
    expect(plain).not.toContain('Swarm');
    // SPEC: "◉" must not appear — stale tasks with sibling .result.json must
    // not be treated as executing agents.
    expect(plain).not.toContain('◉');
  });

  it('sub-case 2: store.json with idle-only agents + stale tasks → Swarm row omitted', async () => {
    // Idle records without live process evidence are bookkeeping, not live agents.
    writeAgentStore(projectRoot, {
      'idle-1': { agentId: 'idle-1', agentType: 'coder', status: 'idle' },
      'idle-2': { agentId: 'idle-2', agentType: 'tester', status: 'idle' },
    });

    // Stale task files present — these must NOT cause "◉" to appear.
    writeStaleTaskFiles(projectRoot, ['task-done-a', 'task-done-b', 'task-done-c']);

    const output = await renderClaudeCodeStatusline(stdinFor(projectRoot), projectRoot);
    const plain = stripAnsi(output);

    // SPEC: idle-only records with no live process evidence are not live.
    expect(plain).not.toContain('Swarm');
    // SPEC: "◉" must NOT appear — stale task files must not inflate executing count.
    expect(plain).not.toContain('Swarm ◉');
    expect(plain).not.toMatch(/\[\s*3\/\d+\]/);
    expect(plain).not.toMatch(/\[\s*5\/\d+\]/);
  });

  it('sub-case 3: no .hive-flow/agents/ directory + stale task files → no Swarm row', async () => {
    // Create .hive-flow/ but omit the agents/ subdirectory entirely.
    mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });

    // Stale task + result files exist under .hive-flow/tasks/.
    writeStaleTaskFiles(projectRoot, ['task-x1', 'task-x2']);

    const output = await renderClaudeCodeStatusline(stdinFor(projectRoot), projectRoot);
    const plain = stripAnsi(output);

    // SPEC: no agents dir → Swarm row must not appear.
    expect(plain).not.toContain('Swarm');
    // SPEC: stale task files with .result.json siblings do NOT trigger "◉".
    expect(plain).not.toContain('◉');
  });

  it('sub-case 4: store.json absent entirely + task files → no Swarm row', async () => {
    // .hive-flow/agents/ dir exists but store.json file is absent.
    mkdirSync(join(projectRoot, '.hive-flow', 'agents'), { recursive: true });

    // Several stale task + result files.
    writeStaleTaskFiles(projectRoot, ['task-y1', 'task-y2', 'task-y3']);

    const output = await renderClaudeCodeStatusline(stdinFor(projectRoot), projectRoot);
    const plain = stripAnsi(output);

    // SPEC: no store.json → no agents → Swarm row absent.
    expect(plain).not.toContain('Swarm');
    expect(plain).not.toContain('◉');
  });

  it('control: busy agent in store.json makes Swarm row "◉" regardless of task files', async () => {
    // A live busy agent in store → "◉" expected (control case to verify the
    // test is meaningful — we can distinguish "◉" from "○").
    // A positive currentTaskPid is required for the phantom-activity fix to
    // count this agent as executing; use process.pid (always alive).
    const livePid = process.pid;
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeAgentStore(projectRoot, {
      'live-1': {
        agentId: 'live-1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'session-a',
        currentTaskPid: livePid,
      },
    });

    // Stale task files also present (should not change the outcome).
    writeStaleTaskFiles(projectRoot, ['task-stale-z1']);

    const output = await renderClaudeCodeStatusline(stdinFor(projectRoot), projectRoot);
    const plain = stripAnsi(output);

    // Control: a real live busy agent in store → "◉".
    expect(plain).toContain('Swarm');
    expect(plain).toContain('Swarm ◉');
  });
});
