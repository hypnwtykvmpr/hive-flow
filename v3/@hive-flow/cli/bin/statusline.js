#!/usr/bin/env node
/**
 * Lightweight Claude Code statusline entrypoint.
 *
 * Keep this intentionally small. Do not import src/index.js, commands/index.js,
 * update checks, MCP startup code, or the CLI parser here.
 */
import { readStatuslineStdin, renderClaudeCodeStatusline } from '../dist/src/statusline/claude-code-renderer.js';

try {
  const stdinData = await readStatuslineStdin();
  const rendered = await renderClaudeCodeStatusline(stdinData, process.cwd());
  process.stdout.write(rendered + '\n');
} catch {
  // Claude Code troubleshooting expects stdout-only success output. On failure,
  // degrade to empty output rather than rendering stack traces in the UI.
  process.stdout.write('');
}
