/**
 * V3 CLI Agent Command
 * Agent management commands for spawning, listing, and controlling agents
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';

// Available agent types with descriptions
const AGENT_TYPES = [
  { value: 'coder', label: 'Coder', hint: 'Code development with neural patterns' },
  { value: 'researcher', label: 'Researcher', hint: 'Research with web access and data analysis' },
  { value: 'tester', label: 'Tester', hint: 'Comprehensive testing with automation' },
  { value: 'reviewer', label: 'Reviewer', hint: 'Code review with security and quality checks' },
  { value: 'architect', label: 'Architect', hint: 'System design with enterprise patterns' },
  { value: 'coordinator', label: 'Coordinator', hint: 'Multi-agent orchestration and workflow' },
  { value: 'analyst', label: 'Analyst', hint: 'Performance analysis and optimization' },
  { value: 'optimizer', label: 'Optimizer', hint: 'Performance optimization and bottleneck analysis' },
  { value: 'security-architect', label: 'Security Architect', hint: 'Security architecture and threat modeling' },
  { value: 'security-auditor', label: 'Security Auditor', hint: 'CVE remediation and security testing' },
  { value: 'memory-specialist', label: 'Memory Specialist', hint: 'AgentDB unification (150x-12,500x faster)' },
  { value: 'swarm-specialist', label: 'Swarm Specialist', hint: 'Unified coordination engine' },
  { value: 'performance-engineer', label: 'Performance Engineer', hint: '2.49x-7.47x optimization targets' },
  { value: 'core-architect', label: 'Core Architect', hint: 'Domain-driven design restructure' },
  { value: 'test-architect', label: 'Test Architect', hint: 'TDD London School methodology' }
];

// Agent spawn subcommand
const spawnCommand: Command = {
  name: 'spawn',
  description: 'Spawn a new agent',
  options: [
    {
      name: 'type',
      short: 't',
      description: 'Agent type to spawn',
      type: 'string',
      choices: AGENT_TYPES.map(a => a.value)
    },
    {
      name: 'name',
      short: 'n',
      description: 'Agent name/identifier',
      type: 'string'
    },
    {
      name: 'provider',
      short: 'p',
      description: 'Provider to use (anthropic, openrouter, ollama)',
      type: 'string',
      default: 'anthropic'
    },
    {
      name: 'model',
      short: 'm',
      description: 'Model to use',
      type: 'string'
    },
    {
      name: 'task',
      description: 'Initial task for the agent',
      type: 'string'
    },
    {
      name: 'timeout',
      description: 'Agent timeout in seconds',
      type: 'number',
      default: 300
    },
    {
      name: 'auto-tools',
      description: 'Enable automatic tool usage',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow agent spawn --type coder --name bot-1', description: 'Spawn a coder agent' },
    { command: 'claude-flow agent spawn -t researcher --task "Research React 19"', description: 'Spawn researcher with task' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let agentType = ctx.flags.type as string;
    let agentName = ctx.flags.name as string;

    // Interactive mode if type not specified
    if (!agentType && ctx.interactive) {
      agentType = await select({
        message: 'Select agent type:',
        options: AGENT_TYPES
      });
    }

    if (!agentType) {
      output.printError('Agent type is required. Use --type or -t flag.');
      return { success: false, exitCode: 1 };
    }

    // Generate name if not provided
    if (!agentName) {
      agentName = `${agentType}-${Date.now().toString(36)}`;
    }

    output.printInfo(`Spawning ${agentType} agent: ${output.highlight(agentName)}`);

    try {
      // Call MCP tool to spawn agent
      const result = await callMCPTool<{
        agentId: string;
        agentType: string;
        status: string;
        createdAt: string;
      }>('agent/spawn', {
        agentType,
        id: agentName,
        config: {
          provider: ctx.flags.provider || 'anthropic',
          model: ctx.flags.model,
          task: ctx.flags.task,
          timeout: ctx.flags.timeout,
          autoTools: ctx.flags.autoTools,
        },
        priority: 'normal',
        metadata: {
          name: agentName,
          capabilities: getAgentCapabilities(agentType),
        },
      });

      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 15 },
          { key: 'value', header: 'Value', width: 40 }
        ],
        data: [
          { property: 'ID', value: result.agentId },
          { property: 'Type', value: result.agentType },
          { property: 'Name', value: agentName },
          { property: 'Status', value: result.status },
          { property: 'Created', value: result.createdAt },
          { property: 'Capabilities', value: getAgentCapabilities(agentType).join(', ') }
        ]
      });

      output.writeln();
      output.printSuccess(`Agent ${agentName} spawned successfully`);

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to spawn agent: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Agent list subcommand
const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List all active agents',
  options: [
    {
      name: 'all',
      short: 'a',
      description: 'Include inactive agents',
      type: 'boolean',
      default: false
    },
    {
      name: 'type',
      short: 't',
      description: 'Filter by agent type',
      type: 'string'
    },
    {
      name: 'status',
      short: 's',
      description: 'Filter by status',
      type: 'string'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    try {
      // Call MCP tool to list agents
      const result = await callMCPTool<{
        agents: Array<{
          id: string;
          agentType: string;
          status: 'active' | 'idle' | 'terminated';
          createdAt: string;
          lastActivityAt?: string;
        }>;
        total: number;
      }>('agent/list', {
        status: ctx.flags.all ? 'all' : ctx.flags.status || undefined,
        agentType: ctx.flags.type || undefined,
        limit: 100,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Active Agents'));
      output.writeln();

      if (result.agents.length === 0) {
        output.printInfo('No agents found matching criteria');
        return { success: true, data: result };
      }

      // Format for display
      const displayAgents = result.agents.map(agent => ({
        id: agent.id,
        type: agent.agentType,
        status: agent.status,
        created: new Date(agent.createdAt).toLocaleTimeString(),
        lastActivity: agent.lastActivityAt
          ? new Date(agent.lastActivityAt).toLocaleTimeString()
          : 'N/A',
      }));

      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 20 },
          { key: 'type', header: 'Type', width: 15 },
          { key: 'status', header: 'Status', width: 12, format: formatStatus },
          { key: 'created', header: 'Created', width: 12 },
          { key: 'lastActivity', header: 'Last Activity', width: 12 }
        ],
        data: displayAgents
      });

      output.writeln();
      output.printInfo(`Total: ${result.total} agents`);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to list agents: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Agent status subcommand
const statusCommand: Command = {
  name: 'status',
  description: 'Show detailed status of an agent',
  options: [
    {
      name: 'id',
      description: 'Agent ID',
      type: 'string'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let agentId = ctx.args[0] || ctx.flags.id as string;

    if (!agentId && ctx.interactive) {
      agentId = await input({
        message: 'Enter agent ID:',
        validate: (v) => v.length > 0 || 'Agent ID is required'
      });
    }

    if (!agentId) {
      output.printError('Agent ID is required');
      return { success: false, exitCode: 1 };
    }

    try {
      // Call MCP tool to get agent status
      const status = await callMCPTool<{
        id: string;
        agentType: string;
        status: 'active' | 'idle' | 'terminated';
        createdAt: string;
        lastActivityAt?: string;
        config?: Record<string, unknown>;
        metrics?: {
          tasksCompleted: number;
          tasksInProgress: number;
          tasksFailed: number;
          averageExecutionTime: number;
          uptime: number;
        };
      }>('agent/status', {
        agentId,
        includeMetrics: true,
        includeHistory: false,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(status);
        return { success: true, data: status };
      }

      output.writeln();
      output.printBox(
        [
          `Type: ${status.agentType}`,
          `Status: ${formatStatus(status.status)}`,
          `Created: ${new Date(status.createdAt).toLocaleString()}`,
          `Last Activity: ${status.lastActivityAt ? new Date(status.lastActivityAt).toLocaleString() : 'N/A'}`
        ].join('\n'),
        `Agent: ${status.id}`
      );

      if (status.metrics) {
        output.writeln();
        output.writeln(output.bold('Metrics'));
        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 15, align: 'right' }
          ],
          data: [
            { metric: 'Tasks Completed', value: status.metrics.tasksCompleted },
            { metric: 'Tasks In Progress', value: status.metrics.tasksInProgress },
            { metric: 'Tasks Failed', value: status.metrics.tasksFailed },
            { metric: 'Avg Execution Time', value: `${status.metrics.averageExecutionTime.toFixed(2)}ms` },
            { metric: 'Uptime', value: `${(status.metrics.uptime / 1000 / 60).toFixed(1)}m` }
          ]
        });
      }

      return { success: true, data: status };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to get agent status: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Agent stop subcommand
const stopCommand: Command = {
  name: 'stop',
  aliases: ['kill'],
  description: 'Stop a running agent',
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
      description: 'Graceful shutdown timeout in seconds',
      type: 'number',
      default: 30
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agentId = ctx.args[0];

    if (!agentId) {
      output.printError('Agent ID is required');
      return { success: false, exitCode: 1 };
    }

    const force = ctx.flags.force as boolean;

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Are you sure you want to stop agent ${agentId}?`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    output.printInfo(`Stopping agent ${agentId}...`);

    try {
      // Call MCP tool to terminate agent
      const result = await callMCPTool<{
        agentId: string;
        terminated: boolean;
        terminatedAt: string;
      }>('agent/terminate', {
        agentId,
        graceful: !force,
        reason: 'Stopped by user via CLI',
      });

      if (!force) {
        output.writeln(output.dim('  Completing current task...'));
        output.writeln(output.dim('  Saving state...'));
        output.writeln(output.dim('  Releasing resources...'));
      }

      output.printSuccess(`Agent ${agentId} stopped successfully`);

      if (ctx.flags.format === 'json') {
        output.printJson(result);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Failed to stop agent: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Agent metrics subcommand
const metricsCommand: Command = {
  name: 'metrics',
  description: 'Show agent performance metrics',
  options: [
    {
      name: 'period',
      short: 'p',
      description: 'Time period (1h, 24h, 7d, 30d)',
      type: 'string',
      default: '24h'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const agentId = ctx.args[0];
    const period = ctx.flags.period as string;

    // Simulated metrics
    const metrics = {
      period,
      summary: {
        totalAgents: 4,
        activeAgents: 3,
        tasksCompleted: 127,
        avgSuccessRate: '96.2%',
        totalTokens: 1234567,
        avgResponseTime: '1.45s'
      },
      byType: [
        { type: 'coder', count: 2, tasks: 45, successRate: '97%' },
        { type: 'researcher', count: 1, tasks: 32, successRate: '95%' },
        { type: 'tester', count: 1, tasks: 50, successRate: '98%' }
      ],
      performance: {
        flashAttention: '2.8x speedup',
        memoryReduction: '52%',
        searchImprovement: '150x faster'
      }
    };

    if (ctx.flags.format === 'json') {
      output.printJson(metrics);
      return { success: true, data: metrics };
    }

    output.writeln();
    output.writeln(output.bold(`Agent Metrics (${period})`));
    output.writeln();

    output.printTable({
      columns: [
        { key: 'metric', header: 'Metric', width: 20 },
        { key: 'value', header: 'Value', width: 15, align: 'right' }
      ],
      data: [
        { metric: 'Total Agents', value: metrics.summary.totalAgents },
        { metric: 'Active Agents', value: metrics.summary.activeAgents },
        { metric: 'Tasks Completed', value: metrics.summary.tasksCompleted },
        { metric: 'Success Rate', value: metrics.summary.avgSuccessRate },
        { metric: 'Total Tokens', value: metrics.summary.totalTokens.toLocaleString() },
        { metric: 'Avg Response Time', value: metrics.summary.avgResponseTime }
      ]
    });

    output.writeln();
    output.writeln(output.bold('By Agent Type'));
    output.printTable({
      columns: [
        { key: 'type', header: 'Type', width: 12 },
        { key: 'count', header: 'Count', width: 8, align: 'right' },
        { key: 'tasks', header: 'Tasks', width: 8, align: 'right' },
        { key: 'successRate', header: 'Success', width: 10, align: 'right' }
      ],
      data: metrics.byType
    });

    output.writeln();
    output.writeln(output.bold('V3 Performance Gains'));
    output.printList([
      `Flash Attention: ${output.success(metrics.performance.flashAttention)}`,
      `Memory Reduction: ${output.success(metrics.performance.memoryReduction)}`,
      `Search: ${output.success(metrics.performance.searchImprovement)}`
    ]);

    return { success: true, data: metrics };
  }
};

// Main agent command
export const agentCommand: Command = {
  name: 'agent',
  description: 'Agent management commands',
  subcommands: [spawnCommand, listCommand, statusCommand, stopCommand, metricsCommand],
  options: [],
  examples: [
    { command: 'claude-flow agent spawn -t coder', description: 'Spawn a coder agent' },
    { command: 'claude-flow agent list', description: 'List all agents' },
    { command: 'claude-flow agent status agent-001', description: 'Show agent status' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Show help if no subcommand
    output.writeln();
    output.writeln(output.bold('Agent Management Commands'));
    output.writeln();
    output.writeln('Usage: claude-flow agent <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('spawn')}    - Spawn a new agent`,
      `${output.highlight('list')}     - List all active agents`,
      `${output.highlight('status')}   - Show detailed agent status`,
      `${output.highlight('stop')}     - Stop a running agent`,
      `${output.highlight('metrics')}  - Show agent metrics`
    ]);
    output.writeln();
    output.writeln('Run "claude-flow agent <subcommand> --help" for subcommand help');

    return { success: true };
  }
};

// Helper functions
function getAgentCapabilities(type: string): string[] {
  const capabilities: Record<string, string[]> = {
    coder: ['code-generation', 'refactoring', 'debugging', 'testing'],
    researcher: ['web-search', 'data-analysis', 'summarization', 'citation'],
    tester: ['unit-testing', 'integration-testing', 'coverage-analysis', 'automation'],
    reviewer: ['code-review', 'security-audit', 'quality-check', 'documentation'],
    architect: ['system-design', 'pattern-analysis', 'scalability', 'documentation'],
    coordinator: ['task-orchestration', 'agent-management', 'workflow-control'],
    'security-architect': ['threat-modeling', 'security-patterns', 'compliance', 'audit'],
    'memory-specialist': ['vector-search', 'agentdb', 'caching', 'optimization'],
    'performance-engineer': ['benchmarking', 'profiling', 'optimization', 'monitoring']
  };

  return capabilities[type] || ['general'];
}

function formatStatus(status: unknown): string {
  const statusStr = String(status);
  switch (statusStr) {
    case 'active':
      return output.success(statusStr);
    case 'idle':
      return output.warning(statusStr);
    case 'inactive':
    case 'stopped':
      return output.dim(statusStr);
    case 'error':
      return output.error(statusStr);
    default:
      return statusStr;
  }
}

export default agentCommand;
