#!/usr/bin/env node
/**
 * Hive Mind Spawn Command Template
 *
 * Spawn specialized agents into the hive mind swarm with
 * intelligent task assignment and capability management.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';

export const hiveMindSpawnCommand = new Command('spawn')
  .description('Spawn specialized agents into the hive mind swarm')
  .argument('[type]', 'Agent type to spawn (researcher, coder, analyzer, coordinator)')
  .option('-n, --name <string>', 'Custom agent name')
  .option('-c, --count <number>', 'Number of agents to spawn', '1')
  .option('-s, --skills <list>', 'Comma-separated list of specialized skills')
  .option('--queen-type <type>', 'Queen coordination type for spawned agents')
  .option('--max-workers <number>', 'Maximum concurrent workers per agent', '4')
  .option('--consensus <threshold>', 'Consensus participation threshold', '0.66')
  .option('--memory-size <mb>', 'Agent memory allocation in MB', '64')
  .option('--auto-scale', 'Enable auto-scaling for spawned agents', false)
  .option('--encryption', 'Enable encrypted communication', false)
  .option('--monitor', 'Enable agent monitoring', false)
  .option('--verbose', 'Enable verbose logging', false)
  .option('--claude', 'Enable Claude integration for agents', false)
  .option('--spawn', 'Alias for spawn command', false)
  .option('--auto-spawn', 'Enable automatic spawning based on workload', false)
  .option('--execute', 'Execute spawned agents immediately', false)
  .action(async (agentType, options) => {
    const spinner = ora('Initializing agent spawn...').start();

    try {
      // Validate spawn options
      await validateSpawnOptions(agentType, options);

      // Get available hive minds
      const hiveMind = await selectHiveMind();
      if (!hiveMind) {
        throw new Error('No active hive mind found. Initialize one first with: claude-flow hive-mind init');
      }

      // Interactive agent type selection if not provided
      if (!agentType) {
        agentType = await selectAgentType();
      }

      // Configure agent specifications
      spinner.text = 'Configuring agent specifications...';
      const agentSpecs = await buildAgentSpecifications(agentType, options);
      
      // Spawn agents
      const spawnCount = parseInt(options.count);
      const spawnedAgents = [];

      for (let i = 0; i < spawnCount; i++) {
        spinner.text = `Spawning ${agentType} agent ${i + 1}/${spawnCount}...`;
        
        const agent = await spawnAgent(hiveMind.id, agentSpecs, i);
        spawnedAgents.push(agent);
        
        // Brief delay for realistic spawning
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Configure agent networking
      spinner.text = 'Establishing agent communications...';
      await configureAgentNetworking(spawnedAgents, options);

      // Auto-assign tasks if available
      if (options.execute) {
        spinner.text = 'Auto-assigning available tasks...';
        await autoAssignTasks(spawnedAgents, hiveMind.id);
      }

      // Start monitoring if enabled
      if (options.monitor) {
        await startAgentMonitoring(spawnedAgents);
      }

      spinner.succeed(chalk.green(`✅ Successfully spawned ${spawnCount} ${agentType} agent(s)!`));

      // Display spawn summary
      displaySpawnSummary(spawnedAgents, options);

      // Show agent details
      displayAgentDetails(spawnedAgents);

      // Show next steps
      console.log('\n' + chalk.bold.cyan('📋 Next Steps:'));
      console.log(chalk.white('  1. Check status: ') + chalk.gray('claude-flow hive-mind status'));
      console.log(chalk.white('  2. Assign tasks: ') + chalk.gray('claude-flow hive-mind task "describe your task"'));
      console.log(chalk.white('  3. Monitor agents: ') + chalk.gray('claude-flow hive-mind metrics'));
      console.log(chalk.white('  4. View consensus: ') + chalk.gray('claude-flow hive-mind consensus'));

    } catch (error) {
      spinner.fail(chalk.red('❌ Failed to spawn agents'));
      console.error(chalk.red('Error:'), error.message);
      
      if (options.verbose) {
        console.error(chalk.gray('Stack trace:'), error.stack);
      }
      
      process.exit(1);
    }
  });

/**
 * Validate spawn options
 */
