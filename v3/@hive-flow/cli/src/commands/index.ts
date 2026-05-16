/**
 * V3 CLI Commands Index
 * Central registry for all CLI commands
 *
 * OPTIMIZATION: Uses lazy loading for commands to reduce CLI startup time by ~200ms
 * Commands are loaded on-demand when first accessed, not at module load time.
 */

import type { Command } from '../types.js';

// =============================================================================
// Lazy Loading Infrastructure
// =============================================================================

type CommandLoader = () => Promise<{ default?: Command; [key: string]: Command | unknown }>;

/**
 * Command loaders - commands are only imported when needed
 * This reduces initial bundle parse time by ~200ms
 */
const commandLoaders: Record<string, CommandLoader> = {
  // P1 Core Commands (frequently used - load first)
  init: () => import('./init.js'),
  start: () => import('./start.js'),
  status: () => import('./status.js'),
  task: () => import('./task.js'),
  session: () => import('./session.js'),
  // Original Commands
  agent: () => import('./agent.js'),
  swarm: () => import('./swarm.js'),
  memory: () => import('./memory.js'),
  mcp: () => import('./mcp.js'),
  config: () => import('./config.js'),
  migrate: () => import('./migrate.js'),
  hooks: () => import('./hooks.js'),
  workflow: () => import('./workflow.js'),
  'hive-mind': () => import('./hive-mind.js'),
  process: () => import('./process.js'),
  daemon: () => import('./daemon.js'),
  // V3 Advanced Commands (less frequently used - lazy load)
  neural: () => import('./neural.js'),
  security: () => import('./security.js'),
  performance: () => import('./performance.js'),
  providers: () => import('./providers.js'),
  plugins: () => import('./plugins.js'),
  deployment: () => import('./deployment.js'),
  claims: () => import('./claims.js'),
  embeddings: () => import('./embeddings.js'),
  // P0 Commands
  completions: () => import('./completions.js'),
  doctor: () => import('./doctor.js'),
  // Analysis Commands
  analyze: () => import('./analyze.js'),
  // Q-Learning Routing Commands
  route: () => import('./route.js'),
  // Progress Commands
  progress: () => import('./progress.js'),
  // Issue Claims Commands (ADR-016)
  issues: () => import('./issues.js'),
  // Auto-update System (ADR-025)
  update: () => import('./update.js'),
  // RuVector PostgreSQL Bridge
  ruvector: () => import('./ruvector/index.js'),
  // Benchmark Suite (Pre-training, Neural, Memory)
  benchmark: () => import('./benchmark.js'),
  // Guidance Control Plane
  guidance: () => import('./guidance.js'),
  // RVFA Appliance Management
  appliance: () => import('./appliance.js'),
  // Context Manager
  'context-manager': () => import('./context-manager.js'),
  // Workflow Signals (pause/resume/stop)
  signal: () => import('./signal.js'),
  // §7 Agent-integration setup surface (Hive Flow MCP install across 7 agent CLIs)
  setup: () => import('./setup.js'),
};

// Cache for loaded commands
const loadedCommands = new Map<string, Command>();

/**
 * Load a command lazily
 */
async function loadCommand(name: string): Promise<Command | undefined> {
  if (loadedCommands.has(name)) {
    return loadedCommands.get(name);
  }

  const loader = commandLoaders[name];
  if (!loader) return undefined;

  try {
    const module = await loader();
    // Try to find the command export (either default or named)
    const command = (module.default || module[`${name}Command`] || Object.values(module).find(
      (v): v is Command => typeof v === 'object' && v !== null && 'name' in v && 'description' in v
    )) as Command | undefined;

    if (command) {
      loadedCommands.set(name, command);
      return command;
    }
  } catch (error) {
    // Always warn for failed loads so they are diagnosable
    console.warn(`[hive-flow] Failed to load command '${name}':`, error instanceof Error ? error.message : String(error));
    failedCommands.push(name);
  }
  return undefined;
}

/** Commands that failed to load (for diagnostics) */
const failedCommands: string[] = [];

/** Get list of commands that failed to load */
export function getFailedCommands(): string[] {
  return [...failedCommands];
}

// =============================================================================
// Synchronous Imports for Core Commands (needed immediately at startup)
// These are the most commonly used commands that need instant access
// =============================================================================

import { initCommand } from './init.js';
import { startCommand } from './start.js';
import { statusCommand } from './status.js';
import { taskCommand } from './task.js';
import { sessionCommand } from './session.js';
import { agentCommand } from './agent.js';
import { swarmCommand } from './swarm.js';
import { memoryCommand } from './memory.js';
import { mcpCommand } from './mcp.js';
import { hooksCommand } from './hooks.js';
import { daemonCommand } from './daemon.js';
import { doctorCommand } from './doctor.js';
import { embeddingsCommand } from './embeddings.js';
import { neuralCommand } from './neural.js';
import { performanceCommand } from './performance.js';
import { securityCommand } from './security.js';
import { ruvectorCommand } from './ruvector/index.js';
import { hiveMindCommand } from './hive-mind.js';
// Additional commands for categorized help display
import { configCommand } from './config.js';
import { completionsCommand } from './completions.js';
import { migrateCommand } from './migrate.js';
import { workflowCommand } from './workflow.js';
import { analyzeCommand } from './analyze.js';
import { routeCommand } from './route.js';
import { progressCommand } from './progress.js';
import { providersCommand } from './providers.js';
import { pluginsCommand } from './plugins.js';
import { deploymentCommand } from './deployment.js';
import { claimsCommand } from './claims.js';
import { issuesCommand } from './issues.js';
import updateCommand from './update.js';
import { processCommand } from './process.js';
import { guidanceCommand } from './guidance.js';
import { applianceCommand } from './appliance.js';
import { signalCommand } from './signal.js';

