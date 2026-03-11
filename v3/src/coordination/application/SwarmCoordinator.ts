/**
 * SwarmCoordinator
 *
 * Coordinates multi-agent swarms with support for hierarchical and mesh topologies.
 * Based on agentic-flow's AttentionCoordinator pattern.
 */

import { EventEmitter } from 'events';
import { Agent } from '../../agent-lifecycle/domain/Agent';
import { Task } from '../../task-execution/domain/Task';
import type {
  AgentConfig,
  AgentMessage,
  AgentMetrics,
  ConsensusDecision,
  ConsensusResult,
  MeshConnection,
  MemoryBackend,
  PluginManagerInterface,
  SwarmConfig,
  SwarmHierarchy,
  SwarmState,
  SwarmTopology,
  Task as ITask,
  TaskAssignment,
  TaskResult
} from '../../shared/types';

export interface SwarmCoordinatorOptions extends SwarmConfig {
  topology: SwarmTopology;
  memoryBackend?: MemoryBackend;
  eventBus?: EventEmitter;
  pluginManager?: PluginManagerInterface;
}

export class SwarmCoordinator {
  private topology: SwarmTopology;
  private agents: Map<string, Agent>;
  private memoryBackend?: MemoryBackend;
  private eventBus: EventEmitter;
  private pluginManager?: PluginManagerInterface;
  private agentMetrics: Map<string, AgentMetrics>;
  private connections: MeshConnection[];
  private initialized: boolean = false;

  constructor(options: SwarmCoordinatorOptions) {
    this.topology = options.topology;
    this.memoryBackend = options.memoryBackend;
    this.eventBus = options.eventBus || new EventEmitter();
    this.pluginManager = options.pluginManager;
    this.agents = new Map();
    this.agentMetrics = new Map();
    this.connections = [];
  }

  /**
   * Initialize the coordinator
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
  }

  /**
   * Shutdown the coordinator
   */
  async shutdown(): Promise<void> {
    // Terminate all agents
    for (const agent of this.agents.values()) {
      agent.terminate();
    }
    this.agents.clear();
    this.connections = [];
    this.agentMetrics.clear();
    this.initialized = false;
  }

  /**
   * Spawn a new agent
   */
  async spawnAgent(config: AgentConfig): Promise<Agent> {
    const agent = new Agent(config);
    this.agents.set(agent.id, agent);

    // Initialize metrics
    this.agentMetrics.set(agent.id, {
      agentId: agent.id,
      tasksCompleted: 0,
      tasksFailed: 0,
      averageExecutionTime: 0,
      successRate: 1.0,
      health: 'healthy'
    });

    // Create connections based on topology
    this.updateConnections(agent);

    // Emit spawn event
    this.eventBus.emit('agent:spawned', { agentId: agent.id, type: agent.type });

    // Store in memory if backend available
    if (this.memoryBackend) {
      await this.memoryBackend.store({
        id: `agent-spawn-${agent.id}`,
        agentId: 'system',
        content: `Agent ${agent.id} spawned`,
        type: 'event',
        timestamp: Date.now(),
        metadata: { eventType: 'agent-spawn', agentId: agent.id, agentType: agent.type }
      });
    }

    return agent;
  }

  /**
   * List all agents
   */
  async listAgents(): Promise<Agent[]> {
    return Array.from(this.agents.values());
  }

  /**
   * Terminate an agent
   */
  async terminateAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.terminate();
      this.agents.delete(agentId);
      this.agentMetrics.delete(agentId);

      // Remove connections
      this.connections = this.connections.filter(
        c => c.from !== agentId && c.to !== agentId
      );

