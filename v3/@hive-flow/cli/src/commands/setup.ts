/**
 * V3 CLI Setup Command
 * Global environment setup for Hive Flow
 *
 * Created with ruv.io
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setupOverride,
  requestOverride,
  revokeOverride,
  overrideStatus,
} from '../permission-guard/biometric-override.js';

/** Default global config written to ~/.hive-flow/config.json */
function defaultGlobalConfig(): Record<string, unknown> {
  return {
    version: '3.0.0',
    mode: 'global',
    topology: 'hierarchical-mesh',
    maxAgents: 15,
    memory: {
      backend: 'hybrid',
      enableHNSW: true,
    },
    neural: { enabled: true },
    logging: { level: 'info' },
  };
}

/** Ensure a directory exists, return whether it was created. */
function ensureDir(dirPath: string): boolean {
  if (existsSync(dirPath)) return false;
  mkdirSync(dirPath, { recursive: true });
  return true;
}

const globalAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const globalDir = join(homedir(), '.hive-flow');
  const force = ctx.flags.force as boolean;

  output.writeln();
  output.writeln(output.bold('Hive Flow Global Setup'));
  output.writeln(output.dim('Configuring ~/.hive-flow/ for global use'));
  output.writeln();

  // 1. Create directory structure
  const subdirs = ['config', 'data', 'memory', 'logs'];
  const created: string[] = [];
  const existing: string[] = [];

  for (const sub of subdirs) {
    const dirPath = join(globalDir, sub);
    if (ensureDir(dirPath)) {
      created.push(sub);
    } else {
      existing.push(sub);
    }
  }

  if (created.length > 0) {
    output.writeln(output.success(`Created directories: ${created.map(d => `~/.hive-flow/${d}`).join(', ')}`));
  }
  if (existing.length > 0) {
    output.writeln(output.dim(`Already exist: ${existing.map(d => `~/.hive-flow/${d}`).join(', ')}`));
  }

  // 2. Write default config
  const configPath = join(globalDir, 'config.json');
  const configExists = existsSync(configPath);

  if (!configExists || force) {
    writeFileSync(configPath, JSON.stringify(defaultGlobalConfig(), null, 2) + '\n', 'utf8');
    output.writeln(output.success(`${configExists ? 'Overwrote' : 'Created'} ~/.hive-flow/config.json`));
  } else {
    output.writeln(output.dim('Config already exists (use --force to overwrite)'));
  }

  // 3. Show status summary
  output.writeln();
  output.writeln(output.bold('Status'));
  output.writeln(output.dim('─'.repeat(45)));

  output.writeln(`  Global data dir:  ${globalDir}`);

  // Detect project-local vs global mode
  const localConfig = existsSync(join(ctx.cwd, '.hive-flow', 'config.yaml'))
    || existsSync(join(ctx.cwd, 'hive-flow.config.json'));
  output.writeln(`  Project-local:    ${localConfig ? output.success('detected') : output.dim('none')}`);
  output.writeln(`  Active mode:      ${localConfig ? 'project-local' : 'global'}`);

  // Available tools
  const tools: string[] = ['memory', 'hooks', 'swarm', 'agent', 'session', 'neural'];
  output.writeln(`  Global tools:     ${tools.join(', ')}`);

  // Read back config for display
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    output.writeln(`  Topology:         ${cfg.topology ?? 'hierarchical-mesh'}`);
    output.writeln(`  Max agents:       ${cfg.maxAgents ?? 15}`);
    output.writeln(`  Memory backend:   ${cfg.memory?.backend ?? 'hybrid'}`);
  } catch {
    // Config read failed — non-critical
  }

  // 4. Next steps
  output.writeln();
  output.writeln(output.bold('Next steps:'));
  output.printList([
    `Run ${output.highlight('hive-flow doctor')} to verify system health`,
    `Run ${output.highlight('hive-flow init')} inside a project for project-local setup`,
    `Run ${output.highlight('hive-flow daemon start')} to start background workers`,
  ]);

  return { success: true, data: { globalDir, created, existing, configExists } };
};

// ---------------------------------------------------------------------------
// Permission-guard subcommands
// ---------------------------------------------------------------------------

