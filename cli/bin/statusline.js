#!/usr/bin/env node
/**
 * Lightweight Claude Code statusline entrypoint.
 *
 * Keep this intentionally small. Do not import src/index.js, commands/index.js,
 * update checks, MCP startup code, or the CLI parser here.
 */
import { readStatuslineStdin, renderClaudeCodeStatuslineWithMeta } from '../dist/src/statusline/claude-code-renderer.js';
import { writeLastRender } from '../dist/src/statusline/last-render.js';

try {
  const stdinData = await readStatuslineStdin();
  const meta = await renderClaudeCodeStatuslineWithMeta(stdinData);
  process.stdout.write(meta.rendered + '\n');
  if (meta.projectKey && meta.projectRoot) {
    await writeLastRender({
      rendered: meta.rendered,
      mode: meta.mode,
      projectRoot: meta.projectRoot,
      projectKey: meta.projectKey,
      ...(meta.context !== undefined ? { context: meta.context } : {}),
      ...(meta.snapshot !== undefined ? { snapshot: meta.snapshot } : {}),
    }).catch(() => undefined);
  }
} catch {
  // Claude Code troubleshooting expects stdout-only success output. On failure,
  // degrade to empty output rather than rendering stack traces in the UI.
  process.stdout.write('');
}
