#!/usr/bin/env node
/**
 * Hive Mind Status Command Template
 *
 * Display comprehensive status of hive mind systems including
 * agents, tasks, memory usage, and performance metrics.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';

export const hiveMindStatusCommand = new Command('status')
  .description('Show comprehensive hive mind system status')
  .option('-h, --hive-id <id>', 'Specific hive mind ID to check')
  .option('-a, --all', 'Show all hive mind systems', false)
  .option('-d, --detailed', 'Show detailed agent information', false)
  .option('-t, --tasks', 'Show task queue and assignments', false)
  .option('-m, --memory', 'Show memory usage statistics', false)
  .option('-p, --performance', 'Show performance metrics', false)
  .option('-w, --watch', 'Watch status in real-time', false)
  .option('-j, --json', 'Output in JSON format', false)
  .option('--queen-type <type>', 'Filter by queen coordination type')
  .option('--max-workers <number>', 'Filter by maximum worker count')
  .option('--consensus <threshold>', 'Filter by consensus threshold')
  .option('--memory-size <mb>', 'Filter by memory allocation')
  .option('--auto-scale', 'Show only auto-scaling enabled systems', false)
  .option('--encryption', 'Show only encrypted systems', false)
  .option('--monitor', 'Show monitoring status', false)
  .option('--verbose', 'Enable verbose output', false)
  .option('--claude', 'Show Claude integration status', false)
  .option('--spawn', 'Show spawn information', false)
  .option('--auto-spawn', 'Show auto-spawn configuration', false)
  .option('--execute', 'Show execution status', false)
  .action(async (options) => {
    try {
      // Get hive mind systems
      const hiveminds = await getHiveMinds(options);
      
      if (hiveminds.length === 0) {
        console.log(chalk.yellow('⚠️  No hive mind systems found'));
        console.log(chalk.gray('Initialize a hive mind with: claude-flow hive-mind init'));
        return;
      }

      // JSON output
      if (options.json) {
        console.log(JSON.stringify(hiveminds, null, 2));
        return;
      }

      // Display status for each hive mind
      for (const hive of hiveminds) {
        await displayHiveMindStatus(hive, options);
        
        if (hiveminds.length > 1) {
          console.log('\n' + chalk.gray('─'.repeat(80)) + '\n');
        }
      }

      // Watch mode
      if (options.watch) {
        console.log('\n' + chalk.gray('👀 Watching status... (Press Ctrl+C to exit)'));
        
        setInterval(async () => {
          console.clear();
          
          const updatedHives = await getHiveMinds(options);
          for (const hive of updatedHives) {
            await displayHiveMindStatus(hive, options);
          }
          
          console.log(chalk.gray(`\n🕐 Updated: ${new Date().toLocaleTimeString()}`));
        }, 3000);
      }

    } catch (error) {
      console.error(chalk.red('❌ Failed to get hive mind status'));
      console.error(chalk.red('Error:'), error.message);
      
      if (options.verbose) {
        console.error(chalk.gray('Stack trace:'), error.stack);
      }
      
      process.exit(1);
    }
  });

/**
 * Get hive mind systems based on filters
 */
