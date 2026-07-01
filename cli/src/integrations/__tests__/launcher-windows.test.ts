import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commandForClaudeSettings,
  resolveLauncherPath,
  resolveStatuslineLauncherPath,
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
  });

  it('writes a Windows MCP launcher that does not require bash', async () => {
    const launcherPath = join(root, 'home', '.hive-flow', 'bin', 'hive-flow-mcp-server.cmd');
    const entrypoint = join(root, 'project with spaces', 'bin', 'mcp-server.js');

    await writeStableLauncher(launcherPath, entrypoint, { platform: 'win32' });

    expect(existsSync(launcherPath)).toBe(true);
    const source = readFileSync(launcherPath, 'utf8');
    expect(source).toContain('@echo off');
    expect(source).toContain('node "%HIVE_FLOW_MCP_SERVER_ENTRYPOINT%" %*');
    expect(source).toContain(`set "HIVE_FLOW_MCP_SERVER_ENTRYPOINT=${entrypoint}"`);
    expect(source).not.toContain('/usr/bin/env bash');
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
