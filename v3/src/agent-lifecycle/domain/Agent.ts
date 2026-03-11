/**
 * Agent Domain Entity
 *
 * Represents an AI agent in the V3 system
 */

import type {
  Agent as IAgent,
  AgentConfig,
  AgentStatus,
  AgentType,
  AgentRole,
  Task,
  TaskResult
} from '../../shared/types';

export class Agent implements IAgent {
  public readonly id: string;
  public readonly type: AgentType;
  public status: AgentStatus;
  public capabilities: string[];
  public role?: AgentRole;
  public parent?: string;
  public metadata?: Record<string, unknown>;
  public createdAt: number;
  public lastActive: number;

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.type = config.type;
    this.status = 'active';
    this.capabilities = config.capabilities || [];
    this.role = config.role;
    this.parent = config.parent;
    this.metadata = config.metadata || {};
    this.createdAt = Date.now();
    this.lastActive = Date.now();
  }

  /**
   * Execute a task assigned to this agent
   */
  async executeTask(task: Task): Promise<TaskResult> {
    if (this.status !== 'active' && this.status !== 'idle') {
      return {
        taskId: task.id,
        status: 'failed',
        error: `Agent ${this.id} is not available (status: ${this.status})`,
        agentId: this.id
      };
    }

    const startTime = Date.now();
    this.status = 'busy';
    this.lastActive = startTime;

    try {
      // Execute task-specific callback if provided
      if (task.onExecute) {
        await task.onExecute();
      }

      // Process task with minimal overhead (actual work done via onExecute callback)
      await this.processTaskExecution(task);

      const duration = Date.now() - startTime;
      this.status = 'active';
      this.lastActive = Date.now();

      return {
        taskId: task.id,
        status: 'completed',
        result: `Task ${task.id} completed successfully`,
        duration,
        agentId: this.id
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.status = 'active';

      return {
        taskId: task.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        duration,
        agentId: this.id
      };
    }
  }

  /**
   * Execute task processing.
   * The actual work is done via task.onExecute() callback;
   * this method is a no-op extension point for subclasses.
   */
  private async processTaskExecution(_task: Task): Promise<void> {
    // No-op — actual task work is performed by onExecute callback.
    // Previously this introduced an artificial 1-10ms setTimeout delay
    // which served no purpose and slowed down tests.
  }

  /**
   * Check if agent has a specific capability
   */
  hasCapability(capability: string): boolean {
    return this.capabilities.includes(capability);
  }

  /**
   * Check if agent can execute a task type
   */
  canExecute(taskType: string): boolean {
    const typeToCapability: Record<string, string> = {
      code: 'code',
      test: 'test',
      review: 'review',
      design: 'design',
      deploy: 'deploy',
      refactor: 'refactor',
      debug: 'debug'
    };

    const requiredCapability = typeToCapability[taskType];
    return requiredCapability ? this.hasCapability(requiredCapability) : true;
  }

  /**
   * Terminate the agent
   */
  terminate(): void {
    this.status = 'terminated';
    this.lastActive = Date.now();
  }

  /**
   * Mark agent as idle
   */
  setIdle(): void {
    if (this.status === 'active' || this.status === 'busy') {
      this.status = 'idle';
      this.lastActive = Date.now();
    }
  }

  /**
   * Activate the agent
   */
  activate(): void {
    if (this.status !== 'terminated') {
      this.status = 'active';
      this.lastActive = Date.now();
    }
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON(): IAgent {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      capabilities: this.capabilities,
      role: this.role,
      parent: this.parent,
      metadata: this.metadata,
      createdAt: this.createdAt,
      lastActive: this.lastActive
    };
  }

  /**
   * Create agent from config
   */
  static fromConfig(config: AgentConfig): Agent {
    return new Agent(config);
  }
}

export { Agent as default };
