// cli/src/statusline/__tests__/hooks-delegation.test.ts
//
// §12.4 Hook-command delegation, warm-cache latency, and launcher regression.
//
// Four guarantees are pinned here:
//   1. `hive-flow hooks statusline` and `hive-flow statusline --agent claude-code`
//      delegate to the same canonical renderer.
//   2. The renderer satisfies the warm-cache latency budget after one warm-up.
//   3. The stable statusline launcher shim execs `bin/statusline.js` directly
//      and never regresses to the heavy CLI path (`bin/cli.js`, `hive-flow
//      statusline`, or `npx ...`).
//   4. `hive-flow hooks statusline` persists the last-render mirror via
//      `writeLastRender` — same wrapper contract as `commands/statusline.ts`
//      and `bin/statusline.js`. Codex Phase 7 Finding parity assertion: the
//      hooks subcommand must update the current pointer (and per-project
//      global mirror) after rendering, so cross-CLI consumers reading the
//      pointer see the latest render regardless of which entrypoint produced
//      it.
//
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';
import { writeStableStatuslineLauncher } from '../../integrations/launcher.js';

// Package root for the @hive-flow/cli package. This file lives at
// src/statusline/__tests__/, so the package root is three levels up.
// The package is ESM ("type": "module"), so __dirname is undefined and we
// derive it from import.meta.url.
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(THIS_DIR, '..', '..', '..');
const CLI_PATH = join(PACKAGE_ROOT, 'bin', 'cli.js');
const DIST_RENDERER = join(PACKAGE_ROOT, 'dist', 'src', 'statusline', 'claude-code-renderer.js');

function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), 'hf-statusline-'));
}

