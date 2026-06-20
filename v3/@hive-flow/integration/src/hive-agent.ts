/**
 * HiveAgent - local Hive Flow agent lifecycle implementation.
 *
 * This module owns the local agent contract used by integration workers. It is
 * intentionally self-contained and has no optional external-agent delegation.
 *
 * @module v3/integration/hive-agent
 * @version 3.0.0
 */

import { EventEmitter } from 'node:events';
import type { AgentStatus, Task, TaskResult, Message } from './worker-task-types.js';

export type { AgentStatus, Task, TaskResult, Message } from './worker-task-types.js';

export type AgentType =
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'researcher'
  | 'planner'
  | 'architect'
  | 'coordinator'
  | 'security'
  | 'performance'
  | 'custom';

export interface IAgentConfig {
  readonly id: string;
  readonly name: string;
  readonly type: AgentType | string;
  capabilities: string[];
  maxConcurrentTasks: number;
  priority: number;
  timeout?: number;
  retryPolicy?: {
    maxRetries: number;
    backoffMs: number;
    backoffMultiplier: number;
  };
  resources?: {
    maxMemoryMb?: number;
    maxCpuPercent?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface IAgent {
  readonly id: string;
  readonly name: string;
  readonly type: AgentType | string;
  readonly config: IAgentConfig;
  readonly createdAt: Date;
  status: AgentStatus;
  currentTaskCount: number;
  lastActivity: Date;
  sessionId?: string;
  terminalId?: string;
  memoryBankId?: string;
  metrics?: {
    tasksCompleted: number;
    tasksFailed: number;
    avgTaskDuration: number;
    errorCount: number;
    uptime: number;
  };
  health?: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    lastCheck: Date;
    issues?: string[];
  };
}

export interface IAgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly startTime: Date;
  status: 'active' | 'idle' | 'terminated';
  terminalId: string;
  memoryBankId: string;
  lastActivity: Date;
  endTime?: Date;
  metadata?: Record<string, unknown>;
}

export interface AgentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastCheck: number;
  issues: string[];
  metrics: {
    uptime: number;
    tasksCompleted: number;
    tasksFailed: number;
    avgLatency: number;
    memoryUsageMb: number;
    cpuPercent: number;
  };
}

export interface HiveAgentConfig extends IAgentConfig {}

export class HiveAgent extends EventEmitter implements IAgent {
  readonly id: string;
  readonly name: string;
  readonly type: AgentType | string;
  readonly config: IAgentConfig;
  readonly createdAt: Date;

  status: AgentStatus = 'spawning';
  currentTaskCount = 0;
  lastActivity: Date;

  sessionId?: string;
  terminalId?: string;
  memoryBankId?: string;

  metrics?: {
    tasksCompleted: number;
    tasksFailed: number;
    avgTaskDuration: number;
    errorCount: number;
    uptime: number;
  };

