import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { generateSettings } from '../settings-generator.js';
import { executeInit, executeUpgrade } from '../executor.js';
import { DEFAULT_INIT_OPTIONS, type InitOptions } from '../types.js';

interface HookCommand {
  command?: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

interface GeneratedSettings {
  hooks?: Record<string, HookEntry[]>;
}

const guardedMatcherTools = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'Read',
  'NotebookRead',
  'WebFetch',
  'NotebookEdit',
  'mcp__filesystem__write_file',
  'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file',
  'mcp__filesystem__rename_file',
  'mcp__filesystem__copy_file',
  'mcp__filesystem__create_directory',
  'mcp__filesystem__delete_file',
  'mcp__filesystem__read_file',
  'mcp__filesystem__read_text_file',
  'mcp__filesystem__read_media_file',
  'mcp__filesystem__read_multiple_files',
];

function relocatedHelperCommand(helper: string, args = '', homeDir = homedir()): string {
  return `node "${join(homeDir, '.hive-flow', 'enforcement', 'bin', helper)}"${args ? ` ${args}` : ''}`;
}

function testOptions(targetDir: string): InitOptions {
  return {
    ...DEFAULT_INIT_OPTIONS,
    targetDir,
    force: true,
    interactive: false,
    components: {
      ...DEFAULT_INIT_OPTIONS.components,
      settings: true,
      helpers: false,
      skills: false,
      commands: false,
      agents: false,
      statusline: false,
      mcp: false,
      runtime: false,
      claudeMd: false,
    },
    statusline: {
      ...DEFAULT_INIT_OPTIONS.statusline,
      enabled: false,
    },
  };
}

function matcherTokens(entry: HookEntry): Set<string> {
  return new Set(String(entry.matcher || '').split('|').filter(Boolean));
}

function findEntry(entries: HookEntry[], commandNeedle: string, matcherNeedle?: string): HookEntry {
  const entry = entries.find((candidate) => {
    const hasCommand = candidate.hooks?.some((hook) => hook.command?.includes(commandNeedle));
    const hasMatcher = matcherNeedle ? String(candidate.matcher || '').includes(matcherNeedle) : true;
    return hasCommand && hasMatcher;
  });
  expect(entry, `Missing hook entry for ${commandNeedle}`).toBeDefined();
  return entry!;
}

function expectFullPreToolUseChain(settings: GeneratedSettings, homeDir = homedir()): void {
  const preToolUse = settings.hooks?.PreToolUse || [];
  expect(preToolUse.length).toBeGreaterThanOrEqual(3);

  const taskEntry = findEntry(preToolUse, 'hive-composition-gate.cjs', 'Task');
  expect(taskEntry.hooks?.[0]?.command).toBe(relocatedHelperCommand('hive-composition-gate.cjs', '', homeDir));

  const spawnEntry = findEntry(preToolUse, 'role-enforcement.cjs', 'mcp__hive-flow__agent_spawn');
  expect(spawnEntry.hooks?.map((hook) => hook.command)).toEqual([
    relocatedHelperCommand('role-enforcement.cjs', '', homeDir),
    relocatedHelperCommand('enforcement.cjs', '', homeDir),
  ]);

  const guardEntry = findEntry(preToolUse, 'hook-handler.cjs', 'Bash');
  const tokens = matcherTokens(guardEntry);
  for (const required of guardedMatcherTools) {
    expect(tokens.has(required), `PreToolUse guard matcher missing ${required}`).toBe(true);
  }

  expect(guardEntry.hooks?.map((hook) => hook.command)).toEqual([
    relocatedHelperCommand('role-enforcement.cjs', '', homeDir),
    relocatedHelperCommand('enforcement.cjs', '', homeDir),
    relocatedHelperCommand('hook-handler.cjs', 'permission-guard', homeDir),
    relocatedHelperCommand('hook-handler.cjs', 'enforce-plan', homeDir),
    relocatedHelperCommand('hook-handler.cjs', 'pre-bash', homeDir),
  ]);
}

function expectSettingsReconciler(settings: GeneratedSettings, homeDir = homedir()): void {
  const postToolUse = settings.hooks?.PostToolUse || [];
  const sessionStart = settings.hooks?.SessionStart || [];
  const stop = settings.hooks?.Stop || [];

  const postEntry = findEntry(postToolUse, 'settings-reconciler.cjs', 'Write|Edit|MultiEdit');
  const postTokens = matcherTokens(postEntry);
  for (const required of ['Write', 'Edit', 'MultiEdit', 'mcp__filesystem__write_file', 'mcp__filesystem__edit_file']) {
    expect(postTokens.has(required), `settings reconciler PostToolUse matcher missing ${required}`).toBe(true);
  }

  const reconcilerCommand = relocatedHelperCommand('settings-reconciler.cjs', '', homeDir);
  expect(postEntry.hooks?.[0]?.command).toBe(reconcilerCommand);
  expect(findEntry(sessionStart, 'settings-reconciler.cjs').hooks?.some((hook) => hook.command === reconcilerCommand)).toBe(true);
  expect(findEntry(stop, 'settings-reconciler.cjs').hooks?.some((hook) => hook.command === reconcilerCommand)).toBe(true);
}

describe('init settings enforcement chain', () => {
  it('fresh settings generation emits the full PreToolUse enforcement chain', () => {
    const settings = generateSettings(testOptions('/tmp/hf-init-test')) as GeneratedSettings;
    expectFullPreToolUseChain(settings);
    expectSettingsReconciler(settings);
    expect(JSON.stringify(settings)).not.toContain('$HOME');
    expect(JSON.stringify(settings)).not.toContain('%USERPROFILE%');
  });

  it('fresh init writes a governed settings.json to disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-settings-init-'));
    const homeRoot = mkdtempSync(join(tmpdir(), 'hf-settings-home-'));
    try {
      const result = await executeInit({
        ...testOptions(root),
        enforcementHomeDir: homeRoot,
      } as InitOptions & { enforcementHomeDir: string });
      expect(result.errors, result.errors.join('\n')).toEqual([]);
      expect(result.success).toBe(true);

      const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as GeneratedSettings;
      expectFullPreToolUseChain(settings, homeRoot);
      expectSettingsReconciler(settings, homeRoot);
      for (const helper of [
        'hive-composition-gate.cjs',
        'role-enforcement.cjs',
        'enforcement.cjs',
        'hook-handler.cjs',
        'settings-reconciler.cjs',
        'provider-tracker.cjs',
        'client-kind.cjs',
        'session-id.cjs',
        'protected-paths.cjs',
        'protected-paths.policy.json',
      ]) {
        expect(existsSync(join(homeRoot, '.hive-flow', 'enforcement', 'bin', helper)), helper).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });

  it('upgrade settings merge installs the same chain for existing projects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-settings-upgrade-'));
    try {
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(
        join(root, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'node .claude/helpers/hook-handler.cjs pre-bash', timeout: 5000 }],
              },
            ],
          },
        }),
        'utf8',
      );

      const result = await executeUpgrade(root, true);
      expect(result.success).toBe(true);

      const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as GeneratedSettings;
      expectFullPreToolUseChain(settings);
      expectSettingsReconciler(settings);
      expect(JSON.stringify(settings)).not.toContain('$HOME');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
