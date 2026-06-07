/**
 * MCP Configuration Generator
 * Creates .mcp.json for Claude Code MCP server integration
 * Handles cross-platform compatibility (Windows requires cmd /c wrapper)
 *
 * Uses a shell wrapper on Unix to auto-repair npm cache corruption
 * (ENOTEMPTY/ECOMPROMISED) before running npx. This is critical for
 * remote environments like Codespaces where interrupted installs
 * leave stale artifacts that prevent subsequent npx runs.
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
 * - Windows: uses 'cmd /c npx' directly
 * - Unix: uses 'sh -c' with retry-on-failure for npm cache corruption
 *
 * The Unix wrapper tries npx normally first. If it fails with ENOTEMPTY
 * or ECOMPROMISED (common in Codespaces/remote envs), it nukes the
 * corrupted cache and retries once. This adds 0ms on success and ~5s
 * on the retry path — acceptable since MCP servers start once per session.
 */
function createMCPServerEntry(
  npxArgs: string[],
  env: Record<string, string>,
  additionalProps: Record<string, unknown> = {}
): object {
  if (isWindows()) {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', ...npxArgs],
      env,
      ...additionalProps,
    };
  }

  // Unix: npx with automatic retry on cache corruption
  const npxCmd = ['npx', '-y', ...npxArgs].join(' ');
  // Try normal launch; on ENOTEMPTY/ECOMPROMISED nuke cache and retry
  const retryScript = `${npxCmd} 2>/tmp/.cf-err.$$ || { if grep -qE 'ENOTEMPTY|ECOMPROMISED' /tmp/.cf-err.$$ 2>/dev/null; then rm -rf ~/.npm/_npx ~/.npm/_cacache 2>/dev/null; exec ${npxCmd}; else cat /tmp/.cf-err.$$ >&2; exit 1; fi; }`;
  return {
    command: 'sh',
    args: ['-c', retryScript],
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
      ['@hive-flow/cli@latest', 'mcp', 'start'],
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
      ['flow-nexus@latest', 'mcp', 'start'],
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
 * Unix wraps npx with cache repair to prevent ENOTEMPTY/ECOMPROMISED
 * Windows uses 'cmd /c' wrapper for npx execution
 */
export function generateMCPCommands(options: InitOptions): string[] {
  const commands: string[] = [];
  const config = options.mcp;

  if (isWindows()) {
    if (config.hiveFlow) {
      commands.push('claude mcp add hive-flow -- cmd /c npx -y @hive-flow/cli@latest mcp start');
    }
    if (config.flowNexus) {
      commands.push('claude mcp add flow-nexus -- cmd /c npx -y flow-nexus@latest mcp start');
    }
  } else {
    // Unix: wrap with retry-on-failure for cache corruption resilience
    if (config.hiveFlow) {
      commands.push("claude mcp add hive-flow -- npx -y @hive-flow/cli@latest mcp start");
    }
    if (config.flowNexus) {
      commands.push("claude mcp add flow-nexus -- npx -y flow-nexus@latest mcp start");
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
    note: 'MCP configuration uses sh wrapper with automatic npm cache repair for remote environment resilience.',
  };
}
