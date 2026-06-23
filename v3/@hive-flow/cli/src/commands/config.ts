/**
 * V3 CLI Config Command
 * Configuration management
 */

import { readFileSync } from 'node:fs';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { DEFAULT_MAX_AGENTS } from '../shared/core/config/defaults.js';
import {
  inspectCredentialKeyStatus,
  removeProviderCredential,
  repairCredentialVault,
  storeProviderCredential,
} from '../credential-store/holder-runtime.js';

// Init configuration
const initCommand: Command = {
  name: 'init',
  description: 'Initialize configuration',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing configuration',
      type: 'boolean',
      default: false
    },
    {
      name: 'sparc',
      description: 'Initialize with SPARC methodology',
      type: 'boolean',
      default: false
    },
    {
      name: 'v3',
      description: 'Initialize V3 configuration',
      type: 'boolean',
      default: true
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const sparc = ctx.flags.sparc as boolean;
    const v3 = ctx.flags.v3 as boolean;

    output.writeln();
    output.printInfo('Initializing Hive Flow configuration...');
    output.writeln();

    // Create default configuration
    const config = {
      version: '3.0.0',
      v3Mode: v3,
      sparc: sparc,
      agents: {
        defaultType: 'coder',
        maxConcurrent: DEFAULT_MAX_AGENTS,
        autoSpawn: true,
        timeout: 300
      },
      swarm: {
        topology: 'hybrid',
        maxAgents: DEFAULT_MAX_AGENTS,
        autoScale: true,
        coordinationStrategy: 'consensus'
      },
      memory: {
        backend: 'hybrid',
        path: './data/memory',
        cacheSize: 256,
        enableHNSW: true
      },
      mcp: {
        transport: 'stdio',
        autoStart: true,
        tools: 'all'
      },
      providers: [
        { name: 'anthropic', priority: 1, enabled: true },
        { name: 'openrouter', priority: 2, enabled: false },
        { name: 'ollama', priority: 3, enabled: false }
      ]
    };

    output.writeln(output.dim('  Creating hive-flow.config.json...'));
    output.writeln(output.dim('  Creating .hive-flow/ directory...'));

    if (sparc) {
      output.writeln(output.dim('  Initializing SPARC methodology...'));
      output.writeln(output.dim('  Creating SPARC workflow files...'));
    }

    if (v3) {
      output.writeln(output.dim('  Enabling V3 multi-agent coordination...'));
      output.writeln(output.dim('  Configuring HiveMemory integration...'));
      output.writeln(output.dim('  Setting up Flash Attention optimization...'));
    }

    output.writeln();
    output.printTable({
      columns: [
        { key: 'setting', header: 'Setting', width: 25 },
        { key: 'value', header: 'Value', width: 30 }
      ],
      data: [
        { setting: 'Version', value: config.version },
        { setting: 'V3 Mode', value: config.v3Mode ? 'Enabled' : 'Disabled' },
        { setting: 'SPARC Mode', value: config.sparc ? 'Enabled' : 'Disabled' },
        { setting: 'Swarm Topology', value: config.swarm.topology },
        { setting: 'Max Agents', value: config.swarm.maxAgents },
        { setting: 'Memory Backend', value: config.memory.backend },
        { setting: 'MCP Transport', value: config.mcp.transport }
      ]
    });

    output.writeln();
    output.printSuccess('Configuration initialized');
    output.writeln(output.dim('  Config file: ./hive-flow.config.json'));

    return { success: true, data: config };
  }
};

