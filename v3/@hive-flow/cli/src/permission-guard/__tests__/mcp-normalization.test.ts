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
// 1b. Filesystem read tools must not expose enforcement HMAC key material
// ---------------------------------------------------------------------------

describe('filesystem read tools sensitive-path guard', () => {
  it.each([
    'mcp__filesystem__read_file',
    'mcp__filesystem__read_text_file',
    'mcp__filesystem__read_media_file',
  ])('blocks %s from reading .hive-flow/enforcement/.hmac-key', async (toolName) => {
    const result = await evaluate(
      makeHookInput(toolName, {
        path: `${CWD}/.hive-flow/enforcement/.hmac-key`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('protected enforcement');
  });

  it('blocks mcp__filesystem__read_multiple_files when any path is the enforcement HMAC key', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__read_multiple_files', {
        paths: [
          `${CWD}/src/app.ts`,
          `${CWD}/.hive-flow/enforcement/.hmac-key`,
        ],
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('protected enforcement');
  });

  it('blocks native Read from reading .hive-flow/enforcement/.hmac-key before always-allow tools', async () => {
    const result = await evaluate(
      makeHookInput('Read', {
        file_path: `${CWD}/.hive-flow/enforcement/.hmac-key`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('protected enforcement');
  });

  it('blocks mixed-case reads of the enforcement HMAC key on case-insensitive filesystems', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__read_text_file', {
        path: `${CWD}/.HIVE-FLOW/ENFORCEMENT/.hmac-key`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('protected enforcement');
  });

  it.each([
    ['.env'],
    ['.hive-flow/enforcement/state.json'],
    ['.claude/settings.json'],
    ['.claude/settings.local.json'],
  ])('blocks mcp__filesystem__read_file from reading protected policy path %s', async (filePath) => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__read_file', {
        path: `${CWD}/${filePath}`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('protected enforcement');
  });

  it('allows read_file for non-sensitive project files', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__read_file', {
        path: `${CWD}/src/app.ts`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Launcher cwd vs real project root
// ---------------------------------------------------------------------------

describe('Write/Edit project-root resolution', () => {
  it('allows writes under HIVE_FLOW_PROJECT_ROOT when cwd is a launcher repo', async () => {
    const previousProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT;
    process.env.HIVE_FLOW_PROJECT_ROOT = '/real/project';

    try {
      const result = await evaluate(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: '/real/project/v3/docs/design/global-hive-flow-plan.md',
            content: '# plan\n',
          },
          cwd: '/launcher/hive-flow',
        },
        {
          ...ALLOW_ALL_CONFIG,
          allowed_write_paths: [],
        },
      );

      expect(result.decision).toBe('allow');
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env.HIVE_FLOW_PROJECT_ROOT;
      } else {
        process.env.HIVE_FLOW_PROJECT_ROOT = previousProjectRoot;
      }
    }
  });

  it('still blocks protected files under HIVE_FLOW_PROJECT_ROOT when cwd is a launcher repo', async () => {
    const previousProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT;
    process.env.HIVE_FLOW_PROJECT_ROOT = '/real/project';

    try {
      const result = await evaluate(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: '/real/project/.claude/settings.json',
            content: '{}',
          },
          cwd: '/launcher/hive-flow',
        },
        {
          ...ALLOW_ALL_CONFIG,
          allowed_write_paths: [],
        },
      );

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('Permission Guard security system');
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env.HIVE_FLOW_PROJECT_ROOT;
      } else {
        process.env.HIVE_FLOW_PROJECT_ROOT = previousProjectRoot;
      }
    }
  });

  it.each(['project_root', 'projectRoot'] as const)(
    'does not trust hook-supplied %s as the policy root',
    async (field) => {
      const previousProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT;
      const previousClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
      delete process.env.HIVE_FLOW_PROJECT_ROOT;
      delete process.env.CLAUDE_PROJECT_DIR;

      try {
        const result = await evaluate(
          {
            tool_name: 'Write',
            tool_input: {
              file_path: '/spoofed/project/v3/docs/design/global-hive-flow-plan.md',
              content: '# plan\n',
            },
            cwd: '/launcher/hive-flow',
            [field]: '/spoofed/project',
          } as HookInput & Record<typeof field, string>,
          {
            ...ALLOW_ALL_CONFIG,
            allowed_write_paths: [],
          },
        );

        expect(result.decision).toBe('deny');
      } finally {
        if (previousProjectRoot === undefined) {
          delete process.env.HIVE_FLOW_PROJECT_ROOT;
        } else {
          process.env.HIVE_FLOW_PROJECT_ROOT = previousProjectRoot;
        }
        if (previousClaudeProjectDir === undefined) {
          delete process.env.CLAUDE_PROJECT_DIR;
        } else {
          process.env.CLAUDE_PROJECT_DIR = previousClaudeProjectDir;
        }
      }
    },
  );
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
// 3b. mcp__filesystem__rename_file → Bash (mv command)
// ---------------------------------------------------------------------------

describe('mcp__filesystem__rename_file normalization', () => {
  it('blocks renaming over .claude/settings.json through MCP filesystem', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__rename_file', {
        source: `${CWD}/tmp/new-settings.json`,
        destination: `${CWD}/.claude/settings.json`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });

  it('blocks renaming over mixed-case .claude/settings.json through MCP filesystem', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__rename_file', {
        source: `${CWD}/tmp/new-settings.json`,
        destination: `${CWD}/.CLAUDE/settings.json`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });

  it('blocks renaming Permission Guard source through MCP filesystem', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__rename_file', {
        source: `${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts`,
        destination: `${CWD}/tmp/gate.ts`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });

  it('blocks renaming mixed-case Permission Guard source through MCP filesystem', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__rename_file', {
        source: `${CWD}/v3/@hive-flow/cli/src/PERMISSION-GUARD/gate.ts`,
        destination: `${CWD}/tmp/gate.ts`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });

  it('allows renaming non-protected project files under the normal policy', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__rename_file', {
        source: `${CWD}/src/old.ts`,
        destination: `${CWD}/src/new.ts`,
      }),
      ALLOW_ALL_CONFIG,
    );
    expect(result.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// 3c. mcp__filesystem__copy_file → Bash (cp command)
// ---------------------------------------------------------------------------

describe('mcp__filesystem__copy_file normalization', () => {
  it('blocks copying over .claude/settings.json through MCP filesystem', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__copy_file', {
        source: `${CWD}/tmp/new-settings.json`,
        destination: `${CWD}/.claude/settings.json`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });

  it('blocks copying Permission Guard source through MCP filesystem', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__copy_file', {
        source: `${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts`,
        destination: `${CWD}/tmp/gate.ts`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });

  it('allows copying non-protected project files under the normal policy', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__copy_file', {
        source: `${CWD}/src/original.ts`,
        destination: `${CWD}/src/copy.ts`,
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

  it('blocks creating directories inside protected Permission Guard paths', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__create_directory', {
        path: `${CWD}/.claude/helpers/new-helper`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });
});

// ---------------------------------------------------------------------------
// 4b. mcp__filesystem__delete_file → Bash (rm command)
// ---------------------------------------------------------------------------

describe('mcp__filesystem__delete_file normalization', () => {
  it('blocks deleting Permission Guard source through MCP filesystem', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__delete_file', {
        path: `${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts`,
      }),
      SELF_PROTECTION_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });

  it('allows deleting non-protected project files under the normal policy', async () => {
    const result = await evaluate(
      makeHookInput('mcp__filesystem__delete_file', {
        path: `${CWD}/tmp/scratch.txt`,
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
