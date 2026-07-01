import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import initCommand from '../init.js';
import { runSetup } from '../setup.js';
import type { CommandContext } from '../../types.js';
import { CommandParser } from '../../parser.js';
import { buildRelocatedCommand, ENGINE_TARGET_FILES, resolveEnforcementBinDir } from '../../install/enforcement-installer.js';

function makeCtx(cwd: string, flags: Record<string, string | number | boolean>): CommandContext {
  return {
    cwd,
    args: [],
    flags: { _: [], ...flags },
    interactive: false,
  };
}

function parseInitFlags(args: string[]) {
  const parser = new CommandParser({ allowUnknownFlags: true });
  parser.registerCommand(initCommand);
  const parsed = parser.parse(['init', ...args]);
  const errors = parser.validateFlags(parsed.flags, initCommand);
  expect(errors).toEqual([]);
  return parsed.flags;
}

function makeProjectRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-init-global-project-'));
  for (const relativePath of [
    '.claude/helpers/hive-composition-gate.cjs',
    '.claude/helpers/role-enforcement.cjs',
    '.claude/helpers/enforcement.cjs',
    '.claude/helpers/hook-handler.cjs',
    '.claude/helpers/settings-reconciler.cjs',
    '.claude/helpers/provider-tracker.cjs',
    '.claude/helpers/client-kind.cjs',
    '.claude/helpers/session-id.cjs',
    '.claude/helpers/statusline.cjs',
    'cli/src/permission-guard/protected-paths.cjs',
    'cli/src/permission-guard/protected-paths.policy.json',
  ]) {
    const target = join(projectRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `fixture:${relativePath}\n`);
  }
  const statuslineRuntime = join(projectRoot, 'cli/bin/statusline.js');
  mkdirSync(dirname(statuslineRuntime), { recursive: true });
  writeFileSync(statuslineRuntime, '#!/usr/bin/env node\nprocess.stdout.write("HF_BOARD\\n");\n');
  return projectRoot;
}

function allHookCommands(settings: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }): string[] {
  return Object.values(settings.hooks || {})
    .flat()
    .flatMap((group) => group.hooks || [])
    .map((hook) => hook.command || '')
    .filter(Boolean);
}

function commandsFor(settings: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }, event: string): string[] {
  return (settings.hooks?.[event] || [])
    .flatMap((group) => group.hooks || [])
    .map((hook) => hook.command || '')
    .filter(Boolean);
}

