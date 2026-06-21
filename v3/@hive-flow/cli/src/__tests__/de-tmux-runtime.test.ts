import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');
const requireFromHere = createRequire(import.meta.url);

const RUNTIME_FILES = [
  '.claude/settings.json',
  '.claude/helpers/agent-task-rewake.cjs',
  '.claude/helpers/hive-enforcement.cjs',
  '.claude/helpers/sentinel-recovery.cjs',
  '.claude/helpers/wake-paths.cjs',
  'scripts/hive-watcher.cjs',
  'v3/@hive-flow/cli/src/commands/statusline.ts',
  'v3/@hive-flow/cli/src/init/settings-generator.ts',
  'v3/@hive-flow/cli/src/mcp-tools/hive-store.ts',
  'v3/@hive-flow/cli/src/mcp-tools/queen-tools.ts',
  'v3/@hive-flow/shared/src/utils/resolve-hive-home.ts',
] as const;

const FORBIDDEN_ACTIVE_TMUX_PATTERNS: Array<[RegExp, string]> = [
  [/\bTMUX_PANE\b/, 'TMUX_PANE environment fallback'],
  [/\btmux-pane\.txt\b/, 'tmux pane registry file'],
  [/["']\/panes\/["']|["']panes["']/, 'tmux pane registry directory'],
  [/\bcommand\s+-v\s+tmux\b/, 'tmux binary probe'],
  [/\btmux\s+display-message\b/, 'tmux display-message call'],
  [/\bdisplay-message\b/, 'tmux display-message token'],
  [/\bsend-keys\b/, 'tmux send-keys call'],
  [/\bcapture-pane\b/, 'tmux capture-pane call'],
  [/ownerTmuxPane\s*=/, 'tmux owner pane persistence'],
  [/record\.ownerTmuxPane\b/, 'tmux pane stored in hive record'],
];

describe('de-tmux runtime invariant', () => {
  it('has no active tmux dependency in hive-flow runtime files', () => {
    const violations: string[] = [];

    for (const relative of RUNTIME_FILES) {
      const source = readFileSync(resolve(repoRoot, relative), 'utf8');
      for (const [pattern, label] of FORBIDDEN_ACTIVE_TMUX_PATTERNS) {
        if (!pattern.test(source)) continue;
        violations.push(`${relative}: ${label}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the private tmux control allowance limited to enforcement detection', () => {
    const root = readFileSync(resolve(repoRoot, '.claude/helpers/enforcement.cjs'), 'utf8');
    const anchor = readFileSync(resolve(repoRoot, 'v3/@hive-flow/cli/.claude/helpers/enforcement.cjs'), 'utf8');

    for (const source of [root, anchor]) {
      expect(source).toContain("commandBasename(word) !== 'hf-tmux-control.sh'");
      expect(source).not.toMatch(/\btmux\s+(send-keys|capture-pane|display-message)\b/);
    }
  });

  it('does not derive durable wake routing from TMUX_PANE alone', () => {
    const wakePaths = requireFromHere(resolve(repoRoot, '.claude/helpers/wake-paths.cjs')) as {
      sessionValue: (input?: unknown, env?: Record<string, string | undefined>) => string | null;
      wakeSessionPaths: (input?: unknown, env?: Record<string, string | undefined>) => unknown;
    };

    expect(wakePaths.sessionValue(null, { TMUX_PANE: '%1' })).toBeNull();
    expect(wakePaths.wakeSessionPaths(null, { TMUX_PANE: '%1' })).toBeNull();
    expect(wakePaths.sessionValue(null, { CLAUDE_SESSION_ID: 'session-1', TMUX_PANE: '%1' })).toBe('session-1');
  });

  it('routes wake sessions by Codex id before Claude or Hive fallback env ids', () => {
    const wakePaths = requireFromHere(resolve(repoRoot, '.claude/helpers/wake-paths.cjs')) as {
      sessionValue: (input?: unknown, env?: Record<string, string | undefined>) => string | null;
    };

    expect(wakePaths.sessionValue(null, {
      CODEX_SESSION_ID: 'codex-session',
      CLAUDE_SESSION_ID: 'claude-session',
      HIVE_FLOW_SESSION_ID: 'hive-session',
    })).toBe('codex-session');
  });
});
