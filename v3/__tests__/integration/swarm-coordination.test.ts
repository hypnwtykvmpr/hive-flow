/**
 * V3 Claude-Flow Swarm Coordination Integration Tests
 *
 * Integration tests for 15-agent swarm coordination
 * Tests end-to-end coordination workflows
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMock, type MockedInterface } from '../helpers/create-mock';
import { createSwarmTestInstance, type V3AgentType } from '../helpers/swarm-instance';
import { swarmConfigs } from '../fixtures/configurations';
import { create15AgentSwarmConfig } from '../fixtures/agents';

/**
 * Swarm coordinator integration interface
 */
interface ISwarmOrchestrator {
  initialize(config: SwarmOrchestratorConfig): Promise<void>;
  spawnAgents(configs: AgentConfig[]): Promise<SpawnResult[]>;
  executeWorkflow(workflow: Workflow): Promise<WorkflowResult>;
  getSwarmStatus(): SwarmStatus;
  shutdown(): Promise<void>;
}

/**
 * Agent spawner interface
 */
interface IAgentSpawner {
  spawn(config: AgentConfig): Promise<Agent>;
  terminate(agentId: string): Promise<void>;
}

/**
 * Workflow engine interface
 */
interface IWorkflowEngine {
  execute(workflow: Workflow, agents: Agent[]): Promise<WorkflowResult>;
  cancel(workflowId: string): Promise<void>;
}

/**
 * Metrics collector interface
 */
interface IMetricsCollector {
  recordSpawn(agentId: string, duration: number): void;
  recordTaskCompletion(taskId: string, duration: number, success: boolean): void;
  getMetrics(): SwarmMetrics;
}

interface SwarmOrchestratorConfig {
  topology: 'hierarchical' | 'mesh' | 'adaptive' | 'hierarchical-mesh';
  maxAgents: number;
  heartbeatInterval: number;
}

interface AgentConfig {
  type: V3AgentType;
  name: string;
  capabilities: string[];
  priority: number;
}

interface SpawnResult {
  success: boolean;
  agent?: Agent;
  error?: string;
}

interface Agent {
  id: string;
  type: V3AgentType;
  name: string;
  status: 'idle' | 'busy' | 'terminated';
  capabilities: string[];
}

interface Workflow {
  id: string;
  name: string;
  tasks: WorkflowTask[];
  parallelism: number;
}

interface WorkflowTask {
  id: string;
  type: string;
  requiredCapabilities: string[];
  payload: unknown;
  dependsOn?: string[];
}

interface WorkflowResult {
  workflowId: string;
  success: boolean;
  taskResults: TaskResult[];
  totalDuration: number;
  agentsUsed: string[];
}

interface TaskResult {
  taskId: string;
  agentId: string;
  success: boolean;
  output?: unknown;
  duration: number;
}

interface SwarmStatus {
  totalAgents: number;
  idleAgents: number;
  busyAgents: number;
  terminatedAgents: number;
  activeWorkflows: number;
}

interface SwarmMetrics {
  totalSpawns: number;
  averageSpawnTime: number;
  totalTasksCompleted: number;
  averageTaskDuration: number;
  successRate: number;
}

/**
 * Swarm orchestrator implementation for integration testing
 */
class SwarmOrchestrator implements ISwarmOrchestrator {
  private agents: Map<string, Agent> = new Map();
  private activeWorkflows = 0;
  private initialized = false;
  private config: SwarmOrchestratorConfig | null = null;

  constructor(
    private readonly spawner: IAgentSpawner,
    private readonly workflowEngine: IWorkflowEngine,
    private readonly metrics: IMetricsCollector
  ) {}

  async initialize(config: SwarmOrchestratorConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
  }

  async spawnAgents(configs: AgentConfig[]): Promise<SpawnResult[]> {
    if (!this.initialized) {
      throw new Error('Orchestrator not initialized');
    }

    const results: SpawnResult[] = [];

    for (const config of configs) {
      if (this.agents.size >= this.config!.maxAgents) {
        results.push({
          success: false,
          error: 'Maximum agent limit reached',
        });
        continue;
      }

      const startTime = Date.now();

      try {
        const agent = await this.spawner.spawn(config);
        this.agents.set(agent.id, agent);
        this.metrics.recordSpawn(agent.id, Date.now() - startTime);
        results.push({ success: true, agent });
      } catch (error) {
        results.push({
          success: false,
          error: (error as Error).message,
        });
      }
    }

    return results;
  }

