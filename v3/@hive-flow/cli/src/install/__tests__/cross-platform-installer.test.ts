import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join } from 'node:path';
import { portableConfirm, readRequiredSecret } from '../portable-prompt.js';
import {
  ENGINE_TARGET_FILES,
  buildRelocatedCommand,
  copyEngineFiles,
  installRelocatedEnforcement,
  mergeUserSettings,
  resolveEnforcementBinDir,
} from '../enforcement-installer.js';
import { getPlatformProviderForPlatform } from '../../permission-guard/biometric-override.js';
import { installCommand } from '../../commands/install.js';

function makeProjectRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-p2-project-'));
  for (const relativePath of [
    '.claude/helpers/hive-composition-gate.cjs',
    '.claude/helpers/role-enforcement.cjs',
    '.claude/helpers/enforcement.cjs',
    '.claude/helpers/hook-handler.cjs',
    '.claude/helpers/settings-reconciler.cjs',
    '.claude/helpers/provider-tracker.cjs',
    '.claude/helpers/session-id.cjs',
    'v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs',
    'v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json',
  ]) {
    const target = join(projectRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `fixture:${relativePath}\n`);
  }
  return projectRoot;
}

function allHookCommands(settings: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }): string[] {
  return Object.values(settings.hooks || {})
    .flat()
    .flatMap((group) => group.hooks || [])
    .map((hook) => hook.command || '')
    .filter(Boolean);
}

describe('cross-platform enforcement installer', () => {
  it('emits absolute relocated hook commands without home env literals', () => {
    const homeDir = join(tmpdir(), 'hf-p2-home-with spaces');
    const binDir = resolveEnforcementBinDir(homeDir);
    const settings = mergeUserSettings({}, { homeDir });
    const commands = allHookCommands(settings);

    expect(binDir).toBe(path.join(homeDir, '.hive-flow', 'enforcement', 'bin'));
    expect(commands).toContain(buildRelocatedCommand('enforcement.cjs', { homeDir }));
    expect(commands).toContain(buildRelocatedCommand('hook-handler.cjs', { homeDir, args: 'permission-guard' }));
    expect(commands.join('\n')).not.toContain('$HOME');
    expect(commands.join('\n')).not.toContain('%USERPROFILE%');
    expect(commands.every((command) => command.includes(binDir) || !command.includes('.hive-flow/enforcement/bin'))).toBe(true);
  });

  it('skips chmod on win32 and routes keypair storage to the Windows PBKDF2 AES provider', async () => {
    const projectRoot = makeProjectRoot();
    const binDir = mkdtempSync(join(tmpdir(), 'hf-p2-win-bin-'));
    const chmodCalls: Array<{ target: string; mode: number }> = [];
    try {
      await copyEngineFiles(projectRoot, binDir, {
        platform: 'win32',
        chmodFile: async (target, mode) => {
          chmodCalls.push({ target, mode });
        },
      });

      expect(chmodCalls).toEqual([]);
      expect(getPlatformProviderForPlatform('win32').name).toContain('Windows PBKDF2 + AES-256-CBC');
      expect(existsSync(join(binDir, 'provider-tracker.cjs'))).toBe(true);
      expect(existsSync(join(binDir, 'session-id.cjs'))).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('fails closed for headless confirmation unless --yes is supplied', async () => {
    await expect(portableConfirm('Install enforcement?', {
      yes: false,
      platform: 'linux',
      ttyAvailable: false,
      stdinIsTTY: false,
    })).resolves.toBe(false);

    await expect(portableConfirm('Install enforcement?', {
      yes: true,
      platform: 'linux',
      ttyAvailable: false,
      stdinIsTTY: false,
    })).resolves.toBe(true);

    await expect(portableConfirm('Install enforcement?', {
      yes: false,
      platform: 'linux',
      ttyAvailable: true,
      ask: async () => 'yes',
    })).resolves.toBe(true);
  });

  it('fails closed instead of accepting an empty non-TTY secret', async () => {
    await expect(readRequiredSecret('Credential unlock: ', {
      input: { isTTY: false } as NodeJS.ReadStream,
      output: { write: () => true } as unknown as NodeJS.WriteStream,
      purpose: 'credential vault unlock',
    })).rejects.toThrow(/credential vault unlock|non-interactive|empty secret/i);
  });

  it('performs engine-only then hooks-only install with the complete 9-file relocated set', async () => {
    const projectRoot = makeProjectRoot();
    const homeDir = mkdtempSync(join(tmpdir(), 'hf-p2-e2e-home-'));
    try {
      await installRelocatedEnforcement({
        projectRoot,
        homeDir,
        yes: true,
        engineOnly: true,
        setupKeypair: false,
      });
      await installRelocatedEnforcement({
        projectRoot,
        homeDir,
        yes: true,
        hooksOnly: true,
        setupKeypair: false,
      });

      const binDir = resolveEnforcementBinDir(homeDir);
      for (const file of ENGINE_TARGET_FILES) {
        expect(existsSync(join(binDir, file)), file).toBe(true);
      }
      expect(ENGINE_TARGET_FILES).toHaveLength(9);
      expect(existsSync(join(binDir, '.version'))).toBe(true);

      const settings = JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8'));
      const commands = allHookCommands(settings);
      expect(commands).toContain(buildRelocatedCommand('settings-reconciler.cjs', { homeDir }));
      expect(commands.join('\n')).not.toContain('$HOME');
      expect(commands.join('\n')).toContain(binDir);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('exposes the global install command with engine-only and hooks-only flags', () => {
    const optionNames = new Set((installCommand.options || []).map((option) => option.name));

    expect(installCommand.name).toBe('install');
    expect(optionNames.has('global')).toBe(true);
    expect(optionNames.has('yes')).toBe(true);
    expect(optionNames.has('engine-only')).toBe(true);
    expect(optionNames.has('hooks-only')).toBe(true);
    expect(optionNames.has('keypair-only')).toBe(true);
    expect(optionNames.has('credentials')).toBe(true);
    expect(optionNames.has('degraded')).toBe(true);
  });
});
