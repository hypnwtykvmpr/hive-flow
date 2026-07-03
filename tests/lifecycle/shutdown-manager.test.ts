/**
 * ShutdownManager Tests
 * Tests for two-stage Ctrl+C, process cleanup, and resource management.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// Mock modules before importing
vi.mock('node:child_process');
vi.mock('node:fs/promises');

// Import after mocking
import { ShutdownManager, ShutdownEvents } from '../../cli/src/shared/lifecycle/shutdown-manager.js';
import { ProcessGroupManager } from '../../cli/src/shared/lifecycle/process-group-manager.js';
import { ResourceCleaner } from '../../cli/src/shared/lifecycle/resource-cleaner.js';
import type { IEventBus } from '../../cli/src/shared/core/interfaces/event.interface.js';

/** Create a mock EventBus */
function createMockEventBus(): IEventBus & { emit: Mock } {
  return {
    emit: vi.fn(),
    emitAsync: vi.fn(),
    on: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    once: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
    eventNames: vi.fn().mockReturnValue([]),
  } as unknown as IEventBus & { emit: Mock };
}

describe('ShutdownManager', () => {
  let eventBus: IEventBus & { emit: Mock };

  beforeEach(() => {
    ShutdownManager.reset();
    eventBus = createMockEventBus();
  });

  describe('setup', () => {
    it('should initialize without errors', () => {
      expect(() => {
        ShutdownManager.setup(eventBus, { shouldExit: false });
      }).not.toThrow();
    });

    it('should not be shutting down initially', () => {
      ShutdownManager.setup(eventBus, { shouldExit: false });
      expect(ShutdownManager.shuttingDown).toBe(false);
    });
  });

  describe('triggerShutdown', () => {
    it('should emit SHUTDOWN_INITIATED event', async () => {
      ShutdownManager.setup(eventBus, { shouldExit: false });

      await ShutdownManager.triggerShutdown('Test shutdown');

      expect(eventBus.emit).toHaveBeenCalledWith(
        ShutdownEvents.SHUTDOWN_INITIATED,
        expect.objectContaining({ reason: 'Test shutdown' }),
      );
    });

    it('should emit SHUTDOWN_COMPLETE event', async () => {
      ShutdownManager.setup(eventBus, { shouldExit: false });

      await ShutdownManager.triggerShutdown('Test shutdown');

      expect(eventBus.emit).toHaveBeenCalledWith(
        ShutdownEvents.SHUTDOWN_COMPLETE,
        expect.objectContaining({ reason: 'Test shutdown' }),
      );
    });

    it('should set shuttingDown to true', async () => {
      ShutdownManager.setup(eventBus, { shouldExit: false });

      await ShutdownManager.triggerShutdown();

      expect(ShutdownManager.shuttingDown).toBe(true);
    });

    it('should be idempotent (second call is a no-op)', async () => {
      ShutdownManager.setup(eventBus, { shouldExit: false });

      await ShutdownManager.triggerShutdown('First');
      await ShutdownManager.triggerShutdown('Second');

      // SHUTDOWN_INITIATED should only be emitted once
      const initiatedCalls = (eventBus.emit as Mock).mock.calls.filter(
        ([event]: [string]) => event === ShutdownEvents.SHUTDOWN_INITIATED,
      );
      expect(initiatedCalls).toHaveLength(1);
    });

    it('should call terminateAll function if registered', async () => {
      const terminateAll = vi.fn().mockResolvedValue(undefined);
      ShutdownManager.setup(eventBus, { shouldExit: false });
      ShutdownManager.setTerminateAll(terminateAll);

      await ShutdownManager.triggerShutdown('Test');

      expect(terminateAll).toHaveBeenCalledWith('Test');
    });

    it('should run beforeShutdown callbacks', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      ShutdownManager.setup(eventBus, { shouldExit: false });
      ShutdownManager.onBeforeShutdown(callback);

      await ShutdownManager.triggerShutdown();

      expect(callback).toHaveBeenCalled();
    });

    it('should not crash if beforeShutdown callback throws', async () => {
      ShutdownManager.setup(eventBus, { shouldExit: false });
      ShutdownManager.onBeforeShutdown(async () => {
        throw new Error('Callback failed');
      });

      await expect(ShutdownManager.triggerShutdown()).resolves.not.toThrow();
    });
  });
});

describe('ProcessGroupManager', () => {
  it('should start with zero tracked processes', () => {
    expect(ProcessGroupManager.size).toBe(0);
  });

  it('should track and untrack processes', () => {
    const mockChild = {
      pid: 12345,
      killed: false,
      once: vi.fn(),
      kill: vi.fn(),
    } as unknown as import('node:child_process').ChildProcess;

    ProcessGroupManager.track(mockChild, 'test-process');
    expect(ProcessGroupManager.size).toBe(1);

    ProcessGroupManager.untrack(12345);
    expect(ProcessGroupManager.size).toBe(0);
  });

  it('should return all tracked processes', () => {
    const mockChild = {
      pid: 99999,
      killed: false,
      once: vi.fn(),
      kill: vi.fn(),
    } as unknown as import('node:child_process').ChildProcess;

    ProcessGroupManager.track(mockChild, 'labeled');
    const all = ProcessGroupManager.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].label).toBe('labeled');

    // Cleanup
    ProcessGroupManager.untrack(99999);
  });
});

describe('ResourceCleaner', () => {
  it('should run registered cleanup handlers', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    ResourceCleaner.register('test-handler', handler);

    const result = await ResourceCleaner.cleanAll();

    expect(handler).toHaveBeenCalled();
    expect(result.succeeded).toContain('test-handler');
  });

  it('should report failed handlers', async () => {
    ResourceCleaner.register('fail-handler', async () => {
      throw new Error('fail');
    });

    const result = await ResourceCleaner.cleanAll();

    expect(result.failed).toContain('fail-handler');
  });

  it('should run handlers in priority order', async () => {
    const order: string[] = [];
    ResourceCleaner.register('low', async () => { order.push('low'); }, 200);
    ResourceCleaner.register('high', async () => { order.push('high'); }, 10);
    ResourceCleaner.register('medium', async () => { order.push('medium'); }, 100);

    await ResourceCleaner.cleanAll();

    expect(order).toEqual(['high', 'medium', 'low']);
  });

  it('cleanAll() is idempotent when called concurrently', async () => {
    const handler = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 50)));
    ResourceCleaner.register('concurrent-handler', handler);

    // Call twice simultaneously
    const [result1, result2] = await Promise.all([
      ResourceCleaner.cleanAll(),
      ResourceCleaner.cleanAll(),
    ]);

    // Only one should have actually run the handler
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result1.succeeded).toContain('concurrent-handler');
    expect(result2.succeeded).toEqual([]); // Second call returns empty results as it's already cleaning or done
  });
});