  async executeWorkflow(workflow: Workflow): Promise<WorkflowResult> {
    if (!this.initialized) {
      throw new Error('Orchestrator not initialized');
    }

    this.activeWorkflows++;
    const startTime = Date.now();

    try {
      const availableAgents = this.getAvailableAgents();
      const result = await this.workflowEngine.execute(workflow, availableAgents);

      for (const taskResult of result.taskResults) {
        this.metrics.recordTaskCompletion(
          taskResult.taskId,
          taskResult.duration,
          taskResult.success
        );
      }

      return result;
    } finally {
      this.activeWorkflows--;
    }
  }

  getSwarmStatus(): SwarmStatus {
    const agents = Array.from(this.agents.values());

    return {
      totalAgents: agents.length,
      idleAgents: agents.filter((a) => a.status === 'idle').length,
      busyAgents: agents.filter((a) => a.status === 'busy').length,
      terminatedAgents: agents.filter((a) => a.status === 'terminated').length,
      activeWorkflows: this.activeWorkflows,
    };
  }

  async shutdown(): Promise<void> {
    for (const [agentId] of this.agents) {
      await this.spawner.terminate(agentId);
    }
    this.agents.clear();
    this.initialized = false;
  }

  private getAvailableAgents(): Agent[] {
    return Array.from(this.agents.values()).filter((a) => a.status === 'idle');
  }
}