async function getHiveMinds(options) {
  // Mock implementation - would query actual systems
  let hiveminds = [
    {
      id: 'hive-1',
      name: 'Development Swarm',
      queenType: 'hierarchical',
      status: 'active',
      uptime: 14400000, // 4 hours
      maxWorkers: 12,
      currentAgents: 8,
      consensusThreshold: 0.66,
      memorySize: 256,
      autoScale: true,
      encryption: true,
      monitor: true,
      claudeIntegration: true,
      createdAt: new Date(Date.now() - 14400000),
      agents: [
        { id: 'agent-1', name: 'researcher-001', type: 'researcher', status: 'busy', task: 'Market Analysis' },
        { id: 'agent-2', name: 'coder-001', type: 'coder', status: 'active', task: 'API Development' },
        { id: 'agent-3', name: 'analyzer-001', type: 'analyzer', status: 'idle', task: null },
        { id: 'agent-4', name: 'coordinator-001', type: 'coordinator', status: 'busy', task: 'Task Coordination' }
      ],
      tasks: [
        { id: 'task-1', description: 'Market Analysis', status: 'in_progress', agent: 'researcher-001', progress: 75 },
        { id: 'task-2', description: 'API Development', status: 'in_progress', agent: 'coder-001', progress: 50 },
        { id: 'task-3', description: 'Data Processing', status: 'queued', agent: null, progress: 0 }
      ],
      memory: {
        used: 180,
        total: 256,
        fragmentation: 0.15,
        hitRate: 0.85
      },
      performance: {
        tasksCompleted: 45,
        avgCompletionTime: 1800000, // 30 minutes
        throughput: 2.5, // tasks per hour
        consensusSuccess: 0.92,
        uptime: 0.98
      }
    },
    {
      id: 'hive-2',
      name: 'Research Collective',
      queenType: 'distributed',
      status: 'active',
      uptime: 7200000, // 2 hours
      maxWorkers: 8,
      currentAgents: 6,
      consensusThreshold: 0.75,
      memorySize: 128,
      autoScale: false,
      encryption: false,
      monitor: false,
      claudeIntegration: false,
      createdAt: new Date(Date.now() - 7200000),
      agents: [
        { id: 'agent-5', name: 'researcher-002', type: 'researcher', status: 'active', task: null },
        { id: 'agent-6', name: 'analyzer-002', type: 'analyzer', status: 'busy', task: 'Pattern Analysis' }
      ],
      tasks: [
        { id: 'task-4', description: 'Pattern Analysis', status: 'in_progress', agent: 'analyzer-002', progress: 30 }
      ],
      memory: {
        used: 64,
        total: 128,
        fragmentation: 0.05,
        hitRate: 0.78
      },
      performance: {
        tasksCompleted: 12,
        avgCompletionTime: 2400000, // 40 minutes
        throughput: 6.0, // tasks per hour
        consensusSuccess: 0.88,
        uptime: 0.95
      }
    }
  ];

  // Apply filters
  if (options.hiveId) {
    hiveminds = hiveminds.filter(h => h.id === options.hiveId);
  }

  if (options.queenType) {
    hiveminds = hiveminds.filter(h => h.queenType === options.queenType);
  }

  if (options.autoScale) {
    hiveminds = hiveminds.filter(h => h.autoScale);
  }

  if (options.encryption) {
    hiveminds = hiveminds.filter(h => h.encryption);
  }

  if (options.claude) {
    hiveminds = hiveminds.filter(h => h.claudeIntegration);
  }

  return hiveminds;
}

/**
 * Display status for a single hive mind
 */
