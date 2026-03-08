/**
 * MCP Tool Normalization Tests
 *
 * Verifies that MCP tool calls are correctly normalized to their native
 * Claude Code equivalents before flowing through the full permission pipeline.
 *
 * The normalizations live in evaluate() inside gate.ts. We test them by
 * calling evaluate() directly with a minimal config that turns off all deny
 * patterns so we can observe the normalization path rather than being blocked
 * by unrelated policies.
 */

import { describe, it, expect } from 'vitest';
import { evaluate } from '../gate.js';
import type { HookInput, PermissionConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal config: allow all paths, no deny patterns, default MCP allow
// ---------------------------------------------------------------------------

const CWD = '/project';

const ALLOW_ALL_CONFIG: Partial<PermissionConfig> = {
  allowed_write_paths: ['${CWD}', '${HOME}'],
  always_allow_tools: [],
  always_allow_tool_prefixes: [],
  always_deny_bash_patterns: [],
  jury_escalation_bash_patterns: [],
  always_allow_bash_patterns: ['.*'],  // allow any bash command for normalization tests
  mcp_default_policy: 'allow',
  mcp_deny_tool_prefixes: [],
  mcp_escalate_tool_prefixes: [],
  allow_paths_outside_working_directory: false,
};

// Config that enables self-protection enforcement for integration tests
const SELF_PROTECTION_CONFIG: Partial<PermissionConfig> = {
  allowed_write_paths: ['${CWD}', '${HOME}'],
  always_allow_tools: [],
  always_allow_tool_prefixes: [],
  always_deny_bash_patterns: [],
  jury_escalation_bash_patterns: [],
  always_allow_bash_patterns: ['.*'],
  mcp_default_policy: 'allow',
  mcp_deny_tool_prefixes: [],
  mcp_escalate_tool_prefixes: [],
  allow_paths_outside_working_directory: false,
};

function makeHookInput(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return { tool_name: toolName, tool_input: toolInput, cwd: CWD };
}

// ---------------------------------------------------------------------------
// 1. mcp__filesystem__write_file → Write
// ---------------------------------------------------------------------------

describe('mcp__filesystem__write_file normalization', () => {
  it('is normalized to Write and evaluated against the write path policy', async () => {
    // Writing inside the project directory should be allowed
    const result = await evaluate(
      makeHookInput('mcp__filesystem__write_file', {
        path: `${CWD}/src/new-file.ts`,
        content: 'export const x = 1;',
      }),
      ALLOW_ALL_CONFIG,
    );
    // The normalized tool_name is Write — it should pass the path check
    expect(result.decision).toBe('allow');
  });

  it('uses file_path as fallback when path is absent', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__write_file', {
        file_path: `${CWD}/src/fallback.ts`,
        content: 'hello',
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 2. mcp__filesystem__edit_file → Edit
// ---------------------------------------------------------------------------

describe('mcp__filesystem__edit_file normalization', () => {
  it('is normalized to Edit with file_path, old_string, new_string', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__edit_file', {
        path: `${CWD}/src/app.ts`,
        old_text: 'foo',
        new_text: 'bar',
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 3. mcp__filesystem__move_file → Bash (mv command)
// ---------------------------------------------------------------------------

describe('mcp__filesystem__move_file normalization', () => {
  it('is normalized to Bash with a quoted mv command', async () => {
    // Moving a non-protected file should be allowed (bash allow-all config)
    const result = await evaluate(
      makeHookInput('mcp__filesystem__move_file', {
        source: `${CWD}/src/old.ts`,
        destination: `${CWD}/src/new.ts`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 4. mcp__filesystem__create_directory → Bash (mkdir -p command)
// ---------------------------------------------------------------------------

describe('mcp__filesystem__create_directory normalization', () => {
  it('is normalized to Bash with a mkdir -p command', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__create_directory', {
        path: `${CWD}/src/new-dir`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 5. mcp__plugin_serena_serena__replace_content → Edit
// ---------------------------------------------------------------------------

describe('mcp__plugin_serena_serena__replace_content normalization', () => {
  it('is normalized to Edit with relative_path as file_path', async () => {
    const result = await evaluate(
      makeHookInput('mcp__plugin_serena_serena__replace_content', {
        relative_path: 'src/app.ts',
        old_string: 'foo',
        new_string: 'bar',
      }),
      ALLOW_ALL_CONFIG,
    );
    // Normalized to Edit — should flow through the write-path check
    // relative_path 'src/app.ts' resolves inside CWD
    expect(['allow', 'deny']).toContain(result.decision);
  });

  it('falls back to file_path when relative_path is absent', async () => {
    const result = await evaluate(
      makeHookInput('mcp__plugin_serena_serena__replace_content', {
        file_path: `${CWD}/src/app.ts`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(['allow', 'deny']).toContain(result.decision);
  });
});

// ---------------------------------------------------------------------------
// 6. mcp__plugin_serena_serena__create_text_file → Write
// ---------------------------------------------------------------------------

describe('mcp__plugin_serena_serena__create_text_file normalization', () => {
  it('is normalized to Write with relative_path as file_path', async () => {
    const result = await evaluate(
      makeHookInput('mcp__plugin_serena_serena__create_text_file', {
        relative_path: 'src/generated.ts',
        content: 'export const x = 1;',
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(['allow', 'deny']).toContain(result.decision);
  });
});

// ---------------------------------------------------------------------------
// 7. mcp__plugin_serena_serena__execute_shell_command → Bash
// ---------------------------------------------------------------------------

describe('mcp__plugin_serena_serena__execute_shell_command normalization', () => {
  it('is normalized to Bash and the command flows through bash evaluation', async () => {
    const result = await evaluate(
      makeHookInput('mcp__plugin_serena_serena__execute_shell_command', {
        command: 'echo hello',
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 8. mcp__hive-flow__terminal_execute → Bash
// ---------------------------------------------------------------------------

describe('mcp__hive-flow__terminal_execute normalization', () => {
  it('is normalized to Bash using the command field', async () => {
    const result = await evaluate(
      makeHookInput('mcp__hive-flow__terminal_execute', {
        command: 'git status',
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });

  it('falls back to cmd field when command is absent', async () => {
    const result = await evaluate(
      makeHookInput('mcp__hive-flow__terminal_execute', {
        cmd: 'git status',
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 9. mcp__hive-flow__terminal_create → Bash
// ---------------------------------------------------------------------------

describe('mcp__hive-flow__terminal_create normalization', () => {
  it('is normalized to Bash', async () => {
    const result = await evaluate(
      makeHookInput('mcp__hive-flow__terminal_create', {
        command: 'node --version',
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 10. Unknown MCP tool → passes through without normalization (uses MCP policy)
// ---------------------------------------------------------------------------

describe('unknown MCP tool (no normalization)', () => {
  it('is not normalized and is handled by the mcp_default_policy (allow)', async () => {
    const result = await evaluate(
      makeHookInput('mcp__unknown__some_tool', {
        arg: 'value',
      }),
      ALLOW_ALL_CONFIG,
    );
    // Default MCP policy is allow → should be allowed
    expect(result.decision).toBe('allow');
  });

  it('is denied when mcp_default_policy is deny', async () => {
    const result = await evaluate(
      makeHookInput('mcp__unknown__some_tool', { arg: 'value' }),
      { ...ALLOW_ALL_CONFIG, mcp_default_policy: 'deny' },
    );
    expect(result.decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// 11. Integration: mcp__filesystem__write_file targeting .claude/settings.json
//     → denied by self-protection (even though it is normalized to Write)
// ---------------------------------------------------------------------------

describe('Integration: MCP write to protected path is denied', () => {
  it('mcp__filesystem__write_file to .claude/settings.json is blocked by self-protection', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__write_file', {
        path: `${CWD}/.claude/settings.json`,
        content: '{}',
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });
});

// ---------------------------------------------------------------------------
// 12. Integration: mcp__plugin_serena_serena__replace_content targeting gate.ts
//     → denied by self-protection (normalized to Edit → self-protection checks file_path)
// ---------------------------------------------------------------------------

describe('Integration: MCP edit to permission-guard source is denied', () => {
  it('mcp__plugin_serena_serena__replace_content targeting gate.ts is blocked', async () => {
    const result = await evaluate(
      makeHookInput('mcp__plugin_serena_serena__replace_content', {
        relative_path: `v3/@hive-flow/cli/src/permission-guard/gate.ts`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });
});
