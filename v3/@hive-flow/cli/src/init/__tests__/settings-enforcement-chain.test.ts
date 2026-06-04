import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSettings } from '../settings-generator.js';
import { executeUpgrade } from '../executor.js';
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

function expectFullPreToolUseChain(settings: GeneratedSettings): void {
  const preToolUse = settings.hooks?.PreToolUse || [];
  expect(preToolUse.length).toBeGreaterThanOrEqual(3);

  const taskEntry = findEntry(preToolUse, 'hive-composition-gate.cjs', 'Task');
  expect(taskEntry.hooks?.[0]?.command).toBe('node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hive-composition-gate.cjs');

  const spawnEntry = findEntry(preToolUse, 'role-enforcement.cjs', 'mcp__hive-flow__agent_spawn');
  expect(spawnEntry.hooks?.map((hook) => hook.command)).toEqual([
    'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/role-enforcement.cjs',
    'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/enforcement.cjs',
  ]);

  const guardEntry = findEntry(preToolUse, 'hook-handler.cjs permission-guard');
  const tokens = matcherTokens(guardEntry);
  for (const required of guardedMatcherTools) {
    expect(tokens.has(required), `PreToolUse guard matcher missing ${required}`).toBe(true);
  }

  expect(guardEntry.hooks?.map((hook) => hook.command)).toEqual([
    'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/role-enforcement.cjs',
    'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/enforcement.cjs',
    'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs permission-guard',
    'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs enforce-plan',
    'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs pre-bash',
  ]);
}

describe('init settings enforcement chain', () => {
  it('fresh settings generation emits the full PreToolUse enforcement chain', () => {
    const settings = generateSettings(testOptions('/tmp/hf-init-test')) as GeneratedSettings;
    expectFullPreToolUseChain(settings);
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
