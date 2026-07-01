/**
 * V3 CLI Start Command
 * System startup for Hive Flow orchestration
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { confirm, select } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { loadSentinelConfig, SentinelConfigError } from '../sentinel/config.js';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_MAX_AGENTS } from '../shared/core/config/defaults.js';

// Default configuration
const DEFAULT_PORT = 3000;
const DEFAULT_TOPOLOGY = 'hierarchical-mesh';

// Main start action
const startAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const daemon = ctx.flags.daemon as boolean;
  const portFlag = ctx.flags.port as number | undefined;
  const topologyFlag = ctx.flags.topology as string | undefined;
  const skipMcp = (ctx.flags.skipMcp ?? ctx.flags['skip-mcp']) as boolean;
  const explicitConfigPath = ctx.flags.config as string | undefined;
  const cwd = ctx.cwd;

  let config: Record<string, unknown>;
  try {
    config = loadSentinelConfig(cwd, explicitConfigPath).config;
  } catch (error) {
    if (error instanceof SentinelConfigError) {
      output.printError(error.message);
    } else {
      output.printError(`Unable to load Hive Flow config: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { success: false, exitCode: 1 };
  }

  const swarmConfig = (config?.swarm as Record<string, unknown>) || {};
  const mcpConfig = (config?.mcp as Record<string, unknown>) || {};

  const finalTopology = topologyFlag || (swarmConfig.topology as string) || DEFAULT_TOPOLOGY;
  const maxAgents = (swarmConfig.maxAgents as number) || DEFAULT_MAX_AGENTS;
  const autoStartMcp = (mcpConfig.autoStart as boolean) !== false && !skipMcp;
  const mcpPort = portFlag || (mcpConfig.serverPort as number) || DEFAULT_PORT;

  output.writeln();
  output.writeln(output.bold('Starting Hive Flow V3'));
  output.writeln();

  const spinner = output.createSpinner({ text: 'Initializing system...' });

  try {
    // Step 1: Initialize swarm
    spinner.start();
    spinner.setText('Initializing V3 swarm...');

    const swarmResult = await callMCPTool<{
      swarmId: string;
      topology: string;
      initializedAt: string;
      config: Record<string, unknown>;
    }>('swarm_init', {
      topology: finalTopology,
      maxAgents,
      autoScaling: swarmConfig.autoScale !== false,
      v3Mode: true
    });

    spinner.succeed(`Swarm initialized (${finalTopology})`);

    // Step 2: Start MCP server if configured
    let mcpResult: Record<string, unknown> | null = null;
    if (autoStartMcp) {
      spinner.setText('Starting MCP server...');
      spinner.start();

      try {
        mcpResult = await callMCPTool<{
          serverId: string;
          port: number;
          transport: string;
          startedAt: string;
        }>('mcp_start', {
          port: mcpPort,
          transport: mcpConfig.transportType || 'stdio',
          tools: mcpConfig.tools || ['agent', 'swarm', 'memory', 'task']
        });

        spinner.succeed(`MCP server started on port ${mcpPort}`);
      } catch (error) {
        spinner.fail('MCP server failed to start');
        output.printWarning(
          error instanceof MCPClientError
            ? error.message
            : String(error)
        );
        // Continue without MCP
      }
    }

    // Step 3: Run health check
    spinner.setText('Running health checks...');
    spinner.start();

    const healthResult = await callMCPTool<{
      status: 'healthy' | 'degraded' | 'unhealthy';
      checks: Array<{ name: string; status: string; message?: string }>;
    }>('swarm_health', {
      swarmId: swarmResult.swarmId
    });

    if (healthResult.status === 'healthy') {
      spinner.succeed('Health checks passed');
    } else {
      spinner.fail(`Health check: ${healthResult.status}`);
    }

    // Success output
    output.writeln();
    output.printSuccess('Hive Flow V3 is running!');
    output.writeln();

    // Status display
    output.printBox(
      [
        `Swarm ID:  ${swarmResult.swarmId}`,
        `Topology:  ${finalTopology}`,
        `Max Agents: ${maxAgents}`,
        `MCP Server: ${autoStartMcp ? `localhost:${mcpPort}` : 'disabled'}`,
        `Mode:      ${daemon ? 'Daemon' : 'Foreground'}`,
        `Health:    ${healthResult.status}`
      ].join('\n'),
      'System Status'
    );

    output.writeln();
    output.writeln(output.bold('Quick Commands:'));
    output.printList([
      `${output.highlight('hive-flow status')} - View system status`,
      `${output.highlight('hive-flow agent spawn -t coder')} - Spawn an agent`,
      `${output.highlight('hive-flow swarm status')} - View swarm details`,
      `${output.highlight('hive-flow stop')} - Stop the system`
    ]);

    // Daemon mode
    if (daemon) {
      output.writeln();
      output.printInfo('Running in daemon mode. Use "hive-flow stop" to stop.');

      // Store PID for daemon management
      const daemonPidPath = path.join(cwd, '.hive-flow', 'daemon.pid');
      fs.writeFileSync(daemonPidPath, String(process.pid));

      // Detach from parent process for true daemon behavior
      if (process.platform !== 'win32') {
        // Unix-like systems: create new session
        try {
          process.stdin.unref?.();
          process.stdout.unref?.();
          process.stderr.unref?.();
        } catch {
          // Ignore errors if streams can't be unref'd
        }
      }

      // Keep process alive in daemon mode
      const keepAlive = setInterval(() => {
        // Heartbeat - check if we should still be running
        if (!fs.existsSync(daemonPidPath)) {
          clearInterval(keepAlive);
          process.exit(0);
        }
      }, 5000);
      keepAlive.unref(); // Don't prevent process from exiting if no other work
    }

    const result = {
      swarmId: swarmResult.swarmId,
      topology: finalTopology,
      maxAgents,
      mcp: mcpResult ? {
        port: mcpPort,
        transport: mcpConfig.transportType || 'stdio'
      } : null,
      health: healthResult.status,
      daemon,
      startedAt: new Date().toISOString()
    };

    if (ctx.flags.format === 'json') {
      output.printJson(result);
    }

    return { success: true, data: result };
  } catch (error) {
    spinner.fail('Startup failed');
    if (error instanceof MCPClientError) {
      output.printError(`Failed to start: ${error.message}`);
    } else {
      output.printError(`Unexpected error: ${String(error)}`);
    }
    return { success: false, exitCode: 1 };
  }
};

// Stop subcommand
const stopCommand: Command = {
  name: 'stop',
  description: 'Stop the Hive Flow system',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force stop without graceful shutdown',
      type: 'boolean',
      default: false
    },
    {
      name: 'timeout',
      description: 'Shutdown timeout in seconds',
      type: 'number',
      default: 30
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;
    const timeout = ctx.flags.timeout as number;

    output.writeln();
    output.writeln(output.bold('Stopping Hive Flow'));
    output.writeln();

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: 'Are you sure you want to stop Hive Flow?',
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    const spinner = output.createSpinner({ text: 'Stopping system...' });
    spinner.start();

    try {
      // Stop MCP server
      spinner.setText('Stopping MCP server...');
      try {
        await callMCPTool('mcp_stop', { graceful: !force, timeout });
        spinner.succeed('MCP server stopped');
      } catch {
        spinner.fail('MCP server was not running');
      }

      // Stop swarm
      spinner.setText('Stopping swarm...');
      spinner.start();
      try {
        await callMCPTool('swarm_stop', {
          graceful: !force,
          timeout,
          saveState: true
        });
        spinner.succeed('Swarm stopped');
      } catch {
        spinner.fail('Swarm was not running');
      }

      // Clean up daemon PID
      const daemonPidPath = path.join(ctx.cwd, '.hive-flow', 'daemon.pid');
      if (fs.existsSync(daemonPidPath)) {
        fs.unlinkSync(daemonPidPath);
      }

      output.writeln();
      output.printSuccess('Hive Flow stopped successfully');

      return {
        success: true,
        data: { stopped: true, force, stoppedAt: new Date().toISOString() }
      };
    } catch (error) {
      spinner.fail('Stop failed');
      output.printError(`Failed to stop: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Restart subcommand
const restartCommand: Command = {
  name: 'restart',
  description: 'Restart the Hive Flow system',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force restart',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Restarting Hive Flow'));
    output.writeln();

    // Stop first
    const stopCtx = { ...ctx, flags: { ...ctx.flags } };
    const stopResult = await stopCommand.action!(stopCtx);

    if (stopResult && !stopResult.success) {
      output.printWarning('Stop failed, attempting to start anyway...');
    }

    // Wait briefly
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Start again
    const startResult = await startAction(ctx);

    return {
      success: startResult.success,
      data: {
        restarted: startResult.success,
        restartedAt: new Date().toISOString()
      }
    };
  }
};

// Quick start subcommand
const quickCommand: Command = {
  name: 'quick',
  aliases: ['q'],
  description: 'Quick start with default settings',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Initialize if needed
    if (!fs.existsSync(path.join(ctx.cwd, '.hive-flow', 'config.yaml'))) {
      output.printInfo('Project not initialized, running init first...');
      output.writeln();

      // Call init with minimal settings
      const { initCommand } = await import('./init.js');
      const initCtx = {
        ...ctx,
        flags: { ...ctx.flags, minimal: true }
      };
      await initCommand.action!(initCtx);
      output.writeln();
    }

    // Start with defaults
    return startAction({
      ...ctx,
      flags: { ...ctx.flags, topology: 'mesh' }
    });
  }
};

// Main start command
export const startCommand: Command = {
  name: 'start',
  description: 'Start the Hive Flow orchestration system',
  subcommands: [stopCommand, restartCommand, quickCommand],
  options: [
    {
      name: 'daemon',
      short: 'd',
      description: 'Run as daemon in background',
      type: 'boolean',
      default: false
    },
    {
      name: 'port',
      short: 'p',
      description: 'MCP server port',
      type: 'number',
      default: DEFAULT_PORT
    },
    {
      name: 'topology',
      short: 't',
      description: 'Swarm topology (hierarchical-mesh, mesh, hierarchical, ring, star)',
      type: 'string',
      choices: ['hierarchical-mesh', 'mesh', 'hierarchical', 'ring', 'star']
    },
    {
      name: 'skip-mcp',
      description: 'Skip starting MCP server',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'hive-flow start', description: 'Start with configuration defaults' },
    { command: 'hive-flow start --daemon', description: 'Start as background daemon' },
    { command: 'hive-flow start --port 3001', description: 'Start MCP on custom port' },
    { command: 'hive-flow start --topology mesh', description: 'Start with mesh topology' },
    { command: 'hive-flow start --skip-mcp', description: 'Start without MCP server' },
    { command: 'hive-flow start quick', description: 'Quick start with defaults' },
    { command: 'hive-flow start stop', description: 'Stop the running system' }
  ],
  action: startAction
};

export default startCommand;
