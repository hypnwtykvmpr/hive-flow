/**
 * V3 CLI Signal Command
 * User-initiated workflow control: pause, resume, skip, stop, mode-change.
 * Writes signal files that the running SignalManager polls and processes.
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';

/** Resolve the signals directory for the current swarm */
function getSignalsDir(ctx: CommandContext): string {
  const swarmId = (ctx.flags.swarm as string) || 'default';
  const baseDir = (ctx.flags.dir as string) || join(ctx.cwd, '.hive-flow', 'signals');
  return join(baseDir, swarmId);
}

/** Write a signal file that SignalManager will pick up on next poll */
async function writeSignal(
  signalsDir: string,
  signal: Record<string, unknown>,
): Promise<void> {
  await mkdir(signalsDir, { recursive: true });
  const filename = `${signal.type}.signal`;
  await writeFile(
    join(signalsDir, filename),
    JSON.stringify(signal, null, 2),
  );
}

const pauseCommand: Command = {
  name: 'pause',
  description: 'Pause the running swarm',
  options: [
    { name: 'reason', short: 'r', type: 'string', description: 'Reason for pausing' },
    { name: 'target', short: 't', type: 'string', description: 'Target agent ID (optional)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const signalsDir = getSignalsDir(ctx);
    await writeSignal(signalsDir, {
      type: 'pause',
      timestamp: new Date().toISOString(),
      source: 'user',
      reason: ctx.flags.reason || 'User requested pause',
      targetId: ctx.flags.target,
    });
    output.printSuccess('Pause signal sent');
    output.printInfo('The swarm will pause on the next poll cycle');
    return { success: true };
  },
};

const resumeCommand: Command = {
  name: 'resume',
  description: 'Resume a paused swarm',
  options: [
    { name: 'reason', short: 'r', type: 'string', description: 'Reason for resuming' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const signalsDir = getSignalsDir(ctx);
    await writeSignal(signalsDir, {
      type: 'resume',
      timestamp: new Date().toISOString(),
      source: 'user',
      reason: ctx.flags.reason || 'User requested resume',
    });
    output.printSuccess('Resume signal sent');
    return { success: true };
  },
};

const skipCommand: Command = {
  name: 'skip',
  description: 'Skip the current task/step',
  options: [
    { name: 'reason', short: 'r', type: 'string', description: 'Reason for skipping' },
    { name: 'target', short: 't', type: 'string', description: 'Target agent ID (optional)' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const signalsDir = getSignalsDir(ctx);
    await writeSignal(signalsDir, {
      type: 'skip',
      timestamp: new Date().toISOString(),
      source: 'user',
      reason: ctx.flags.reason || 'User requested skip',
      targetId: ctx.flags.target,
    });
    output.printSuccess('Skip signal sent');
    return { success: true };
  },
};

const stopCommand: Command = {
  name: 'stop',
  description: 'Stop the running swarm',
  options: [
    { name: 'reason', short: 'r', type: 'string', description: 'Reason for stopping' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const signalsDir = getSignalsDir(ctx);
    await writeSignal(signalsDir, {
      type: 'stop',
      timestamp: new Date().toISOString(),
      source: 'user',
      reason: ctx.flags.reason || 'User requested stop',
    });
    output.printSuccess('Stop signal sent');
    output.printWarning('The swarm will stop after the current task completes');
    return { success: true };
  },
};

const modeCommand: Command = {
  name: 'mode',
  description: 'Switch execution mode (autonomous/interactive)',
  options: [
    { name: 'reason', short: 'r', type: 'string', description: 'Reason for mode change' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const targetMode = ctx.args[0];
    if (!targetMode || !['autonomous', 'interactive'].includes(targetMode)) {
      output.printError('Usage: signal mode <autonomous|interactive>');
      return { success: false, exitCode: 1 };
    }
    const signalsDir = getSignalsDir(ctx);
    await writeSignal(signalsDir, {
      type: 'mode-change',
      timestamp: new Date().toISOString(),
      source: 'user',
      targetMode,
      reason: ctx.flags.reason || `Switching to ${targetMode} mode`,
    });
    output.printSuccess(`Mode change signal sent: ${targetMode}`);
    return { success: true };
  },
};

export const signalCommand: Command = {
  name: 'signal',
  description: 'Send workflow control signals (pause, resume, skip, stop)',
  options: [
    { name: 'swarm', short: 's', type: 'string', description: 'Target swarm ID', default: 'default' },
    { name: 'dir', short: 'd', type: 'string', description: 'Signals directory override' },
  ],
  subcommands: [pauseCommand, resumeCommand, skipCommand, stopCommand, modeCommand],
  examples: [
    { command: 'hive-flow signal pause', description: 'Pause the swarm' },
    { command: 'hive-flow signal resume', description: 'Resume the swarm' },
    { command: 'hive-flow signal stop -r "Task complete"', description: 'Stop with reason' },
    { command: 'hive-flow signal mode interactive', description: 'Switch to interactive mode' },
    { command: 'hive-flow signal skip -t agent-1', description: 'Skip for specific agent' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Workflow Signal Commands'));
    output.writeln();
    output.writeln('Usage: hive-flow signal <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('pause')}   - Pause the running swarm`,
      `${output.highlight('resume')}  - Resume a paused swarm`,
      `${output.highlight('skip')}    - Skip the current task/step`,
      `${output.highlight('stop')}    - Stop the running swarm`,
      `${output.highlight('mode')}    - Switch execution mode (autonomous/interactive)`,
    ]);
    output.writeln();
    output.writeln('Run "hive-flow signal <subcommand> --help" for subcommand help');
    return { success: true };
  },
};

export default signalCommand;