describe('Swarm Coordination Integration', () => {
  let mockSpawner: MockedInterface<IAgentSpawner>;
  let mockWorkflowEngine: MockedInterface<IWorkflowEngine>;
  let mockMetrics: MockedInterface<IMetricsCollector>;
  let orchestrator: SwarmOrchestrator;
  let agentCounter: number;

  beforeEach(() => {
    mockSpawner = createMock<IAgentSpawner>();
    mockWorkflowEngine = createMock<IWorkflowEngine>();
    mockMetrics = createMock<IMetricsCollector>();
    agentCounter = 0;

    mockSpawner.spawn.mockImplementation(async (config: AgentConfig) => ({
      id: `agent-${++agentCounter}`,
      type: config.type,
      name: config.name,
      status: 'idle' as const,
      capabilities: config.capabilities,
    }));
    mockSpawner.terminate.mockResolvedValue(undefined);

    mockWorkflowEngine.execute.mockImplementation(async (workflow, agents) => ({
      workflowId: workflow.id,
      success: true,
      taskResults: workflow.tasks.map((task, i) => ({
        taskId: task.id,
        agentId: agents[i % agents.length]?.id ?? 'unknown',
        success: true,
        duration: 100,
      })),
      totalDuration: workflow.tasks.length * 100,
      agentsUsed: agents.map((a) => a.id),
    }));
    mockWorkflowEngine.cancel.mockResolvedValue(undefined);

    mockMetrics.recordSpawn.mockReturnValue(undefined);
    mockMetrics.recordTaskCompletion.mockReturnValue(undefined);
    mockMetrics.getMetrics.mockReturnValue({
      totalSpawns: 0,
      averageSpawnTime: 0,
      totalTasksCompleted: 0,
      averageTaskDuration: 0,
      successRate: 0,
    });

    orchestrator = new SwarmOrchestrator(mockSpawner, mockWorkflowEngine, mockMetrics);
  });

  describe('15-Agent Swarm Initialization', () => {
    it('should spawn all 15 agents successfully', async () => {
      // Given
      await orchestrator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        heartbeatInterval: 1000,
      });

      const agentConfigs = create15AgentSwarmConfig();

      // When
      const results = await orchestrator.spawnAgents(agentConfigs);

      // Then
      expect(results).toHaveLength(15);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it('should reject agents beyond limit', async () => {
      // Given
      await orchestrator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        heartbeatInterval: 1000,
      });

      const agentConfigs = create15AgentSwarmConfig();
      const extraConfig: AgentConfig = {
        type: 'coder',
        name: 'Extra Agent',
        capabilities: ['coding'],
        priority: 50,
      };

      // When
      await orchestrator.spawnAgents(agentConfigs);
      const extraResult = await orchestrator.spawnAgents([extraConfig]);

      // Then
      expect(extraResult[0].success).toBe(false);
      expect(extraResult[0].error).toContain('Maximum agent limit');
    });

    it('should report correct swarm status after initialization', async () => {
      // Given
      await orchestrator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        heartbeatInterval: 1000,
      });

      const agentConfigs = create15AgentSwarmConfig();
      await orchestrator.spawnAgents(agentConfigs);

      // When
      const status = orchestrator.getSwarmStatus();

      // Then
      expect(status.totalAgents).toBe(15);
      expect(status.idleAgents).toBe(15);
      expect(status.busyAgents).toBe(0);
    });

    it('should record spawn metrics for each agent', async () => {
      // Given
      await orchestrator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        heartbeatInterval: 1000,
      });

      const agentConfigs = create15AgentSwarmConfig().slice(0, 5);

      // When
      await orchestrator.spawnAgents(agentConfigs);

      // Then
      expect(mockMetrics.recordSpawn).toHaveBeenCalledTimes(5);
    });
  });

  describe('Workflow Execution', () => {
    beforeEach(async () => {
      await orchestrator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        heartbeatInterval: 1000,
      });

      const agentConfigs = create15AgentSwarmConfig().slice(0, 5);
      await orchestrator.spawnAgents(agentConfigs);
    });

    it('should execute workflow with available agents', async () => {
      // Given
      const workflow: Workflow = {
        id: 'workflow-1',
        name: 'Security Scan',
        tasks: [
          { id: 'task-1', type: 'scan', requiredCapabilities: [], payload: {} },
          { id: 'task-2', type: 'analyze', requiredCapabilities: [], payload: {} },
        ],
        parallelism: 2,
      };

      // When
      const result = await orchestrator.executeWorkflow(workflow);

      // Then
      expect(result.success).toBe(true);
      expect(result.taskResults).toHaveLength(2);
    });

    it('should pass available agents to workflow engine', async () => {
      // Given
      const workflow: Workflow = {
        id: 'workflow-1',
        name: 'Test Workflow',
        tasks: [{ id: 'task-1', type: 'test', requiredCapabilities: [], payload: {} }],
        parallelism: 1,
      };

      // When
      await orchestrator.executeWorkflow(workflow);

      // Then
      expect(mockWorkflowEngine.execute).toHaveBeenCalledWith(
        workflow,
        expect.arrayContaining([
          expect.objectContaining({
            status: 'idle',
          }),
        ])
      );
    });

    it('should record task completion metrics', async () => {
      // Given
      const workflow: Workflow = {
        id: 'workflow-1',
        name: 'Test Workflow',
        tasks: [
          { id: 'task-1', type: 'test', requiredCapabilities: [], payload: {} },
          { id: 'task-2', type: 'test', requiredCapabilities: [], payload: {} },
        ],
        parallelism: 2,
      };

      // When
      await orchestrator.executeWorkflow(workflow);

      // Then
      expect(mockMetrics.recordTaskCompletion).toHaveBeenCalledTimes(2);
    });

    it('should return agents used in result', async () => {
      // Given
      const workflow: Workflow = {
        id: 'workflow-1',
        name: 'Test Workflow',
        tasks: [{ id: 'task-1', type: 'test', requiredCapabilities: [], payload: {} }],
        parallelism: 1,
      };

      // When
      const result = await orchestrator.executeWorkflow(workflow);

      // Then
      expect(result.agentsUsed.length).toBeGreaterThan(0);
    });
  });

  describe('Swarm Lifecycle', () => {
    it('should throw error if not initialized', async () => {
      // Given - not initialized

      // When/Then
      await expect(
        orchestrator.spawnAgents([{ type: 'coder', name: 'Test', capabilities: [], priority: 50 }])
      ).rejects.toThrow('Orchestrator not initialized');
    });

    it('should terminate all agents on shutdown', async () => {
      // Given
      await orchestrator.initialize({
        topology: 'mesh',
        maxAgents: 10,
        heartbeatInterval: 1000,
      });

      await orchestrator.spawnAgents([
        { type: 'coder', name: 'Agent 1', capabilities: [], priority: 50 },
        { type: 'tester', name: 'Agent 2', capabilities: [], priority: 50 },
      ]);

      // When
      await orchestrator.shutdown();

      // Then
      expect(mockSpawner.terminate).toHaveBeenCalledTimes(2);
    });

    it('should clear swarm status after shutdown', async () => {
      // Given
      await orchestrator.initialize({
        topology: 'mesh',
        maxAgents: 10,
        heartbeatInterval: 1000,
      });

      await orchestrator.spawnAgents([
        { type: 'coder', name: 'Agent 1', capabilities: [], priority: 50 },
      ]);

      // When
      await orchestrator.shutdown();
      const status = orchestrator.getSwarmStatus();

      // Then
      expect(status.totalAgents).toBe(0);
    });
  });

  describe('Hierarchical-Mesh Topology', () => {
    it('should support hierarchical-mesh with 15 agents', async () => {
      // Given
      await orchestrator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        heartbeatInterval: 1000,
      });

      // Create agents with Queen coordinator at top
      const agents: AgentConfig[] = [
        { type: 'queen-coordinator', name: 'Queen', capabilities: ['orchestration'], priority: 100 },
        { type: 'security-architect', name: 'Security Arch', capabilities: ['security'], priority: 90 },
        { type: 'memory-specialist', name: 'Memory Spec', capabilities: ['memory'], priority: 80 },
        { type: 'coder', name: 'Coder 1', capabilities: ['coding'], priority: 70 },
        { type: 'tester', name: 'Tester 1', capabilities: ['testing'], priority: 70 },
      ];

      // When
      const results = await orchestrator.spawnAgents(agents);

      // Then
      expect(results.every((r) => r.success)).toBe(true);

      // Verify Queen is present
      expect(results[0].agent?.type).toBe('queen-coordinator');
    });

    it('should execute workflow through hierarchical coordination', async () => {
      // Given
      await orchestrator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        heartbeatInterval: 1000,
      });

      await orchestrator.spawnAgents([
        { type: 'queen-coordinator', name: 'Queen', capabilities: ['orchestration'], priority: 100 },
        { type: 'coder', name: 'Coder', capabilities: ['coding'], priority: 70 },
        { type: 'tester', name: 'Tester', capabilities: ['testing'], priority: 70 },
      ]);

      const workflow: Workflow = {
        id: 'hierarchical-workflow',
        name: 'Hierarchical Test',
        tasks: [
          { id: 'task-1', type: 'implement', requiredCapabilities: ['coding'], payload: {} },
          { id: 'task-2', type: 'test', requiredCapabilities: ['testing'], payload: {}, dependsOn: ['task-1'] },
        ],
        parallelism: 1,
      };

      // When
      const result = await orchestrator.executeWorkflow(workflow);

      // Then
      expect(result.success).toBe(true);
      expect(mockWorkflowEngine.execute).toHaveBeenCalledWith(
        workflow,
        expect.arrayContaining([
          expect.objectContaining({ type: 'queen-coordinator' }),
        ])
      );
    });
  });

  describe('Swarm Test Instance Helper', () => {
    it('should create swarm test instance with default topology', () => {
      // When
      const swarm = createSwarmTestInstance();

      // Then
      expect(swarm.topology).toBe('hierarchical-mesh');
      expect(swarm.getAllAgents().length).toBeGreaterThan(0);
    });

    it('should support custom agent types', () => {
      // When
      const swarm = createSwarmTestInstance({
        topology: 'mesh',
        agentTypes: ['coder', 'tester', 'reviewer'],
      });

      // Then
      expect(swarm.getAgent('coder')).toBeDefined();
      expect(swarm.getAgent('tester')).toBeDefined();
      expect(swarm.getAgent('reviewer')).toBeDefined();
    });

    it('should track agent interactions', async () => {
      // Given
      const swarm = createSwarmTestInstance({
        agentTypes: ['queen-coordinator', 'coder'],
      });

      await swarm.initialize();

      // When
      await swarm.coordinate({
        id: 'test-task',
        type: 'implementation',
        payload: {},
        priority: 50,
      });

      // Then
      const interactions = swarm.getInteractions();
      expect(interactions.length).toBeGreaterThan(0);
    });
  });
});
