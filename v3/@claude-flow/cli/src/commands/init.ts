/**
 * V3 CLI Init Command
 * Project initialization for Claude Flow
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { confirm, select, input } from '../prompt.js';
import * as fs from 'fs';
import * as path from 'path';

// Default configuration template
const DEFAULT_CONFIG = {
  version: '3.0.0',
  agents: {
    defaultType: 'coder',
    autoSpawn: false,
    maxConcurrent: 5,
    timeout: 300,
    providers: [
      {
        name: 'anthropic',
        enabled: true,
        priority: 1,
        model: 'claude-sonnet-4-20250514'
      }
    ]
  },
  swarm: {
    topology: 'hierarchical-mesh',
    maxAgents: 15,
    autoScale: true,
    coordinationStrategy: 'consensus',
    healthCheckInterval: 30000
  },
  memory: {
    backend: 'hybrid',
    persistPath: '.claude-flow/data',
    cacheSize: 100,
    enableHNSW: true,
    vectorDimension: 1536
  },
  mcp: {
    serverHost: 'localhost',
    serverPort: 3000,
    autoStart: false,
    transportType: 'stdio',
    tools: ['agent', 'swarm', 'memory', 'task']
  },
  cli: {
    colorOutput: true,
    interactive: true,
    verbosity: 'normal',
    outputFormat: 'text',
    progressStyle: 'spinner'
  },
  hooks: {
    enabled: true,
    autoExecute: true,
    hooks: []
  }
};

// Minimal configuration template
const MINIMAL_CONFIG = {
  version: '3.0.0',
  agents: {
    defaultType: 'coder',
    maxConcurrent: 3
  },
  swarm: {
    topology: 'mesh',
    maxAgents: 5
  },
  memory: {
    backend: 'memory'
  }
};

// Flow Nexus enhanced configuration
const FLOW_NEXUS_CONFIG = {
  ...DEFAULT_CONFIG,
  flowNexus: {
    enabled: true,
    sandbox: {
      provider: 'e2b',
      timeout: 300000
    },
    neural: {
      trainingEnabled: true,
      modelPath: '.claude-flow/neural'
    },
    distributed: {
      enabled: true,
      coordinationMode: 'quic'
    }
  },
  swarm: {
    ...DEFAULT_CONFIG.swarm,
    topology: 'hierarchical-mesh',
    maxAgents: 50,
    autoScale: true
  }
};

// Default agent definitions
const DEFAULT_AGENTS = [
  {
    id: 'coder',
    name: 'Coder Agent',
    description: 'Code development with neural patterns',
    capabilities: ['code-generation', 'refactoring', 'debugging', 'testing'],
    model: 'claude-sonnet-4-20250514'
  },
  {
    id: 'researcher',
    name: 'Researcher Agent',
    description: 'Research with web access and data analysis',
    capabilities: ['web-search', 'data-analysis', 'summarization', 'citation'],
    model: 'claude-sonnet-4-20250514'
  },
  {
    id: 'tester',
    name: 'Tester Agent',
    description: 'Comprehensive testing with automation',
    capabilities: ['unit-testing', 'integration-testing', 'coverage-analysis', 'automation'],
    model: 'claude-sonnet-4-20250514'
  },
  {
    id: 'reviewer',
    name: 'Reviewer Agent',
    description: 'Code review with security and quality checks',
    capabilities: ['code-review', 'security-audit', 'quality-check', 'documentation'],
    model: 'claude-sonnet-4-20250514'
  },
  {
    id: 'architect',
    name: 'Architect Agent',
    description: 'System design with enterprise patterns',
    capabilities: ['system-design', 'pattern-analysis', 'scalability', 'documentation'],
    model: 'claude-sonnet-4-20250514'
  }
];

// Directory structure to create
const DIRECTORY_STRUCTURE = [
  '.claude-flow',
  '.claude-flow/agents',
  '.claude-flow/data',
  '.claude-flow/logs',
  '.claude-flow/hooks',
  '.claude-flow/workflows',
  '.claude-flow/sessions'
];

// Check if project is already initialized
function isInitialized(cwd: string): boolean {
  const configPath = path.join(cwd, '.claude-flow', 'config.yaml');
  return fs.existsSync(configPath);
}

// Create directory structure
function createDirectories(cwd: string): void {
  for (const dir of DIRECTORY_STRUCTURE) {
    const dirPath = path.join(cwd, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}

// Write YAML config (simple YAML serialization)
function toYaml(obj: unknown, indent: number = 0): string {
  const spaces = '  '.repeat(indent);
  let result = '';

  if (obj === null || obj === undefined) {
    return 'null';
  }

  if (typeof obj === 'boolean' || typeof obj === 'number') {
    return String(obj);
  }

  if (typeof obj === 'string') {
    // Quote strings that might be interpreted as other types
    if (obj.includes(':') || obj.includes('#') || obj.includes('\n') ||
        obj === 'true' || obj === 'false' || !isNaN(Number(obj))) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    result = '\n';
    for (const item of obj) {
      if (typeof item === 'object' && item !== null) {
        result += `${spaces}- `;
        const lines = toYaml(item, indent + 1).split('\n');
        result += lines[0] + '\n';
        for (let i = 1; i < lines.length; i++) {
          if (lines[i].trim()) {
            result += `${spaces}  ${lines[i]}\n`;
          }
        }
      } else {
        result += `${spaces}- ${toYaml(item, indent + 1)}\n`;
      }
    }
    return result.trimEnd();
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';
    result = indent === 0 ? '' : '\n';
    for (const [key, value] of entries) {
      const valueStr = toYaml(value, indent + 1);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result += `${spaces}${key}:${valueStr}\n`;
      } else if (Array.isArray(value)) {
        result += `${spaces}${key}:${valueStr}\n`;
      } else {
        result += `${spaces}${key}: ${valueStr}\n`;
      }
    }
    return result.trimEnd();
  }

  return String(obj);
}

// Write config file
function writeConfig(cwd: string, config: unknown): void {
  const configPath = path.join(cwd, '.claude-flow', 'config.yaml');
  const content = `# Claude Flow V3 Configuration\n# Generated at: ${new Date().toISOString()}\n\n${toYaml(config)}`;
  fs.writeFileSync(configPath, content, 'utf-8');
}

// Write agent definitions
function writeAgents(cwd: string, agents: typeof DEFAULT_AGENTS): void {
  const agentsPath = path.join(cwd, '.claude-flow', 'agents');

  for (const agent of agents) {
    const agentFile = path.join(agentsPath, `${agent.id}.yaml`);
    const content = `# ${agent.name}\n# ${agent.description}\n\n${toYaml(agent)}`;
    fs.writeFileSync(agentFile, content, 'utf-8');
  }
}

// Write gitignore for .claude-flow
function writeGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.claude-flow', '.gitignore');
  const content = `# Claude Flow local files
data/
logs/
sessions/
*.log
*.tmp

# Keep config and agents
!config.yaml
!agents/
`;
  fs.writeFileSync(gitignorePath, content, 'utf-8');
}

// Write sample hook
function writeSampleHook(cwd: string): void {
  const hookPath = path.join(cwd, '.claude-flow', 'hooks', 'pre-task.js');
  const content = `/**
 * Sample Pre-Task Hook
 * This hook runs before each task execution
 */

