/**
 * MCP Configuration Generator
 * Creates .mcp.json for Claude Code MCP server integration
 * Handles cross-platform compatibility (Windows requires cmd /c wrapper)
 *
 * Generated configs launch the installed command directly instead of
 * embedding package-manager install guidance in runtime MCP settings.
 */

import type { InitOptions, MCPConfig } from './types.js';

/**
 * Check if running on Windows
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Generate platform-specific MCP server entry
 * - Windows: uses cmd /c wrapper for command resolution
 * - Unix: launches the installed command directly
 */
function createMCPServerEntry(
  command: string,
  args: string[],
  env: Record<string, string>,
  additionalProps: Record<string, unknown> = {}
): object {
  if (isWindows()) {
    return {
      command: 'cmd',
      args: ['/c', command, ...args],
      env,
      ...additionalProps,
    };
  }

  return {
    command,
    args,
    env,
    ...additionalProps,
  };
}

/**
 * Generate MCP configuration
 */
export function generateMCPConfig(options: InitOptions): object {
  const config = options.mcp;
  const mcpServers: Record<string, object> = {};

  // Shared env vars that prevent npm cache corruption issues
  // npm_config_prefer_online: skip stale cache integrity (fixes ECOMPROMISED)
  // npm_config_update_notifier: suppress update check (faster startup)
  const npmCacheEnv = {
    npm_config_prefer_online: 'true',
    npm_config_update_notifier: 'false',
  };

  // Hive Flow MCP server (core)
  if (config.hiveFlow) {
    mcpServers['hive-flow'] = createMCPServerEntry(
      'hive-flow',
      ['mcp', 'start'],
      {
        ...npmCacheEnv,
        HIVE_FLOW_MODE: 'v3',
        HIVE_FLOW_HOOKS_ENABLED: 'true',
        HIVE_FLOW_TOPOLOGY: options.runtime.topology,
        HIVE_FLOW_MAX_AGENTS: String(options.runtime.maxAgents),
        HIVE_FLOW_MEMORY_BACKEND: options.runtime.memoryBackend,
      },
      { autoStart: config.autoStart }
    );
  }

  // Flow Nexus MCP server (cloud features)
  if (config.flowNexus) {
    mcpServers['flow-nexus'] = createMCPServerEntry(
      'flow-nexus',
      ['mcp', 'start'],
      { ...npmCacheEnv },
      { optional: true, requiresAuth: true }
    );
  }

  return { mcpServers };
}

/**
 * Generate .mcp.json as formatted string
 */
export function generateMCPJson(options: InitOptions): string {
  const config = generateMCPConfig(options);
  return JSON.stringify(config, null, 2);
}

/**
 * Generate MCP server add commands for manual setup
 * Windows uses a cmd /c wrapper for command resolution
 */
export function generateMCPCommands(options: InitOptions): string[] {
  const commands: string[] = [];
  const config = options.mcp;

  if (isWindows()) {
    if (config.hiveFlow) {
      commands.push('claude mcp add hive-flow -- cmd /c hive-flow mcp start');
    }
    if (config.flowNexus) {
      commands.push('claude mcp add flow-nexus -- cmd /c flow-nexus mcp start');
    }
  } else {
    // Unix: wrap with retry-on-failure for cache corruption resilience
    if (config.hiveFlow) {
      commands.push("claude mcp add hive-flow -- hive-flow mcp start");
    }
    if (config.flowNexus) {
      commands.push("claude mcp add flow-nexus -- flow-nexus mcp start");
    }
  }

  return commands;
}

/**
 * Get platform-specific setup instructions
 */
export function getPlatformInstructions(): { platform: string; note: string } {
  if (isWindows()) {
    return {
      platform: 'Windows',
      note: 'MCP configuration uses cmd /c wrapper for npx compatibility.',
    };
  }
  return {
    platform: process.platform === 'darwin' ? 'macOS' : 'Linux',
    note: 'MCP configuration launches installed commands directly.',
  };
}