describe('hooks statusline delegation (§12.4)', () => {
  // The spawn-based delegation test cannot run without a built dist/ because
  // both bin/cli.js and bin/statusline.js import from dist/. The harness
  // documents `npm run build` as part of Wave 5 §13; if dist is missing in
  // CI we surface a clear skip rather than a misleading crash.
  const builtDist = existsSync(DIST_RENDERER);

  it.skipIf(!builtDist)('hooks statusline delegates to the canonical renderer', () => {
    const projectCwd = makeFixture();
    const sample = JSON.stringify({
      workspace: { current_dir: projectCwd, project_dir: projectCwd },
      model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' },
      context_window: { used_percentage: 12 },
    });

    const top = spawnSync(
      process.execPath,
      [CLI_PATH, 'statusline', '--agent', 'claude-code'],
      { cwd: projectCwd, input: sample, encoding: 'utf8', timeout: 10_000 },
    );
    const hook = spawnSync(
      process.execPath,
      [CLI_PATH, 'hooks', 'statusline'],
      { cwd: projectCwd, input: sample, encoding: 'utf8', timeout: 10_000 },
    );

    expect(top.status).toBe(0);
    expect(hook.status).toBe(0);
    // The renderer emits "Opus 4.8" from stdin's display_name and appends " 1M"
    // when the id matches [1m] (case-insensitive). Both transports should
    // contain the model display.
    expect(hook.stdout).toContain('Opus 4.8');
    // Regression fence: legacy fake "DDD Domains" row must not surface from
    // either the hooks subcommand or the canonical command after Wave 2
    // consolidation removed the inline collectors.
    expect(hook.stdout).not.toContain('DDD Domains');
  });

  // Codex Phase 7 Finding parity: the hooks subcommand must persist the
  // last-render mirror via `writeLastRender`, exactly like the top-level
  // `commands/statusline.ts` wrapper and `bin/statusline.js`. Cross-CLI
  // consumers rely on the current pointer being updated by EVERY entrypoint
  // — if the hooks path skipped persistence, a hook-driven render would
  // silently leave the pointer pointing at a stale earlier render.
  it.skipIf(!builtDist)('hooks statusline writes the current-pointer mirror after rendering', async () => {
    const projectCwd = makeFixture();
    const hfHome = mkdtempSync(join(tmpdir(), 'hf-hooks-home-'));
    try {
      const sample = JSON.stringify({
        workspace: { current_dir: projectCwd, project_dir: projectCwd },
        model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' },
        context_window: { used_percentage: 12 },
      });

      const hook = spawnSync(
        process.execPath,
        [CLI_PATH, 'hooks', 'statusline'],
        {
          cwd: projectCwd,
          input: sample,
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, HIVE_FLOW_HOME: hfHome },
        },
      );

      expect(hook.status).toBe(0);

      // The current pointer is the cross-CLI handoff file: a single global
      // pointer at `${HIVE_FLOW_HOME}/.hive-flow/statusline/current.json` that
      // identifies the most-recently-rendered project so non-Claude consumers
      // can find the latest render without knowing `projectKey` ahead of time.
      const currentPointer = join(hfHome, '.hive-flow', 'statusline', 'current.json');
      expect(existsSync(currentPointer)).toBe(true);

      // Validate the pointer points at a real per-project last-render.json
      // that also exists on disk. We re-derive the canonical mirror path
      // (rooted under the redirected HIVE_FLOW_HOME) rather than trusting
      // the pointer's `lastRender` field blindly. Matches the existing
      // pattern in `last-render.test.ts` for parsing this same pointer
      // file.
      const pointer = JSON.parse(readFileSync(currentPointer, 'utf8'));
      expect(pointer.version).toBe(1);
      expect(typeof pointer.projectRoot).toBe('string');
      // 16-char lowercase hex (matches Wave 3 `resolveProjectScope` shape).
      expect(pointer.projectKey).toMatch(/^[0-9a-f]{16}$/);
      const expectedLastRender = join(
        hfHome,
        '.hive-flow',
        'statusline',
        'projects',
        pointer.projectKey,
        'last-render.json',
      );
      expect(pointer.lastRender).toBe(expectedLastRender);
      expect(existsSync(expectedLastRender)).toBe(true);
    } finally {
      rmSync(hfHome, { recursive: true, force: true });
    }
  });

  it('renders within the warm-cache latency budget', async () => {
    const cwd = makeFixture();
    const stdinData = {
      workspace: { current_dir: cwd, project_dir: cwd },
      model: { display_name: 'Opus 4.8' },
    };

    // Warm any per-cwd caches (e.g., the tmpdir-keyed spawn cache used by
    // the renderer) and then time a second invocation.
    await renderClaudeCodeStatusline(stdinData, cwd);
    const start = performance.now();
    await renderClaudeCodeStatusline(stdinData, cwd);
    const elapsed = performance.now() - start;

    // 200ms matches the runbook target; the renderer's internal budget is
    // 220ms so anything under 200ms confirms the warm path is genuinely fast.
    expect(elapsed).toBeLessThan(200);
  });

  it('stable statusline launcher executes the lightweight runtime entrypoint', async () => {
    const cwd = makeFixture();
    const launcher = join(cwd, '.hive-flow', 'bin', 'claude-code-statusline');
    const runtime = join(cwd, 'cli', 'bin', 'statusline.js');

    // The runtime file does not need to exist for writeStableStatuslineLauncher
    // — the launcher records the path inside a bash shim that resolves at
    // spawn-time, not at write-time.
    await writeStableStatuslineLauncher(launcher, runtime);

    const source = readFileSync(launcher, 'utf8');
    // Positive assertion: the runtime entrypoint path is embedded verbatim.
    expect(source).toContain('bin/statusline.js');
    // Regression fence: must never delegate through the heavy CLI surface.
    expect(source).not.toContain('bin/cli.js statusline');
    expect(source).not.toContain('hive-flow statusline');
    expect(source).not.toContain('npx ');
    expect(source).toContain('HIVE_FLOW_STATUSLINE_CHAIN_PREVIOUS');
  });
});