module.exports = async function preTaskHook(context) {
  const { task, agent, config } = context;

  // Log task start
  console.log(\`[Hook] Starting task: \${task.id}\`);

  // You can modify the task or add metadata
  return {
    ...context,
    metadata: {
      ...context.metadata,
      hookExecuted: true,
      timestamp: new Date().toISOString()
    }
  };
};
`;
  fs.writeFileSync(hookPath, content, 'utf-8');
}

// Init subcommand (default)
const initAction = async (ctx: CommandContext): Promise<CommandResult> => {
  const force = ctx.flags.force as boolean;
  const minimal = ctx.flags.minimal as boolean;
  const flowNexus = ctx.flags['flow-nexus'] as boolean;
  const cwd = ctx.cwd;

  // Check if already initialized
  if (isInitialized(cwd) && !force) {
    output.printWarning('Claude Flow is already initialized in this directory');
    output.printInfo('Use --force to reinitialize');

    if (ctx.interactive) {
      const proceed = await confirm({
        message: 'Do you want to reinitialize? This will overwrite existing configuration.',
        default: false
      });

      if (!proceed) {
        return { success: true, message: 'Initialization cancelled' };
      }
    } else {
      return { success: false, exitCode: 1, message: 'Already initialized' };
    }
  }

  output.writeln();
  output.writeln(output.bold('Initializing Claude Flow V3'));
  output.writeln();

  // Create spinner
  const spinner = output.createSpinner({ text: 'Creating directory structure...' });
  spinner.start();

  try {
    // Create directories
    createDirectories(cwd);
    spinner.succeed('Directory structure created');

    // Select configuration type
    let config: typeof DEFAULT_CONFIG | typeof MINIMAL_CONFIG | typeof FLOW_NEXUS_CONFIG;
    let configType: string;

    if (flowNexus) {
      config = FLOW_NEXUS_CONFIG;
      configType = 'Flow Nexus';
    } else if (minimal) {
      config = MINIMAL_CONFIG;
      configType = 'Minimal';
    } else if (ctx.interactive) {
      configType = await select({
        message: 'Select configuration type:',
        options: [
          { value: 'default', label: 'Default', hint: 'Full configuration with all features' },
          { value: 'minimal', label: 'Minimal', hint: 'Lightweight configuration for quick start' },
          { value: 'flow-nexus', label: 'Flow Nexus', hint: 'Enhanced configuration with Flow Nexus features' }
        ]
      });

      config = configType === 'minimal' ? MINIMAL_CONFIG :
               configType === 'flow-nexus' ? FLOW_NEXUS_CONFIG : DEFAULT_CONFIG;
    } else {
      config = DEFAULT_CONFIG;
      configType = 'Default';
    }

    // Write configuration
    spinner.setText('Writing configuration...');
    spinner.start();
    writeConfig(cwd, config);
    spinner.succeed(`Configuration written (${configType})`);

    // Write agent definitions (unless minimal)
    if (!minimal) {
      spinner.setText('Creating agent definitions...');
      spinner.start();
      writeAgents(cwd, DEFAULT_AGENTS);
      spinner.succeed(`Created ${DEFAULT_AGENTS.length} agent definitions`);
    }

    // Write gitignore
    spinner.setText('Creating .gitignore...');
    spinner.start();
    writeGitignore(cwd);
    spinner.succeed('Created .gitignore');

    // Write sample hook (unless minimal)
    if (!minimal) {
      spinner.setText('Creating sample hook...');
      spinner.start();
      writeSampleHook(cwd);
      spinner.succeed('Created sample hook');
    }

    // Success message
    output.writeln();
    output.printSuccess('Claude Flow V3 initialized successfully!');
    output.writeln();

    output.printBox(
      [
        `Configuration: .claude-flow/config.yaml`,
        `Agents:        .claude-flow/agents/`,
        `Data:          .claude-flow/data/`,
        `Hooks:         .claude-flow/hooks/`,
        `Sessions:      .claude-flow/sessions/`
      ].join('\n'),
      'Project Structure'
    );

    output.writeln();
    output.writeln(output.bold('Next steps:'));
    output.printList([
      `Run ${output.highlight('claude-flow start')} to start the orchestration system`,
      `Run ${output.highlight('claude-flow agent spawn -t coder')} to spawn an agent`,
      `Run ${output.highlight('claude-flow swarm init')} to initialize a swarm`,
      `Edit ${output.highlight('.claude-flow/config.yaml')} to customize settings`
    ]);

    const result = {
      initialized: true,
      configType,
      directories: DIRECTORY_STRUCTURE,
      agents: minimal ? [] : DEFAULT_AGENTS.map(a => a.id),
      configPath: path.join(cwd, '.claude-flow', 'config.yaml')
    };

    if (ctx.flags.format === 'json') {
      output.printJson(result);
    }

    return { success: true, data: result };
  } catch (error) {
    spinner.fail('Initialization failed');
    output.printError(`Failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false, exitCode: 1 };
  }
};

// Wizard subcommand for interactive setup
const wizardCommand: Command = {
  name: 'wizard',
  description: 'Interactive setup wizard',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Claude Flow V3 Setup Wizard'));
    output.writeln(output.dim('Answer a few questions to configure your project'));
    output.writeln();

    try {
      // Project name
      const projectName = await input({
        message: 'Project name:',
        default: path.basename(ctx.cwd),
        validate: (v) => v.length > 0 || 'Project name is required'
      });

      // Swarm topology
      const topology = await select({
        message: 'Select swarm topology:',
        options: [
          { value: 'hierarchical-mesh', label: 'Hierarchical Mesh', hint: 'Best for complex projects (recommended)' },
          { value: 'mesh', label: 'Mesh', hint: 'Peer-to-peer coordination' },
          { value: 'hierarchical', label: 'Hierarchical', hint: 'Tree-based coordination' },
          { value: 'ring', label: 'Ring', hint: 'Sequential coordination' },
          { value: 'star', label: 'Star', hint: 'Hub-based coordination' }
        ]
      });

      // Max agents
      const maxAgents = await input({
        message: 'Maximum concurrent agents:',
        default: '15',
        validate: (v) => {
          const n = parseInt(v);
          return (!isNaN(n) && n > 0 && n <= 50) || 'Enter a number between 1 and 50';
        }
      });

      // Memory backend
      const memoryBackend = await select({
        message: 'Select memory backend:',
        options: [
          { value: 'hybrid', label: 'Hybrid', hint: 'SQLite + AgentDB (recommended)' },
          { value: 'agentdb', label: 'AgentDB', hint: '150x faster vector search' },
          { value: 'sqlite', label: 'SQLite', hint: 'Standard SQL storage' },
          { value: 'memory', label: 'In-Memory', hint: 'Fast but non-persistent' }
        ]
      });

      // Enable hooks
      const enableHooks = await confirm({
        message: 'Enable hooks system for learning?',
        default: true
      });

      // Enable MCP auto-start
      const autoStartMCP = await confirm({
        message: 'Auto-start MCP server?',
        default: false
      });

      // Build custom configuration
      const customConfig = {
        ...DEFAULT_CONFIG,
        projectName,
        swarm: {
          ...DEFAULT_CONFIG.swarm,
          topology,
          maxAgents: parseInt(maxAgents)
        },
        memory: {
          ...DEFAULT_CONFIG.memory,
          backend: memoryBackend
        },
        hooks: {
          ...DEFAULT_CONFIG.hooks,
          enabled: enableHooks
        },
        mcp: {
          ...DEFAULT_CONFIG.mcp,
          autoStart: autoStartMCP
        }
      };

      // Create structure and write config
      createDirectories(ctx.cwd);
      writeConfig(ctx.cwd, customConfig);
      writeAgents(ctx.cwd, DEFAULT_AGENTS);
      writeGitignore(ctx.cwd);
      if (enableHooks) {
        writeSampleHook(ctx.cwd);
      }

      output.writeln();
      output.printSuccess('Setup complete!');
      output.writeln();

      output.printTable({
        columns: [
          { key: 'setting', header: 'Setting', width: 20 },
          { key: 'value', header: 'Value', width: 30 }
        ],
        data: [
          { setting: 'Project', value: projectName },
          { setting: 'Topology', value: topology },
          { setting: 'Max Agents', value: maxAgents },
          { setting: 'Memory Backend', value: memoryBackend },
          { setting: 'Hooks', value: enableHooks ? 'Enabled' : 'Disabled' },
          { setting: 'MCP Auto-start', value: autoStartMCP ? 'Yes' : 'No' }
        ]
      });

      return {
        success: true,
        data: {
          projectName,
          topology,
          maxAgents: parseInt(maxAgents),
          memoryBackend,
          enableHooks,
          autoStartMCP
        }
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'User cancelled') {
        output.printInfo('Setup cancelled');
        return { success: true };
      }
      throw error;
    }
  }
};

// Check subcommand
const checkCommand: Command = {
  name: 'check',
  description: 'Check if Claude Flow is initialized',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const initialized = isInitialized(ctx.cwd);
    const configPath = path.join(ctx.cwd, '.claude-flow', 'config.yaml');

    if (ctx.flags.format === 'json') {
      output.printJson({ initialized, configPath: initialized ? configPath : null });
      return { success: true, data: { initialized } };
    }

    if (initialized) {
      output.printSuccess(`Claude Flow is initialized`);
      output.printInfo(`Config: ${configPath}`);
    } else {
      output.printWarning('Claude Flow is not initialized in this directory');
      output.printInfo('Run "claude-flow init" to initialize');
    }

    return { success: true, data: { initialized } };
  }
};

// Main init command
export const initCommand: Command = {
  name: 'init',
  description: 'Initialize Claude Flow in the current directory',
  subcommands: [wizardCommand, checkCommand],
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing configuration',
      type: 'boolean',
      default: false
    },
    {
      name: 'minimal',
      short: 'm',
      description: 'Create minimal configuration',
      type: 'boolean',
      default: false
    },
    {
      name: 'flow-nexus',
      description: 'Initialize with Flow Nexus features',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow init', description: 'Initialize with default configuration' },
    { command: 'claude-flow init --minimal', description: 'Initialize with minimal configuration' },
    { command: 'claude-flow init --flow-nexus', description: 'Initialize with Flow Nexus features' },
    { command: 'claude-flow init --force', description: 'Reinitialize and overwrite existing config' },
    { command: 'claude-flow init wizard', description: 'Interactive setup wizard' }
  ],
  action: initAction
};

export default initCommand;