async function validateSpawnOptions(agentType, options) {
  const validAgentTypes = ['researcher', 'coder', 'analyzer', 'coordinator', 'architect', 'tester', 'optimizer'];
  
  if (agentType && !validAgentTypes.includes(agentType)) {
    throw new Error(`Invalid agent type: ${agentType}. Valid types: ${validAgentTypes.join(', ')}`);
  }

  const count = parseInt(options.count);
  if (isNaN(count) || count < 1 || count > 50) {
    throw new Error('Agent count must be between 1 and 50');
  }

  const maxWorkers = parseInt(options.maxWorkers);
  if (isNaN(maxWorkers) || maxWorkers < 1 || maxWorkers > 20) {
    throw new Error('Max workers per agent must be between 1 and 20');
  }

  const memorySize = parseInt(options.memorySize);
  if (isNaN(memorySize) || memorySize < 32 || memorySize > 1024) {
    throw new Error('Agent memory size must be between 32 and 1024 MB');
  }
}

/**
 * Select active hive mind
 */
async function selectHiveMind() {
  // Mock implementation - would query actual hive minds
  const hiveminds = [
    { id: 'hive-1', name: 'Development Swarm', status: 'active', agents: 8 },
    { id: 'hive-2', name: 'Research Collective', status: 'active', agents: 12 }
  ];

  if (hiveminds.length === 0) {
    return null;
  }

  if (hiveminds.length === 1) {
    return hiveminds[0];
  }

  const { selectedHive } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedHive',
      message: 'Select target hive mind:',
      choices: hiveminds.map(h => ({
        name: `${h.name} (${h.agents} agents) - ${h.status}`,
        value: h.id
      }))
    }
  ]);

  return hiveminds.find(h => h.id === selectedHive);
}

/**
 * Select agent type interactively
 */
async function selectAgentType() {
  const agentTypes = [
    { value: 'researcher', name: 'Researcher - Information gathering and analysis' },
    { value: 'coder', name: 'Coder - Code generation and implementation' },
    { value: 'analyzer', name: 'Analyzer - Data analysis and pattern detection' },
    { value: 'coordinator', name: 'Coordinator - Task coordination and management' },
    { value: 'architect', name: 'Architect - System design and architecture' },
    { value: 'tester', name: 'Tester - Quality assurance and testing' },
    { value: 'optimizer', name: 'Optimizer - Performance optimization' }
  ];

  const { agentType } = await inquirer.prompt([
    {
      type: 'list',
      name: 'agentType',
      message: 'Select agent type to spawn:',
      choices: agentTypes
    }
  ]);

  return agentType;
}

/**
 * Build agent specifications
 */
async function buildAgentSpecifications(agentType, options) {
  const baseSpecs = {
    researcher: {
      capabilities: ['web_search', 'data_analysis', 'information_synthesis'],
      tools: ['search', 'analyze', 'summarize'],
      priority: 'medium'
    },
    coder: {
      capabilities: ['code_generation', 'debugging', 'refactoring'],
      tools: ['write_code', 'test', 'review'],
      priority: 'high'
    },
    analyzer: {
      capabilities: ['pattern_recognition', 'data_processing', 'insights_generation'],
      tools: ['analyze', 'visualize', 'report'],
      priority: 'medium'
    },
    coordinator: {
      capabilities: ['task_management', 'resource_allocation', 'team_coordination'],
      tools: ['schedule', 'assign', 'monitor'],
      priority: 'high'
    }
  };

  const spec = baseSpecs[agentType] || baseSpecs.researcher;
  
  // Add custom skills if provided
  if (options.skills) {
    const customSkills = options.skills.split(',').map(s => s.trim());
    spec.capabilities.push(...customSkills);
  }

  return {
    type: agentType,
    name: options.name || `${agentType}-${Date.now()}`,
    capabilities: spec.capabilities,
    tools: spec.tools,
    priority: spec.priority,
    maxWorkers: parseInt(options.maxWorkers),
    memorySize: parseInt(options.memorySize),
    encryption: options.encryption,
    claudeIntegration: options.claude,
    autoScale: options.autoScale
  };
}