  health?: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    lastCheck: Date;
    issues?: string[];
  };

  private initialized = false;
  private currentTask: Task | null = null;
  private taskStartTime = 0;
  private totalTaskDuration = 0;

  constructor(config: HiveAgentConfig) {
    super();

    if (!config.id || !config.name || !config.type) {
      throw new Error('Agent config must include id, name, and type');
    }

    this.id = config.id;
    this.name = config.name;
    this.type = config.type;
    this.config = config;
    this.createdAt = new Date();
    this.lastActivity = new Date();

    this.metrics = {
      tasksCompleted: 0,
      tasksFailed: 0,
      avgTaskDuration: 0,
      errorCount: 0,
      uptime: 0,
    };

    this.health = {
      status: 'healthy',
      lastCheck: new Date(),
      issues: [],
    };

    this.emit('created', { agentId: this.id, type: this.type });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.emit('initializing', { agentId: this.id });

    try {
      await this.localInitialize();

      this.status = 'idle';
      this.initialized = true;
      this.lastActivity = new Date();

      this.emit('initialized', { agentId: this.id, status: this.status });
    } catch (error) {
      this.status = 'error';
      if (this.health) {
        this.health.status = 'unhealthy';
        (this.health.issues ??= []).push(`Initialization failed: ${(error as Error).message}`);
      }

      this.emit('initialization-failed', {
        agentId: this.id,
        error: error as Error,
      });

      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.emit('shutting-down', { agentId: this.id });

    try {
      if (this.currentTask) {
        this.emit('task-cancelled', {
          agentId: this.id,
          taskId: this.currentTask.id,
        });
        this.currentTask = null;
      }

      await this.localShutdown();

      this.status = 'terminated';
      this.initialized = false;
      this.currentTaskCount = 0;

      this.emit('shutdown', { agentId: this.id });
    } catch (error) {
      this.emit('shutdown-error', {
        agentId: this.id,
        error: error as Error,
      });

      throw error;
    }
  }

  async executeTask(task: Task): Promise<TaskResult> {
    this.ensureInitialized();

    if (this.status === 'terminated' || this.status === 'error') {
      throw new Error(`Agent ${this.id} is not available (status: ${this.status})`);
    }

    if (this.currentTaskCount >= this.config.maxConcurrentTasks) {
      throw new Error(`Agent ${this.id} has reached max concurrent tasks`);
    }

    this.currentTask = task;
    this.currentTaskCount++;
    this.status = 'busy';
    this.taskStartTime = Date.now();
    this.lastActivity = new Date();

    this.emit('task-started', {
      agentId: this.id,
      taskId: task.id,
      taskType: task.type,
    });

    try {
      const output = await this.localExecuteTask(task);
      const duration = Date.now() - this.taskStartTime;

      if (this.metrics) {
        this.metrics.tasksCompleted++;
        this.totalTaskDuration += duration;
        this.metrics.avgTaskDuration = this.totalTaskDuration / this.metrics.tasksCompleted;
      }

      const result: TaskResult = {
        taskId: task.id,
        success: true,
        output,
        duration,
      };

      this.emit('task-completed', {
        agentId: this.id,
        taskId: task.id,
        duration,
        success: true,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - this.taskStartTime;

      if (this.metrics) {
        this.metrics.tasksFailed++;
        this.metrics.errorCount++;
      }

      const result: TaskResult = {
        taskId: task.id,
        success: false,
        error: error as Error,
        duration,
      };

      this.emit('task-failed', {
        agentId: this.id,
        taskId: task.id,
        error: error as Error,
        duration,
      });

      return result;
    } finally {
      this.currentTask = null;
      this.currentTaskCount--;
      this.status = this.currentTaskCount > 0 ? 'busy' : 'idle';
      this.lastActivity = new Date();
    }
  }

  async sendMessage(to: string, message: Message): Promise<void> {
    this.ensureInitialized();

    this.emit('message-sending', {
      from: this.id,
      to,
      messageId: message.id,
    });

    try {
      this.emit('message-send', { from: this.id, to, message });

      this.emit('message-sent', {
        from: this.id,
        to,
        messageId: message.id,
      });
    } catch (error) {
      this.emit('message-send-failed', {
        from: this.id,
        to,
        messageId: message.id,
        error: error as Error,
      });

      throw error;
    }
  }

  async broadcastMessage(message: Message): Promise<void> {
    this.ensureInitialized();

    this.emit('message-broadcasting', {
      from: this.id,
      messageId: message.id,
    });

    this.emit('message-broadcast', { from: this.id, message });

    this.emit('message-broadcasted', {
      from: this.id,
      messageId: message.id,
    });
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getHealth(): AgentHealth {
    const uptime = Date.now() - this.createdAt.getTime();

    const metricsData = this.metrics ?? {
      tasksCompleted: 0,
      tasksFailed: 0,
      avgTaskDuration: 0,
      errorCount: 0,
      uptime: 0,
    };
    metricsData.uptime = uptime;

    const healthData = this.health ?? {
      status: 'healthy' as const,
      lastCheck: new Date(),
      issues: [],
    };

    const totalTasks = metricsData.tasksCompleted + metricsData.tasksFailed;
    const errorRate = totalTasks > 0 ? metricsData.tasksFailed / totalTasks : 0;

    if (errorRate > 0.5) {
      healthData.status = 'unhealthy';
    } else if (errorRate > 0.2) {
      healthData.status = 'degraded';
    } else {
      healthData.status = 'healthy';
    }

    healthData.lastCheck = new Date();

    return {
      status: healthData.status,
      lastCheck: Date.now(),
      issues: healthData.issues || [],
      metrics: {
        uptime,
        tasksCompleted: metricsData.tasksCompleted,
        tasksFailed: metricsData.tasksFailed,
        avgLatency: metricsData.avgTaskDuration,
        memoryUsageMb: this.estimateMemoryUsage(),
        cpuPercent: 0,
      },
    };
  }

  private async localInitialize(): Promise<void> {
    if (!this.sessionId) {
      this.sessionId = this.generateId('session');
    }

    if (!this.memoryBankId) {
      this.memoryBankId = this.generateId('memory');
    }
  }

  private async localShutdown(): Promise<void> {
    this.currentTask = null;
    this.currentTaskCount = 0;
  }

  protected async localExecuteTask(task: Task): Promise<unknown> {
    return {
      message: `Task ${task.id} processed by agent ${this.id}`,
      input: task.input,
      timestamp: Date.now(),
    };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`Agent ${this.id} not initialized. Call initialize() first.`);
    }
  }

  private estimateMemoryUsage(): number {
    return 1 + ((this.metrics?.tasksCompleted ?? 0) * 0.1);
  }

  private generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}

export async function createHiveAgent(config: HiveAgentConfig): Promise<HiveAgent> {
  const agent = new HiveAgent(config);
  await agent.initialize();
  return agent;
}