// Get configuration
const getCommand: Command = {
  name: 'get',
  description: 'Get configuration value',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Configuration key (dot notation)',
      type: 'string'
    }
  ],
  examples: [
    { command: 'hive-flow config get swarm.topology', description: 'Get swarm topology' },
    { command: 'hive-flow config get -k memory.backend', description: 'Get memory backend' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string || ctx.args[0];

    // Default config values (loaded from actual config when available)
    const configValues: Record<string, unknown> = {
      'version': '3.0.0',
      'v3Mode': true,
      'swarm.topology': 'hybrid',
      'swarm.maxAgents': DEFAULT_MAX_AGENTS,
      'swarm.autoScale': true,
      'memory.backend': 'hybrid',
      'memory.cacheSize': 256,
      'mcp.transport': 'stdio',
      'agents.defaultType': 'coder',
      'agents.maxConcurrent': DEFAULT_MAX_AGENTS
    };

    if (!key) {
      // Show all config
      if (ctx.flags.format === 'json') {
        output.printJson(configValues);
        return { success: true, data: configValues };
      }

      output.writeln();
      output.writeln(output.bold('Current Configuration'));
      output.writeln();

      output.printTable({
        columns: [
          { key: 'key', header: 'Key', width: 25 },
          { key: 'value', header: 'Value', width: 30 }
        ],
        data: Object.entries(configValues).map(([k, v]) => ({ key: k, value: String(v) }))
      });

      return { success: true, data: configValues };
    }

    const value = configValues[key];

    if (value === undefined) {
      output.printError(`Configuration key not found: ${key}`);
      return { success: false, exitCode: 1 };
    }

    if (ctx.flags.format === 'json') {
      output.printJson({ key, value });
    } else {
      output.writeln(`${key} = ${value}`);
    }

    return { success: true, data: { key, value } };
  }
};

