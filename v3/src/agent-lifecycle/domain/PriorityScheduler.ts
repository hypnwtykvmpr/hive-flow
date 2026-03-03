import { Task } from '../../shared/types';
import { IPriorityScheduler, PriorityLevel } from './types';

/**
 * Multi-level Priority Scheduler with Anti-Starvation Aging
 */
export class PriorityScheduler implements IPriorityScheduler {
  private readonly queues: Map<PriorityLevel, Task[]>;
  private readonly arrivalTimes: Map<string, number>; // taskId -> timestamp
  private dequeueCount = 0;
  private readonly promotionTickInterval = 100;
  private readonly agingThresholdMs = 30000; // 30s

  constructor() {
    this.queues = new Map([
      [PriorityLevel.CRITICAL, []],
      [PriorityLevel.HIGH, []],
      [PriorityLevel.NORMAL, []],
      [PriorityLevel.LOW, []]
    ]);
    this.arrivalTimes = new Map();
  }

  /**
   * Enqueue a task. O(1)
   */
  public enqueue(task: Task, priority?: PriorityLevel): void {
    const resolvedPriority = priority ?? this.inferPriority(task);
    const queue = this.queues.get(resolvedPriority) || this.queues.get(PriorityLevel.NORMAL)!;
    queue.push(task);
    this.arrivalTimes.set(task.id, Date.now());
  }

  /**
   * Infer priority level from task metadata and priority string
   */
  private inferPriority(task: Task): PriorityLevel {
    // Check for explicit critical flag in metadata
    if (task.metadata?.priority === 'critical' || task.type === 'system') {
      return PriorityLevel.CRITICAL;
    }

    const priority = task.priority as string;
    switch (priority) {
      case 'high':
        return PriorityLevel.HIGH;
      case 'low':
        return PriorityLevel.LOW;
      case 'medium':
      default:
        return PriorityLevel.NORMAL;
    }
  }

  /**
   * Dequeue the next task. O(1) across a fixed number of levels.
   */
  public next(): Task | undefined {
    this.dequeueCount++;

    // Periodic anti-starvation check
    if (this.dequeueCount % this.promotionTickInterval === 0) {
      this.promoteOldTasks();
    }

    // Try to get next task from highest priority down
    const levels = [
      PriorityLevel.CRITICAL,
      PriorityLevel.HIGH,
      PriorityLevel.NORMAL,
      PriorityLevel.LOW
    ];

    for (const level of levels) {
      const queue = this.queues.get(level)!;
      if (queue.length > 0) {
        const task = queue.shift();
        if (task) {
          this.arrivalTimes.delete(task.id);
          return task;
        }
      }
    }

    return undefined;
  }

  /**
   * Anti-starvation aging: promotes tasks that have been waiting too long.
   */
  public promoteOldTasks(): void {
    const now = Date.now();

    // Start from LOW (3) and go up to HIGH (1)
    // Tasks in HIGH (1) get promoted to CRITICAL (0)
    // CRITICAL (0) tasks cannot be promoted further
    const levelsToScan = [
      PriorityLevel.LOW,
      PriorityLevel.NORMAL,
      PriorityLevel.HIGH
    ];

    for (const level of levelsToScan) {
      const currentQueue = this.queues.get(level)!;
      if (currentQueue.length === 0) continue;

      const tasksToPromote: Task[] = [];
      const remainingTasks: Task[] = [];

      for (const task of currentQueue) {
        const arrivalTime = this.arrivalTimes.get(task.id) || now;
        if (now - arrivalTime > this.agingThresholdMs) {
          tasksToPromote.push(task);
        } else {
          remainingTasks.push(task);
        }
      }

      if (tasksToPromote.length > 0) {
        this.queues.set(level, remainingTasks);
        if (level === PriorityLevel.CRITICAL) continue;
        const higherLevel = (level - 1) as PriorityLevel;
        const higherQueue = this.queues.get(higherLevel);
        if (!higherQueue) continue;
        higherQueue.push(...tasksToPromote);
      }
    }
  }

  /**
   * Total number of pending tasks
   */
  public get length(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * Clear all tasks
   */
  public clear(): void {
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
    this.arrivalTimes.clear();
    this.dequeueCount = 0;
  }
}

export default PriorityScheduler;