describe('init --global --claude-code', () => {
  let cwd: string;
  let homeDir: string;
  let projectRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hf-init-global-non-project-'));
    homeDir = mkdtempSync(join(tmpdir(), 'hf-init-global-home-'));
    projectRoot = makeProjectRoot();
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('exposes the approved global Claude Code options on init', () => {
    const optionNames = new Set((initCommand.options || []).map((option) => option.name));

    expect(optionNames.has('global')).toBe(true);
    expect(optionNames.has('claude-code')).toBe(true);
    expect(optionNames.has('yes')).toBe(true);
    expect(optionNames.has('home')).toBe(true);
    expect(optionNames.has('user-settings')).toBe(true);
    expect(optionNames.has('project-root')).toBe(true);
  });

  it('installs universal gates from a non-project directory without adding deny policy', async () => {
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    const staleSessionEnd = 'node /old/hive-flow/cli.js hooks session-end --generate-summary';
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      disableAllHooks: true,
      permissions: {
        allow: ['Bash(echo ok)'],
        deny: ['Read(./.env)'],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'hive-flow hooks modify-bash --command "$CMD"' }],
          },
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'node /user/custom-read-hook.cjs' }],
          },
        ],
        Stop: [
          {
            hooks: [
              { type: 'command', command: staleSessionEnd },
              { type: 'command', command: 'node /user/keep-stop-hook.cjs' },
            ],
          },
        ],
      },
    }), 'utf8');

    const result = await initCommand.action!(makeCtx(cwd, {
      global: true,
      'claude-code': true,
      yes: true,
      home: homeDir,
      'user-settings': settingsPath,
      'project-root': projectRoot,
    }));

    expect(result).toMatchObject({ success: true });
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(cwd, '.hive-flow', 'config.yaml'))).toBe(false);

    const binDir = resolveEnforcementBinDir(homeDir);
    for (const file of ENGINE_TARGET_FILES) {
      expect(existsSync(join(binDir, file)), file).toBe(true);
    }

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const commands = allHookCommands(settings);
    expect(settings.disableAllHooks).toBeUndefined();
    expect(settings.permissions).toEqual({
      allow: ['Bash(echo ok)'],
      deny: ['Read(./.env)'],
    });
    expect(commands).toContain(buildRelocatedCommand('hive-composition-gate.cjs', { homeDir }));
    expect(commands).toContain(buildRelocatedCommand('role-enforcement.cjs', { homeDir }));
    expect(commands).toContain(buildRelocatedCommand('enforcement.cjs', { homeDir }));
    expect(commands).toContain(buildRelocatedCommand('hook-handler.cjs', { homeDir, args: 'permission-guard' }));
    expect(commands.join('\n')).toContain(binDir);
    expect(commands.join('\n')).not.toContain('$HOME');
    expect(commands.join('\n')).not.toContain('%USERPROFILE%');
    expect(commands.some((command) => /modify-(?:bash|file)/.test(command))).toBe(false);
    expect(commandsFor(settings, 'Stop').join('\n')).not.toContain('session-end');
    expect(commandsFor(settings, 'SessionEnd')).toContain(staleSessionEnd);
  });

  it('resolves packaged enforcement sources when launched outside any project', async () => {
    const settingsPath = join(homeDir, '.claude', 'settings.json');

    const result = await initCommand.action!(makeCtx(cwd, {
      global: true,
      'claude-code': true,
      yes: true,
      home: homeDir,
      'user-settings': settingsPath,
    }));

    expect(result).toMatchObject({ success: true });
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(resolveEnforcementBinDir(homeDir), 'hook-handler.cjs'))).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(allHookCommands(settings)).toContain(buildRelocatedCommand('hook-handler.cjs', { homeDir, args: 'permission-guard' }));
  });

  it('honors an explicit user settings path even when home is overridden', async () => {
    const settingsOwner = mkdtempSync(join(tmpdir(), 'hf-init-global-settings-owner-'));
    try {
      const explicitSettingsPath = join(settingsOwner, '.claude', 'settings.json');
      const homeSettingsPath = join(homeDir, '.claude', 'settings.json');
      mkdirSync(dirname(explicitSettingsPath), { recursive: true });
      writeFileSync(explicitSettingsPath, JSON.stringify({
        env: { KEEP_ME: 'yes' },
      }), 'utf8');

      const flags = parseInitFlags([
        '--global',
        '--claude-code',
        '--yes',
        '--home',
        homeDir,
        '--user-settings',
        explicitSettingsPath,
        '--project-root',
        projectRoot,
      ]);
      expect(flags.userSettings).toBe(explicitSettingsPath);
      expect(flags.projectRoot).toBe(projectRoot);

      const result = await initCommand.action!(makeCtx(cwd, flags));

      expect(result).toMatchObject({ success: true });
      expect(existsSync(homeSettingsPath)).toBe(false);
      const settings = JSON.parse(readFileSync(explicitSettingsPath, 'utf8'));
      expect(settings.env).toEqual({ KEEP_ME: 'yes' });
      expect(allHookCommands(settings)).toContain(buildRelocatedCommand('hook-handler.cjs', { homeDir, args: 'permission-guard' }));
      expect(settings.statusLine.command).toContain(join(homeDir, '.hive-flow', 'bin', 'claude-code-statusline'));
    } finally {
      rmSync(settingsOwner, { recursive: true, force: true });
    }
  });

  it('installs a managed global statusLine that suppresses the prior prompt and restores it on uninstall', async () => {
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    const customWrapper = join(homeDir, '.claude', 'statusline-wrapper.sh');
    const previousStatusLine = {
      type: 'command',
      command: `bash "${customWrapper}"`,
      padding: 3,
      refreshInterval: 7,
    };
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(customWrapper, '#!/usr/bin/env bash\ncat >/dev/null\nprintf "CUSTOM_PROMPT\\n"\n', 'utf8');
    writeFileSync(settingsPath, JSON.stringify({ statusLine: previousStatusLine }, null, 2), 'utf8');

    const result = await initCommand.action!(makeCtx(cwd, {
      global: true,
      'claude-code': true,
      yes: true,
      home: homeDir,
      'user-settings': settingsPath,
      'project-root': projectRoot,
    }));

    expect(result).toMatchObject({ success: true });
    const installed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(installed.statusLine).toMatchObject({
      type: 'command',
      padding: 0,
      refreshInterval: 1,
    });
    expect(installed.statusLine.command).toContain('claude-code-statusline');
    expect(installed.statusLine.command).not.toContain('statusline-wrapper.sh');

    const statuslineLauncher = join(homeDir, '.hive-flow', 'bin', 'claude-code-statusline');
    const launched = spawnSync(statuslineLauncher, [], {
      cwd,
      input: JSON.stringify({
        workspace: { current_dir: cwd, project_dir: cwd },
        model: { display_name: 'Opus 4.8' },
      }),
      encoding: 'utf8',
      timeout: 5000,
    });

    expect(launched.status).toBe(0);
    expect(launched.stdout).toContain('Opus 4.8');
    expect(launched.stdout).not.toContain('CUSTOM_PROMPT');

    const diagnosticChain = spawnSync(statuslineLauncher, [], {
      cwd,
      input: JSON.stringify({
        workspace: { current_dir: cwd, project_dir: cwd },
        model: { display_name: 'Opus 4.8' },
      }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HIVE_FLOW_STATUSLINE_CHAIN_PREVIOUS: '1' },
    });
    expect(diagnosticChain.status).toBe(0);
    expect(diagnosticChain.stdout).toContain('Opus 4.8');
    expect(diagnosticChain.stdout).toContain('CUSTOM_PROMPT');

    const rerun = await initCommand.action!(makeCtx(cwd, {
      global: true,
      'claude-code': true,
      yes: true,
      home: homeDir,
      'user-settings': settingsPath,
      'project-root': projectRoot,
    }));
    expect(rerun).toMatchObject({ success: true });
    const relaunched = spawnSync(statuslineLauncher, [], {
      cwd,
      input: JSON.stringify({
        workspace: { current_dir: cwd, project_dir: cwd },
        model: { display_name: 'Opus 4.8' },
      }),
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(relaunched.status).toBe(0);
    expect(relaunched.stdout).toContain('Opus 4.8');
    expect(relaunched.stdout).not.toContain('HF_BOARD');
    expect(relaunched.stdout).not.toContain('CUSTOM_PROMPT');

    const uninstall = await runSetup({
      action: 'uninstall',
      agents: ['claude-code'],
      scope: 'user',
      cwd,
      homeDir,
      lockPath: join(cwd, '.hive-flow', 'setup.lock'),
      dryRun: false,
      createConfig: false,
      forceAdopt: false,
      features: 'statusline',
    });

    expect(uninstall.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent: 'claude-code',
        feature: 'statusline',
        outcome: 'applied',
      }),
    ]));
    const restored = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(restored.statusLine).toEqual(previousStatusLine);
  });
});
