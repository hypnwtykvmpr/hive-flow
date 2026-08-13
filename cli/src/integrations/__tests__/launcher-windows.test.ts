import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commandForClaudeSettings,
  resolveActivityHookLauncherPath,
  resolveLauncherPath,
  resolveStatuslineLauncherPath,
  writeStableActivityHookLauncher,
  writeStableLauncher,
  writeStableStatuslineLauncher,
} from '../launcher.js';

describe('Windows launcher generation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-win-launcher-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves Windows command launchers with .cmd suffixes', () => {
    const homeDir = join(root, 'home with spaces');
    const projectRoot = join(root, 'project');

    expect(resolveLauncherPath('user', homeDir, projectRoot, 'win32')).toBe(
      join(homeDir, '.hive-flow', 'bin', 'hive-flow-mcp-server.cmd'),
    );
    expect(resolveStatuslineLauncherPath('user', homeDir, projectRoot, 'win32')).toBe(
      join(homeDir, '.hive-flow', 'bin', 'claude-code-statusline.cmd'),
    );
    expect(commandForClaudeSettings(join(homeDir, '.hive-flow', 'bin', 'claude-code-statusline.cmd'), 'win32')).toBe(
      `"${join(homeDir, '.hive-flow', 'bin', 'claude-code-statusline.cmd')}"`,
    );
    // f16a: the activity-hook launcher is a third managed Windows binary.
    expect(resolveActivityHookLauncherPath('user', homeDir, projectRoot, 'win32')).toBe(
      join(homeDir, '.hive-flow', 'bin', 'claude-activity-hook.cmd'),
    );
  });

  it('writes a Windows activity-hook launcher that is fail-open and silent (f16a)', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'claude-activity-hook.cmd');
    const entrypoint = join(root, 'project with spaces', 'bin', 'claude-activity-hook.js');

    await writeStableActivityHookLauncher(launcherPath, entrypoint, { platform: 'win32' });

    const contents = readFileSync(launcherPath, 'utf8');
    expect(existsSync(launcherPath)).toBe(true);
    // No bash: a .cmd wrapper Windows can run.
    expect(contents).not.toContain('#!/usr/bin/env bash');
    expect(contents).toContain('@echo off');
    // The entrypoint (containing spaces) must be quoted.
    expect(contents).toContain(`node "${entrypoint}"`);
    // Forwards the event argument.
    expect(contents).toContain('%*');
    // FAIL-OPEN: never surfaces output or a non-zero status to Claude Code.
    expect(contents).toContain('>NUL 2>NUL');
    expect(contents).toContain('exit /b 0');
    // CRLF line endings for cmd.exe.
    expect(contents).toContain('\r\n');
  });

  it('rewrites the Windows activity-hook launcher idempotently', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'claude-activity-hook.cmd');
    const entrypoint = join(root, 'project', 'bin', 'claude-activity-hook.js');

    await writeStableActivityHookLauncher(launcherPath, entrypoint, { platform: 'win32' });
    const first = readFileSync(launcherPath, 'utf8');
    await writeStableActivityHookLauncher(launcherPath, entrypoint, { platform: 'win32' });
    expect(readFileSync(launcherPath, 'utf8')).toBe(first);
  });

  it('escapes percent expansion in the activity-hook entrypoint (f16a W1b)', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'claude-activity-hook.cmd');
    // A LEGAL Windows path that is also batch environment-expansion syntax.
    const entrypoint = 'C:\\%WINDIR%\\hive flow\\bin\\claude-activity-hook.js';

    await writeStableActivityHookLauncher(launcherPath, entrypoint, { platform: 'win32' });

    const contents = readFileSync(launcherPath, 'utf8');
    // `%` must be doubled so cmd.exe emits it literally instead of substituting
    // the environment variable when the batch file runs.
    expect(contents).toContain('node "C:\\%%WINDIR%%\\hive flow\\bin\\claude-activity-hook.js"');
    expect(contents).not.toContain('"C:\\%WINDIR%\\hive flow');
    // Fail-open contract is retained.
    expect(contents).toContain('>NUL 2>NUL');
    expect(contents).toContain('exit /b 0');
  });

  it('disables delayed expansion before using the entrypoint (f16a B3)', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'claude-activity-hook.cmd');
    // A LEGAL Windows path containing `!`, which is rewritten by a command
    // processor that has delayed expansion enabled.
    const entrypoint = 'C:\\hive!flow\\bin\\claude-activity-hook.js';

    await writeStableActivityHookLauncher(launcherPath, entrypoint, { platform: 'win32' });

    const contents = readFileSync(launcherPath, 'utf8');
    expect(contents).toContain('setlocal DisableDelayedExpansion');
    // The directive MUST precede any use of the entrypoint, or it protects nothing.
    expect(contents.indexOf('setlocal DisableDelayedExpansion')).toBeLessThan(
      contents.indexOf(entrypoint),
    );
    // The bang survives literally in the emitted command.
    expect(contents).toContain(`node "${entrypoint}"`);
    // Fail-open contract and CRLF retained alongside the new directive.
    expect(contents).toContain('>NUL 2>NUL');
    expect(contents).toContain('exit /b 0');
    expect(contents).toContain('\r\n');
  });

  it('refuses to embed a hostile activity-hook path in a Windows launcher', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'claude-activity-hook.cmd');
    await expect(
      writeStableActivityHookLauncher(launcherPath, 'C:\\evil"path\\hook.js', { platform: 'win32' }),
    ).rejects.toThrow(/cannot be embedded/i);
  });

  /**
   * Create a fixture as a REAL readable file.
   *
   * `writeStableLauncher` validates that both entrypoints are readable regular
   * files whenever the TARGET platform equals the HOST platform. A POSIX host
   * generating a win32 wrapper skips that check, so a fake path passes locally
   * and then fails on a Windows runner, where the same test targets its own
   * platform. Fixtures must therefore be valid on the target platform, not just
   * on the machine that happens to run the suite.
   */
  function seedFixture(file: string): string {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '// fixture\n');
    return file;
  }

  it('writes a Windows MCP launcher that does not require bash', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'hive-flow-mcp-server.cmd');
    const entrypoint = seedFixture(join(root, 'project with spaces', 'bin', 'mcp-server.js'));

    // A launcher path carrying every cmd metacharacter that could be reparsed.
    // Each of these characters is legal in a Windows filename, so this fixture
    // is creatable on the target platform as well as on POSIX.
    const attesting = seedFixture(
      join(root, 'helpers (x86) & co ^ !var! %PATH%', 'hive-flow-mcp-launcher.cjs'),
    );

    await writeStableLauncher(launcherPath, entrypoint, attesting, { platform: 'win32' });

    expect(existsSync(launcherPath)).toBe(true);
    const source = readFileSync(launcherPath, 'utf8');
    expect(source).toContain('@echo off');
    expect(source).not.toContain('/usr/bin/env bash');

    // Invoke the ATTESTING LAUNCHER, not the MCP server directly.
    expect(source).toContain('node "%HIVE_FLOW_MCP_LAUNCHER%" %*');
    expect(source).not.toContain('node "%HIVE_FLOW_MCP_SERVER_ENTRYPOINT%" %*');

    // Both paths travel in env vars, so metacharacters in them are never
    // reparsed as command syntax. `%` is doubled for batch, and delayed
    // expansion is disabled so `!` cannot expand inside the quoted set.
    expect(source).toContain(`set "HIVE_FLOW_MCP_SERVER_ENTRYPOINT=${entrypoint.replace(/%/g, '%%')}"`);
    expect(source).toContain(`set "HIVE_FLOW_MCP_LAUNCHER=${attesting.replace(/%/g, '%%')}"`);
    expect(source).toContain('setlocal DisableDelayedExpansion');
    // The raw `%PATH%` form must not survive, or cmd would expand it.
    expect(source).not.toContain('%PATH%\\hive-flow-mcp-launcher.cjs');
  });

  it('refuses a Windows attesting launcher path containing a double quote', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'hive-flow-mcp-server.cmd');
    const entrypoint = seedFixture(join(root, 'project', 'bin', 'mcp-server.js'));
    // A double quote is ILLEGAL in a Windows filename, so this path can never be
    // a real file and the assertion depends on the encoder running BEFORE the
    // filesystem checks. That ordering is what makes the reported error the same
    // on a POSIX host and on a Windows runner; with the checks first, a Windows
    // runner reported "not a readable file" here instead.
    await expect(
      writeStableLauncher(launcherPath, entrypoint, 'C:\\evil"path\\launcher.cjs', { platform: 'win32' }),
    ).rejects.toThrow(/cannot be embedded/i);
  });

  it('applies filesystem validation when the target platform equals the host', async () => {
    // Exercises the `platform === process.platform` branch directly. Every other
    // win32 case in this file targets a platform the POSIX host does not match,
    // so that branch is skipped locally — which is exactly why a suite green on
    // macOS was red on windows-latest. Targeting the HOST platform reproduces
    // the runner-matches-target condition on any machine, including Windows CI.
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'host-target-launcher');
    const entrypoint = seedFixture(join(root, 'host target', 'bin', 'mcp-server.js'));
    const attesting = seedFixture(join(root, 'host target', 'helpers', 'hive-flow-mcp-launcher.cjs'));

    // Real fixtures: the now-active checks must ACCEPT them.
    await expect(
      writeStableLauncher(launcherPath, entrypoint, attesting, { platform: process.platform }),
    ).resolves.toBeUndefined();
    expect(existsSync(launcherPath)).toBe(true);

    // Absent entrypoint: the same active checks must REJECT it, so the test
    // proves discrimination rather than merely that the happy path runs.
    await expect(
      writeStableLauncher(
        launcherPath,
        join(root, 'host target', 'bin', 'absent-server.js'),
        attesting,
        { platform: process.platform },
      ),
    ).rejects.toThrow(/not a readable file/i);
  });

  it('writes a Windows statusline launcher and Node companion with the prior prompt preserved but not chained by default', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'claude-code-statusline.cmd');
    const entrypoint = join(root, 'project with spaces', 'bin', 'statusline.js');
    const previousCommand = 'powershell.exe -NoProfile -Command "Write-Output CUSTOM"';

    await writeStableStatuslineLauncher(launcherPath, entrypoint, {
      platform: 'win32',
      previousCommand,
    });

    const companionPath = `${launcherPath}.cjs`;
    expect(existsSync(launcherPath)).toBe(true);
    expect(existsSync(companionPath)).toBe(true);
    const cmd = readFileSync(launcherPath, 'utf8');
    const companion = readFileSync(companionPath, 'utf8');
    expect(cmd).toContain('@echo off');
    expect(cmd).toContain('node "%~dp0claude-code-statusline.cmd.cjs" %*');
    expect(cmd).not.toContain('/usr/bin/env bash');
    expect(companion).toContain(JSON.stringify(entrypoint));
    expect(companion).toContain(JSON.stringify(previousCommand));
    expect(companion).toContain('spawnSync(process.execPath');
    expect(companion).toContain("process.env.HIVE_FLOW_STATUSLINE_CHAIN_PREVIOUS === '1'");
    expect(companion).toContain('shell: true');
  });
});
