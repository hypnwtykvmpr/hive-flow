import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hooksCommand } from '../hooks.js';
import type { Command, CommandContext } from '../../types.js';

function getSubcommand(name: 'modify-file' | 'modify-bash'): Command {
  const command = hooksCommand.subcommands?.find(subcommand => subcommand.name === name);
  if (!command) throw new Error(`missing hooks subcommand: ${name}`);
  return command;
}

function makeCtx(
  cwd: string,
  flags: Record<string, string | number | boolean> = {},
  args: string[] = [],
): CommandContext {
  return {
    cwd,
    args,
    flags: { _: [], ...flags },
    interactive: false,
  };
}

async function runHook(command: Command, ctx: CommandContext) {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  const result = await command.action!(ctx);
  return { result, stdout, stderr };
}

function parseSingleJsonLine(stdout: string): Record<string, any> {
  expect(stdout.endsWith('\n')).toBe(true);
  const lines = stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

function expectDecision(payload: Record<string, any>, decision: 'allow' | 'deny'): void {
  expect(payload.decision).toBe(decision);
  expect(payload.hookSpecificOutput).toMatchObject({
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
  });
  expect(typeof payload.reason).toBe('string');
}

describe('hooks modify-file/modify-bash protocol compatibility', () => {
  let projectRoot: string;
  let originalProjectRoot: string | undefined;
  let originalForceThrow: string | undefined;
  let originalForceStdout: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-hooks-modify-'));
    originalProjectRoot = process.env.HIVE_FLOW_PROJECT_ROOT;
    originalForceThrow = process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_THROW;
    originalForceStdout = process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_STDOUT;
    process.env.HIVE_FLOW_PROJECT_ROOT = projectRoot;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalProjectRoot === undefined) delete process.env.HIVE_FLOW_PROJECT_ROOT;
    else process.env.HIVE_FLOW_PROJECT_ROOT = originalProjectRoot;
    if (originalForceThrow === undefined) delete process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_THROW;
    else process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_THROW = originalForceThrow;
    if (originalForceStdout === undefined) delete process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_STDOUT;
    else process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_STDOUT = originalForceStdout;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('registers legacy modify hook subcommands', () => {
    expect(getSubcommand('modify-file').hidden).toBe(true);
    expect(getSubcommand('modify-bash').hidden).toBe(true);
  });

  it('allows private ignored agent-router report writes with pure JSON stdout', async () => {
    const { result, stdout, stderr } = await runHook(
      getSubcommand('modify-file'),
      makeCtx(projectRoot, { file: '.agent-router/reports/2026-06-09-cursor-router-bughunt.md' }),
    );

    expect(result).toMatchObject({ success: true });
    expect(stderr).toBe('');
    const payload = parseSingleJsonLine(stdout);
    expectDecision(payload, 'allow');
  });

  it('allows private agent-router report paths across generated safe names', async () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'.split('');
    const segment = fc.array(fc.constantFrom(...chars), { minLength: 1, maxLength: 18 })
      .map(parts => parts.join(''))
      .filter(value => value !== '.' && value !== '..');

    await fc.assert(
      fc.asyncProperty(fc.array(segment, { minLength: 1, maxLength: 4 }), async (segments) => {
        vi.restoreAllMocks();
        const filePath = `.agent-router/reports/${segments.join('/')}.md`;
        const { stdout, stderr } = await runHook(
          getSubcommand('modify-file'),
          makeCtx(projectRoot, { file: filePath }),
        );

        expect(stderr).toBe('');
        expectDecision(parseSingleJsonLine(stdout), 'allow');
      }),
      { numRuns: 75 },
    );
  });

  it('always emits parseable single-line JSON for arbitrary file hook paths', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 120 }), async (filePath) => {
        vi.restoreAllMocks();
        const { stdout } = await runHook(
          getSubcommand('modify-file'),
          makeCtx(projectRoot, { file: filePath }),
        );

        const payload = parseSingleJsonLine(stdout);
        expect(payload.decision === 'allow' || payload.decision === 'deny').toBe(true);
        expect(payload.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      }),
      { numRuns: 75 },
    );
  });

  it('always emits parseable single-line JSON for arbitrary bash hook commands', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 160 }), async (command) => {
        vi.restoreAllMocks();
        const { stdout } = await runHook(
          getSubcommand('modify-bash'),
          makeCtx(projectRoot, { command }),
        );

        const payload = parseSingleJsonLine(stdout);
        expect(payload.decision === 'allow' || payload.decision === 'deny').toBe(true);
        expect(payload.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      }),
      { numRuns: 75 },
    );
  });

  it('allows non-destructive router handoff commands with pure JSON stdout', async () => {
    const command = '.agent-router/agent-router.sh handoff-from cursor claude "handoff ready"';
    const { result, stdout, stderr } = await runHook(
      getSubcommand('modify-bash'),
      makeCtx(projectRoot, { command }),
    );

    expect(result).toMatchObject({ success: true });
    expect(stderr).toBe('');
    expectDecision(parseSingleJsonLine(stdout), 'allow');
  });

  it('denies protected file writes without escalating enforcement state', async () => {
    const statePath = join(projectRoot, '.hive-flow', 'enforcement', 'state.json');
    mkdirSync(join(projectRoot, '.hive-flow', 'enforcement'), { recursive: true });
    writeFileSync(statePath, '{"sentinel":"unchanged"}\n', 'utf8');

    const { result, stdout, stderr } = await runHook(
      getSubcommand('modify-file'),
      makeCtx(projectRoot, { file: '.claude/settings.json' }),
    );

    expect(result).toMatchObject({ success: true });
    expect(stderr).toBe('');
    const payload = parseSingleJsonLine(stdout);
    expectDecision(payload, 'deny');
    expect(payload.reason).toContain('Permission Guard security system');
    expect(readFileSync(statePath, 'utf8')).toBe('{"sentinel":"unchanged"}\n');
  });

  it('denies protected shell writes and destructive shell commands', async () => {
    const protectedWrite = await runHook(
      getSubcommand('modify-bash'),
      makeCtx(projectRoot, { command: 'printf x > .claude/settings.json' }),
    );
    expectDecision(parseSingleJsonLine(protectedWrite.stdout), 'deny');

    vi.restoreAllMocks();
    const destructive = await runHook(
      getSubcommand('modify-bash'),
      makeCtx(projectRoot, { command: 'rm -rf dist' }),
    );
    const payload = parseSingleJsonLine(destructive.stdout);
    expectDecision(payload, 'deny');
    expect(payload.reason).toContain('Destructive shell command');
  });

  it('denies a matrix of protected write targets with JSON-only decisions', async () => {
    const targets = [
      '.claude/settings.json',
      '.claude/helpers/hook-handler.cjs',
      '.hive-flow/enforcement/state.json',
      '.git/info/exclude',
      'v3/@hive-flow/cli/src/permission-guard/gate.ts',
    ];

    for (const target of targets) {
      vi.restoreAllMocks();
      const { stdout, stderr } = await runHook(
        getSubcommand('modify-file'),
        makeCtx(projectRoot, { file: target }),
      );
      expect(stderr).toBe('');
      expectDecision(parseSingleJsonLine(stdout), 'deny');
    }
  });

  it('denies a matrix of destructive shell commands with JSON-only decisions', async () => {
    const commands = [
      'rm -rf dist',
      'git reset --hard',
      'git clean -xdf',
      'chmod -R 777 .',
      'chown -R user:staff .',
    ];

    for (const command of commands) {
      vi.restoreAllMocks();
      const { stdout, stderr } = await runHook(
        getSubcommand('modify-bash'),
        makeCtx(projectRoot, { command }),
      );
      expect(stderr).toBe('');
      expectDecision(parseSingleJsonLine(stdout), 'deny');
    }
  });

  it('fails open with valid JSON when hook parsing throws before identifying a target', async () => {
    process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_THROW = '1';

    const { result, stdout, stderr } = await runHook(
      getSubcommand('modify-file'),
      makeCtx(projectRoot, { file: '.agent-router/reports/safe.md' }),
    );

    expect(result).toMatchObject({ success: true });
    expect(stderr).toBe('');
    const payload = parseSingleJsonLine(stdout);
    expectDecision(payload, 'allow');
    expect(payload.reason).toContain('forced modify hook failure');
  });

  it('suppresses accidental stdout produced during hook evaluation', async () => {
    process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_STDOUT = '1';

    const { stdout, stderr } = await runHook(
      getSubcommand('modify-bash'),
      makeCtx(projectRoot, { command: '.agent-router/agent-router.sh handoff-from cursor claude ok' }),
    );

    expect(stderr).toBe('');
    expect(stdout).not.toContain('stray modify hook stdout');
    expectDecision(parseSingleJsonLine(stdout), 'allow');
  });

  it('does not create enforcement state for normal allow, deny, or fail-open decisions', async () => {
    expect(existsSync(join(projectRoot, '.hive-flow', 'enforcement', 'state.json'))).toBe(false);

    await runHook(
      getSubcommand('modify-file'),
      makeCtx(projectRoot, { file: '.agent-router/reports/safe.md' }),
    );
    vi.restoreAllMocks();
    await runHook(
      getSubcommand('modify-bash'),
      makeCtx(projectRoot, { command: 'rm -rf dist' }),
    );
    vi.restoreAllMocks();
    process.env.HIVE_FLOW_MODIFY_HOOK_FORCE_THROW = '1';
    await runHook(
      getSubcommand('modify-bash'),
      makeCtx(projectRoot, { command: '.agent-router/agent-router.sh handoff-from cursor claude ok' }),
    );

    expect(existsSync(join(projectRoot, '.hive-flow', 'enforcement', 'state.json'))).toBe(false);
  });
});
