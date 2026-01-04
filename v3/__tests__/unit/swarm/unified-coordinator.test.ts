/**
 * V3 Claude-Flow Unified Coordinator Unit Tests
 *
 * London School TDD - Behavior Verification
 * Tests 15-agent swarm coordination (ADR-003)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMock, type MockedInterface, InteractionRecorder } from '../../helpers/create-mock';
import { createSwarmTestInstance, type V3AgentType, type SwarmTask } from '../../helpers/swarm-instance';
import { swarmConfigs, createSwarmConfig } from '../../fixtures/configurations';
import { agentConfigs, create15AgentSwarmConfig } from '../../fixtures/agents';

/**
 * Unified coordinator interface (to be implemented per ADR-003)
 */
interface IUnifiedCoordinator {
  initialize(config: SwarmConfig): Promise<void>;
  addAgent(agent: AgentInfo): Promise<void>;
  removeAgent(agentId: string): Promise<void>;
  coordinate(task: CoordinationTask): Promise<CoordinationResult>;
  shutdown(): Promise<void>;
  getTopology(): SwarmTopology;
  getAgentStatus(agentId: string): AgentStatus | null;
}

/**
 * Task distributor interface (collaborator)
 */
interface ITaskDistributor {
  distribute(task: CoordinationTask, agents: AgentInfo[]): Promise<TaskAssignment[]>;
  rebalance(assignments: TaskAssignment[]): Promise<TaskAssignment[]>;
}

/**
 * Consensus manager interface (collaborator)
 */
interface IConsensusManager {
  propose(proposal: Proposal): Promise<boolean>;
  getLeader(): string | null;
  isLeader(agentId: string): boolean;
}

/**
 * Communication channel interface (collaborator)
 */
interface ICommunicationChannel {
  broadcast(message: SwarmMessage): Promise<void>;
  send(agentId: string, message: SwarmMessage): Promise<void>;
  subscribe(handler: MessageHandler): void;
}

/**
 * Event publisher interface (collaborator)
 */
interface IEventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

interface SwarmConfig {
  topology: 'hierarchical' | 'mesh' | 'adaptive' | 'hierarchical-mesh';
  maxAgents: number;
  consensusProtocol: 'raft' | 'pbft' | 'gossip';
}

interface AgentInfo {
  id: string;
  type: V3AgentType;
  capabilities: string[];
  priority: number;
}

interface CoordinationTask {
  id: string;
  type: string;
  payload: unknown;
  requiredCapabilities: string[];
  priority: number;
}

interface CoordinationResult {
  taskId: string;
  success: boolean;
  results: TaskResult[];
  duration: number;
  participatingAgents: string[];
}

interface TaskAssignment {
  agentId: string;
  taskId: string;
  subtask: unknown;
}

interface TaskResult {
  agentId: string;
  success: boolean;
  output?: unknown;
  error?: Error;
}

interface Proposal {
  type: string;
  payload: unknown;
  proposerId: string;
}

interface SwarmMessage {
  type: string;
  payload: unknown;
  from: string;
  to: string | 'broadcast';
}

type MessageHandler = (message: SwarmMessage) => Promise<void>;

type SwarmTopology = 'hierarchical' | 'mesh' | 'adaptive' | 'hierarchical-mesh';

type AgentStatus = 'idle' | 'busy' | 'offline';

interface DomainEvent {
  type: string;
  payload: unknown;
  timestamp: Date;
}

/**
 * Unified coordinator implementation for testing
 */
class UnifiedCoordinator implements IUnifiedCoordinator {
  private agents: Map<string, AgentInfo> = new Map();
  private agentStatus: Map<string, AgentStatus> = new Map();
  private initialized = false;
  private config: SwarmConfig | null = null;

  constructor(
    private readonly distributor: ITaskDistributor,
    private readonly consensus: IConsensusManager,
    private readonly channel: ICommunicationChannel,
    private readonly eventPublisher: IEventPublisher
  ) {}

  async initialize(config: SwarmConfig): Promise<void> {
    if (this.initialized) {
      throw new Error('Coordinator already initialized');
    }

    this.config = config;

    // Subscribe to messages
    this.channel.subscribe(async (message) => {
      await this.handleMessage(message);
    });

    // Publish initialization event
    await this.eventPublisher.publish({
      type: 'CoordinatorInitialized',
      payload: { topology: config.topology, maxAgents: config.maxAgents },
      timestamp: new Date(),
    });

    this.initialized = true;
  }

