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

// Export all commands
export { agentCommand } from './agent.js';
export { swarmCommand } from './swarm.js';
export { memoryCommand } from './memory.js';
export { mcpCommand } from './mcp.js';
export { configCommand } from './config.js';
export { migrateCommand } from './migrate.js';

/**
 * All available commands
 */
export const commands: Command[] = [
  agentCommand,
  swarmCommand,
  memoryCommand,
  mcpCommand,
  configCommand,
  migrateCommand
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
