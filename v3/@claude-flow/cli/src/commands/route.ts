/**
 * V3 CLI Route Command
 * Intelligent task-to-agent routing using Q-Learning
 *
 * Features:
 * - Q-Learning based agent selection
 * - Semantic task understanding
 * - Confidence scoring
 * - Learning from feedback
 *
 * Created with love by ruv.io
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import {
  createQLearningRouter,
  isRuvectorAvailable,
  type QLearningRouter,
  type RouteDecision,
} from '../ruvector/index.js';

// ============================================================================
// Agent Type Definitions
// ============================================================================

interface AgentType {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  priority: number;
}

/**
 * Available agent types for routing
 */
const AGENT_TYPES: AgentType[] = [
  { id: 'coder', name: 'Coder', description: 'Implements features and writes code', capabilities: ['coding', 'implementation', 'refactoring'], priority: 1 },
  { id: 'tester', name: 'Tester', description: 'Creates tests and validates functionality', capabilities: ['testing', 'validation', 'quality'], priority: 2 },
  { id: 'reviewer', name: 'Reviewer', description: 'Reviews code quality and security', capabilities: ['review', 'security', 'best-practices'], priority: 3 },
  { id: 'architect', name: 'Architect', description: 'Designs system architecture', capabilities: ['design', 'architecture', 'planning'], priority: 4 },
  { id: 'researcher', name: 'Researcher', description: 'Researches requirements and patterns', capabilities: ['research', 'analysis', 'documentation'], priority: 5 },
  { id: 'optimizer', name: 'Optimizer', description: 'Optimizes performance and efficiency', capabilities: ['optimization', 'performance', 'profiling'], priority: 6 },
  { id: 'debugger', name: 'Debugger', description: 'Debugs issues and fixes bugs', capabilities: ['debugging', 'troubleshooting', 'fixing'], priority: 7 },
  { id: 'documenter', name: 'Documenter', description: 'Creates and updates documentation', capabilities: ['documentation', 'writing', 'explaining'], priority: 8 },
];

// ============================================================================
// Router Singleton
// ============================================================================

let routerInstance: QLearningRouter | null = null;
let routerInitialized = false;

/**
 * Get or create the router instance
 */
async function getRouter(): Promise<QLearningRouter> {
  if (!routerInstance) {
    routerInstance = createQLearningRouter();
  }
  if (!routerInitialized) {
    await routerInstance.initialize();
    routerInitialized = true;
  }
  return routerInstance;
}

/**
 * Get agent type by route name
 */
function getAgentType(route: string): AgentType | undefined {
  return AGENT_TYPES.find(a => a.id === route);
}

// ============================================================================
// Route Subcommand
// ============================================================================