  async addAgent(agent: AgentInfo): Promise<void> {
    if (!this.initialized) {
      throw new Error('Coordinator not initialized');
    }

    if (this.agents.size >= this.config!.maxAgents) {
      throw new Error('Maximum agent limit reached');
    }

    this.agents.set(agent.id, agent);
    this.agentStatus.set(agent.id, 'idle');

    // Broadcast agent joined
    await this.channel.broadcast({
      type: 'AgentJoined',
      payload: { agentId: agent.id, type: agent.type },
      from: 'coordinator',
      to: 'broadcast',
    });

    await this.eventPublisher.publish({
      type: 'AgentAddedToSwarm',
      payload: { agentId: agent.id, agentType: agent.type },
      timestamp: new Date(),
    });
  }

  async removeAgent(agentId: string): Promise<void> {
    if (!this.agents.has(agentId)) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    this.agents.delete(agentId);
    this.agentStatus.delete(agentId);

    // Broadcast agent left
    await this.channel.broadcast({
      type: 'AgentLeft',
      payload: { agentId },
      from: 'coordinator',
      to: 'broadcast',
    });

    await this.eventPublisher.publish({
      type: 'AgentRemovedFromSwarm',
      payload: { agentId },
      timestamp: new Date(),
    });
  }

  async coordinate(task: CoordinationTask): Promise<CoordinationResult> {
    if (!this.initialized) {
      throw new Error('Coordinator not initialized');
    }

    const startTime = Date.now();

    // Get available agents
    const availableAgents = this.getAvailableAgents(task.requiredCapabilities);

    if (availableAgents.length === 0) {
      throw new Error('No available agents with required capabilities');
    }

    // For hierarchical topology, propose task through consensus
    if (this.config!.topology.includes('hierarchical')) {
      const approved = await this.consensus.propose({
        type: 'TaskCoordination',
        payload: task,
        proposerId: 'coordinator',
      });

      if (!approved) {
        throw new Error('Task coordination not approved by consensus');
      }
    }

    // Distribute task
    const assignments = await this.distributor.distribute(task, availableAgents);

    // Mark agents as busy
    for (const assignment of assignments) {
      this.agentStatus.set(assignment.agentId, 'busy');
    }

    // Notify agents
    for (const assignment of assignments) {
      await this.channel.send(assignment.agentId, {
        type: 'TaskAssigned',
        payload: assignment,
        from: 'coordinator',
        to: assignment.agentId,
      });
    }

    // Simulate task execution results
    const results: TaskResult[] = assignments.map((a) => ({
      agentId: a.agentId,
      success: true,
    }));

    // Mark agents as idle
    for (const assignment of assignments) {
      this.agentStatus.set(assignment.agentId, 'idle');
    }

    const duration = Date.now() - startTime;

    await this.eventPublisher.publish({
      type: 'TaskCoordinationCompleted',
      payload: { taskId: task.id, duration, participatingAgents: assignments.map((a) => a.agentId) },
      timestamp: new Date(),
    });

    return {
      taskId: task.id,
      success: true,
      results,
      duration,
      participatingAgents: assignments.map((a) => a.agentId),
    };
  }

  async shutdown(): Promise<void> {
    // Notify all agents
    await this.channel.broadcast({
      type: 'CoordinatorShutdown',
      payload: {},
      from: 'coordinator',
      to: 'broadcast',
    });

    // Clear state
    this.agents.clear();
    this.agentStatus.clear();
    this.initialized = false;

    await this.eventPublisher.publish({
      type: 'CoordinatorShutdown',
      payload: {},
      timestamp: new Date(),
    });
  }

  getTopology(): SwarmTopology {
    return this.config?.topology ?? 'mesh';
  }

  getAgentStatus(agentId: string): AgentStatus | null {
    return this.agentStatus.get(agentId) ?? null;
  }

  private getAvailableAgents(requiredCapabilities: string[]): AgentInfo[] {
    const available: AgentInfo[] = [];

    for (const [agentId, agent] of this.agents) {
      const status = this.agentStatus.get(agentId);

      if (status === 'idle') {
        const hasCapabilities = requiredCapabilities.every((cap) =>
          agent.capabilities.includes(cap)
        );

        if (hasCapabilities || requiredCapabilities.length === 0) {
          available.push(agent);
        }
      }
    }

    return available.sort((a, b) => b.priority - a.priority);
  }

