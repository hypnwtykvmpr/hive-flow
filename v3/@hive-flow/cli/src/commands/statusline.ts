// v3/@hive-flow/cli/src/commands/statusline.ts
//
// Top-level `hive-flow statusline` command. Delegates to the canonical
// Claude Code statusline renderer in src/statusline/claude-code-renderer.ts.
//
// This command is intended for humans, tests, and scripted verification.
// The Claude Code `statusLine.command` setting itself should point at the
// stable launcher emitted by integrations/launcher.ts, NOT at this command
// directly (see runbook §6 and §7).

import type { Command, CommandContext, CommandResult } from '../types.js';
import { readStatuslineStdin, renderClaudeCodeStatusline } from '../statusline/claude-code-renderer.js';

export const statuslineCommand: Command = {
  name: 'statusline',
  description: 'Render Hive Flow statusline output for coding agent CLIs',
  options: [
    {
      name: 'agent',
      description: 'Agent CLI name (only "claude-code" is currently supported)',
      type: 'string',
      default: 'claude-code',
    },
    {
      name: 'json',
      description: 'Emit structured output containing the rendered text',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    {
      command: 'hive-flow statusline --agent claude-code',
      description: 'Render Claude Code statusline from stdin',
    },
    {
      command: 'hive-flow statusline --agent claude-code --json',
      description: 'Emit structured JSON containing the rendered text',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agent = String(ctx.flags.agent ?? 'claude-code');
    if (agent !== 'claude-code') {
      return {
        success: false,
        message: `Unsupported statusline agent: ${agent}`,
        exitCode: 2,
      };
    }

    const stdinData = await readStatuslineStdin();
    const rendered = await renderClaudeCodeStatusline(stdinData, process.cwd());

    if (ctx.flags.json || ctx.flags.format === 'json') {
      const data = { text: rendered, agent };
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return { success: true, data };
    }

    process.stdout.write(rendered + '\n');
    return { success: true, data: { text: rendered, agent } };
  },
};

export default statuslineCommand;
