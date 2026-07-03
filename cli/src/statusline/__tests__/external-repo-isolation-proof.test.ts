// cli/src/statusline/__tests__/external-repo-isolation-proof.test.ts
//
// PROOF 2 — EXTERNAL-TEMP-REPO ISOLATION: agents from repo A must NOT appear
// in repo B's statusline Swarm row.
//
// This test encodes the REQUIRED corrected behavior per the statusboard-fix
// spec. The statusline is project-scoped: each repo's `.hive-flow/agents/store.json`
// is independent. A repo that has NO live agents must render NO Swarm row (or an
// empty/omitted Swarm), even if another repo on the same machine has many
// active agents in its own store.
//
// Assertions:
//   a. Repo A: store.json with busy agents → Swarm row present with those agents.
//   b. Repo B (separate tmp dir, own .hive-flow/): store.json with NO live
//      agents → Swarm row omitted entirely (no "Swarm" token in output).
//   c. Repo B has NO Swarm content from repo A's agents.
//   d. Repo C (no .hive-flow/ at all) → no Swarm row, no cross-contamination.
//
// Harness conventions follow project-scope.test.ts and claude-code-renderer.test.ts:
//   - mkdtempSync for isolation
//   - writeFileSync for fixtures
//   - renderClaudeCodeStatusline as the system under test
//   - stripAnsi helper

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/** Write a minimal .hive-flow/agents/store.json with the given agent records. */
function writeAgentStore(
  projectRoot: string,
  agents: Record<string, {
    agentId: string;
    agentType: string;
    status: string;
    ownerSessionId?: string;
    currentTaskPid?: number;
  }>,
): void {
  const dir = join(projectRoot, '.hive-flow', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'store.json'),
    JSON.stringify({ version: '1.0', agents }),
    'utf8',
  );
}

/**
 * Standard stdin payload for renderer. Sets workspace.current_dir to
 * `projectRoot` so the renderer resolves scope to that directory.
 */
