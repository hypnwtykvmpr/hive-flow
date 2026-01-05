/**
 * V3 CLI Commands Index
 * Central registry for all CLI commands
 */

import type { Command } from '../types.js';
import { agentCommand } from './agent.js';
import { swarmCommand } from './swarm.js';
import { memoryCommand } from './memory.js';
import { mcpCommand } from './mcp.js';
import { configCommand } from './config.js';
import { migrateCommand } from './migrate.js';
import { hooksCommand } from './hooks.js';
// P1 Commands
import { initCommand } from './init.js';
import { startCommand } from './start.js';
import { statusCommand } from './status.js';
import { taskCommand } from './task.js';
import { sessionCommand } from './session.js';

// Export all commands
export { agentCommand } from './agent.js';
export { swarmCommand } from './swarm.js';
export { memoryCommand } from './memory.js';
export { mcpCommand } from './mcp.js';
export { configCommand } from './config.js';
export { migrateCommand } from './migrate.js';
export { hooksCommand } from './hooks.js';
// P1 Commands
export { initCommand } from './init.js';
export { startCommand } from './start.js';
export { statusCommand } from './status.js';
export { taskCommand } from './task.js';
export { sessionCommand } from './session.js';

/**
 * All available commands
 */
export const commands: Command[] = [
  // P1 Core Commands
  initCommand,
  startCommand,
  statusCommand,
  taskCommand,
  sessionCommand,
  // Original Commands
  agentCommand,
  swarmCommand,
  memoryCommand,
  mcpCommand,
  configCommand,
  migrateCommand,
  hooksCommand
];

/**
 * Command registry map for quick lookup
 */
export const commandRegistry = new Map<string, Command>();

// Register all commands and their aliases
for (const cmd of commands) {
  commandRegistry.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commandRegistry.set(alias, cmd);
    }
  }
}

/**
 * Get command by name
 */
export function getCommand(name: string): Command | undefined {
  return commandRegistry.get(name);
}

/**
 * Check if command exists
 */
export function hasCommand(name: string): boolean {
  return commandRegistry.has(name);
}

/**
 * Get all command names (including aliases)
 */
export function getCommandNames(): string[] {
  return Array.from(commandRegistry.keys());
}

/**
 * Get all unique commands (excluding aliases)
 */
export function getUniqueCommands(): Command[] {
  return commands.filter(cmd => !cmd.hidden);
}

/**
 * Setup commands in a CLI instance
 */
export function setupCommands(cli: { command: (cmd: Command) => void }): void {
  for (const cmd of commands) {
    cli.command(cmd);
  }
}
