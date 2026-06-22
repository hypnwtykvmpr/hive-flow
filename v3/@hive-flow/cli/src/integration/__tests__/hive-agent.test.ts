/**
 * HiveAgent Test Suite
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HiveAgent, createHiveAgent } from '../hive-agent.js';

describe('HiveAgent', () => {
  let agent: HiveAgent;

  beforeEach(async () => {
    agent = new HiveAgent({
      id: 'test-agent-1',
      name: 'Test Agent',
      type: 'coder',
      capabilities: ['code-generation', 'refactoring'],
      maxConcurrentTasks: 3,
      priority: 5,
    });
  });

  afterEach(async () => {
    if (agent) {
      await agent.shutdown();
    }
  });

  describe('Initialization', () => {
    it('should create an agent with correct configuration', () => {
      expect(agent.id).toBe('test-agent-1');
      expect(agent.name).toBe('Test Agent');
      expect(agent.type).toBe('coder');
      expect(agent.status).toBe('spawning');
    });

    it('should initialize successfully', async () => {
      await agent.initialize();

      expect(agent.status).toBe('idle');
      expect(agent.metrics?.tasksCompleted).toBe(0);
      expect(agent.metrics?.tasksFailed).toBe(0);
    });

    it('should be idempotent on multiple initialize calls', async () => {
      await agent.initialize();
      await agent.initialize();
      await agent.initialize();

      expect(agent.status).toBe('idle');
    });
  });

  describe('Task Execution', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('should execute a simple task', async () => {
      const result = await agent.executeTask({
        id: 'task-1',
        type: 'code',
        description: 'Generate function',
        input: { name: 'hello' },
      });

      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-1');
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(agent.metrics?.tasksCompleted).toBe(1);
    });

    it('should update status during task execution', async () => {
      const result = await agent.executeTask({
        id: 'task-2',
        type: 'code',
        description: 'Test task',
      });

      expect(result.success).toBe(true);
      expect(agent.status).toBe('idle');
    });

    it('should track metrics correctly', async () => {
      await agent.executeTask({
        id: 'task-3',
        type: 'code',
        description: 'Task 1',
      });

      await agent.executeTask({
        id: 'task-4',
        type: 'code',
        description: 'Task 2',
      });

      expect(agent.metrics?.tasksCompleted).toBe(2);
      expect(agent.metrics?.avgTaskDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Messaging', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('emits local message events without external delegation', async () => {
      const observed: unknown[] = [];
      agent.on('message-send', (payload) => observed.push(payload));

      await agent.sendMessage('agent-2', {
        id: 'message-1',
        from: 'test-agent-1',
        type: 'status',
        payload: 'ready',
        timestamp: Date.now(),
      });

      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ from: 'test-agent-1', to: 'agent-2' });
    });
  });

  describe('Health Monitoring', () => {
    beforeEach(async () => {
      await agent.initialize();
    });

    it('should return health status', () => {
      const health = agent.getHealth();

      expect(health.status).toBe('healthy');
      expect(health.metrics.tasksCompleted).toBe(0);
      expect(health.metrics.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should report healthy status with low error rate', async () => {
      await agent.executeTask({
        id: 'task-5',
        type: 'code',
        description: 'Successful task',
      });

      const health = agent.getHealth();
      expect(health.status).toBe('healthy');
    });
  });

  describe('Shutdown', () => {
    it('should shutdown gracefully', async () => {
      await agent.initialize();
      await agent.shutdown();

      expect(agent.status).toBe('terminated');
    });
  });
});

describe('createHiveAgent', () => {
  it('should create and initialize an agent', async () => {
    const agent = await createHiveAgent({
      id: 'factory-agent-1',
      name: 'Factory Agent',
      type: 'tester',
      capabilities: ['testing'],
      maxConcurrentTasks: 1,
      priority: 3,
    });

    expect(agent.id).toBe('factory-agent-1');
    expect(agent.status).toBe('idle');

    await agent.shutdown();
  });
});
