/**
 * V3 Claude-Flow Task Manager Unit Tests
 *
 * London School TDD - Behavior Verification
 * Tests task lifecycle management
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMock, type MockedInterface, InteractionRecorder } from '../../helpers/create-mock';
import { taskDefinitions, taskInstances, createTaskDefinition } from '../../fixtures/tasks';

/**
 * Task manager interface (to be implemented)
 */
interface ITaskManager {
  create(definition: TaskDefinition): Promise<Task>;
  execute(taskId: string): Promise<TaskResult>;
  cancel(taskId: string): Promise<void>;
  getStatus(taskId: string): Promise<TaskStatus>;
  list(filter?: TaskFilter): Promise<Task[]>;
}

/**
 * Task repository interface (collaborator)
 */
interface ITaskRepository {
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | null>;
  findAll(filter?: TaskFilter): Promise<Task[]>;
  update(id: string, updates: Partial<Task>): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Task executor interface (collaborator)
 */
interface ITaskExecutor {
  run(task: Task): Promise<TaskResult>;
  abort(taskId: string): Promise<void>;
}

/**
 * Event publisher interface (collaborator)
 */
interface IEventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

interface TaskDefinition {
  name: string;
  type: string;
  payload: unknown;
  priority?: number;
}

interface Task {
  id: string;
  name: string;
  type: string;
  status: TaskStatus;
  payload: unknown;
  priority: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

interface TaskResult {
  taskId: string;
  success: boolean;
  output?: unknown;
  error?: Error;
  duration: number;
}

interface TaskFilter {
  status?: TaskStatus;
  type?: string;
  priority?: number;
}

interface DomainEvent {
  type: string;
  payload: unknown;
  timestamp: Date;
}

/**
 * Task manager implementation for testing
 */
class TaskManager implements ITaskManager {
  constructor(
    private readonly repository: ITaskRepository,
    private readonly executor: ITaskExecutor,
    private readonly eventPublisher: IEventPublisher,
    private readonly idGenerator: () => string = () => `task-${Date.now()}`
  ) {}

  async create(definition: TaskDefinition): Promise<Task> {
    if (!definition.name || !definition.type) {
      throw new Error('Task name and type are required');
    }

    const task: Task = {
      id: this.idGenerator(),
      name: definition.name,
      type: definition.type,
      status: 'pending',
      payload: definition.payload,
      priority: definition.priority ?? 50,
      createdAt: new Date(),
    };

    await this.repository.save(task);

    await this.eventPublisher.publish({
      type: 'TaskCreated',
      payload: { taskId: task.id, name: task.name, type: task.type },
      timestamp: new Date(),
    });

    return task;
  }

  async execute(taskId: string): Promise<TaskResult> {
    const task = await this.repository.findById(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== 'pending') {
      throw new Error(`Task cannot be executed: current status is ${task.status}`);
    }

    // Update status to running
    await this.repository.update(taskId, {
      status: 'running',
      startedAt: new Date(),
    });

    await this.eventPublisher.publish({
      type: 'TaskStarted',
      payload: { taskId },
      timestamp: new Date(),
    });

    const startTime = Date.now();

    try {
      const result = await this.executor.run({ ...task, status: 'running' });

      // Update status to completed
      await this.repository.update(taskId, {
        status: 'completed',
        completedAt: new Date(),
      });

      await this.eventPublisher.publish({
        type: 'TaskCompleted',
        payload: { taskId, success: true, duration: result.duration },
        timestamp: new Date(),
      });

      return result;
    } catch (error) {
      // Update status to failed
      await this.repository.update(taskId, {
        status: 'failed',
        completedAt: new Date(),
      });

      await this.eventPublisher.publish({
        type: 'TaskFailed',
        payload: { taskId, error: (error as Error).message },
        timestamp: new Date(),
      });

      return {
        taskId,
        success: false,
        error: error as Error,
        duration: Date.now() - startTime,
      };
    }
  }

  async cancel(taskId: string): Promise<void> {
    const task = await this.repository.findById(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error(`Cannot cancel task: current status is ${task.status}`);
    }

    if (task.status === 'running') {
      await this.executor.abort(taskId);
    }

    await this.repository.update(taskId, {
      status: 'cancelled',
      completedAt: new Date(),
    });

    await this.eventPublisher.publish({
      type: 'TaskCancelled',
      payload: { taskId },
      timestamp: new Date(),
    });
  }

  async getStatus(taskId: string): Promise<TaskStatus> {
    const task = await this.repository.findById(taskId);

    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return task.status;
  }