// Pre-populate cache with core commands
loadedCommands.set('init', initCommand);
loadedCommands.set('start', startCommand);
loadedCommands.set('status', statusCommand);
loadedCommands.set('task', taskCommand);
loadedCommands.set('session', sessionCommand);
loadedCommands.set('agent', agentCommand);
loadedCommands.set('swarm', swarmCommand);
loadedCommands.set('memory', memoryCommand);
loadedCommands.set('mcp', mcpCommand);
loadedCommands.set('hooks', hooksCommand);
loadedCommands.set('daemon', daemonCommand);
loadedCommands.set('doctor', doctorCommand);
loadedCommands.set('embeddings', embeddingsCommand);
loadedCommands.set('neural', neuralCommand);
loadedCommands.set('performance', performanceCommand);
loadedCommands.set('security', securityCommand);
loadedCommands.set('ruvector', ruvectorCommand);
loadedCommands.set('hive-mind', hiveMindCommand);
loadedCommands.set('guidance', guidanceCommand);
loadedCommands.set('signal', signalCommand);
loadedCommands.set('config', configCommand);
loadedCommands.set('completions', completionsCommand);
loadedCommands.set('migrate', migrateCommand);
loadedCommands.set('workflow', workflowCommand);
loadedCommands.set('analyze', analyzeCommand);
loadedCommands.set('route', routeCommand);
loadedCommands.set('progress', progressCommand);
loadedCommands.set('providers', providersCommand);
loadedCommands.set('plugins', pluginsCommand);
loadedCommands.set('deployment', deploymentCommand);
loadedCommands.set('claims', claimsCommand);
loadedCommands.set('issues', issuesCommand);
loadedCommands.set('update', updateCommand);
loadedCommands.set('process', processCommand);
loadedCommands.set('appliance', applianceCommand);

// =============================================================================
// Exports (maintain backwards compatibility)
// =============================================================================

// Export synchronously loaded commands
export { initCommand } from './init.js';
export { startCommand } from './start.js';
export { statusCommand } from './status.js';
export { taskCommand } from './task.js';
export { sessionCommand } from './session.js';
export { agentCommand } from './agent.js';
export { swarmCommand } from './swarm.js';
export { memoryCommand } from './memory.js';
export { mcpCommand } from './mcp.js';
export { hooksCommand } from './hooks.js';
export { daemonCommand } from './daemon.js';
export { doctorCommand } from './doctor.js';
export { embeddingsCommand } from './embeddings.js';
export { neuralCommand } from './neural.js';
export { performanceCommand } from './performance.js';
export { securityCommand } from './security.js';
export { ruvectorCommand } from './ruvector/index.js';
export { hiveMindCommand } from './hive-mind.js';
export { guidanceCommand } from './guidance.js';
export { applianceCommand } from './appliance.js';
export { signalCommand } from './signal.js';

// Lazy-loaded command re-exports (for backwards compatibility, but async-only)
export async function getConfigCommand() { return loadCommand('config'); }
export async function getMigrateCommand() { return loadCommand('migrate'); }
export async function getWorkflowCommand() { return loadCommand('workflow'); }
export async function getHiveMindCommand() { return loadCommand('hive-mind'); }
export async function getProcessCommand() { return loadCommand('process'); }
export async function getTaskCommand() { return loadCommand('task'); }
export async function getSessionCommand() { return loadCommand('session'); }
export async function getNeuralCommand() { return loadCommand('neural'); }
export async function getSecurityCommand() { return loadCommand('security'); }
export async function getPerformanceCommand() { return loadCommand('performance'); }
export async function getProvidersCommand() { return loadCommand('providers'); }
export async function getPluginsCommand() { return loadCommand('plugins'); }
export async function getDeploymentCommand() { return loadCommand('deployment'); }
export async function getClaimsCommand() { return loadCommand('claims'); }
export async function getEmbeddingsCommand() { return loadCommand('embeddings'); }
export async function getCompletionsCommand() { return loadCommand('completions'); }
export async function getAnalyzeCommand() { return loadCommand('analyze'); }
export async function getRouteCommand() { return loadCommand('route'); }
export async function getProgressCommand() { return loadCommand('progress'); }
export async function getIssuesCommand() { return loadCommand('issues'); }
export async function getRuvectorCommand() { return loadCommand('ruvector'); }
export async function getGuidanceCommand() { return loadCommand('guidance'); }
export async function getApplianceCommand() { return loadCommand('appliance'); }
export async function getSignalCommand() { return loadCommand('signal'); }