  private async handleMessage(message: SwarmMessage): Promise<void> {
    // Handle incoming messages
    if (message.type === 'AgentStatusUpdate') {
      const { agentId, status } = message.payload as { agentId: string; status: AgentStatus };
      this.agentStatus.set(agentId, status);
    }
  }
}

describe('UnifiedCoordinator', () => {
  let mockDistributor: MockedInterface<ITaskDistributor>;
  let mockConsensus: MockedInterface<IConsensusManager>;
  let mockChannel: MockedInterface<ICommunicationChannel>;
  let mockEventPublisher: MockedInterface<IEventPublisher>;
  let coordinator: UnifiedCoordinator;
  let interactionRecorder: InteractionRecorder;

  beforeEach(() => {
    mockDistributor = createMock<ITaskDistributor>();
    mockConsensus = createMock<IConsensusManager>();
    mockChannel = createMock<ICommunicationChannel>();
    mockEventPublisher = createMock<IEventPublisher>();
    interactionRecorder = new InteractionRecorder();

    // Configure default mock behavior
    mockDistributor.distribute.mockResolvedValue([]);
    mockDistributor.rebalance.mockResolvedValue([]);

    mockConsensus.propose.mockResolvedValue(true);
    mockConsensus.getLeader.mockReturnValue('leader-agent');
    mockConsensus.isLeader.mockReturnValue(false);

    mockChannel.broadcast.mockResolvedValue(undefined);
    mockChannel.send.mockResolvedValue(undefined);
    mockChannel.subscribe.mockReturnValue(undefined);

    mockEventPublisher.publish.mockResolvedValue(undefined);

    // Track interactions
    interactionRecorder.track('distributor', mockDistributor);
    interactionRecorder.track('consensus', mockConsensus);
    interactionRecorder.track('channel', mockChannel);
    interactionRecorder.track('events', mockEventPublisher);

    coordinator = new UnifiedCoordinator(
      mockDistributor,
      mockConsensus,
      mockChannel,
      mockEventPublisher
    );
  });

  describe('initialize', () => {
    it('should subscribe to communication channel', async () => {
      // Given
      const config: SwarmConfig = {
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        consensusProtocol: 'raft',
      };

      // When
      await coordinator.initialize(config);

      // Then
      expect(mockChannel.subscribe).toHaveBeenCalled();
    });

    it('should publish initialization event', async () => {
      // Given
      const config: SwarmConfig = {
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        consensusProtocol: 'raft',
      };

      // When
      await coordinator.initialize(config);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CoordinatorInitialized',
          payload: expect.objectContaining({
            topology: 'hierarchical-mesh',
            maxAgents: 15,
          }),
        })
      );
    });

    it('should throw error if already initialized', async () => {
      // Given
      const config: SwarmConfig = {
        topology: 'mesh',
        maxAgents: 10,
        consensusProtocol: 'gossip',
      };
      await coordinator.initialize(config);

      // When/Then
      await expect(coordinator.initialize(config)).rejects.toThrow(
        'Coordinator already initialized'
      );
    });
  });

  describe('addAgent', () => {
    beforeEach(async () => {
      await coordinator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        consensusProtocol: 'raft',
      });
    });

    it('should throw error if not initialized', async () => {
      // Given
      const uninitializedCoordinator = new UnifiedCoordinator(
        mockDistributor,
        mockConsensus,
        mockChannel,
        mockEventPublisher
      );

      const agent: AgentInfo = {
        id: 'agent-1',
        type: 'coder',
        capabilities: ['coding'],
        priority: 50,
      };

      // When/Then
      await expect(uninitializedCoordinator.addAgent(agent)).rejects.toThrow(
        'Coordinator not initialized'
      );
    });

    it('should broadcast agent joined message', async () => {
      // Given
      const agent: AgentInfo = {
        id: 'agent-1',
        type: 'queen-coordinator',
        capabilities: ['orchestration'],
        priority: 100,
      };

      // When
      await coordinator.addAgent(agent);

      // Then
      expect(mockChannel.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AgentJoined',
          payload: expect.objectContaining({
            agentId: 'agent-1',
          }),
        })
      );
    });

    it('should publish AgentAddedToSwarm event', async () => {
      // Given
      const agent: AgentInfo = {
        id: 'agent-1',
        type: 'security-architect',
        capabilities: ['security-design'],
        priority: 90,
      };

      // When
      await coordinator.addAgent(agent);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AgentAddedToSwarm',
          payload: expect.objectContaining({
            agentId: 'agent-1',
            agentType: 'security-architect',
          }),
        })
      );
    });

    it('should set agent status to idle', async () => {
      // Given
      const agent: AgentInfo = {
        id: 'agent-1',
        type: 'coder',
        capabilities: ['coding'],
        priority: 50,
      };

      // When
      await coordinator.addAgent(agent);

      // Then
      expect(coordinator.getAgentStatus('agent-1')).toBe('idle');
    });

    it('should throw error when max agents reached', async () => {
      // Given - Add 15 agents to reach max
      for (let i = 0; i < 15; i++) {
        await coordinator.addAgent({
          id: `agent-${i}`,
          type: 'coder',
          capabilities: ['coding'],
          priority: 50,
        });
      }

      // When/Then
      await expect(
        coordinator.addAgent({
          id: 'agent-16',
          type: 'coder',
          capabilities: ['coding'],
          priority: 50,
        })
      ).rejects.toThrow('Maximum agent limit reached');
    });
  });

  describe('removeAgent', () => {
    beforeEach(async () => {
      await coordinator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        consensusProtocol: 'raft',
      });
      await coordinator.addAgent({
        id: 'agent-1',
        type: 'coder',
        capabilities: ['coding'],
        priority: 50,
      });
    });

    it('should throw error for non-existent agent', async () => {
      // When/Then
      await expect(coordinator.removeAgent('non-existent')).rejects.toThrow(
        'Agent not found: non-existent'
      );
    });

    it('should broadcast agent left message', async () => {
      // When
      await coordinator.removeAgent('agent-1');

      // Then
      expect(mockChannel.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AgentLeft',
          payload: { agentId: 'agent-1' },
        })
      );
    });

    it('should publish AgentRemovedFromSwarm event', async () => {
      // When
      await coordinator.removeAgent('agent-1');

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AgentRemovedFromSwarm',
          payload: { agentId: 'agent-1' },
        })
      );
    });

    it('should clear agent status', async () => {
      // When
      await coordinator.removeAgent('agent-1');

      // Then
      expect(coordinator.getAgentStatus('agent-1')).toBeNull();
    });
  });

  describe('coordinate', () => {
    beforeEach(async () => {
      await coordinator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        consensusProtocol: 'raft',
      });
      await coordinator.addAgent({
        id: 'agent-1',
        type: 'coder',
        capabilities: ['coding', 'debugging'],
        priority: 50,
      });
      await coordinator.addAgent({
        id: 'agent-2',
        type: 'tester',
        capabilities: ['testing'],
        priority: 60,
      });
    });

    it('should throw error if not initialized', async () => {
      // Given
      const uninitializedCoordinator = new UnifiedCoordinator(
        mockDistributor,
        mockConsensus,
        mockChannel,
        mockEventPublisher
      );

      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: ['coding'],
        priority: 50,
      };

      // When/Then
      await expect(uninitializedCoordinator.coordinate(task)).rejects.toThrow(
        'Coordinator not initialized'
      );
    });

    it('should propose task through consensus for hierarchical topology', async () => {
      // Given
      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: [],
        priority: 50,
      };
      mockDistributor.distribute.mockResolvedValue([
        { agentId: 'agent-1', taskId: 'task-1', subtask: {} },
      ]);

      // When
      await coordinator.coordinate(task);

      // Then
      expect(mockConsensus.propose).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TaskCoordination',
          payload: task,
        })
      );
    });

    it('should throw error if consensus rejects', async () => {
      // Given
      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: [],
        priority: 50,
      };
      mockConsensus.propose.mockResolvedValue(false);

      // When/Then
      await expect(coordinator.coordinate(task)).rejects.toThrow(
        'Task coordination not approved by consensus'
      );
    });

    it('should distribute task to available agents', async () => {
      // Given
      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: ['coding'],
        priority: 50,
      };
      mockDistributor.distribute.mockResolvedValue([
        { agentId: 'agent-1', taskId: 'task-1', subtask: {} },
      ]);

      // When
      await coordinator.coordinate(task);

      // Then
      expect(mockDistributor.distribute).toHaveBeenCalledWith(
        task,
        expect.arrayContaining([
          expect.objectContaining({ id: 'agent-1' }),
        ])
      );
    });

    it('should throw error if no agents with required capabilities', async () => {
      // Given
      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: ['non-existent-capability'],
        priority: 50,
      };

      // When/Then
      await expect(coordinator.coordinate(task)).rejects.toThrow(
        'No available agents with required capabilities'
      );
    });

    it('should send task assignment to each agent', async () => {
      // Given
      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: [],
        priority: 50,
      };
      mockDistributor.distribute.mockResolvedValue([
        { agentId: 'agent-1', taskId: 'task-1', subtask: { part: 1 } },
        { agentId: 'agent-2', taskId: 'task-1', subtask: { part: 2 } },
      ]);

      // When
      await coordinator.coordinate(task);

      // Then
      expect(mockChannel.send).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          type: 'TaskAssigned',
        })
      );
      expect(mockChannel.send).toHaveBeenCalledWith(
        'agent-2',
        expect.objectContaining({
          type: 'TaskAssigned',
        })
      );
    });

    it('should return coordination result', async () => {
      // Given
      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: [],
        priority: 50,
      };
      mockDistributor.distribute.mockResolvedValue([
        { agentId: 'agent-1', taskId: 'task-1', subtask: {} },
      ]);

      // When
      const result = await coordinator.coordinate(task);

      // Then
      expect(result.taskId).toBe('task-1');
      expect(result.success).toBe(true);
      expect(result.participatingAgents).toContain('agent-1');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should publish TaskCoordinationCompleted event', async () => {
      // Given
      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: [],
        priority: 50,
      };
      mockDistributor.distribute.mockResolvedValue([
        { agentId: 'agent-1', taskId: 'task-1', subtask: {} },
      ]);

      // When
      await coordinator.coordinate(task);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TaskCoordinationCompleted',
          payload: expect.objectContaining({
            taskId: 'task-1',
          }),
        })
      );
    });

    it('should prioritize higher priority agents', async () => {
      // Given
      const task: CoordinationTask = {
        id: 'task-1',
        type: 'implementation',
        payload: {},
        requiredCapabilities: [],
        priority: 50,
      };

      let capturedAgents: AgentInfo[] = [];
      mockDistributor.distribute.mockImplementation(async (_, agents) => {
        capturedAgents = agents;
        return [{ agentId: agents[0].id, taskId: 'task-1', subtask: {} }];
      });

      // When
      await coordinator.coordinate(task);

      // Then - agent-2 has higher priority (60 vs 50)
      expect(capturedAgents[0].id).toBe('agent-2');
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      await coordinator.initialize({
        topology: 'mesh',
        maxAgents: 10,
        consensusProtocol: 'gossip',
      });
    });

    it('should broadcast shutdown message', async () => {
      // When
      await coordinator.shutdown();

      // Then
      expect(mockChannel.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CoordinatorShutdown',
        })
      );
    });

    it('should publish shutdown event', async () => {
      // When
      await coordinator.shutdown();

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CoordinatorShutdown',
        })
      );
    });

    it('should clear all agents', async () => {
      // Given
      await coordinator.addAgent({
        id: 'agent-1',
        type: 'coder',
        capabilities: ['coding'],
        priority: 50,
      });

      // When
      await coordinator.shutdown();

      // Then
      expect(coordinator.getAgentStatus('agent-1')).toBeNull();
    });
  });

  describe('getTopology', () => {
    it('should return configured topology', async () => {
      // Given
      await coordinator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        consensusProtocol: 'raft',
      });

      // When
      const topology = coordinator.getTopology();

      // Then
      expect(topology).toBe('hierarchical-mesh');
    });

    it('should return mesh as default before initialization', () => {
      // When
      const topology = coordinator.getTopology();

      // Then
      expect(topology).toBe('mesh');
    });
  });

  describe('15-agent swarm coordination (ADR-003)', () => {
    it('should support up to 15 agents', async () => {
      // Given
      await coordinator.initialize({
        topology: 'hierarchical-mesh',
        maxAgents: 15,
        consensusProtocol: 'raft',
      });

      const agentConfigurations = create15AgentSwarmConfig();

      // When
      for (let i = 0; i < 15; i++) {
        await coordinator.addAgent({
          id: `agent-${i}`,
          type: agentConfigurations[i].type,
          capabilities: agentConfigurations[i].capabilities,
          priority: agentConfigurations[i].priority ?? 50,
        });
      }

      // Then - all 15 agents should have idle status
      for (let i = 0; i < 15; i++) {
        expect(coordinator.getAgentStatus(`agent-${i}`)).toBe('idle');
      }
    });
  });
});