const permissionGuardSetupCommand: Command = {
  name: 'setup',
  description: 'One-time Ed25519 keypair generation for Permission Guard (run as human, not LLM)',
  options: [],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Permission Guard Setup'));
    output.writeln(output.dim('Generating Ed25519 keypair and storing private key in locked credential store'));
    output.writeln();
    try {
      await setupOverride();
      output.writeln();
      output.writeln(output.success('Permission Guard setup complete.'));
      output.writeln(output.dim('You can now use: hive-flow setup permission-guard override'));
      return { success: true };
    } catch (err) {
      output.writeln(output.error(`Setup failed: ${(err as Error).message}`));
      return { success: false, message: (err as Error).message };
    }
  },
};

const permissionGuardOverrideCommand: Command = {
  name: 'override',
  description: 'Request a 5-minute permission override window (triggers human authentication)',
  options: [],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Requesting Permission Override'));
    output.writeln(output.dim('This will trigger your platform credential store authentication...'));
    output.writeln();
    const result = await requestOverride();
    if (result.granted) {
      const expiresAt = new Date(result.expiresAt).toLocaleTimeString();
      output.writeln(output.success(`Override granted — active until ${expiresAt}`));
      return { success: true, data: result };
    } else {
      output.writeln(output.error('Override not granted — authentication failed or cancelled.'));
      return { success: false, message: 'Override not granted' };
    }
  },
};

const permissionGuardRevokeCommand: Command = {
  name: 'revoke',
  description: 'Immediately revoke any active permission override',
  options: [],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    revokeOverride();
    return { success: true };
  },
};

const permissionGuardStatusCommand: Command = {
  name: 'status',
  description: 'Show current permission override state (active/expired/none)',
  options: [],
  action: async (_ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Permission Guard Override Status'));
    output.writeln(output.dim('─'.repeat(45)));
    const status = overrideStatus();
    if (status.active && status.expiresAt !== undefined && status.secondsRemaining !== undefined) {
      const expiresAt = new Date(status.expiresAt).toLocaleTimeString();
      const mins = Math.floor(status.secondsRemaining / 60);
      const secs = status.secondsRemaining % 60;
      const remaining = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      output.writeln(`  State:     ${output.success('ACTIVE')}`);
      output.writeln(`  Expires:   ${expiresAt} (${remaining} remaining)`);
    } else if (existsSync(join(homedir(), '.hive-flow', 'permission-guard', 'active-override.json'))) {
      output.writeln(`  State:     ${output.dim('EXPIRED')}`);
    } else {
      output.writeln(`  State:     ${output.dim('NONE')}`);
    }
    output.writeln();
    return { success: true, data: status };
  },
};

const permissionGuardCommand: Command = {
  name: 'permission-guard',
  description: 'Manage cryptographic permission overrides (Ed25519-backed)',
  subcommands: [
    permissionGuardSetupCommand,
    permissionGuardOverrideCommand,
    permissionGuardRevokeCommand,
    permissionGuardStatusCommand,
  ],
  examples: [
    { command: 'hive-flow setup permission-guard setup', description: 'One-time keypair generation' },
    { command: 'hive-flow setup permission-guard override', description: 'Request 5-minute override window' },
    { command: 'hive-flow setup permission-guard revoke', description: 'Revoke active override immediately' },
    { command: 'hive-flow setup permission-guard status', description: 'Show override state' },
  ],
};

// Global subcommand
const globalCommand: Command = {
  name: 'global',
  description: 'Set up global ~/.hive-flow/ directory and default config',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing config',
      type: 'boolean',
      default: false,
    },
  ],
  action: globalAction,
};

// Main setup command
export const setupCommand: Command = {
  name: 'setup',
  description: 'Environment setup and configuration',
  subcommands: [globalCommand, permissionGuardCommand],
  examples: [
    { command: 'hive-flow setup global', description: 'Create global ~/.hive-flow/ directory' },
    { command: 'hive-flow setup global --force', description: 'Recreate global config from defaults' },
    { command: 'hive-flow setup permission-guard setup', description: 'One-time Permission Guard keypair generation' },
    { command: 'hive-flow setup permission-guard override', description: 'Request 5-minute override window' },
    { command: 'hive-flow setup permission-guard revoke', description: 'Revoke active override immediately' },
    { command: 'hive-flow setup permission-guard status', description: 'Show override state' },
  ],
};

export default setupCommand;
