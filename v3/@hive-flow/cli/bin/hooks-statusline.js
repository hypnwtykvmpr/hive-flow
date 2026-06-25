#!/usr/bin/env node

/**
 * Compatibility CLI for the historical hooks-statusline binary.
 *
 * The legacy hooks statusline generator used stale fallbacks. Keep the binary
 * name available for users, but route every render through the canonical
 * Claude Code statusline renderer.
 */

import { readStatuslineStdin, renderClaudeCodeStatuslineWithMeta } from '../dist/src/statusline/claude-code-renderer.js';
import { writeLastRender } from '../dist/src/statusline/last-render.js';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const compactMode = args.includes('--compact');
const helpMode = args.includes('--help') || args.includes('-h');

async function main() {
  if (helpMode) {
    console.log(`
Hooks Statusline - compatibility wrapper

Usage:
  hooks-statusline              Output canonical Hive Flow statusline
  hooks-statusline --json       Output structured canonical render
  hooks-statusline --compact    Output compact structured canonical render
  hooks-statusline --help       Show this help

This binary delegates to @hive-flow/cli/bin/statusline.js. It no longer runs
the legacy hooks statusline collector.
`);
    return;
  }

  const stdinData = await readStatuslineStdin();
  const meta = await renderClaudeCodeStatuslineWithMeta(stdinData, process.cwd());

  if (meta.projectKey && meta.projectRoot) {
    await writeLastRender({
      rendered: meta.rendered,
      mode: meta.mode,
      projectRoot: meta.projectRoot,
      projectKey: meta.projectKey,
      ...(meta.snapshot !== undefined ? { snapshot: meta.snapshot } : {}),
    }).catch(() => undefined);
  }

  if (compactMode || jsonMode) {
    const payload = {
      source: 'canonical-statusline',
      agent: 'claude-code',
      mode: meta.mode,
      text: meta.rendered,
    };
    console.log(JSON.stringify(payload, null, compactMode ? 0 : 2));
    return;
  }

  process.stdout.write(meta.rendered + '\n');
}

main().catch(() => {
  process.stdout.write('');
});
