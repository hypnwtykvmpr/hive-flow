/**
 * MCP Configuration Generator
 * Creates .mcp.json for Claude Code MCP server integration
 */

import type { InitOptions, MCPConfig } from './types.js';

/**
 * Generate MCP configuration
 */
export function generateMCPConfig(options: InitOptions): object {
  const config = options.mcp;
  const mcpServers: Record<string, object> = {};

  // Claude Flow MCP server (core)
  if (config.claudeFlow) {
    mcpServers['claude-flow'] = {
      command: 'npx',
      args: ['@claude-flow/cli', 'mcp', 'start'],
      env: {
        CLAUDE_FLOW_MODE: 'v3',
        CLAUDE_FLOW_HOOKS_ENABLED: 'true',
        CLAUDE_FLOW_TOPOLOGY: options.runtime.topology,
        CLAUDE_FLOW_MAX_AGENTS: String(options.runtime.maxAgents),
        CLAUDE_FLOW_MEMORY_BACKEND: options.runtime.memoryBackend,
      },
      autoStart: config.autoStart,
    };
  }

  // Ruv-Swarm MCP server (enhanced coordination)
  if (config.ruvSwarm) {
    mcpServers['ruv-swarm'] = {
      command: 'npx',
      args: ['ruv-swarm', 'mcp', 'start'],
      env: {},
      optional: true,
    };
  }

  // Flow Nexus MCP server (cloud features)
  if (config.flowNexus) {
    mcpServers['flow-nexus'] = {
      command: 'npx',
      args: ['flow-nexus@latest', 'mcp', 'start'],
      env: {},
      optional: true,
      requiresAuth: true,
    };
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
 */
export function generateMCPCommands(options: InitOptions): string[] {
  const commands: string[] = [];
  const config = options.mcp;

  if (config.claudeFlow) {
    commands.push('claude mcp add claude-flow -- npx @claude-flow/cli mcp start');
  }

  if (config.ruvSwarm) {
    commands.push('claude mcp add ruv-swarm -- npx ruv-swarm mcp start');
  }

  if (config.flowNexus) {
    commands.push('claude mcp add flow-nexus -- npx flow-nexus@latest mcp start');
  }

  return commands;
}