/**
 * Core commands loaded synchronously (available immediately)
 * Advanced commands loaded on-demand for faster startup
 */
export const commands: Command[] = [
  // Core commands (synchronously loaded)
  initCommand,
  startCommand,
  statusCommand,
  taskCommand,
  sessionCommand,
  agentCommand,
  swarmCommand,
  memoryCommand,
  mcpCommand,
  hooksCommand,
  daemonCommand,
  doctorCommand,
  embeddingsCommand,
  neuralCommand,
  performanceCommand,
  securityCommand,
  ruvectorCommand,
  hiveMindCommand,
  guidanceCommand,
  signalCommand,
  // Additional commands (also synchronously loaded)
  configCommand,
  completionsCommand,
  migrateCommand,
  workflowCommand,
  analyzeCommand,
  routeCommand,
  progressCommand,
  providersCommand,
  pluginsCommand,
  deploymentCommand,
  claimsCommand,
  issuesCommand,
  updateCommand,
  processCommand,
  applianceCommand,
];

/**
 * Commands organized by category for help display
 */
export const commandsByCategory = {
  primary: [
    initCommand,
    startCommand,
    statusCommand,
    agentCommand,
    swarmCommand,
    memoryCommand,
    taskCommand,
    sessionCommand,
    mcpCommand,
    hooksCommand,
  ],
  advanced: [
    neuralCommand,
    securityCommand,
    performanceCommand,
    embeddingsCommand,
    hiveMindCommand,
    ruvectorCommand,
    guidanceCommand,
  ],
  utility: [
    configCommand,
    doctorCommand,
    daemonCommand,
    completionsCommand,
    migrateCommand,
    workflowCommand,
  ],
  analysis: [
    analyzeCommand,
    routeCommand,
    progressCommand,
  ],
  management: [
    providersCommand,
    pluginsCommand,
    deploymentCommand,
    claimsCommand,
    issuesCommand,
    updateCommand,
    processCommand,
    applianceCommand,
    signalCommand,
  ],
};

/**
 * Command registry map for quick lookup
 * Supports both sync (core commands) and async (lazy-loaded) commands
 */
export const commandRegistry = new Map<string, Command>();

// Register core commands and their aliases
for (const cmd of commands) {
  commandRegistry.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commandRegistry.set(alias, cmd);
    }
  }
}

/**
 * Get command by name (sync for core commands, returns undefined for lazy commands)
 * Use getCommandAsync for lazy-loaded commands
 */
export function getCommand(name: string): Command | undefined {
  return loadedCommands.get(name) || commandRegistry.get(name);
}

/**
 * Get command by name (async - supports lazy loading)
 */
export async function getCommandAsync(name: string): Promise<Command | undefined> {
  // Check already-loaded commands first
  const cached = loadedCommands.get(name);
  if (cached) return cached;

  // Check sync registry
  const synced = commandRegistry.get(name);
  if (synced) return synced;

  // Try lazy loading
  return loadCommand(name);
}

/**
 * Check if command exists (sync check for core commands)
 */
export function hasCommand(name: string): boolean {
  return loadedCommands.has(name) || commandRegistry.has(name) || name in commandLoaders;
}

/**
 * Get all command names (including aliases and lazy-loadable)
 */
export function getCommandNames(): string[] {
  const names = new Set([
    ...Array.from(commandRegistry.keys()),
    ...Array.from(loadedCommands.keys()),
    ...Object.keys(commandLoaders),
  ]);
  return Array.from(names);
}

/**
 * Get all visible commands (excluding hidden/aliases)
 * @deprecated Use getVisibleCommands() instead
 */
export function getUniqueCommands(): Command[] {
  return getVisibleCommands();
}

/**
 * Get all visible commands (excluding hidden)
 */
export function getVisibleCommands(): Command[] {
  return commands.filter(cmd => !cmd.hidden);
}

/**
 * Clear command cache (useful for testing)
 */
export function clearCommandCache(): void {
  loadedCommands.clear();
  failedCommands.length = 0;
}

/**
 * Load all commands (populates lazy-loaded commands)
 * Use this when you need all commands available synchronously
 */
export async function loadAllCommands(): Promise<Command[]> {
  const allCommands: Command[] = [...commands];

  for (const name of Object.keys(commandLoaders)) {
    if (!loadedCommands.has(name)) {
      const cmd = await loadCommand(name);
      if (cmd && !allCommands.includes(cmd)) {
        allCommands.push(cmd);
      }
    }
  }

  return allCommands;
}

/**
 * Setup commands in a CLI instance
 */
export function setupCommands(cli: { command: (cmd: Command) => void }): void {
  for (const cmd of commands) {
    cli.command(cmd);
  }
}

/**
 * Setup all commands including lazy-loaded (async)
 */
export async function setupAllCommands(cli: { command: (cmd: Command) => void }): Promise<void> {
  const allCommands = await loadAllCommands();
  for (const cmd of allCommands) {
    cli.command(cmd);
  }
}