  async list(filter?: TaskFilter): Promise<Task[]> {
    return this.repository.findAll(filter);
  }
}

describe('TaskManager', () => {
  let mockRepository: MockedInterface<ITaskRepository>;
  let mockExecutor: MockedInterface<ITaskExecutor>;
  let mockEventPublisher: MockedInterface<IEventPublisher>;
  let taskManager: TaskManager;
  let interactionRecorder: InteractionRecorder;
  const mockIdGenerator = vi.fn().mockReturnValue('task-123');

  beforeEach(() => {
    mockRepository = createMock<ITaskRepository>();
    mockExecutor = createMock<ITaskExecutor>();
    mockEventPublisher = createMock<IEventPublisher>();
    interactionRecorder = new InteractionRecorder();

    // Configure default mock behavior
    mockRepository.save.mockResolvedValue(undefined);
    mockRepository.findById.mockResolvedValue(null);
    mockRepository.findAll.mockResolvedValue([]);
    mockRepository.update.mockResolvedValue(undefined);
    mockRepository.delete.mockResolvedValue(undefined);

    mockExecutor.run.mockResolvedValue({
      taskId: 'task-123',
      success: true,
      duration: 100,
    });
    mockExecutor.abort.mockResolvedValue(undefined);

    mockEventPublisher.publish.mockResolvedValue(undefined);

    // Track interactions
    interactionRecorder.track('repository', mockRepository);
    interactionRecorder.track('executor', mockExecutor);
    interactionRecorder.track('events', mockEventPublisher);

    taskManager = new TaskManager(
      mockRepository,
      mockExecutor,
      mockEventPublisher,
      mockIdGenerator
    );
  });

  describe('create', () => {
    it('should save task to repository', async () => {
      // Given
      const definition = taskDefinitions.implementation;

      // When
      await taskManager.create(definition);

      // Then
      expect(mockRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: definition.name,
          type: definition.type,
          status: 'pending',
        })
      );
    });

    it('should publish TaskCreated event', async () => {
      // Given
      const definition = taskDefinitions.implementation;

      // When
      await taskManager.create(definition);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TaskCreated',
          payload: expect.objectContaining({
            taskId: 'task-123',
            name: definition.name,
          }),
        })
      );
    });

    it('should save before publishing event', async () => {
      // Given
      const definition = taskDefinitions.implementation;

      // When
      await taskManager.create(definition);

      // Then
      const interactions = interactionRecorder.getInteractionOrder();
      const saveIndex = interactions.indexOf('repository.save');
      const publishIndex = interactions.indexOf('events.publish');

      expect(saveIndex).toBeLessThan(publishIndex);
    });

    it('should return created task with generated id', async () => {
      // Given
      const definition = taskDefinitions.implementation;

      // When
      const result = await taskManager.create(definition);

      // Then
      expect(result.id).toBe('task-123');
      expect(result.name).toBe(definition.name);
      expect(result.type).toBe(definition.type);
      expect(result.status).toBe('pending');
    });

    it('should use default priority when not specified', async () => {
      // Given
      const definition = { name: 'Test', type: 'test', payload: {} };

      // When
      const result = await taskManager.create(definition);

      // Then
      expect(result.priority).toBe(50);
    });

    it('should use provided priority', async () => {
      // Given
      const definition = { name: 'Test', type: 'test', payload: {}, priority: 100 };

      // When
      const result = await taskManager.create(definition);

      // Then
      expect(result.priority).toBe(100);
    });

    it('should throw error for missing name', async () => {
      // Given
      const definition = { name: '', type: 'test', payload: {} };

      // When/Then
      await expect(taskManager.create(definition)).rejects.toThrow(
        'Task name and type are required'
      );
    });

