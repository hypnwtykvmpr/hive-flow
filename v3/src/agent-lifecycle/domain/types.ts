import { Task } from '../../shared/types';

/**
 * States for the Agent Cognitive Loop
 */
export enum LoopState {
  IDLE = 'IDLE',
  THINKING = 'THINKING',
  ACTING = 'ACTING',
  REFLECTING = 'REFLECTING',
  RECOVERING = 'RECOVERING'
}

/**
 * Priority levels for the scheduler
 */
export enum PriorityLevel {
  CRITICAL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3
}

/**
 * Interface for the Priority Scheduler
 */
export interface IPriorityScheduler {
  /**
   * Enqueue a task with optional priority level
   */
  enqueue(task: Task, priority?: PriorityLevel): void;

  /**
   * Dequeue the next highest priority task
   */
  next(): Task | undefined;

  /**
   * Promote tasks that have been waiting too long (anti-starvation)
   */
  promoteOldTasks(): void;

  /**
   * Get total number of pending tasks
   */
  readonly length: number;

  /**
   * Clear all tasks
   */
  clear(): void;
}

/**
 * Interface for the Cognitive Loop
 */
export interface ICognitiveLoop {
  /**
   * Current state of the loop
   */
  readonly state: LoopState;

  /**
   * Start the loop
   */
  start(): void;

  /**
   * Stop the loop
   */
  stop(): void;

  /**
   * Process a task through the cognitive cycle
   */
  processTask(task: Task): Promise<void>;
}

/**
 * Interface for the Rate Limiter
 */
export interface IRateLimiter {
  /**
   * Attempt to consume tokens. Returns true if successful.
   */
  tryConsume(tokens?: number): boolean;

  /**
   * Wait until tokens are available and consume them.
   */
  consume(tokens?: number): Promise<void>;

  /**
   * Current number of available tokens
   */
  getAvailableTokens(): number;
}

/**
 * Configuration for the Rate Limiter
 */
export interface RateLimiterConfig {
  capacity: number;
  refillRate: number; // tokens per second
}

/**
 * Configuration for the Cognitive Loop
 */
export interface LoopConfig {
  maxRetries?: number;
  initialBackoff?: number; // ms
  stateTimeout?: number; // ms
  rateLimiter?: RateLimiterConfig;
}