      this.eventBus.emit('agent:terminated', { agentId });
    }
  }

  /**
   * Distribute tasks across agents
   */
  async distributeTasks(tasks: ITask[]): Promise<TaskAssignment[]> {
    const assignments: TaskAssignment[] = [];
    const agentLoads = new Map<string, number>();

    // Initialize load counts
    for (const agent of this.agents.values()) {
      agentLoads.set(agent.id, 0);
    }

    // Sort tasks by priority
    const sortedTasks = Task.sortByPriority(tasks.map(t => new Task(t)));

    for (const task of sortedTasks) {
      // Find suitable agents
      const suitableAgents = Array.from(this.agents.values()).filter(agent =>
        agent.canExecute(task.type) && agent.status === 'active'
      );

      if (suitableAgents.length === 0) continue;

      // Load balance: assign to agent with lowest load
      let bestAgent = suitableAgents[0];
      let lowestLoad = agentLoads.get(bestAgent.id) || 0;

      for (const agent of suitableAgents) {
        const load = agentLoads.get(agent.id) || 0;
        if (load < lowestLoad) {
          lowestLoad = load;
          bestAgent = agent;
        }
      }

      assignments.push({
        taskId: task.id,
        agentId: bestAgent.id,
        assignedAt: Date.now(),
        priority: task.priority
      });

      agentLoads.set(bestAgent.id, (agentLoads.get(bestAgent.id) || 0) + 1);
    }

    return assignments;
  }

  /**
   * Execute a task on a specific agent
   */
  async executeTask(agentId: string, task: ITask): Promise<TaskResult> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return {
        taskId: task.id,
        status: 'failed',
        error: `Agent ${agentId} not found`,
        agentId
      };
    }

    const startTime = Date.now();
    let result: TaskResult;

    try {
      result = await agent.executeTask(task);
    } catch (error) {
      // Normalize rejected executions into a failed TaskResult so callers
      // never observe unhandled promise rejections.
      result = {
        taskId: task.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        agentId
      };
    }

    const duration = Date.now() - startTime;

    // Ensure duration is populated even for synthesized failure results.
    if (typeof result.duration !== 'number') {
      result.duration = duration;
    }

    // Update metrics
    const metrics = this.agentMetrics.get(agentId);
    if (metrics) {
      if (result.status === 'completed') {
        metrics.tasksCompleted++;
      } else {
        metrics.tasksFailed = (metrics.tasksFailed || 0) + 1;
      }
      const total = metrics.tasksCompleted + (metrics.tasksFailed || 0);
      metrics.successRate = metrics.tasksCompleted / total;
      metrics.averageExecutionTime =
        (metrics.averageExecutionTime * (total - 1) + duration) / total;
    }

    // Store result in memory
    if (this.memoryBackend) {
      await this.memoryBackend.store({
        id: `task-result-${task.id}`,
        agentId,
        content: `Task ${task.id} ${result.status}`,
        type: result.status === 'completed' ? 'task-complete' : 'event',
        timestamp: Date.now(),
        metadata: {
          taskId: task.id,
          status: result.status,
          duration,
          error: result.error
        }
      });
    }

    return result;
  }

  /**
   * Execute multiple tasks concurrently
   */
  async executeTasksConcurrently(tasks: ITask[]): Promise<TaskResult[]> {
    const assignments = await this.distributeTasks(tasks);
    const results = await Promise.all(
      assignments.map(async assignment => {
        const task = tasks.find(t => t.id === assignment.taskId);
        if (!task) {
          return {
            taskId: assignment.taskId,
            status: 'failed' as const,
            error: 'Task not found'
          };
        }
        return this.executeTask(assignment.agentId, task);
      })
    );
    return results;
  }

  /**
   * Send a message between agents
   */
  async sendMessage(message: AgentMessage): Promise<void> {
    const enhancedMessage = {
      ...message,
      timestamp: Date.now()
    };

    this.eventBus.emit('agent:message', enhancedMessage);
  }

  /**
   * Get swarm state
   */
  async getSwarmState(): Promise<SwarmState> {
    return {
      agents: Array.from(this.agents.values()),
      topology: this.topology,
      leader: this.getLeader()?.id,
      activeConnections: this.connections.length
    };
  }

  /**
   * Get current topology
   */
  getTopology(): SwarmTopology {
    return this.topology;
  }

  /**
   * Get swarm hierarchy (for hierarchical topology)
   */
  async getHierarchy(): Promise<SwarmHierarchy> {
    const leader = this.getLeader();
    const workers = Array.from(this.agents.values())
      .filter(a => a.role !== 'leader')
      .map(a => ({ id: a.id, parent: a.parent || leader?.id || '' }));

    return {
      leader: leader?.id || '',
      workers
    };
  }

  /**
   * Get mesh connections
   */
  async getMeshConnections(): Promise<MeshConnection[]> {
    return this.connections;
  }

  /**
   * Scale agents
   */
  async scaleAgents(config: { type: string; count: number }): Promise<void> {
    const existingOfType = Array.from(this.agents.values()).filter(
      a => a.type === config.type
    );

    const currentCount = existingOfType.length;
    const targetCount = Math.max(0, config.count);

    if (targetCount === currentCount) {
      return;
    }

    if (targetCount > currentCount) {
      // Scale up to the target absolute count
      const toAdd = targetCount - currentCount;
      for (let i = 0; i < toAdd; i++) {
        await this.spawnAgent({
          id: `${config.type}-${Date.now()}-${currentCount + i}`,
          type: config.type,
          capabilities: this.getDefaultCapabilities(config.type)
        });
      }
    } else {
      // Scale down to the target absolute count
      const toRemoveCount = currentCount - targetCount;
      const toRemove = existingOfType.slice(0, toRemoveCount);
      for (const agent of toRemove) {
        await this.terminateAgent(agent.id);
      }
    }
  }

  /**
   * Reach consensus among agents.
   *
   * @experimental This is a stub — real consensus requires LLM integration
   * or a deterministic voting protocol. Do not rely on the current return
   * value for production decisions.
   */
  async reachConsensus(
    _decision: ConsensusDecision,
    _agentIds: string[]
  ): Promise<ConsensusResult> {
    throw new Error(
      'Not implemented: consensus requires LLM integration or a deterministic voting protocol'
    );
  }

  /**
   * Resolve task dependencies
   */
  async resolveTaskDependencies(tasks: ITask[]): Promise<ITask[]> {
    return Task.resolveExecutionOrder(tasks.map(t => new Task(t)));
  }

  /**
   * Get agent metrics
   */
  async getAgentMetrics(agentId: string): Promise<AgentMetrics> {
    const metrics = this.agentMetrics.get(agentId);
    if (!metrics) {
      return {
        agentId,
        tasksCompleted: 0,
        averageExecutionTime: 0,
        successRate: 0,
        health: 'unhealthy'
      };
    }
    return metrics;
  }

  /**
   * Reconfigure the swarm
   */
  async reconfigure(config: { topology: SwarmTopology }): Promise<void> {
    this.topology = config.topology;

    // Rebuild connections based on new topology
    this.connections = [];
    for (const agent of this.agents.values()) {
      this.updateConnections(agent);
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private getLeader(): Agent | undefined {
    return Array.from(this.agents.values()).find(a => a.role === 'leader');
  }

  private updateConnections(agent: Agent): void {
    if (this.topology === 'mesh') {
      // In mesh, connect to all other agents (deduplicate using sorted pair key)
      for (const other of this.agents.values()) {
        if (other.id !== agent.id) {
          const pairKey = [agent.id, other.id].sort().join('::');
          const exists = this.connections.some(c => {
            const existingKey = [c.from, c.to].sort().join('::');
            return existingKey === pairKey;
          });
          if (!exists) {
            this.connections.push({
              from: agent.id,
              to: other.id,
              type: 'peer'
            });
          }
        }
      }
    } else if (this.topology === 'hierarchical') {
      // In hierarchical, connect workers to leader (deduplicate)
      const leader = this.getLeader();
      if (leader && agent.role !== 'leader') {
        const exists = this.connections.some(
          c => c.from === agent.id && c.to === leader.id
        );
        if (!exists) {
          this.connections.push({
            from: agent.id,
            to: leader.id,
            type: 'leader'
          });
        }
      }
    }
  }

  private getDefaultCapabilities(type: string): string[] {
    const defaults: Record<string, string[]> = {
      coder: ['code', 'refactor', 'debug'],
      tester: ['test', 'validate', 'e2e'],
      reviewer: ['review', 'analyze', 'security-audit'],
      coordinator: ['coordinate', 'manage', 'orchestrate'],
      designer: ['design', 'prototype'],
      deployer: ['deploy', 'release']
    };
    return defaults[type] || [];
  }
}

export { SwarmCoordinator as default };
