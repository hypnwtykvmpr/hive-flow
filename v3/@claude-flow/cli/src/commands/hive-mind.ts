/**
 * V3 CLI Hive Mind Command
 * Queen-led consensus-based multi-agent coordination
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';

// Hive topologies
const TOPOLOGIES = [
  { value: 'hierarchical', label: 'Hierarchical', hint: 'Queen-led with worker agents' },
  { value: 'mesh', label: 'Mesh', hint: 'Peer-to-peer coordination' },
  { value: 'hierarchical-mesh', label: 'Hierarchical Mesh', hint: 'Queen + peer communication (recommended)' },
  { value: 'adaptive', label: 'Adaptive', hint: 'Dynamic topology based on task' }
];

// Consensus strategies
const CONSENSUS_STRATEGIES = [
  { value: 'byzantine', label: 'Byzantine Fault Tolerant', hint: '2/3 majority, handles malicious actors' },
  { value: 'raft', label: 'Raft', hint: 'Leader-based consensus' },
  { value: 'gossip', label: 'Gossip', hint: 'Eventually consistent, scalable' },
  { value: 'crdt', label: 'CRDT', hint: 'Conflict-free replicated data' },
  { value: 'quorum', label: 'Quorum', hint: 'Simple majority voting' }
];

// Init subcommand
const initCommand: Command = {
  name: 'init',
  description: 'Initialize a hive mind',
  options: [
    {
      name: 'topology',
      short: 't',
      description: 'Hive topology',
      type: 'string',
      choices: TOPOLOGIES.map(t => t.value),
      default: 'hierarchical-mesh'
    },
    {
      name: 'consensus',
      short: 'c',
      description: 'Consensus strategy',
      type: 'string',
      choices: CONSENSUS_STRATEGIES.map(s => s.value),
      default: 'byzantine'
    },
    {
      name: 'max-agents',
      short: 'm',
      description: 'Maximum agents',
      type: 'number',
      default: 15
    },
    {
      name: 'persist',
      short: 'p',
      description: 'Enable persistent state',
      type: 'boolean',
      default: true
    },
    {
      name: 'memory-backend',
      description: 'Memory backend (agentdb, sqlite, hybrid)',
      type: 'string',
      default: 'hybrid'
    }
  ],
  examples: [
    { command: 'claude-flow hive-mind init -t hierarchical-mesh', description: 'Init hierarchical mesh' },
    { command: 'claude-flow hive-mind init -c byzantine -m 20', description: 'Init with Byzantine consensus' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let topology = ctx.flags.topology as string;
    let consensus = ctx.flags.consensus as string;

    if (ctx.interactive && !ctx.flags.topology) {
      topology = await select({
        message: 'Select hive topology:',
        options: TOPOLOGIES,
        default: 'hierarchical-mesh'
      });
    }

    if (ctx.interactive && !ctx.flags.consensus) {
      consensus = await select({
        message: 'Select consensus strategy:',
        options: CONSENSUS_STRATEGIES,
        default: 'byzantine'
      });
    }

    const config = {
      topology: topology || 'hierarchical-mesh',
      consensus: consensus || 'byzantine',
      maxAgents: ctx.flags.maxAgents as number || 15,
      persist: ctx.flags.persist as boolean,
      memoryBackend: ctx.flags.memoryBackend as string || 'hybrid'
    };

    output.writeln();
    output.writeln(output.bold('Initializing Hive Mind'));

    const spinner = output.createSpinner({ text: 'Setting up hive infrastructure...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        hiveId: string;
        topology: string;
        consensus: string;
        queenId: string;
        status: 'initialized' | 'ready';
        config: typeof config;
      }>('hive-mind/init', config);

      spinner.succeed('Hive Mind initialized');

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Hive ID: ${result.hiveId}`,
          `Queen ID: ${result.queenId}`,
          `Topology: ${result.topology}`,
          `Consensus: ${result.consensus}`,
          `Max Agents: ${config.maxAgents}`,
          `Memory: ${config.memoryBackend}`,
          `Status: ${output.success(result.status)}`
        ].join('\n'),
        'Hive Mind Configuration'
      );

      output.writeln();
      output.printInfo('Queen agent is ready to coordinate worker agents');
      output.writeln(output.dim('  Use "claude-flow hive-mind spawn" to add workers'));

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Failed to initialize');
      if (error instanceof MCPClientError) {
        output.printError(`Init error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Spawn subcommand
const spawnCommand: Command = {
  name: 'spawn',
  description: 'Spawn worker agents into the hive',
  options: [
    {
      name: 'count',
      short: 'n',
      description: 'Number of workers to spawn',
      type: 'number',
      default: 1
    },
    {
      name: 'type',
      short: 't',
      description: 'Agent type',
      type: 'string',
      default: 'worker'
    },
    {
      name: 'capabilities',
      short: 'c',
      description: 'Comma-separated capabilities',
      type: 'string'
    },
    {
      name: 'priority',
      short: 'p',
      description: 'Agent priority (low, normal, high)',
      type: 'string',
      default: 'normal'
    }
  ],
  examples: [
    { command: 'claude-flow hive-mind spawn -n 5', description: 'Spawn 5 workers' },
    { command: 'claude-flow hive-mind spawn -t coder -c "coding,testing"', description: 'Spawn coder with capabilities' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const count = ctx.flags.count as number;
    const type = ctx.flags.type as string;
    const capabilities = ctx.flags.capabilities ? (ctx.flags.capabilities as string).split(',') : [];
    const priority = ctx.flags.priority as string;

    output.printInfo(`Spawning ${count} ${type} agent(s)...`);

    try {
      const result = await callMCPTool<{
        spawned: Array<{
          id: string;
          type: string;
          status: string;
          assignedQueen: string;
        }>;
        total: number;
        hiveStatus: {
          activeAgents: number;
          maxAgents: number;
          queenLoad: string;
        };
      }>('hive-mind/spawn', {
        count,
        agentType: type,
        capabilities,
        priority,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printTable({
        columns: [
          { key: 'id', header: 'Agent ID', width: 20 },
          { key: 'type', header: 'Type', width: 12 },
          { key: 'status', header: 'Status', width: 12, format: formatAgentStatus },
          { key: 'assignedQueen', header: 'Queen', width: 15 }
        ],
        data: result.spawned
      });

      output.writeln();
      output.printSuccess(`Spawned ${result.spawned.length} agent(s)`);
      output.writeln(output.dim(`  Hive: ${result.hiveStatus.activeAgents}/${result.hiveStatus.maxAgents} agents, Queen load: ${result.hiveStatus.queenLoad}`));

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Spawn error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Status subcommand
const statusCommand: Command = {
  name: 'status',
  description: 'Show hive mind status',
  options: [
    {
      name: 'detailed',
      short: 'd',
      description: 'Show detailed metrics',
      type: 'boolean',
      default: false
    },
    {
      name: 'watch',
      short: 'w',
      description: 'Watch for changes',
      type: 'boolean',
      default: false
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const detailed = ctx.flags.detailed as boolean;

    try {
      const result = await callMCPTool<{
        hiveId: string;
        status: 'active' | 'idle' | 'degraded' | 'offline';
        topology: string;
        consensus: string;
        queen: {
          id: string;
          status: string;
          load: number;
          tasksQueued: number;
        };
        workers: Array<{
          id: string;
          type: string;
          status: string;
          currentTask?: string;
          tasksCompleted: number;
        }>;
        metrics: {
          totalTasks: number;
          completedTasks: number;
          failedTasks: number;
          avgTaskTime: number;
          consensusRounds: number;
          memoryUsage: string;
        };
        health: {
          overall: string;
          queen: string;
          workers: string;
          consensus: string;
          memory: string;
        };
      }>('hive-mind/status', {
        includeMetrics: detailed,
        includeWorkers: true,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Hive ID: ${result.hiveId}`,
          `Status: ${formatHiveStatus(result.status)}`,
          `Topology: ${result.topology}`,
          `Consensus: ${result.consensus}`,
          '',
          `Queen: ${result.queen.id}`,
          `  Status: ${formatAgentStatus(result.queen.status)}`,
          `  Load: ${(result.queen.load * 100).toFixed(1)}%`,
          `  Queued Tasks: ${result.queen.tasksQueued}`
        ].join('\n'),
        'Hive Mind Status'
      );

      output.writeln();
      output.writeln(output.bold('Worker Agents'));
      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 20 },
          { key: 'type', header: 'Type', width: 12 },
          { key: 'status', header: 'Status', width: 10, format: formatAgentStatus },
          { key: 'currentTask', header: 'Current Task', width: 20, format: (v: unknown) => String(v || '-') },
          { key: 'tasksCompleted', header: 'Completed', width: 10, align: 'right' }
        ],
        data: result.workers
      });

      if (detailed) {
        output.writeln();
        output.writeln(output.bold('Metrics'));
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 20 },
            { key: 'value', header: 'Value', width: 15, align: 'right' }
          ],
          data: [
            { metric: 'Total Tasks', value: result.metrics.totalTasks },
            { metric: 'Completed', value: result.metrics.completedTasks },
            { metric: 'Failed', value: result.metrics.failedTasks },
            { metric: 'Avg Task Time', value: `${result.metrics.avgTaskTime.toFixed(1)}ms` },
            { metric: 'Consensus Rounds', value: result.metrics.consensusRounds },
            { metric: 'Memory Usage', value: result.metrics.memoryUsage }
          ]
        });

        output.writeln();
        output.writeln(output.bold('Health'));
        output.printList([
          `Overall: ${formatHealth(result.health.overall)}`,
          `Queen: ${formatHealth(result.health.queen)}`,
          `Workers: ${formatHealth(result.health.workers)}`,
          `Consensus: ${formatHealth(result.health.consensus)}`,
          `Memory: ${formatHealth(result.health.memory)}`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Status error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Task subcommand
const taskCommand: Command = {
  name: 'task',
  description: 'Submit tasks to the hive',
  options: [
    {
      name: 'description',
      short: 'd',
      description: 'Task description',
      type: 'string'
    },
    {
      name: 'priority',
      short: 'p',
      description: 'Task priority',
      type: 'string',
      choices: ['low', 'normal', 'high', 'critical'],
      default: 'normal'
    },
    {
      name: 'require-consensus',
      short: 'c',
      description: 'Require consensus for completion',
      type: 'boolean',
      default: false
    },
    {
      name: 'timeout',
      description: 'Task timeout in seconds',
      type: 'number',
      default: 300
    }
  ],
  examples: [
    { command: 'claude-flow hive-mind task -d "Implement auth module"', description: 'Submit task' },
    { command: 'claude-flow hive-mind task -d "Security review" -p critical -c', description: 'Critical task with consensus' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let description = ctx.flags.description as string || ctx.args.join(' ');

    if (!description && ctx.interactive) {
      description = await input({
        message: 'Task description:',
        validate: (v) => v.length > 0 || 'Description is required'
      });
    }

    if (!description) {
      output.printError('Task description is required');
      return { success: false, exitCode: 1 };
    }

    const priority = ctx.flags.priority as string;
    const requireConsensus = ctx.flags.requireConsensus as boolean;
    const timeout = ctx.flags.timeout as number;

    output.printInfo('Submitting task to hive...');

    try {
      const result = await callMCPTool<{
        taskId: string;
        description: string;
        status: string;
        assignedTo: string[];
        priority: string;
        requiresConsensus: boolean;
        estimatedTime: string;
      }>('hive-mind/task', {
        description,
        priority,
        requireConsensus,
        timeout,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printBox(
        [
          `Task ID: ${result.taskId}`,
          `Status: ${formatAgentStatus(result.status)}`,
          `Priority: ${formatPriority(priority)}`,
          `Assigned: ${result.assignedTo.join(', ')}`,
          `Consensus: ${result.requiresConsensus ? 'Yes' : 'No'}`,
          `Est. Time: ${result.estimatedTime}`
        ].join('\n'),
        'Task Submitted'
      );

      output.writeln();
      output.printSuccess('Task submitted to hive');
      output.writeln(output.dim(`  Track with: claude-flow hive-mind task-status ${result.taskId}`));

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Task submission error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Optimize memory subcommand
const optimizeMemoryCommand: Command = {
  name: 'optimize-memory',
  description: 'Optimize hive memory and patterns',
  options: [
    {
      name: 'aggressive',
      short: 'a',
      description: 'Aggressive optimization',
      type: 'boolean',
      default: false
    },
    {
      name: 'threshold',
      description: 'Quality threshold for pattern retention',
      type: 'number',
      default: 0.7
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const aggressive = ctx.flags.aggressive as boolean;
    const threshold = ctx.flags.threshold as number;

    output.printInfo('Optimizing hive memory...');

    const spinner = output.createSpinner({ text: 'Analyzing patterns...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        optimized: boolean;
        before: { patterns: number; memory: string };
        after: { patterns: number; memory: string };
        removed: number;
        consolidated: number;
        timeMs: number;
      }>('hive-mind/optimize-memory', {
        aggressive,
        qualityThreshold: threshold,
      });

      spinner.succeed('Memory optimized');

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'before', header: 'Before', width: 15, align: 'right' },
          { key: 'after', header: 'After', width: 15, align: 'right' }
        ],
        data: [
          { metric: 'Patterns', before: result.before.patterns, after: result.after.patterns },
          { metric: 'Memory', before: result.before.memory, after: result.after.memory }
        ]
      });

      output.writeln();
      output.printList([
        `Patterns removed: ${result.removed}`,
        `Patterns consolidated: ${result.consolidated}`,
        `Optimization time: ${result.timeMs}ms`
      ]);

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Optimization failed');
      if (error instanceof MCPClientError) {
        output.printError(`Optimization error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Shutdown subcommand
const shutdownCommand: Command = {
  name: 'shutdown',
  description: 'Shutdown the hive mind',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force shutdown',
      type: 'boolean',
      default: false
    },
    {
      name: 'save-state',
      short: 's',
      description: 'Save state before shutdown',
      type: 'boolean',
      default: true
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;
    const saveState = ctx.flags.saveState as boolean;

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: 'Shutdown the hive mind? All agents will be terminated.',
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo('Shutting down hive mind...');

    const spinner = output.createSpinner({ text: 'Graceful shutdown in progress...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        shutdown: boolean;
        agentsTerminated: number;
        stateSaved: boolean;
        shutdownTime: string;
      }>('hive-mind/shutdown', {
        force,
        saveState,
      });

      spinner.succeed('Hive mind shutdown complete');

      output.writeln();
      output.printList([
        `Agents terminated: ${result.agentsTerminated}`,
        `State saved: ${result.stateSaved ? 'Yes' : 'No'}`,
        `Shutdown time: ${result.shutdownTime}`
      ]);

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Shutdown failed');
      if (error instanceof MCPClientError) {
        output.printError(`Shutdown error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Main hive-mind command
export const hiveMindCommand: Command = {
  name: 'hive-mind',
  aliases: ['hive'],
  description: 'Queen-led consensus-based multi-agent coordination',
  subcommands: [initCommand, spawnCommand, statusCommand, taskCommand, optimizeMemoryCommand, shutdownCommand],
  options: [],
  examples: [
    { command: 'claude-flow hive-mind init -t hierarchical-mesh', description: 'Initialize hive' },
    { command: 'claude-flow hive-mind spawn -n 5', description: 'Spawn workers' },
    { command: 'claude-flow hive-mind task -d "Build feature"', description: 'Submit task' }
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Hive Mind - Consensus-Based Multi-Agent Coordination'));
    output.writeln();
    output.writeln('Usage: claude-flow hive-mind <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}            - Initialize hive mind`,
      `${output.highlight('spawn')}           - Spawn worker agents`,
      `${output.highlight('status')}          - Show hive status`,
      `${output.highlight('task')}            - Submit task to hive`,
      `${output.highlight('optimize-memory')} - Optimize patterns and memory`,
      `${output.highlight('shutdown')}        - Shutdown the hive`
    ]);
    output.writeln();
    output.writeln('Features:');
    output.printList([
      'Queen-led hierarchical coordination',
      'Byzantine fault tolerant consensus',
      'HNSW-accelerated pattern matching',
      'Cross-session memory persistence',
      'Automatic load balancing'
    ]);

    return { success: true };
  }
};

// Helper functions
function formatAgentStatus(status: unknown): string {
  const statusStr = String(status);
  switch (statusStr) {
    case 'active':
    case 'ready':
    case 'running':
      return output.success(statusStr);
    case 'idle':
    case 'waiting':
      return output.dim(statusStr);
    case 'busy':
      return output.highlight(statusStr);
    case 'error':
    case 'failed':
      return output.error(statusStr);
    default:
      return statusStr;
  }
}

function formatHiveStatus(status: string): string {
  switch (status) {
    case 'active':
      return output.success(status);
    case 'idle':
      return output.dim(status);
    case 'degraded':
      return output.warning(status);
    case 'offline':
      return output.error(status);
    default:
      return status;
  }
}

function formatHealth(health: string): string {
  switch (health) {
    case 'healthy':
    case 'good':
      return output.success(health);
    case 'warning':
    case 'degraded':
      return output.warning(health);
    case 'critical':
    case 'unhealthy':
      return output.error(health);
    default:
      return health;
  }
}

function formatPriority(priority: string): string {
  switch (priority) {
    case 'critical':
      return output.error(priority.toUpperCase());
    case 'high':
      return output.warning(priority);
    case 'normal':
      return priority;
    case 'low':
      return output.dim(priority);
    default:
      return priority;
  }
}

export default hiveMindCommand;