async function displayHiveMindStatus(hive, options) {
  // Header
  console.log(chalk.bold.cyan(`🐝 ${hive.name}`));
  console.log(chalk.gray(`ID: ${hive.id}`));
  console.log(chalk.gray('━'.repeat(60)));

  // Basic status
  const statusColor = getStatusColor(hive.status);
  const uptimeStr = formatUptime(hive.uptime);
  
  console.log(chalk.white('Status:'), statusColor(hive.status.toUpperCase()));
  console.log(chalk.white('Queen Type:'), chalk.yellow(hive.queenType));
  console.log(chalk.white('Uptime:'), chalk.cyan(uptimeStr));
  console.log(chalk.white('Agents:'), chalk.cyan(`${hive.currentAgents}/${hive.maxWorkers}`));
  console.log(chalk.white('Memory:'), chalk.cyan(`${hive.memory.used}MB/${hive.memory.total}MB (${Math.round(hive.memory.used/hive.memory.total*100)}%)`));

  // Features
  const features = [];
  if (hive.autoScale) features.push(chalk.green('Auto-Scale'));
  if (hive.encryption) features.push(chalk.green('Encryption'));
  if (hive.monitor) features.push(chalk.green('Monitoring'));
  if (hive.claudeIntegration) features.push(chalk.green('Claude'));
  
  if (features.length > 0) {
    console.log(chalk.white('Features:'), features.join(' '));
  }

  // Agents table
  if (options.detailed && hive.agents.length > 0) {
    console.log('\n' + chalk.bold('🤖 Agents:'));
    
    const agentTable = new Table({
      head: ['Name', 'Type', 'Status', 'Current Task'],
      style: { head: ['cyan'] }
    });

    hive.agents.forEach(agent => {
      agentTable.push([
        agent.name,
        agent.type,
        getAgentStatusBadge(agent.status),
        agent.task || chalk.gray('None')
      ]);
    });

    console.log(agentTable.toString());
  }

  // Tasks table
  if ((options.tasks || hive.tasks.length > 0) && hive.tasks.length > 0) {
    console.log('\n' + chalk.bold('📋 Tasks:'));
    
    const taskTable = new Table({
      head: ['ID', 'Description', 'Status', 'Agent', 'Progress'],
      style: { head: ['cyan'] }
    });

    hive.tasks.forEach(task => {
      taskTable.push([
        task.id.substring(0, 8),
        task.description.length > 30 ? task.description.substring(0, 30) + '...' : task.description,
        getTaskStatusBadge(task.status),
        task.agent || chalk.gray('Unassigned'),
        `${task.progress}%`
      ]);
    });

    console.log(taskTable.toString());
  }

  // Memory statistics
  if (options.memory) {
    console.log('\n' + chalk.bold('💾 Memory Statistics:'));
    console.log(chalk.white('  Used:'), chalk.cyan(`${hive.memory.used}MB`));
    console.log(chalk.white('  Total:'), chalk.cyan(`${hive.memory.total}MB`));
    console.log(chalk.white('  Fragmentation:'), chalk.yellow(`${Math.round(hive.memory.fragmentation * 100)}%`));
    console.log(chalk.white('  Hit Rate:'), chalk.green(`${Math.round(hive.memory.hitRate * 100)}%`));
  }

  // Performance metrics
  if (options.performance) {
    console.log('\n' + chalk.bold('📊 Performance Metrics:'));
    console.log(chalk.white('  Tasks Completed:'), chalk.cyan(hive.performance.tasksCompleted));
    console.log(chalk.white('  Avg Completion Time:'), chalk.cyan(formatDuration(hive.performance.avgCompletionTime)));
    console.log(chalk.white('  Throughput:'), chalk.cyan(`${hive.performance.throughput} tasks/hour`));
    console.log(chalk.white('  Consensus Success:'), chalk.green(`${Math.round(hive.performance.consensusSuccess * 100)}%`));
    console.log(chalk.white('  System Uptime:'), chalk.green(`${Math.round(hive.performance.uptime * 100)}%`));
  }

  // Summary stats
  if (!options.detailed && !options.tasks && !options.memory && !options.performance) {
    const activeAgents = hive.agents.filter(a => a.status === 'active' || a.status === 'busy').length;
    const inProgressTasks = hive.tasks.filter(t => t.status === 'in_progress').length;
    
    console.log('\n' + chalk.bold('📈 Quick Stats:'));
    console.log(chalk.white('  Active Agents:'), chalk.green(activeAgents));
    console.log(chalk.white('  Tasks in Progress:'), chalk.blue(inProgressTasks));
    console.log(chalk.white('  Memory Usage:'), chalk.yellow(`${Math.round(hive.memory.used/hive.memory.total*100)}%`));
    console.log(chalk.white('  Consensus Threshold:'), chalk.cyan(`${Math.round(hive.consensusThreshold * 100)}%`));
  }
}

/**
 * Get status color
 */
function getStatusColor(status) {
  const colors = {
    active: chalk.green,
    inactive: chalk.red,
    paused: chalk.yellow,
    error: chalk.red
  };
  return colors[status] || chalk.gray;
}

/**
 * Get agent status badge
 */
function getAgentStatusBadge(status) {
  const badges = {
    active: chalk.green('● Active'),
    busy: chalk.blue('● Busy'),
    idle: chalk.yellow('● Idle'),
    error: chalk.red('● Error')
  };
  return badges[status] || chalk.gray('● Unknown');
}

/**
 * Get task status badge
 */
function getTaskStatusBadge(status) {
  const badges = {
    queued: chalk.gray('⏸ Queued'),
    in_progress: chalk.blue('▶️ In Progress'),
    completed: chalk.green('✅ Completed'),
    failed: chalk.red('❌ Failed')
  };
  return badges[status] || chalk.gray('❓ Unknown');
}

/**
 * Format uptime duration
 */
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Format duration
 */
function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export default hiveMindStatusCommand;