function stdinFor(projectRoot: string, sessionId = 'repo-isolation-session'): Record<string, unknown> {
  return {
    session_id: sessionId,
    workspace: { current_dir: projectRoot, project_dir: projectRoot },
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 10,
      total_input_tokens: 10_000,
      total_output_tokens: 1_000,
      context_window_size: 200_000,
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Proof 2 — external-temp-repo isolation: agents are project-scoped', () => {
  let repoA: string;
  let repoB: string;
  let repoC: string;
  let originalForceColor: string | undefined;
  let originalNoColor: string | undefined;

  beforeEach(() => {
    repoA = mkdtempSync(join(tmpdir(), 'hf-isolation-repo-a-'));
    repoB = mkdtempSync(join(tmpdir(), 'hf-isolation-repo-b-'));
    repoC = mkdtempSync(join(tmpdir(), 'hf-isolation-repo-c-'));
    originalForceColor = process.env.FORCE_COLOR;
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '0';
  });

  afterEach(() => {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
    rmSync(repoC, { recursive: true, force: true });
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  it('repo A with busy agents shows Swarm row with those agents', async () => {
    // Repo A has 2 live busy agents plus one ownerless/no-PID idle record.
    // Only owned records with live process evidence are allowed in Swarm.
    writeAgentStore(repoA, {
      'agent-a1': {
        agentId: 'agent-a1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
      'agent-a2': {
        agentId: 'agent-a2',
        agentType: 'tester',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
      'agent-a3': { agentId: 'agent-a3', agentType: 'reviewer', status: 'idle' },
    });

    const output = await renderClaudeCodeStatusline(stdinFor(repoA), repoA);
    const plain = stripAnsi(output);

    // Repo A has live agents → Swarm row must be present.
    expect(plain).toContain('Swarm');
    // 2 owned + live busy agents are counted; the idle bookkeeping row is not.
    expect(plain).toMatch(/\[\s*2\/\d+\]/);
  });

  it('repo B with NO live agents shows NO Swarm row regardless of repo A', async () => {
    // Repo A: populated with busy agents.
    writeAgentStore(repoA, {
      'agent-a1': { agentId: 'agent-a1', agentType: 'coder', status: 'busy' },
      'agent-a2': { agentId: 'agent-a2', agentType: 'tester', status: 'busy' },
    });

    // Repo B: has .hive-flow/ but only terminated agents (all terminal => drop from count).
    writeAgentStore(repoB, {
      'agent-b1': { agentId: 'agent-b1', agentType: 'coder', status: 'terminated' },
      'agent-b2': { agentId: 'agent-b2', agentType: 'tester', status: 'complete' },
    });

    // Render repo B's statusline using repo B's projectRoot.
    const output = await renderClaudeCodeStatusline(stdinFor(repoB), repoB);
    const plain = stripAnsi(output);

    // SPEC: repo B has no live agents → Swarm row must NOT appear.
    expect(plain).not.toContain('Swarm');
    // SPEC: repo A's agents (agent-a1, agent-a2) must NOT bleed into repo B's output.
    expect(plain).not.toContain('agent-a1');
    expect(plain).not.toContain('agent-a2');
  });

  it('repo B idle-only no-PID store renders no Swarm row and contains no repo A agents', async () => {
    // Repo A: 3 busy agents.
    writeAgentStore(repoA, {
      'agent-a1': {
        agentId: 'agent-a1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
      'agent-a2': {
        agentId: 'agent-a2',
        agentType: 'architect',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
      'agent-a3': {
        agentId: 'agent-a3',
        agentType: 'reviewer',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
    });

    // Repo B: only idle agents — no active execution.
    writeAgentStore(repoB, {
      'agent-b1': { agentId: 'agent-b1', agentType: 'coder', status: 'idle' },
      'agent-b2': { agentId: 'agent-b2', agentType: 'tester', status: 'idle' },
    });

    const output = await renderClaudeCodeStatusline(stdinFor(repoB), repoB);
    const plain = stripAnsi(output);

    // SPEC: idle/no-PID bookkeeping is not live agent evidence.
    expect(plain).not.toContain('Swarm');
    // SPEC: repo A's executing agents must not bleed in.
    expect(plain).not.toContain('Swarm ◉');
    // SPEC: repo A's count (3) must not appear in repo B's slot.
    expect(plain).not.toMatch(/\[\s*3\/\d+\]/);
  });

  it('repo C (no .hive-flow/) has no Swarm row even when repo A is fully active', async () => {
    // Repo A: many busy agents to ensure cross-contamination would be visible.
    writeAgentStore(repoA, {
      'agent-a1': {
        agentId: 'agent-a1',
        agentType: 'coder',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
      'agent-a2': {
        agentId: 'agent-a2',
        agentType: 'tester',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
      'agent-a3': {
        agentId: 'agent-a3',
        agentType: 'reviewer',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
      'agent-a4': {
        agentId: 'agent-a4',
        agentType: 'architect',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
      'agent-a5': {
        agentId: 'agent-a5',
        agentType: 'queen',
        status: 'busy',
        ownerSessionId: 'repo-isolation-session',
        currentTaskPid: process.pid,
      },
    });

    // Repo C: no .hive-flow/ directory at all — header-only mode.
    const output = await renderClaudeCodeStatusline(stdinFor(repoC), repoC);
    const plain = stripAnsi(output);

    // SPEC: header-only mode → no Swarm row.
    expect(plain).not.toContain('Swarm');
    // SPEC: none of repo A's agents leak into repo C's output.
    expect(plain).not.toContain('agent-a1');
    expect(plain).not.toContain('agent-a5');
  });

  it('two repos with independent idle no-PID records omit Swarm without cross-contamination', async () => {
    // Repo A: 4 idle bookkeeping records.
    writeAgentStore(repoA, {
      'a1': { agentId: 'a1', agentType: 'coder', status: 'idle' },
      'a2': { agentId: 'a2', agentType: 'tester', status: 'idle' },
      'a3': { agentId: 'a3', agentType: 'reviewer', status: 'idle' },
      'a4': { agentId: 'a4', agentType: 'planner', status: 'idle' },
    });

    // Repo B: 2 idle bookkeeping records.
    writeAgentStore(repoB, {
      'b1': { agentId: 'b1', agentType: 'coder', status: 'idle' },
      'b2': { agentId: 'b2', agentType: 'tester', status: 'idle' },
    });

    const [outputA, outputB] = await Promise.all([
      renderClaudeCodeStatusline(stdinFor(repoA), repoA),
      renderClaudeCodeStatusline(stdinFor(repoB), repoB),
    ]);

    const plainA = stripAnsi(outputA);
    const plainB = stripAnsi(outputB);

    // Idle/no-PID records are not live agents.
    expect(plainA).not.toContain('Swarm');
    expect(plainB).not.toContain('Swarm');

    // No cross-contamination: repo A count must not appear in repo B's slot.
    expect(plainB).not.toMatch(/\[\s*4\/\d+\]/);
    // No cross-contamination: repo B count must not appear in repo A's slot.
    expect(plainA).not.toMatch(/\[\s*2\/\d+\]/);
  });
});
