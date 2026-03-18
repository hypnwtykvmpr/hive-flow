import { describe, it, expect, beforeEach } from 'vitest';
import * as nodePath from 'node:path';

// ---------------------------------------------------------------------------
// enforcement.cjs — loaded via require() since it is CJS
// ---------------------------------------------------------------------------

const ENFORCEMENT_CJS_PATH = nodePath.resolve(
  __dirname, '..', '..', '..', '..', '..', '.claude', 'helpers', 'enforcement.cjs',
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let enf: any;

// ---------------------------------------------------------------------------
// Task A — MCP filesystem enforcement
// ---------------------------------------------------------------------------

describe('Task A: MCP filesystem enforcement gap', () => {
  beforeEach(() => {
    // Fresh require each time to avoid stale state
    enf = require(ENFORCEMENT_CJS_PATH);
  });

  const freshState = () => ({
    level: 0,
    violations: 0,
    consecutiveDenials: 0,
    restrictedGroups: [],
    history: [],
    integrityCompromised: false,
  });

  it('1. mcp__filesystem__write_file to .claude/settings.json is circumvention', () => {
    const result = enf.detectCircumvention(
      'mcp__filesystem__write_file',
      { path: '.claude/settings.json' },
      freshState(),
    );
    expect(result.circumvention).toBe(true);
  });

  it('2. mcp__filesystem__edit_file to .hive-flow/enforcement/state.json is circumvention', () => {
    const result = enf.detectCircumvention(
      'mcp__filesystem__edit_file',
      { path: '.hive-flow/enforcement/state.json' },
      freshState(),
    );
    expect(result.circumvention).toBe(true);
  });

  it('3. mcp__filesystem__move_file with destination .claude/helpers/enforcement.cjs is circumvention', () => {
    const result = enf.detectCircumvention(
      'mcp__filesystem__move_file',
      { destination: '.claude/helpers/enforcement.cjs' },
      freshState(),
    );
    expect(result.circumvention).toBe(true);
  });

  it('4. mcp__filesystem__create_directory to .hive-flow/enforcement/ is circumvention', () => {
    const result = enf.detectCircumvention(
      'mcp__filesystem__create_directory',
      { path: '.hive-flow/enforcement/' },
      freshState(),
    );
    expect(result.circumvention).toBe(true);
  });

  it('5. mcp__filesystem__read_file to .claude/settings.json is NOT circumvention (reads are safe)', () => {
    const result = enf.detectCircumvention(
      'mcp__filesystem__read_file',
      { path: '.claude/settings.json' },
      freshState(),
    );
    expect(result.circumvention).toBe(false);
  });

  it('6. getRestrictionGroups for mcp__filesystem__write_file returns [write, exec]', () => {
    const groups = enf.getRestrictionGroups('mcp__filesystem__write_file', {}, {});
    expect(groups).toEqual(['write', 'exec']);
  });

  it('7. getRestrictionGroups for mcp__filesystem__create_directory returns [write, exec]', () => {
    const groups = enf.getRestrictionGroups('mcp__filesystem__create_directory', {}, {});
    expect(groups).toEqual(['write', 'exec']);
  });

  it('8a. mcp__filesystem__move_file with source in protected path is circumvention', () => {
    const result = enf.detectCircumvention(
      'mcp__filesystem__move_file',
      { source: '.hive-flow/enforcement/state.json', destination: '/tmp/exfil.json' },
      freshState(),
    );
    expect(result.circumvention).toBe(true);
  });

  it('8. TOOL_GROUPS.write includes all 3 MCP filesystem write tools', () => {
    const writeGroup: string[] = enf.TOOL_GROUPS.write;
    expect(writeGroup).toContain('mcp__filesystem__write_file');
    expect(writeGroup).toContain('mcp__filesystem__edit_file');
    expect(writeGroup).toContain('mcp__filesystem__move_file');
  });
});

// ---------------------------------------------------------------------------
// Task B — git commit obfuscation detection
// ---------------------------------------------------------------------------

describe('Task B: git commit obfuscation detection (isGitCommitCommand)', () => {
  beforeEach(() => {
    enf = require(ENFORCEMENT_CJS_PATH);
  });

  it('9. direct: git commit -m "test"', () => {
    expect(enf.isGitCommitCommand('git commit -m "test"')).toBe(true);
  });

  it('10. command substitution: $(which git) commit -m "msg"', () => {
    expect(enf.isGitCommitCommand('$(which git) commit -m "msg"')).toBe(true);
  });

  it('11. backtick substitution: `which git` commit -m "msg"', () => {
    expect(enf.isGitCommitCommand('`which git` commit -m "msg"')).toBe(true);
  });

  it('12. env prefix: env git commit -m "msg"', () => {
    expect(enf.isGitCommitCommand('env git commit -m "msg"')).toBe(true);
  });

  it('13. command builtin: command git commit -m "msg"', () => {
    expect(enf.isGitCommitCommand('command git commit -m "msg"')).toBe(true);
  });

  it('14. absolute path: /usr/bin/git commit -m "msg"', () => {
    expect(enf.isGitCommitCommand('/usr/bin/git commit -m "msg"')).toBe(true);
  });

  it('15. absolute path: /usr/local/bin/git commit', () => {
    expect(enf.isGitCommitCommand('/usr/local/bin/git commit')).toBe(true);
  });

  it('16. git log is NOT a commit command', () => {
    expect(enf.isGitCommitCommand('git log --oneline')).toBe(false);
  });

  it('17. echo hello is NOT a commit command', () => {
    expect(enf.isGitCommitCommand('echo hello')).toBe(false);
  });

  it('18. null input returns false', () => {
    expect(enf.isGitCommitCommand(null)).toBe(false);
  });

  it('19. empty string returns false', () => {
    expect(enf.isGitCommitCommand('')).toBe(false);
  });

  it('20b. git -c alias bypass: git -c alias.x=commit x -m "msg"', () => {
    expect(enf.isGitCommitCommand('git -c alias.x=commit x -m "msg"')).toBe(true);
  });

  it('20c. command length cap: very long string returns false', () => {
    expect(enf.isGitCommitCommand('a'.repeat(20000))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task C — Workflow hooks (WorkflowHookDispatcher)
// ---------------------------------------------------------------------------

describe('Task C: Workflow hook dispatcher (workflow-executor.ts)', () => {
  // We need a dynamic import for ESM module. Reset module state between tests.
  let setWorkflowHookDispatcher: typeof import('../mcp-tools/workflow-executor.js').setWorkflowHookDispatcher;
  let getWorkflowHookDispatcher: typeof import('../mcp-tools/workflow-executor.js').getWorkflowHookDispatcher;

  beforeEach(async () => {
    // Dynamic import — vitest handles ESM
    const mod = await import('../mcp-tools/workflow-executor.js');
    setWorkflowHookDispatcher = mod.setWorkflowHookDispatcher;
    getWorkflowHookDispatcher = mod.getWorkflowHookDispatcher;
    // Always clean up the dispatcher between tests
    setWorkflowHookDispatcher(null);
  });

  it('20. setWorkflowHookDispatcher and getWorkflowHookDispatcher are exported functions', () => {
    expect(typeof setWorkflowHookDispatcher).toBe('function');
    expect(typeof getWorkflowHookDispatcher).toBe('function');
  });

  it('21. getWorkflowHookDispatcher returns null when none set', () => {
    expect(getWorkflowHookDispatcher()).toBeNull();
  });

  it('22. after setWorkflowHookDispatcher(mock), getWorkflowHookDispatcher returns the mock', () => {
    const mockDispatcher = {
      dispatch: async () => ({ success: true }),
    };
    setWorkflowHookDispatcher(mockDispatcher);
    expect(getWorkflowHookDispatcher()).toBe(mockDispatcher);
  });

  it('23. setWorkflowHookDispatcher(null) clears it back to null', () => {
    const mockDispatcher = {
      dispatch: async () => ({ success: true }),
    };
    setWorkflowHookDispatcher(mockDispatcher);
    expect(getWorkflowHookDispatcher()).toBe(mockDispatcher);

    setWorkflowHookDispatcher(null);
    expect(getWorkflowHookDispatcher()).toBeNull();
  });
});
