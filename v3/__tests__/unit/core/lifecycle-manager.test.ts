/**
 * V3 Claude-Flow Lifecycle Manager Unit Tests
 *
 * London School TDD - Behavior Verification
 * Tests agent lifecycle management
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMock, type MockedInterface, InteractionRecorder } from '../../helpers/create-mock';
import { agentConfigs, createAgentConfig } from '../../fixtures/agents';

/**
 * Lifecycle manager interface (to be implemented)
 */
interface ILifecycleManager {
  spawn(config: AgentConfig): Promise<Agent>;
  terminate(agentId: string): Promise<void>;
  restart(agentId: string): Promise<Agent>;
  getAgent(agentId: string): Promise<Agent | null>;
  listAgents(): Promise<Agent[]>;
  getHealth(agentId: string): Promise<AgentHealth>;
}

/**
 * Agent registry interface (collaborator)
 */
interface IAgentRegistry {
  register(agent: Agent): Promise<void>;
  unregister(agentId: string): Promise<void>;
  find(agentId: string): Promise<Agent | null>;
  findAll(): Promise<Agent[]>;
  update(agentId: string, updates: Partial<Agent>): Promise<void>;
}

/**
 * Agent factory interface (collaborator)
 */
interface IAgentFactory {
  create(config: AgentConfig): Promise<Agent>;
  validate(config: AgentConfig): boolean;
}

/**
 * Health monitor interface (collaborator)
 */
interface IHealthMonitor {
  startMonitoring(agentId: string): void;
  stopMonitoring(agentId: string): void;
  getHealth(agentId: string): AgentHealth;
}

/**
 * Event publisher interface (collaborator)
 */
interface IEventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

interface AgentConfig {
  type: string;
  name: string;
  capabilities: string[];
  priority?: number;
}

interface Agent {
  id: string;
  type: string;
  name: string;
  status: AgentStatus;
  capabilities: string[];
  createdAt: Date;
  lastActiveAt?: Date;
}

type AgentStatus = 'initializing' | 'idle' | 'busy' | 'terminating' | 'terminated';

interface AgentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastCheck: Date;
  metrics: {
    cpuUsage: number;
    memoryUsage: number;
    taskCount: number;
  };
}

interface DomainEvent {
  type: string;
  payload: unknown;
  timestamp: Date;
}

/**
 * Lifecycle manager implementation for testing
 */
class LifecycleManager implements ILifecycleManager {
  constructor(
    private readonly registry: IAgentRegistry,
    private readonly factory: IAgentFactory,
    private readonly healthMonitor: IHealthMonitor,
    private readonly eventPublisher: IEventPublisher
  ) {}

  async spawn(config: AgentConfig): Promise<Agent> {
    // Validate configuration
    if (!this.factory.validate(config)) {
      throw new Error('Invalid agent configuration');
    }

    // Create agent
    const agent = await this.factory.create(config);

    // Register agent
    await this.registry.register(agent);

    // Start health monitoring
    this.healthMonitor.startMonitoring(agent.id);

    // Update status to idle
    await this.registry.update(agent.id, { status: 'idle' });

    // Publish event
    await this.eventPublisher.publish({
      type: 'AgentSpawned',
      payload: { agentId: agent.id, type: agent.type, name: agent.name },
      timestamp: new Date(),
    });

    return { ...agent, status: 'idle' };
  }

  async terminate(agentId: string): Promise<void> {
    const agent = await this.registry.find(agentId);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (agent.status === 'terminated') {
      throw new Error(`Agent already terminated: ${agentId}`);
    }

    // Update status to terminating
    await this.registry.update(agentId, { status: 'terminating' });

    // Stop health monitoring
    this.healthMonitor.stopMonitoring(agentId);

    // Update status to terminated
    await this.registry.update(agentId, { status: 'terminated' });

    // Publish event
    await this.eventPublisher.publish({
      type: 'AgentTerminated',
      payload: { agentId },
      timestamp: new Date(),
    });
  }

  async restart(agentId: string): Promise<Agent> {
    const agent = await this.registry.find(agentId);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Terminate existing
    await this.terminate(agentId);

    // Unregister old agent
    await this.registry.unregister(agentId);

    // Spawn new agent with same config
    const newAgent = await this.spawn({
      type: agent.type,
      name: agent.name,
      capabilities: agent.capabilities,
    });

    // Publish restart event
    await this.eventPublisher.publish({
      type: 'AgentRestarted',
      payload: { oldAgentId: agentId, newAgentId: newAgent.id },
      timestamp: new Date(),
    });

    return newAgent;
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    return this.registry.find(agentId);
  }

  async listAgents(): Promise<Agent[]> {
    return this.registry.findAll();
  }

  async getHealth(agentId: string): Promise<AgentHealth> {
    const agent = await this.registry.find(agentId);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return this.healthMonitor.getHealth(agentId);
  }
}