const routeTaskCommand: Command = {
  name: 'task',
  description: 'Route a task to the optimal agent using Q-Learning',
  options: [
    {
      name: 'q-learning',
      short: 'q',
      description: 'Use Q-Learning for agent selection (default: true)',
      type: 'boolean',
      default: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Force specific agent (bypasses Q-Learning)',
      type: 'string',
    },
    {
      name: 'explore',
      short: 'e',
      description: 'Enable exploration (random selection chance)',
      type: 'boolean',
      default: true,
    },
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow route task "implement authentication"', description: 'Route task to best agent' },
    { command: 'claude-flow route task "write unit tests" --q-learning', description: 'Use Q-Learning routing' },
    { command: 'claude-flow route task "review code" --agent reviewer', description: 'Force specific agent' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskDescription = ctx.args[0];
    const forceAgent = ctx.flags.agent as string | undefined;
    const useExploration = ctx.flags.explore as boolean;
    const jsonOutput = ctx.flags.json as boolean;

    if (!taskDescription) {
      output.printError('Task description is required');
      output.writeln(output.dim('Usage: claude-flow route task "task description"'));
      return { success: false, exitCode: 1 };
    }

    const spinner = output.createSpinner({ text: 'Analyzing task...', spinner: 'dots' });
    spinner.start();

    try {
      if (forceAgent) {
        // Bypass Q-Learning, use specified agent
        const agent = getAgentType(forceAgent) ||
          AGENT_TYPES.find(a => a.name.toLowerCase() === forceAgent.toLowerCase());

        if (!agent) {
          spinner.fail(`Agent "${forceAgent}" not found`);
          output.writeln();
          output.writeln('Available agents:');
          output.printList(AGENT_TYPES.map(a => `${output.highlight(a.id)} - ${a.description}`));
          return { success: false, exitCode: 1 };
        }

        spinner.succeed(`Routed to ${agent.name}`);

        if (jsonOutput) {
          output.printJson({
            task: taskDescription,
            agentId: agent.id,
            agentName: agent.name,
            confidence: 1.0,
            method: 'forced',
          });
        } else {
          output.writeln();
          output.printBox([
            `Task: ${taskDescription}`,
            `Agent: ${output.highlight(agent.name)} (${agent.id})`,
            `Confidence: ${output.success('100%')} (forced)`,
            `Description: ${agent.description}`,
          ].join('\n'), 'Routing Result');
        }

        return { success: true, data: { agentId: agent.id, agentName: agent.name } };
      }

      // Use Q-Learning routing
      const router = await getRouter();
      const result: RouteDecision = router.route(taskDescription, useExploration);
      const agent = getAgentType(result.route) || AGENT_TYPES[0];

      spinner.succeed(`Routed to ${agent.name}`);

      if (jsonOutput) {
        output.printJson({
          task: taskDescription,
          agentId: result.route,
          agentName: agent.name,
          confidence: result.confidence,
          qValues: result.qValues,
          explored: result.explored,
          alternatives: result.alternatives.map(a => ({
            agentId: a.route,
            agentName: getAgentType(a.route)?.name || a.route,
            score: a.score,
          })),
        });
      } else {
        output.writeln();

        const confidence = result.confidence ?? 0;
        const confidenceColor = confidence >= 0.7
          ? output.success
          : confidence >= 0.4
            ? output.warning
            : output.error;

        output.printBox([
          `Task: ${taskDescription}`,
          ``,
          `Agent: ${output.highlight(agent.name)} (${result.route})`,
          `Confidence: ${confidenceColor(`${(result.confidence * 100).toFixed(1)}%`)}`,
          `Q-Value: ${Math.max(...result.qValues).toFixed(3)}`,
          `Exploration: ${result.explored ? output.warning('Yes') : 'No'}`,
          ``,
          `Description: ${agent.description}`,
          `Capabilities: ${agent.capabilities.join(', ')}`,
        ].join('\n'), 'Q-Learning Routing');

        if (result.alternatives.length > 0) {
          output.writeln();
          output.writeln(output.bold('Alternatives:'));
          output.printTable({
            columns: [
              { key: 'agent', header: 'Agent', width: 20 },
              { key: 'score', header: 'Score', width: 12, align: 'right' },
            ],
            data: result.alternatives.map(a => ({
              agent: getAgentType(a.route)?.name || a.route,
              score: a.score.toFixed(3),
            })),
          });
        }
      }

      return { success: true, data: { agentId: result.route, result } };
    } catch (error) {
      spinner.fail('Routing failed');
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// List Agents Subcommand
// ============================================================================

const listAgentsCommand: Command = {
  name: 'list-agents',
  aliases: ['agents', 'ls'],
  description: 'List all available agent types for routing',
  options: [
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow route list-agents', description: 'List all agents' },
    { command: 'claude-flow route agents --json', description: 'List agents as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const jsonOutput = ctx.flags.json as boolean;

    try {
      if (jsonOutput) {
        output.printJson(AGENT_TYPES);
      } else {
        output.writeln();
        output.writeln(output.bold('Available Agent Types'));
        output.writeln(output.dim('Ordered by priority (highest first)'));
        output.writeln();

        output.printTable({
          columns: [
            { key: 'id', header: 'ID', width: 15 },
            { key: 'name', header: 'Name', width: 15 },
            { key: 'priority', header: 'Priority', width: 10, align: 'right' },
            { key: 'description', header: 'Description', width: 45 },
          ],
          data: AGENT_TYPES.map(a => ({
            id: output.highlight(a.id),
            name: a.name,
            priority: String(a.priority),
            description: a.description,
          })),
        });

        output.writeln();
        output.writeln(output.dim(`Total: ${AGENT_TYPES.length} agent types`));
      }

      return { success: true, data: AGENT_TYPES };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Stats Subcommand
// ============================================================================

const statsCommand: Command = {
  name: 'stats',
  description: 'Show Q-Learning router statistics',
  options: [
    {
      name: 'json',
      short: 'j',
      description: 'Output in JSON format',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow route stats', description: 'Show routing statistics' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const jsonOutput = ctx.flags.json as boolean;

    try {
      const router = await getRouter();
      const stats = router.getStats();
      const ruvectorAvailable = await isRuvectorAvailable();

      const ruvectorStatus = {
        available: ruvectorAvailable,
        wasmAccelerated: stats.useNative === 1,
        backend: stats.useNative === 1 ? 'ruvector-native' : 'fallback',
      };

      if (jsonOutput) {
        output.printJson({ stats, ruvector: ruvectorStatus });
      } else {
        output.writeln();
        output.writeln(output.bold('Q-Learning Router Statistics'));
        output.writeln();

        output.printTable({
          columns: [
            { key: 'metric', header: 'Metric', width: 25 },
            { key: 'value', header: 'Value', width: 20, align: 'right' },
          ],
          data: [
            { metric: 'Update Count', value: String(stats.updateCount) },
            { metric: 'Q-Table Size', value: String(stats.qTableSize) },
            { metric: 'Step Count', value: String(stats.stepCount) },
            { metric: 'Epsilon', value: stats.epsilon.toFixed(4) },
            { metric: 'Avg TD Error', value: stats.avgTDError.toFixed(4) },
            { metric: 'Native Backend', value: stats.useNative === 1 ? 'Yes' : 'No' },
          ],
        });

        output.writeln();
        output.writeln(output.bold('RuVector Status'));
        output.printList([
          `Available: ${ruvectorStatus.available ? output.success('Yes') : output.warning('No (using fallback)')}`,
          `WASM Accelerated: ${ruvectorStatus.wasmAccelerated ? output.success('Yes') : 'No'}`,
          `Backend: ${ruvectorStatus.backend}`,
        ]);
      }

      return { success: true, data: { stats, ruvector: ruvectorStatus } };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Feedback Subcommand
// ============================================================================

const feedbackCommand: Command = {
  name: 'feedback',
  description: 'Provide feedback on a routing decision',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description (context for learning)',
      type: 'string',
      required: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Agent that was used',
      type: 'string',
      required: true,
    },
    {
      name: 'reward',
      short: 'r',
      description: 'Reward value (-1 to 1, where 1 is best)',
      type: 'number',
      default: 0.8,
    },
    {
      name: 'next-task',
      short: 'n',
      description: 'Next task description (for multi-step learning)',
      type: 'string',
    },
  ],
  examples: [
    { command: 'claude-flow route feedback -t "implement auth" -a coder -r 0.9', description: 'Positive feedback' },
    { command: 'claude-flow route feedback -t "write tests" -a tester -r -0.5', description: 'Negative feedback' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const taskDescription = ctx.flags.task as string;
    const agentId = ctx.flags.agent as string;
    const reward = ctx.flags.reward as number;
    const nextTask = ctx.flags['next-task'] as string | undefined;

    if (!taskDescription || !agentId) {
      output.printError('Task description and agent are required');
      return { success: false, exitCode: 1 };
    }

    // Validate agent
    const agent = getAgentType(agentId);
    if (!agent) {
      output.printError(`Unknown agent: ${agentId}`);
      output.writeln('Available agents:');
      output.printList(AGENT_TYPES.map(a => a.id));
      return { success: false, exitCode: 1 };
    }

    try {
      const router = await getRouter();
      const clampedReward = Math.max(-1, Math.min(1, reward));
      const tdError = router.update(taskDescription, agentId, clampedReward, nextTask);

      output.printSuccess(`Feedback recorded for agent "${agent.name}"`);
      output.writeln();
      output.printBox([
        `Task: ${taskDescription}`,
        `Agent: ${agent.name} (${agentId})`,
        `Reward: ${clampedReward >= 0 ? output.success(clampedReward.toFixed(2)) : output.error(clampedReward.toFixed(2))}`,
        `TD Error: ${Math.abs(tdError).toFixed(4)}`,
        nextTask ? `Next Task: ${nextTask}` : '',
      ].filter(Boolean).join('\n'), 'Feedback Recorded');

      return { success: true, data: { tdError } };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Reset Subcommand
// ============================================================================

const resetCommand: Command = {
  name: 'reset',
  description: 'Reset the Q-Learning router state',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force reset without confirmation',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'claude-flow route reset', description: 'Reset router state' },
    { command: 'claude-flow route reset --force', description: 'Force reset' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const force = ctx.flags.force as boolean;

    if (!force && ctx.interactive) {
      output.printWarning('This will reset all learned Q-values and statistics.');
      output.writeln(output.dim('Use --force to skip this confirmation.'));
      return { success: false, exitCode: 1 };
    }

    try {
      const router = await getRouter();
      router.reset();
      output.printSuccess('Q-Learning router state has been reset');
      return { success: true };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Export/Import Subcommands
// ============================================================================

const exportCommand: Command = {
  name: 'export',
  description: 'Export Q-table for persistence',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'Output file path (outputs to stdout if not specified)',
      type: 'string',
    },
  ],
  examples: [
    { command: 'claude-flow route export', description: 'Export Q-table to stdout' },
    { command: 'claude-flow route export -f qtable.json', description: 'Export to file' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const filePath = ctx.flags.file as string | undefined;

    try {
      const router = await getRouter();
      const data = router.export();

      if (filePath) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        output.printSuccess(`Q-table exported to ${filePath}`);
      } else {
        output.printJson(data);
      }

      return { success: true, data };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

const importCommand: Command = {
  name: 'import',
  description: 'Import Q-table from file',
  options: [
    {
      name: 'file',
      short: 'f',
      description: 'Input file path',
      type: 'string',
      required: true,
    },
  ],
  examples: [
    { command: 'claude-flow route import -f qtable.json', description: 'Import Q-table from file' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const filePath = ctx.flags.file as string;

    if (!filePath) {
      output.printError('File path is required');
      return { success: false, exitCode: 1 };
    }

    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      const router = await getRouter();
      router.import(data);

      output.printSuccess(`Q-table imported from ${filePath}`);
      output.writeln(output.dim(`Loaded ${Object.keys(data).length} state entries`));

      return { success: true };
    } catch (error) {
      output.printError(error instanceof Error ? error.message : String(error));
      return { success: false, exitCode: 1 };
    }
  },
};

// ============================================================================
// Main Route Command
// ============================================================================

export const routeCommand: Command = {
  name: 'route',
  description: 'Intelligent task-to-agent routing using Q-Learning',
  subcommands: [
    routeTaskCommand,
    listAgentsCommand,
    statsCommand,
    feedbackCommand,
    resetCommand,
    exportCommand,
    importCommand,
  ],
  options: [
    {
      name: 'q-learning',
      short: 'q',
      description: 'Use Q-Learning for agent selection',
      type: 'boolean',
      default: true,
    },
    {
      name: 'agent',
      short: 'a',
      description: 'Force specific agent',
      type: 'string',
    },
  ],
  examples: [
    { command: 'claude-flow route "implement feature"', description: 'Route task to best agent' },
    { command: 'claude-flow route "write tests" --q-learning', description: 'Use Q-Learning routing' },
    { command: 'claude-flow route --agent coder "fix bug"', description: 'Force specific agent' },
    { command: 'claude-flow route list-agents', description: 'List available agents' },
    { command: 'claude-flow route stats', description: 'Show routing statistics' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // If task description provided directly, route it
    if (ctx.args.length > 0 && routeTaskCommand.action) {
      const result = await routeTaskCommand.action(ctx);
      if (result) return result;
      return { success: true };
    }

    // Show help
    output.writeln();
    output.writeln(output.bold('Q-Learning Agent Router'));
    output.writeln(output.dim('Intelligent task-to-agent routing using reinforcement learning'));
    output.writeln();

    output.writeln('Usage: claude-flow route <task> [options]');
    output.writeln('       claude-flow route <subcommand>');
    output.writeln();

    output.writeln(output.bold('Subcommands:'));
    output.printList([
      `${output.highlight('task')}         - Route a task to optimal agent`,
      `${output.highlight('list-agents')}  - List available agent types`,
      `${output.highlight('stats')}        - Show router statistics`,
      `${output.highlight('feedback')}     - Provide routing feedback`,
      `${output.highlight('reset')}        - Reset router state`,
      `${output.highlight('export')}       - Export Q-table`,
      `${output.highlight('import')}       - Import Q-table`,
    ]);
    output.writeln();

    output.writeln(output.bold('How It Works:'));
    output.printList([
      'Analyzes task description using hash-based state encoding',
      'Uses Q-Learning to learn from routing outcomes',
      'Epsilon-greedy exploration for continuous improvement',
      'Provides confidence scores and alternatives',
    ]);
    output.writeln();

    // Show quick status
    const ruvectorAvailable = await isRuvectorAvailable();

    output.writeln(output.bold('Backend Status:'));
    output.printList([
      `RuVector: ${ruvectorAvailable ? output.success('Available') : output.warning('Fallback mode')}`,
      `Backend: ${ruvectorAvailable ? 'ruvector-native' : 'JavaScript fallback'}`,
    ]);
    output.writeln();

    output.writeln(output.dim('Run "claude-flow route <subcommand> --help" for more info'));

    return { success: true };
  },
};

export default routeCommand;
