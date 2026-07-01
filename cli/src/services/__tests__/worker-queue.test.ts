import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { propertyRunsFromEnv } from '../../__tests__/property-runs.js';
import { WorkerQueue, type QueueTask } from '../worker-queue.js';
import type { HeadlessExecutionResult, HeadlessWorkerType } from '../headless-worker-executor.js';

const PROPERTY_RUNS = propertyRunsFromEnv(50);

function resultFor(task: QueueTask, output = 'ok'): HeadlessExecutionResult {
  return {
    success: true,
    output,
    durationMs: 1,
    model: 'sonnet',
    sandboxMode: 'strict',
    workerType: task.workerType,
    timestamp: new Date(),
    executionId: `execution-${task.id}`,
  };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WorkerQueue concurrency and timing', () => {
  it('dequeues each concurrently enqueued task exactly once across scheduled races', async () => {
    const workerTypes: HeadlessWorkerType[] = ['audit', 'optimize', 'testgaps'];

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.constantFrom(...workerTypes), { minLength: 1, maxLength: 12 }),
        async (scheduler, taskTypes) => {
          const queue = new WorkerQueue({ heartbeatIntervalMs: 10_000 });
          const enqueuedIds: string[] = [];
          const dequeuedIds: string[] = [];
          const scheduledEnqueue = scheduler.scheduleFunction(async (workerType: HeadlessWorkerType, index: number) => {
            const taskId = await queue.enqueue(workerType, { prompt: `task-${index}` });
            enqueuedIds.push(taskId);
          });
          const scheduledDequeue = scheduler.scheduleFunction(async (index: number) => {
            const task = await queue.dequeue(workerTypes);
            if (task) {
              dequeuedIds.push(task.id);
              await queue.complete(task.id, resultFor(task));
            }
            return index;
          });

          const enqueueOps = taskTypes.map((workerType, index) => scheduledEnqueue(workerType, index));
          const earlyDequeueOps = taskTypes.map((_, index) => scheduledDequeue(index));

          await scheduler.waitIdle();
          await Promise.all([...enqueueOps, ...earlyDequeueOps]);

          let task: QueueTask | null;
          while ((task = await queue.dequeue(workerTypes))) {
            dequeuedIds.push(task.id);
            await queue.complete(task.id, resultFor(task));
          }

          expect(new Set(dequeuedIds).size).toBe(dequeuedIds.length);
          expect(dequeuedIds.sort()).toEqual(enqueuedIds.sort());

          await queue.shutdown();
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: 31_001 },
    );
  });

  it('does not hand the same pending task to duplicate concurrent dequeues', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (scheduler) => {
        const queue = new WorkerQueue();
        const taskId = await queue.enqueue('audit', { prompt: 'single task' });
        const scheduledDequeue = scheduler.scheduleFunction(async () => queue.dequeue(['audit']));
        const dequeueOps = Array.from({ length: 8 }, () => scheduledDequeue());
        await scheduler.waitIdle();
        const results = await Promise.all(dequeueOps);

        const claimedTasks = results.filter((task): task is QueueTask => task !== null);
        expect(claimedTasks.map((task) => task.id)).toEqual([taskId]);
        expect(results.filter((task) => task === null)).toHaveLength(7);

        await queue.complete(taskId, resultFor(claimedTasks[0]));
        await queue.shutdown();
      }),
      { numRuns: PROPERTY_RUNS, seed: 31_002 },
    );
  });

  it('preserves priority order and ids during scheduled enqueue bursts', async () => {
    const priorities = ['critical', 'high', 'normal', 'low'] as const;

    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.constantFrom(...priorities), { minLength: 8, maxLength: 32 }),
        async (scheduler, taskPriorities) => {
          const queue = new WorkerQueue();
          const enqueued: Array<{ id: string; priority: (typeof priorities)[number]; index: number }> = [];
          const scheduledEnqueue = scheduler.scheduleFunction(
            async (priority: (typeof priorities)[number], index: number) => {
              const id = await queue.enqueue('audit', { prompt: `burst-${index}` }, { priority });
              enqueued.push({ id, priority, index });
            },
          );

          const enqueueOps = taskPriorities.map((priority, index) => scheduledEnqueue(priority, index));
          await scheduler.waitAll();
          await Promise.all(enqueueOps);

          const drained: QueueTask[] = [];
          let task: QueueTask | null;
          while ((task = await queue.dequeue(['audit']))) {
            drained.push(task);
            await queue.complete(task.id, resultFor(task));
          }

          const priorityRank = new Map(priorities.map((priority, index) => [priority, index]));
          const expected = enqueued
            .map((entry, insertionOrder) => ({ ...entry, insertionOrder }))
            .sort((left, right) => {
              const byPriority = priorityRank.get(left.priority)! - priorityRank.get(right.priority)!;
              return byPriority === 0 ? left.insertionOrder - right.insertionOrder : byPriority;
            });

          expect(drained.map((task) => task.id)).toEqual(expected.map((task) => task.id));
          expect(new Set(drained.map((task) => task.id)).size).toBe(enqueued.length);

          await queue.shutdown();
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: 31_003 },
    );
  });

  it('emits enqueue, dequeue, and completion events in operation order', async () => {
    const queue = new WorkerQueue();
    const events: string[] = [];
    queue.on('taskEnqueued', ({ taskId }) => events.push(`enqueued:${taskId}`));
    queue.on('taskDequeued', ({ taskId }) => events.push(`dequeued:${taskId}`));
    queue.on('taskCompleted', ({ taskId }) => events.push(`completed:${taskId}`));

    const taskId = await queue.enqueue('audit');
    const task = await queue.dequeue(['audit']);
    expect(task?.id).toBe(taskId);

    await queue.complete(taskId, resultFor(task!));

    expect(events).toEqual([`enqueued:${taskId}`, `dequeued:${taskId}`, `completed:${taskId}`]);

    await queue.shutdown();
  });

  it('uses retry backoff timers and preserves failure event order without real sleeps', async () => {
    vi.useFakeTimers();

    const queue = new WorkerQueue();
    const events: string[] = [];
    queue.on('taskDequeued', ({ taskId }) => events.push(`dequeued:${taskId}`));
    queue.on('taskRetrying', ({ taskId, retryCount, delay }) => events.push(`retrying:${taskId}:${retryCount}:${delay}`));
    queue.on('taskFailed', ({ taskId, error }) => events.push(`failed:${taskId}:${error}`));

    const taskId = await queue.enqueue('audit', {}, { maxRetries: 1 });
    const task = await queue.dequeue(['audit']);
    expect(task?.id).toBe(taskId);

    await queue.fail(taskId, 'first failure');
    expect(events).toEqual([`dequeued:${taskId}`, `retrying:${taskId}:1:2000`]);
    expect(await queue.dequeue(['audit'])).toBeNull();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(await queue.dequeue(['audit'])).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    const retriedTask = await queue.dequeue(['audit']);
    expect(retriedTask?.id).toBe(taskId);

    await queue.fail(taskId, 'second failure');
    expect(events).toEqual([
      `dequeued:${taskId}`,
      `retrying:${taskId}:1:2000`,
      `dequeued:${taskId}`,
      `failed:${taskId}:second failure`,
    ]);

    const failedTask = await queue.getTask(taskId);
    expect(failedTask?.status).toBe('failed');
    expect(failedTask?.error).toBe('second failure');

    await queue.shutdown();
  });

  it('propagates handler errors into failed task state and taskFailed events', async () => {
    vi.useFakeTimers();

    const queue = new WorkerQueue();
    const events: string[] = [];
    queue.on('error', ({ error }) => events.push(`error:${error}`));
    queue.on('taskDequeued', ({ taskId }) => events.push(`dequeued:${taskId}`));
    queue.on('taskFailed', ({ taskId, error }) => events.push(`failed:${taskId}:${error}`));

    const taskId = await queue.enqueue('audit', {}, { maxRetries: 0 });
    await queue.start(
      ['audit'],
      async () => {
        throw new Error('handler exploded');
      },
      { maxConcurrent: 1 },
    );

    await flushMicrotasks();

    expect(events).toEqual([`dequeued:${taskId}`, `failed:${taskId}:handler exploded`]);
    expect(await queue.getTask(taskId)).toMatchObject({
      id: taskId,
      status: 'failed',
      error: 'handler exploded',
    });

    await queue.shutdown();
  });

  it('applies maxConcurrent back-pressure until an active task completes', async () => {
    vi.useFakeTimers();

    const queue = new WorkerQueue();
    const started: string[] = [];
    const completions = new Map<string, (result: HeadlessExecutionResult) => void>();

    const ids = await Promise.all([
      queue.enqueue('audit', { prompt: 'one' }),
      queue.enqueue('audit', { prompt: 'two' }),
      queue.enqueue('audit', { prompt: 'three' }),
    ]);

    await queue.start(
      ['audit'],
      async (task) => {
        started.push(task.id);
        return new Promise<HeadlessExecutionResult>((resolve) => {
          completions.set(task.id, resolve);
        });
      },
      { maxConcurrent: 2 },
    );

    await flushMicrotasks();
    expect(started).toHaveLength(2);
    expect(new Set(started).size).toBe(2);
    expect(started.every((id) => ids.includes(id))).toBe(true);

    await vi.advanceTimersByTimeAsync(99);
    expect(started).toHaveLength(2);

    const firstStartedId = started[0];
    completions.get(firstStartedId)?.(resultFor((await queue.getTask(firstStartedId))!, 'first done'));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(started).toHaveLength(3);
    expect(new Set(started)).toEqual(new Set(ids));

    for (const id of started.slice(1)) {
      completions.get(id)?.(resultFor((await queue.getTask(id))!, `${id} done`));
    }
    await flushMicrotasks();

    for (const id of ids) {
      expect((await queue.getTask(id))?.status).toBe('completed');
    }

    await queue.shutdown();
  });

  it('waits for active processing to drain before shutdown events without real sleeps', async () => {
    vi.useFakeTimers();

    const queue = new WorkerQueue({ heartbeatIntervalMs: 10_000 });
    const events: string[] = [];
    let resolveHandler: ((result: HeadlessExecutionResult) => void) | undefined;

    queue.on('taskCompleted', ({ taskId }) => events.push(`completed:${taskId}`));
    queue.on('taskFailed', ({ taskId, error }) => events.push(`failed:${taskId}:${error}`));
    queue.on('workerUnregistered', ({ workerId }) => events.push(`unregistered:${workerId}`));
    queue.on('shutdown', () => events.push('shutdown'));

    const taskId = await queue.enqueue('audit');
    await queue.start(
      ['audit'],
      async (task) => new Promise<HeadlessExecutionResult>((resolve) => {
        resolveHandler = () => resolve(resultFor(task, 'drained'));
      }),
      { maxConcurrent: 1 },
    );
    await flushMicrotasks();

    const shutdown = queue.shutdown();
    await flushMicrotasks();

    resolveHandler?.(resultFor((await queue.getTask(taskId))!, 'drained'));
    await flushMicrotasks();
    expect(events).toEqual([`completed:${taskId}`]);

    await vi.advanceTimersByTimeAsync(999);
    expect(events).toEqual([`completed:${taskId}`]);

    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(events).toEqual([
      `completed:${taskId}`,
      expect.stringMatching(/^unregistered:worker-/),
      'shutdown',
    ]);
    expect((await queue.getTask(taskId))?.status).toBe('completed');
  });

  it('force-fails still-active tasks after the shutdown drain timeout', async () => {
    vi.useFakeTimers();

    const queue = new WorkerQueue({ heartbeatIntervalMs: 10_000 });
    const events: string[] = [];
    queue.on('taskFailed', ({ taskId, error }) => events.push(`failed:${taskId}:${error}`));
    queue.on('workerUnregistered', () => events.push('unregistered'));
    queue.on('shutdown', () => events.push('shutdown'));

    const taskId = await queue.enqueue('audit', {}, { maxRetries: 0 });
    await queue.start(
      ['audit'],
      async () => new Promise<HeadlessExecutionResult>(() => {}),
      { maxConcurrent: 1 },
    );
    await flushMicrotasks();

    const shutdown = queue.shutdown();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(events).toEqual([]);
    expect((await queue.getTask(taskId))?.status).toBe('processing');

    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(events).toEqual([`failed:${taskId}:Worker shutdown`, 'unregistered', 'shutdown']);
    expect(await queue.getTask(taskId)).toMatchObject({
      id: taskId,
      status: 'failed',
      error: 'Worker shutdown',
    });
  });

  it('emits start loop errors before backing off and continues polling after the error timer', async () => {
    vi.useFakeTimers();

    const queue = new WorkerQueue();
    const events: string[] = [];
    let dequeueCalls = 0;
    const originalDequeue = queue.dequeue.bind(queue);

    queue.on('workerRegistered', () => events.push('registered'));
    queue.on('error', ({ error }) => events.push(`error:${error}`));

    vi.spyOn(queue, 'dequeue').mockImplementation(async (workerTypes) => {
      dequeueCalls++;
      if (dequeueCalls === 1) {
        throw new Error('dequeue failed');
      }
      return originalDequeue(workerTypes);
    });

    await queue.start(['audit'], async (task) => resultFor(task), { maxConcurrent: 1 });
    await flushMicrotasks();

    expect(events).toEqual(['registered', 'error:dequeue failed']);
    expect(dequeueCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(dequeueCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(dequeueCalls).toBe(2);

    await queue.shutdown();
  });

  it('keeps cancelled duplicate entries from being processed when an id remains in the queue', async () => {
    const queue = new WorkerQueue();
    const taskId = await queue.enqueue('audit');

    expect(await queue.cancel(taskId)).toBe(true);
    expect(await queue.dequeue(['audit'])).toBeNull();
    expect((await queue.getTask(taskId))?.status).toBe('cancelled');

    await queue.shutdown();
  });
});
