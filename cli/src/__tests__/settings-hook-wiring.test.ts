import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const settingsPath = resolve(here, '../../../.claude/settings.json');

interface HookCommand {
  command?: string;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

interface Settings {
  hooks?: {
    PreToolUse?: HookEntry[];
    PostToolUse?: HookEntry[];
  };
}

function loadSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
}

function matcherTokens(entry: HookEntry): Set<string> {
  return new Set(String(entry.matcher || '').split('|').filter(Boolean));
}

function findHookEntry(entries: HookEntry[], commandNeedle: string, matcherNeedle?: string): HookEntry {
  const entry = entries.find((candidate) => {
    const hasCommand = candidate.hooks?.some((hook) => hook.command?.includes(commandNeedle));
    const hasMatcher = matcherNeedle ? String(candidate.matcher || '').includes(matcherNeedle) : true;
    return hasCommand && hasMatcher;
  });
  expect(entry, `Missing hook entry for ${commandNeedle}`).toBeDefined();
  return entry!;
}

describe('project Claude settings hook wiring', () => {
  it('routes all security-sensitive tool shapes through PreToolUse guard hooks', () => {
    const settings = loadSettings();
    const preToolUse = settings.hooks?.PreToolUse || [];
    const guardEntry = findHookEntry(preToolUse, 'hook-handler.cjs permission-guard');
    const tokens = matcherTokens(guardEntry);

    for (const required of [
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
    ]) {
      expect(tokens.has(required), `PreToolUse guard matcher missing ${required}`).toBe(true);
    }
  });

  it('routes filesystem mutators through PostToolUse edit/gate hooks', () => {
    const settings = loadSettings();
    const postToolUse = settings.hooks?.PostToolUse || [];
    const editEntry = findHookEntry(postToolUse, 'hook-handler.cjs post-edit', 'mcp__filesystem__write_file');
    const tokens = matcherTokens(editEntry);

    for (const required of [
      'mcp__filesystem__write_file',
      'mcp__filesystem__edit_file',
      'mcp__filesystem__move_file',
      'mcp__filesystem__rename_file',
      'mcp__filesystem__copy_file',
      'mcp__filesystem__create_directory',
      'mcp__filesystem__delete_file',
    ]) {
      expect(tokens.has(required), `PostToolUse edit/gate matcher missing ${required}`).toBe(true);
    }

    expect(editEntry.hooks?.some((hook) => hook.command?.includes('hook-handler.cjs enforce-gate'))).toBe(true);
  });

  it('routes read tools through PostToolUse activity/completion hooks', () => {
    const settings = loadSettings();
    const postToolUse = settings.hooks?.PostToolUse || [];
    const activityEntry = findHookEntry(postToolUse, 'agent-activity-logger.cjs');
    const activityTokens = matcherTokens(activityEntry);
    expect(activityTokens.has('Read'), 'activity matcher missing Read').toBe(true);
    expect(activityTokens.has('NotebookRead'), 'activity matcher missing NotebookRead').toBe(true);
    expect(activityTokens.has('mcp__filesystem__*'), 'activity matcher missing MCP filesystem wildcard').toBe(true);

    const completionEntry = findHookEntry(postToolUse, 'hook-handler.cjs hive-check-complete');
    const completionTokens = matcherTokens(completionEntry);
    expect(completionTokens.has('Read'), 'completion matcher missing Read').toBe(true);
    expect(completionTokens.has('NotebookRead'), 'completion matcher missing NotebookRead').toBe(true);
    expect(completionTokens.has('mcp__filesystem__*'), 'completion matcher missing MCP filesystem wildcard').toBe(true);
  });
});