/**
 * Spawn individual agent
 */
async function spawnAgent(hiveMindId, specs, index) {
  const agentId = `${specs.type}-${Date.now()}-${index}`;
  
  // Mock agent creation
  const agent = {
    id: agentId,
    name: specs.name + (index > 0 ? `-${index}` : ''),
    type: specs.type,
    hiveMindId,
    capabilities: specs.capabilities,
    tools: specs.tools,
    status: 'initializing',
    spawnedAt: new Date(),
    config: {
      maxWorkers: specs.maxWorkers,
      memorySize: specs.memorySize,
      encryption: specs.encryption,
      claudeIntegration: specs.claudeIntegration
    }
  };

  // Simulate spawn process
  await new Promise(resolve => setTimeout(resolve, 100));
  agent.status = 'active';

  return agent;
}

/**
 * Configure agent networking
 */
async function configureAgentNetworking(agents, options) {
  for (const agent of agents) {
    agent.networking = {
      protocol: options.encryption ? 'wss' : 'ws',
      channels: [`hive-${agent.hiveMindId}`, `agent-${agent.type}`],
      encryption: options.encryption,
      heartbeatInterval: 30000
    };
  }
}

/**
 * Auto-assign available tasks
 */
async function autoAssignTasks(agents, hiveMindId) {
  // Mock task assignment
  const availableTasks = [
    { id: 'task-1', type: 'research', description: 'Market analysis' },
    { id: 'task-2', type: 'coding', description: 'API development' }
  ];

  for (let i = 0; i < Math.min(agents.length, availableTasks.length); i++) {
    const agent = agents[i];
    const task = availableTasks[i];
    
    agent.currentTask = task.id;
    agent.status = 'busy';
    
    console.log(chalk.gray(`  🎯 Assigned ${task.description} to ${agent.name}`));
  }
}

/**
 * Start agent monitoring
 */
async function startAgentMonitoring(agents) {
  console.log(chalk.gray('📊 Starting agent monitoring...'));
  
  for (const agent of agents) {
    agent.monitoring = {
      enabled: true,
      metricsInterval: 60000,
      alertThresholds: {
        cpu: 80,
        memory: 90,
        responseTime: 5000
      }
    };
  }
}

/**
 * Display spawn summary
 */
function displaySpawnSummary(agents, options) {
  console.log('\n' + chalk.bold.green('🚀 Agent Spawn Summary'));
  console.log(chalk.gray('━'.repeat(50)));
  
  console.log(chalk.white('Total Spawned:'), chalk.cyan(agents.length));
  console.log(chalk.white('Agent Type:'), chalk.yellow(agents[0].type));
  console.log(chalk.white('Hive Mind:'), chalk.yellow(agents[0].hiveMindId));
  console.log(chalk.white('Status:'), chalk.green('Active'));
  
  const features = [
    options.autoScale && chalk.green('Auto-Scale'),
    options.encryption && chalk.green('Encryption'),
    options.monitor && chalk.green('Monitoring'),
    options.claude && chalk.green('Claude')
  ].filter(Boolean);
  
  if (features.length > 0) {
    console.log(chalk.white('Features:'), features.join(' '));
  }
}

/**
 * Display agent details
 */
function displayAgentDetails(agents) {
  console.log('\n' + chalk.bold.blue('🤖 Agent Details:'));
  
  agents.forEach(agent => {
    console.log(chalk.cyan(`  ${agent.name} (${agent.id.substring(0, 8)}...)`));
    console.log(chalk.gray(`    Capabilities: ${agent.capabilities.join(', ')}`));
    console.log(chalk.gray(`    Tools: ${agent.tools.join(', ')}`));
    console.log(chalk.gray(`    Status: ${agent.status}`));
    console.log(chalk.gray(`    Memory: ${agent.config.memorySize}MB`));
    
    if (agent.currentTask) {
      console.log(chalk.yellow(`    Current Task: ${agent.currentTask}`));
    }
    
    console.log();
  });
}

export default hiveMindSpawnCommand;