describe('LifecycleManager', () => {
  let mockRegistry: MockedInterface<IAgentRegistry>;
  let mockFactory: MockedInterface<IAgentFactory>;
  let mockHealthMonitor: MockedInterface<IHealthMonitor>;
  let mockEventPublisher: MockedInterface<IEventPublisher>;
  let lifecycleManager: LifecycleManager;
  let interactionRecorder: InteractionRecorder;

  beforeEach(() => {
    mockRegistry = createMock<IAgentRegistry>();
    mockFactory = createMock<IAgentFactory>();
    mockHealthMonitor = createMock<IHealthMonitor>();
    mockEventPublisher = createMock<IEventPublisher>();
    interactionRecorder = new InteractionRecorder();

    // Configure default mock behavior
    mockRegistry.register.mockResolvedValue(undefined);
    mockRegistry.unregister.mockResolvedValue(undefined);
    mockRegistry.find.mockResolvedValue(null);
    mockRegistry.findAll.mockResolvedValue([]);
    mockRegistry.update.mockResolvedValue(undefined);

    mockFactory.validate.mockReturnValue(true);
    mockFactory.create.mockResolvedValue({
      id: 'agent-123',
      type: 'coder',
      name: 'Test Agent',
      status: 'initializing',
      capabilities: ['coding'],
      createdAt: new Date(),
    });

    mockHealthMonitor.getHealth.mockReturnValue({
      status: 'healthy',
      lastCheck: new Date(),
      metrics: { cpuUsage: 10, memoryUsage: 50, taskCount: 0 },
    });

    mockEventPublisher.publish.mockResolvedValue(undefined);

    // Track interactions
    interactionRecorder.track('registry', mockRegistry);
    interactionRecorder.track('factory', mockFactory);
    interactionRecorder.track('health', mockHealthMonitor);
    interactionRecorder.track('events', mockEventPublisher);

    lifecycleManager = new LifecycleManager(
      mockRegistry,
      mockFactory,
      mockHealthMonitor,
      mockEventPublisher
    );
  });

  describe('spawn', () => {
    it('should validate configuration first', async () => {
      // Given
      const config = agentConfigs.coder;

      // When
      await lifecycleManager.spawn(config);

      // Then
      expect(mockFactory.validate).toHaveBeenCalledWith(config);
    });

    it('should throw error for invalid configuration', async () => {
      // Given
      const config = agentConfigs.coder;
      mockFactory.validate.mockReturnValue(false);

      // When/Then
      await expect(lifecycleManager.spawn(config)).rejects.toThrow(
        'Invalid agent configuration'
      );
    });

    it('should create agent via factory', async () => {
      // Given
      const config = agentConfigs.coder;

      // When
      await lifecycleManager.spawn(config);

      // Then
      expect(mockFactory.create).toHaveBeenCalledWith(config);
    });

    it('should register agent after creation', async () => {
      // Given
      const config = agentConfigs.coder;
      const createdAgent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Coder Agent',
        status: 'initializing' as AgentStatus,
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockFactory.create.mockResolvedValue(createdAgent);

      // When
      await lifecycleManager.spawn(config);

      // Then
      expect(mockRegistry.register).toHaveBeenCalledWith(createdAgent);
    });

    it('should start health monitoring after registration', async () => {
      // Given
      const config = agentConfigs.coder;

      // When
      await lifecycleManager.spawn(config);

      // Then
      expect(mockHealthMonitor.startMonitoring).toHaveBeenCalledWith('agent-123');
    });

    it('should update status to idle after monitoring started', async () => {
      // Given
      const config = agentConfigs.coder;

      // When
      await lifecycleManager.spawn(config);

      // Then
      expect(mockRegistry.update).toHaveBeenCalledWith(
        'agent-123',
        expect.objectContaining({ status: 'idle' })
      );
    });

    it('should publish AgentSpawned event', async () => {
      // Given
      const config = agentConfigs.coder;

      // When
      await lifecycleManager.spawn(config);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AgentSpawned',
          payload: expect.objectContaining({
            agentId: 'agent-123',
          }),
        })
      );
    });

    it('should return agent with idle status', async () => {
      // Given
      const config = agentConfigs.coder;

      // When
      const result = await lifecycleManager.spawn(config);

      // Then
      expect(result.status).toBe('idle');
    });

    it('should follow correct lifecycle order', async () => {
      // Given
      const config = agentConfigs.coder;

      // When
      await lifecycleManager.spawn(config);

      // Then
      const order = interactionRecorder.getInteractionOrder();

      // Validate -> Create -> Register -> Monitor -> Update -> Publish
      expect(order.indexOf('factory.validate')).toBeLessThan(order.indexOf('factory.create'));
      expect(order.indexOf('factory.create')).toBeLessThan(order.indexOf('registry.register'));
      expect(order.indexOf('registry.register')).toBeLessThan(order.indexOf('health.startMonitoring'));
    });
  });

  describe('terminate', () => {
    it('should find agent in registry', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.terminate('agent-123');

      // Then
      expect(mockRegistry.find).toHaveBeenCalledWith('agent-123');
    });

    it('should throw error for non-existent agent', async () => {
      // Given
      mockRegistry.find.mockResolvedValue(null);

      // When/Then
      await expect(lifecycleManager.terminate('non-existent')).rejects.toThrow(
        'Agent not found: non-existent'
      );
    });

    it('should throw error for already terminated agent', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'terminated',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When/Then
      await expect(lifecycleManager.terminate('agent-123')).rejects.toThrow(
        'Agent already terminated: agent-123'
      );
    });

    it('should update status to terminating first', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.terminate('agent-123');

      // Then
      const firstUpdate = mockRegistry.update.mock.calls[0];
      expect(firstUpdate[1]).toMatchObject({ status: 'terminating' });
    });

    it('should stop health monitoring', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.terminate('agent-123');

      // Then
      expect(mockHealthMonitor.stopMonitoring).toHaveBeenCalledWith('agent-123');
    });

    it('should update status to terminated', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.terminate('agent-123');

      // Then
      const lastUpdate = mockRegistry.update.mock.calls[mockRegistry.update.mock.calls.length - 1];
      expect(lastUpdate[1]).toMatchObject({ status: 'terminated' });
    });

    it('should publish AgentTerminated event', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.terminate('agent-123');

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AgentTerminated',
          payload: { agentId: 'agent-123' },
        })
      );
    });
  });

  describe('restart', () => {
    it('should find existing agent', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.restart('agent-123');

      // Then
      expect(mockRegistry.find).toHaveBeenCalledWith('agent-123');
    });

    it('should throw error for non-existent agent', async () => {
      // Given
      mockRegistry.find.mockResolvedValue(null);

      // When/Then
      await expect(lifecycleManager.restart('non-existent')).rejects.toThrow(
        'Agent not found: non-existent'
      );
    });

    it('should terminate existing agent', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.restart('agent-123');

      // Then
      expect(mockRegistry.update).toHaveBeenCalledWith(
        'agent-123',
        expect.objectContaining({ status: 'terminating' })
      );
    });

    it('should unregister old agent', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.restart('agent-123');

      // Then
      expect(mockRegistry.unregister).toHaveBeenCalledWith('agent-123');
    });

    it('should spawn new agent with same config', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.restart('agent-123');

      // Then
      expect(mockFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'coder',
          name: 'Test',
          capabilities: ['coding'],
        })
      );
    });

    it('should publish AgentRestarted event', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.restart('agent-123');

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AgentRestarted',
        })
      );
    });

    it('should return new agent', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      const result = await lifecycleManager.restart('agent-123');

      // Then
      expect(result.status).toBe('idle');
    });
  });

  describe('getAgent', () => {
    it('should delegate to registry find', async () => {
      // When
      await lifecycleManager.getAgent('agent-123');

      // Then
      expect(mockRegistry.find).toHaveBeenCalledWith('agent-123');
    });

    it('should return agent when found', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      const result = await lifecycleManager.getAgent('agent-123');

      // Then
      expect(result).toEqual(agent);
    });

    it('should return null when not found', async () => {
      // Given
      mockRegistry.find.mockResolvedValue(null);

      // When
      const result = await lifecycleManager.getAgent('non-existent');

      // Then
      expect(result).toBeNull();
    });
  });

  describe('listAgents', () => {
    it('should delegate to registry findAll', async () => {
      // When
      await lifecycleManager.listAgents();

      // Then
      expect(mockRegistry.findAll).toHaveBeenCalled();
    });

    it('should return all agents', async () => {
      // Given
      const agents: Agent[] = [
        { id: 'agent-1', type: 'coder', name: 'Agent 1', status: 'idle', capabilities: [], createdAt: new Date() },
        { id: 'agent-2', type: 'tester', name: 'Agent 2', status: 'busy', capabilities: [], createdAt: new Date() },
      ];
      mockRegistry.findAll.mockResolvedValue(agents);

      // When
      const result = await lifecycleManager.listAgents();

      // Then
      expect(result).toEqual(agents);
    });
  });

  describe('getHealth', () => {
    it('should find agent first', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      // When
      await lifecycleManager.getHealth('agent-123');

      // Then
      expect(mockRegistry.find).toHaveBeenCalledWith('agent-123');
    });

    it('should throw error for non-existent agent', async () => {
      // Given
      mockRegistry.find.mockResolvedValue(null);

      // When/Then
      await expect(lifecycleManager.getHealth('non-existent')).rejects.toThrow(
        'Agent not found: non-existent'
      );
    });

    it('should return health from monitor', async () => {
      // Given
      const agent: Agent = {
        id: 'agent-123',
        type: 'coder',
        name: 'Test',
        status: 'idle',
        capabilities: ['coding'],
        createdAt: new Date(),
      };
      mockRegistry.find.mockResolvedValue(agent);

      const health: AgentHealth = {
        status: 'healthy',
        lastCheck: new Date(),
        metrics: { cpuUsage: 10, memoryUsage: 50, taskCount: 2 },
      };
      mockHealthMonitor.getHealth.mockReturnValue(health);

      // When
      const result = await lifecycleManager.getHealth('agent-123');

      // Then
      expect(result).toEqual(health);
    });
  });
});