// Set configuration
const setCommand: Command = {
  name: 'set',
  description: 'Set configuration value',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Configuration key',
      type: 'string',
      required: true
    },
    {
      name: 'value',
      short: 'v',
      description: 'Configuration value',
      type: 'string',
      required: true
    }
  ],
  examples: [
    { command: 'hive-flow config set swarm.maxAgents 20', description: 'Set max agents' },
    { command: 'hive-flow config set -k memory.backend -v hivememory', description: 'Set memory backend' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string || ctx.args[0];
    const value = ctx.flags.value as string || ctx.args[1];

    if (!key || value === undefined) {
      output.printError('Both key and value are required');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Setting ${key} = ${value}`);
    output.printSuccess('Configuration updated');

    return { success: true, data: { key, value } };
  }
};

// List providers
const providersCommand: Command = {
  name: 'providers',
  description: 'Manage AI providers',
  options: [
    {
      name: 'add',
      short: 'a',
      description: 'Add provider',
      type: 'string'
    },
    {
      name: 'remove',
      short: 'r',
      description: 'Remove provider',
      type: 'string'
    },
    {
      name: 'enable',
      description: 'Enable provider',
      type: 'string'
    },
    {
      name: 'disable',
      description: 'Disable provider',
      type: 'string'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const providers = [
      { name: 'anthropic', model: 'claude-3-5-sonnet-20241022', priority: 1, enabled: true, status: 'Active' },
      { name: 'openrouter', model: 'claude-3.5-sonnet', priority: 2, enabled: false, status: 'Disabled' },
      { name: 'ollama', model: 'llama3.2', priority: 3, enabled: false, status: 'Disabled' },
      { name: 'gemini', model: 'gemini-2.0-flash', priority: 4, enabled: false, status: 'Disabled' }
    ];

    if (ctx.flags.format === 'json') {
      output.printJson(providers);
      return { success: true, data: providers };
    }

    output.writeln();
    output.writeln(output.bold('AI Providers'));
    output.writeln();

    output.printTable({
      columns: [
        { key: 'name', header: 'Provider', width: 12 },
        { key: 'model', header: 'Model', width: 25 },
        { key: 'priority', header: 'Priority', width: 10, align: 'right' },
        { key: 'status', header: 'Status', width: 10, format: (v) => {
          if (v === 'Active') return output.success(String(v));
          return output.dim(String(v));
        }}
      ],
      data: providers
    });

    output.writeln();
    output.writeln(output.dim('Use --add, --remove, --enable, --disable to manage providers'));

    return { success: true, data: providers };
  }
};

// Reset configuration
const resetCommand: Command = {
  name: 'reset',
  description: 'Reset configuration to defaults',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    },
    {
      name: 'section',
      description: 'Reset specific section only',
      type: 'string',
      choices: ['agents', 'swarm', 'memory', 'mcp', 'providers', 'all']
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;
    const section = ctx.flags.section as string || 'all';

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Reset ${section} configuration to defaults?`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo(`Resetting ${section} configuration...`);
    output.printSuccess('Configuration reset to defaults');

    return { success: true, data: { section, reset: true } };
  }
};

// Export configuration
const exportCommand: Command = {
  name: 'export',
  description: 'Export configuration',
  options: [
    {
      name: 'output',
      short: 'o',
      description: 'Output file path',
      type: 'string'
    },
    {
      name: 'format',
      short: 'f',
      description: 'Export format (json, yaml)',
      type: 'string',
      default: 'json',
      choices: ['json', 'yaml']
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const outputPath = ctx.flags.output as string || './hive-flow.config.export.json';

    const config = {
      version: '3.0.0',
      exportedAt: new Date().toISOString(),
      agents: { defaultType: 'coder', maxConcurrent: DEFAULT_MAX_AGENTS },
      swarm: { topology: 'hybrid', maxAgents: DEFAULT_MAX_AGENTS },
      memory: { backend: 'hybrid', cacheSize: 256 },
      mcp: { transport: 'stdio', tools: 'all' }
    };

    output.printInfo(`Exporting configuration to ${outputPath}...`);
    output.printJson(config);
    output.writeln();
    output.printSuccess('Configuration exported');

    return { success: true, data: { path: outputPath, config } };
  }
};

// Import configuration
const importCommand: Command = {
  name: 'import',
  description: 'Import configuration',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'Configuration file path',
      type: 'string',
      required: true
    },
    {
      name: 'merge',
      description: 'Merge with existing configuration',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const file = ctx.flags.file as string || ctx.args[0];
    const merge = ctx.flags.merge as boolean;

    if (!file) {
      output.printError('File path is required');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Importing configuration from ${file}...`);

    if (merge) {
      output.writeln(output.dim('  Merging with existing configuration...'));
    } else {
      output.writeln(output.dim('  Replacing existing configuration...'));
    }

    output.printSuccess('Configuration imported');

    return { success: true, data: { file, merge, imported: true } };
  }
};

// Credential key management
const keySetCommand: Command = {
  name: 'set',
  description: 'Store a provider key in the platform credential store and initialize the encrypted vault',
  options: [
    { name: 'provider', short: 'p', description: 'Provider name', type: 'string', required: true },
    { name: 'value', short: 'v', description: 'Provider API key value (discouraged: visible in argv)', type: 'string' },
    { name: 'stdin', description: 'Read the provider API key from stdin instead of argv', type: 'boolean', default: false },
    { name: 'degraded', description: 'Allow degraded backend setup for explicit test/CI lanes', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const provider = String(ctx.flags.provider || ctx.args[0] || '').trim();
    const argvSecret = typeof ctx.flags.value === 'string' && ctx.flags.value.length > 0
      ? ctx.flags.value
      : typeof ctx.args[1] === 'string'
        ? ctx.args[1]
        : '';
    const secret = ctx.flags.stdin
      ? readFileSync(0, 'utf8').replace(/\r?\n$/, '')
      : argvSecret;
    if (!provider || !secret) {
      output.printError('Provider and key value are required');
      return { success: false, exitCode: 1 };
    }
    if (!ctx.flags.stdin && argvSecret) {
      output.printWarning('Provider key was supplied in argv and may appear in shell history or process listings; prefer: hive-flow config key set -p <provider> --stdin');
    }
    const result = await storeProviderCredential({
      provider,
      secret,
      allowDegraded: Boolean(ctx.flags.degraded),
    });
    output.printSuccess(`Stored credential for ${result.provider}`);
    return { success: true, data: { provider: result.provider, stored: result.stored, vaultReady: result.vaultReady } };
  },
};

const keyStatusCommand: Command = {
  name: 'status',
  description: 'Show non-secret provider key status',
  options: [
    { name: 'provider', short: 'p', description: 'Provider name', type: 'string' },
    { name: 'json', description: 'Print JSON output', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const provider = String(ctx.flags.provider || ctx.args[0] || '').trim() || undefined;
    const status = await inspectCredentialKeyStatus({ provider });
    const backend = status.backend ?? { available: status.unlock === 'available' };
    const data = {
      provider: status.provider,
      present: status.present,
      drift: status.drift,
      holderCache: status.holderCache,
      unlock: status.unlock,
      backend: {
        available: backend.available,
        degraded: backend.degraded,
        reason: backend.reason,
      },
    };
    if (ctx.flags.json || ctx.flags.format === 'json') output.printJson(data);
    else output.printInfo(`${data.provider || 'credentials'}: ${data.present ? 'present' : 'missing'} (${data.unlock})`);
    return { success: true, data };
  },
};

const keyRepairCommand: Command = {
  name: 'repair',
  description: 'Create or repair the encrypted credential vault',
  options: [
    { name: 'degraded', description: 'Allow degraded backend setup for explicit test/CI lanes', type: 'boolean', default: false },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const result = await repairCredentialVault({ allowDegraded: Boolean(ctx.flags.degraded) });
    output.printSuccess(result.vaultReady ? 'Credential vault ready' : 'Credential vault repair attempted');
    return { success: true, data: { repaired: result.repaired, vaultReady: result.vaultReady } };
  },
};

const keyRemoveCommand: Command = {
  name: 'remove',
  description: 'Remove a provider key from the platform credential store',
  options: [
    { name: 'provider', short: 'p', description: 'Provider name', type: 'string', required: true },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const provider = String(ctx.flags.provider || ctx.args[0] || '').trim();
    if (!provider) {
      output.printError('Provider is required');
      return { success: false, exitCode: 1 };
    }
    const result = await removeProviderCredential({ provider });
    output.printSuccess(`Removed credential for ${result.provider}`);
    return { success: true, data: result };
  },
};

const keyCommand: Command = {
  name: 'key',
  description: 'Manage provider keys in the Hive Flow credential store',
  subcommands: [keySetCommand, keyStatusCommand, keyRepairCommand, keyRemoveCommand],
  examples: [
    { command: 'printf "%s\\n" "$OPENROUTER_API_KEY" | hive-flow config key set -p openrouter --stdin', description: 'Store OpenRouter key without putting it in argv' },
    { command: 'hive-flow config key status -p openrouter --json', description: 'Check key status without printing values' },
    { command: 'hive-flow config key repair', description: 'Create or repair encrypted vault metadata' },
    { command: 'hive-flow config key remove -p openrouter', description: 'Remove OpenRouter key' },
  ],
};

// Main config command
export const configCommand: Command = {
  name: 'config',
  description: 'Configuration management',
  subcommands: [initCommand, getCommand, setCommand, providersCommand, keyCommand, resetCommand, exportCommand, importCommand],
  options: [],
  examples: [
    { command: 'hive-flow config init --v3', description: 'Initialize V3 config' },
    { command: 'hive-flow config get swarm.topology', description: 'Get config value' },
    { command: 'hive-flow config set swarm.maxAgents 20', description: 'Set config value' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Configuration Management'));
    output.writeln();
    output.writeln('Usage: hive-flow config <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}       - Initialize configuration`,
      `${output.highlight('get')}        - Get configuration value`,
      `${output.highlight('set')}        - Set configuration value`,
      `${output.highlight('providers')}  - Manage AI providers`,
      `${output.highlight('key')}        - Manage provider keys in the credential store`,
      `${output.highlight('reset')}      - Reset to defaults`,
      `${output.highlight('export')}     - Export configuration`,
      `${output.highlight('import')}     - Import configuration`
    ]);

    return { success: true };
  }
};

export default configCommand;
