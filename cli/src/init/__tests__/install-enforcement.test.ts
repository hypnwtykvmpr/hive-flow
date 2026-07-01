import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const installerPath = resolve(__dirname, '../../../../scripts/install-enforcement.mjs');
const installerUrl = pathToFileURL(installerPath).href;

describe('relocated enforcement installer helpers', () => {
  it('merges the user-level trigger without preserving generated project-local hook groups', async () => {
    const { mergeUserSettings } = await import(installerUrl);
    const homeDir = join(tmpdir(), 'hf-install-home-with spaces');
    const settings = mergeUserSettings({
      disableAllHooks: true,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/enforcement.cjs', timeout: 5000 },
            ],
          },
          {
            matcher: 'CustomTool',
            hooks: [
              { type: 'command', command: 'node .claude/helpers/custom-hook-handler.cjs custom', timeout: 1000 },
            ],
          },
        ],
      },
    }, { homeDir });
    const binDir = join(homeDir, '.hive-flow', 'enforcement', 'bin');

    expect(settings.disableAllHooks).toBeUndefined();
    const preToolUse = settings.hooks.PreToolUse;
    const preCommands = preToolUse.flatMap((group: { hooks?: Array<{ command?: string }> }) =>
      (group.hooks || []).map((hook) => hook.command || '')
    );
    expect(preCommands).toContain(`node "${join(binDir, 'enforcement.cjs')}"`);
    expect(preCommands).toContain(`node "${join(binDir, 'hook-handler.cjs')}" permission-guard`);
    expect(preCommands).not.toContain('node "$CLAUDE_PROJECT_DIR"/.claude/helpers/enforcement.cjs');
    expect(preCommands).toContain('node .claude/helpers/custom-hook-handler.cjs custom');
    expect(preCommands.join('\n')).not.toContain('$HOME');
    expect(preCommands.join('\n')).not.toContain('%USERPROFILE%');

    const commandsFor = (event: string) => (settings.hooks[event] || [])
      .flatMap((group: { hooks?: Array<{ command?: string }> }) => (group.hooks || []).map((hook) => hook.command || ''));
    expect(commandsFor('PostToolUse')).toContain(`node "${join(binDir, 'settings-reconciler.cjs')}"`);
    expect(commandsFor('SessionStart')).toContain(`node "${join(binDir, 'settings-reconciler.cjs')}"`);
    expect(commandsFor('Stop')).toContain(`node "${join(binDir, 'settings-reconciler.cjs')}"`);
  });

  it('copies relocated engine files and local policy into the target bin', async () => {
    const { copyEngineFiles } = await import(installerUrl);
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-install-engine-project-'));
    const binDir = mkdtempSync(join(tmpdir(), 'hf-install-engine-bin-'));
    try {
      for (const relativePath of [
        '.claude/helpers/layout-paths.cjs',
        '.claude/helpers/hive-flow-mcp-launcher.cjs',
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

      await copyEngineFiles(projectRoot, binDir);

      for (const targetName of [
        'layout-paths.cjs',
        'hive-flow-mcp-launcher.cjs',
        'hive-composition-gate.cjs',
        'role-enforcement.cjs',
        'enforcement.cjs',
        'hook-handler.cjs',
        'settings-reconciler.cjs',
        'provider-tracker.cjs',
        'client-kind.cjs',
        'session-id.cjs',
        'statusline.cjs',
        'protected-paths.cjs',
        'protected-paths.policy.json',
      ]) {
        expect(existsSync(join(binDir, targetName))).toBe(true);
      }
      expect(JSON.parse(readFileSync(join(binDir, '.version'), 'utf8')).source).toBe(projectRoot);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
