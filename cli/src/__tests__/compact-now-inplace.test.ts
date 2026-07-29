import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// `__dirname` is <repo>/cli/src/__tests__, so the repo root is three levels up.
// This previously used five, a leftover from when the package lived at
// v3/@hive-flow/cli/. After the CLI promotion it resolved outside the repo and
// both tests died with MODULE_NOT_FOUND before exercising compact-now at all —
// the same stale-depth class as the credential workflow repair.
const repoRoot = resolve(__dirname, '..', '..', '..');
const helperPath = join(repoRoot, '.claude', 'helpers', 'compact-now.cjs');

// Fail loudly and specifically if the anchor ever drifts again, instead of
// surfacing an opaque MODULE_NOT_FOUND from inside a spawned process.
if (!existsSync(helperPath)) {
  throw new Error(
    `compact-now helper not found at ${helperPath}; the repoRoot anchor in this test is stale`,
  );
}
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-compact-now-'));
  roots.push(root);
  mkdirSync(join(root, '.hive-flow', 'data'), { recursive: true });
  return root;
}

/**
 * Provide a measurement the way a real `--mode inplace` run gets one.
 *
 * These tests previously wrote `autopilot-state.json` with **no** `sessionId`
 * and passed no `--resume`, which only measured because the old fallback guard
 * short-circuited when either session id was absent. That is the hive-flow-9543
 * defect, so the fixture encoded the bug: it would keep passing even if the
 * fallback trusted an arbitrary foreign session's state.
 *
 * `--mode inplace` never passes `--resume`, so post-fix it can never legitimately
 * reach the autopilot fallback. Its real measurement source is the statusline
 * record, which wins on precedence and requires no session id — so that is what
 * these tests now supply.
 */
function writeMeasuredContext(root: string, percentage = 60): void {
  const projectKey = 'fedcba9876543210';
  const dir = join(root, '.hive-flow', 'statusline', 'projects', projectKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last-render.json'), JSON.stringify({
    version: 1,
    renderedAt: new Date().toISOString(),
    mode: 'header-only',
    projectRoot: root,
    projectKey,
    rendered: 'hive-flow | Opus 4.8 | Working | ctx │███████▋     │',
    context: { percentage, source: 'stdin' },
  }), 'utf8');
}

function writeFakeTmux(binDir: string, logPath: string): void {
  mkdirSync(binDir, { recursive: true });
  const fakeTmux = join(binDir, 'tmux');
  writeFileSync(
    fakeTmux,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      'fs.appendFileSync(process.env.HF_FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");',
      "if (args[0] === 'display-message') { process.stdout.write(process.env.TMUX_PANE || '%current'); }",
    ].join('\n'),
  );
  chmodSync(fakeTmux, 0o755);
  writeFileSync(logPath, '', 'utf8');
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe('compact-now current-session in-place compaction', () => {
  it('writes recovery state and submits /compact to the current Claude tmux pane', () => {
    const root = makeRoot();
    const binDir = join(root, 'bin');
    const tmuxLog = join(root, 'tmux.log');
    writeFakeTmux(binDir, tmuxLog);
    writeMeasuredContext(root);
    writeFileSync(join(root, '.hive-flow', 'data', 'tmux-pane.txt'), '%claude\n', 'utf8');

    const output = execFileSync(process.execPath, [
      helperPath,
      '--mode',
      'inplace',
      '--reason',
      'context high',
      '--next-step',
      'resume audit',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
        CLAUDE_PROJECT_DIR: root,
        // Scope the statusline record lookup to this fixture, so the measurement
        // comes from the record written above rather than the operator's real
        // statusline cache.
        HIVE_FLOW_HOME: root,
        TMUX: '/tmp/tmux-test',
        TMUX_PANE: '%claude',
        HF_FAKE_TMUX_LOG: tmuxLog,
      },
      encoding: 'utf8',
    });

    const parsed = JSON.parse(output) as {
      ok: boolean;
      mode: string;
      headless: { launched: boolean; mode: string; pane: string };
      handoffPath: string;
      requestPath: string;
    };
    expect(parsed).toMatchObject({
      ok: true,
      mode: 'inplace',
      headless: { launched: true, mode: 'inplace', pane: '%claude' },
    });
    expect(readFileSync(parsed.handoffPath, 'utf8')).toContain('context high');
    expect(JSON.parse(readFileSync(parsed.requestPath, 'utf8'))).toMatchObject({
      type: 'hive-flow.compact-request',
      mode: 'inplace',
      nextStep: 'resume audit',
    });

    const calls = readFileSync(tmuxLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.arrayContaining(['send-keys', '-t', '%claude', '-l']));
    expect(calls[0].join(' ')).toContain('/compact Preserve the active task state');
    expect(calls[1]).toEqual(['send-keys', '-t', '%claude', 'Enter']);
  });

  it('refuses to inject /compact into a different recorded Claude pane by default', () => {
    const root = makeRoot();
    const binDir = join(root, 'bin');
    const tmuxLog = join(root, 'tmux.log');
    writeFakeTmux(binDir, tmuxLog);
    writeMeasuredContext(root);
    writeFileSync(join(root, '.hive-flow', 'data', 'tmux-pane.txt'), '%claude\n', 'utf8');

    expect(() => execFileSync(process.execPath, [
      helperPath,
      '--mode',
      'inplace',
      '--reason',
      'context high',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
        CLAUDE_PROJECT_DIR: root,
        // Scope the statusline record lookup to this fixture, so the measurement
        // comes from the record written above rather than the operator's real
        // statusline cache.
        HIVE_FLOW_HOME: root,
        TMUX: '/tmp/tmux-test',
        TMUX_PANE: '%codex',
        HF_FAKE_TMUX_LOG: tmuxLog,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).toThrow(/Refusing to inject \/compact/);
    expect(readFileSync(tmuxLog, 'utf8')).toBe('');
  });
});
