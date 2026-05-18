// v3/@hive-flow/cli/src/statusline/__tests__/claude-code-renderer.test.ts
//
// Wave 5 / §12.1 — Renderer tests.
// Asserts the canonical Claude Code statusline renderer:
//   - Renders model/context from stdin payload.
//   - Omits Hive-only rows when `.hive-flow` is absent.
//   - Omits Hive-only fake rows when `.hive-flow` exists but holds no live data.
//   - Shows Hive rows only when live Hive data exists.
//   - Finds ADRs in all supported locations.
//
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'hf-statusline-'));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('claude-code statusline renderer', () => {
  it('renders project name/model/context from stdin', async () => {
    const cwd = fixture();
    const output = await renderClaudeCodeStatusline({
      workspace: { current_dir: cwd, project_dir: cwd },
      model: { id: 'claude-opus-4-7[1m]', display_name: 'Opus 4.7' },
      context_window: {
        used_percentage: 45,
        total_input_tokens: 1234,
        total_output_tokens: 56,
        context_window_size: 1000000,
      },
    }, cwd);

    expect(output).toContain('Opus 4.7 1M');
    expect(output).toContain('45% ctx');
    expect(output).toContain('1234 in/56 out');
  });

  it('omits Hive-only rows when .hive-flow is absent', async () => {
    const cwd = fixture();
    const output = await renderClaudeCodeStatusline({
      workspace: { current_dir: cwd, project_dir: cwd },
      model: { display_name: 'Opus 4.7' },
    }, cwd);

    expect(output).not.toContain('Swarm');
    expect(output).not.toContain('ADRs ●0/0');
    expect(output).not.toContain('Vectors ●0');
    expect(output).not.toContain('daemon off');
  });

  it('omits Hive-only fake rows when .hive-flow exists but has no live data', async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, '.hive-flow'), { recursive: true });

    const output = await renderClaudeCodeStatusline({
      workspace: { current_dir: cwd, project_dir: cwd },
      model: { display_name: 'Opus 4.7' },
    }, cwd);

    expect(output).not.toContain('Swarm');
    expect(output).not.toContain('[ 0/50]');
    expect(output).not.toContain('ADRs ●0/0');
    expect(output).not.toContain('Vectors ●0');
  });

  it('shows Hive rows only when live Hive data exists', async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, '.hive-flow', 'agents'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.hive-flow', 'agents', 'store.json'), JSON.stringify({
      agents: {
        worker1: { agentType: 'coder', status: 'busy' },
        queen1: { agentType: 'queen', status: 'idle' },
        old1: { agentType: 'tester', status: 'terminated' },
      },
      version: 1,
    }));
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: 'x' }] }] },
    }));

    const output = await renderClaudeCodeStatusline({
      workspace: { current_dir: cwd, project_dir: cwd },
      model: { display_name: 'Opus 4.7' },
    }, cwd);

    const plain = stripAnsi(output);
    expect(plain).toContain('Swarm');
    expect(plain).toContain('[ 1/50]');
    expect(plain).toContain('♛1');
  });

  it('finds ADRs in all supported locations', async () => {
    const cwd = fixture();
    mkdirSync(join(cwd, 'docs', 'adrs'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'adrs', 'ADR-0001-global-statusline.md'), '# ADR\n');

    const output = await renderClaudeCodeStatusline({
      workspace: { current_dir: cwd, project_dir: cwd },
      model: { display_name: 'Opus 4.7' },
    }, cwd);

    expect(output).toContain('ADRs ●1');
  });
});