    it('should throw error for missing type', async () => {
      // Given
      const definition = { name: 'Test', type: '', payload: {} };

      // When/Then
      await expect(taskManager.create(definition)).rejects.toThrow(
        'Task name and type are required'
      );
    });
  });

  describe('execute', () => {
    it('should find task in repository', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.execute(task.id);

      // Then
      expect(mockRepository.findById).toHaveBeenCalledWith(task.id);
    });

    it('should update status to running before execution', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.execute(task.id);

      // Then
      expect(mockRepository.update).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({
          status: 'running',
        })
      );
    });

    it('should publish TaskStarted event', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.execute(task.id);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TaskStarted',
          payload: { taskId: task.id },
        })
      );
    });

    it('should call executor run with task', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.execute(task.id);

      // Then
      expect(mockExecutor.run).toHaveBeenCalledWith(
        expect.objectContaining({
          id: task.id,
          status: 'running',
        })
      );
    });

    it('should update status to completed on success', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);
      mockExecutor.run.mockResolvedValue({
        taskId: task.id,
        success: true,
        duration: 100,
      });

      // When
      await taskManager.execute(task.id);

      // Then
      const updateCalls = mockRepository.update.mock.calls;
      const finalUpdate = updateCalls[updateCalls.length - 1];
      expect(finalUpdate[1]).toMatchObject({ status: 'completed' });
    });

    it('should publish TaskCompleted event on success', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.execute(task.id);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TaskCompleted',
        })
      );
    });

    it('should update status to failed on error', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);
      mockExecutor.run.mockRejectedValue(new Error('Execution failed'));

      // When
      await taskManager.execute(task.id);

      // Then
      const updateCalls = mockRepository.update.mock.calls;
      const finalUpdate = updateCalls[updateCalls.length - 1];
      expect(finalUpdate[1]).toMatchObject({ status: 'failed' });
    });

    it('should publish TaskFailed event on error', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);
      mockExecutor.run.mockRejectedValue(new Error('Execution failed'));

      // When
      await taskManager.execute(task.id);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TaskFailed',
          payload: expect.objectContaining({
            error: 'Execution failed',
          }),
        })
      );
    });

    it('should return result with error on failure', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);
      const error = new Error('Execution failed');
      mockExecutor.run.mockRejectedValue(error);

      // When
      const result = await taskManager.execute(task.id);

      // Then
      expect(result.success).toBe(false);
      expect(result.error).toBe(error);
    });

    it('should throw error for non-existent task', async () => {
      // Given
      mockRepository.findById.mockResolvedValue(null);

      // When/Then
      await expect(taskManager.execute('non-existent')).rejects.toThrow(
        'Task not found: non-existent'
      );
    });

    it('should throw error for already running task', async () => {
      // Given
      const task = { ...taskInstances.runningCodeReview };
      mockRepository.findById.mockResolvedValue(task);

      // When/Then
      await expect(taskManager.execute(task.id)).rejects.toThrow(
        'Task cannot be executed: current status is running'
      );
    });

    it('should throw error for completed task', async () => {
      // Given
      const task = { ...taskInstances.completedUnitTesting };
      mockRepository.findById.mockResolvedValue(task);

      // When/Then
      await expect(taskManager.execute(task.id)).rejects.toThrow(
        'Task cannot be executed: current status is completed'
      );
    });
  });

  describe('cancel', () => {
    it('should find task in repository', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.cancel(task.id);

      // Then
      expect(mockRepository.findById).toHaveBeenCalledWith(task.id);
    });

    it('should update status to cancelled', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.cancel(task.id);

      // Then
      expect(mockRepository.update).toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({
          status: 'cancelled',
        })
      );
    });

    it('should abort running task', async () => {
      // Given
      const task = { ...taskInstances.runningCodeReview };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.cancel(task.id);

      // Then
      expect(mockExecutor.abort).toHaveBeenCalledWith(task.id);
    });

    it('should not abort pending task', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.cancel(task.id);

      // Then
      expect(mockExecutor.abort).not.toHaveBeenCalled();
    });

    it('should publish TaskCancelled event', async () => {
      // Given
      const task = { ...taskInstances.pendingSecurityScan };
      mockRepository.findById.mockResolvedValue(task);

      // When
      await taskManager.cancel(task.id);

      // Then
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'TaskCancelled',
          payload: { taskId: task.id },
        })
      );
    });

    it('should throw error for non-existent task', async () => {
      // Given
      mockRepository.findById.mockResolvedValue(null);

      // When/Then
      await expect(taskManager.cancel('non-existent')).rejects.toThrow(
        'Task not found: non-existent'
      );
    });

    it('should throw error for already completed task', async () => {
      // Given
      const task = { ...taskInstances.completedUnitTesting };
      mockRepository.findById.mockResolvedValue(task);

      // When/Then
      await expect(taskManager.cancel(task.id)).rejects.toThrow(
        'Cannot cancel task: current status is completed'
      );
    });

    it('should throw error for already cancelled task', async () => {
      // Given
      const task = { ...taskInstances.cancelledSwarmCoordination };
      mockRepository.findById.mockResolvedValue(task);

      // When/Then
      await expect(taskManager.cancel(task.id)).rejects.toThrow(
        'Cannot cancel task: current status is cancelled'
      );
    });
  });

  describe('getStatus', () => {
    it('should return task status from repository', async () => {
      // Given
      const task = { ...taskInstances.runningCodeReview };
      mockRepository.findById.mockResolvedValue(task);

      // When
      const result = await taskManager.getStatus(task.id);

      // Then
      expect(result).toBe('running');
    });

    it('should throw error for non-existent task', async () => {
      // Given
      mockRepository.findById.mockResolvedValue(null);

      // When/Then
      await expect(taskManager.getStatus('non-existent')).rejects.toThrow(
        'Task not found: non-existent'
      );
    });
  });

  describe('list', () => {
    it('should delegate to repository findAll', async () => {
      // Given
      const filter = { status: 'pending' as TaskStatus };

      // When
      await taskManager.list(filter);

      // Then
      expect(mockRepository.findAll).toHaveBeenCalledWith(filter);
    });

    it('should return all tasks when no filter', async () => {
      // Given
      const tasks = [taskInstances.pendingSecurityScan, taskInstances.runningCodeReview];
      mockRepository.findAll.mockResolvedValue(tasks);

      // When
      const result = await taskManager.list();

      // Then
      expect(result).toEqual(tasks);
    });
  });
});
