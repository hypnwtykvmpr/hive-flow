import { Task } from '../../shared/types';
import { LoopState, ICognitiveLoop, LoopConfig, IRateLimiter } from './types';
import { RateLimiter } from './RateLimiter';

/**
 * Agent Cognitive Loop State Machine
 * 
 * Manages states: IDLE -> THINKING -> ACTING -> REFLECTING -> IDLE
 * Handles errors via RECOVERING state and exponential backoff.
 */
export class CognitiveLoop implements ICognitiveLoop {
  private _state: LoopState = LoopState.IDLE;
  private readonly config: Required<LoopConfig>;
  private readonly rateLimiter: IRateLimiter;
  private readonly dlq: Task[] = [];
  private isRunning = false;

  constructor(config: LoopConfig = {}) {
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      initialBackoff: config.initialBackoff ?? 1000,
      stateTimeout: config.stateTimeout ?? 30000,
      rateLimiter: config.rateLimiter ?? { capacity: 10, refillRate: 1 }
    };
    this.rateLimiter = new RateLimiter(this.config.rateLimiter);
  }

  /**
   * Current state of the loop
   */
  public get state(): LoopState {
    return this._state;
  }

  /**
   * Start the loop
   */
  public start(): void {
    this.isRunning = true;
  }

  /**
   * Stop the loop
   */
  public stop(): void {
    this.isRunning = false;
  }

  /**
   * Perform a guarded state transition
   */
  private transition(nextState: LoopState): void {
    const allowed: Record<LoopState, LoopState[]> = {
      [LoopState.IDLE]: [LoopState.THINKING, LoopState.RECOVERING],
      [LoopState.THINKING]: [LoopState.ACTING, LoopState.REFLECTING, LoopState.RECOVERING],
      [LoopState.ACTING]: [LoopState.REFLECTING, LoopState.RECOVERING],
      [LoopState.REFLECTING]: [LoopState.IDLE, LoopState.RECOVERING],
      [LoopState.RECOVERING]: [LoopState.IDLE]
    };

    if (!allowed[this._state].includes(nextState)) {
      throw new Error(`Invalid cognitive loop transition from ${this._state} to ${nextState}`);
    }

    this._state = nextState;
  }

  /**
   * Process a task through the full cognitive cycle
   */
  public async processTask(task: Task): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Cognitive loop is not running. Call start() first.');
    }

    let retries = 0;
    while (retries <= this.config.maxRetries) {
      try {
        await this.runCycle(task);
        return; // Success!
      } catch (error) {
        retries++;
        
        // Final failure -> move to DLQ
        if (retries > this.config.maxRetries) {
          this.dlq.push(task);
          throw new Error(`Task ${task.id} failed fatally after ${this.config.maxRetries} retries: ${error}`);
        }

        // Recoverable failure -> Transition to RECOVERING and wait
        this.transition(LoopState.RECOVERING);
        const waitTime = this.config.initialBackoff * Math.pow(2, retries - 1);

        await new Promise(resolve => setTimeout(resolve, waitTime));

        // Reset to IDLE for next attempt
        this.transition(LoopState.IDLE);
      }
    }
  }

  /**
   * Run a single cognitive cycle for a task
   */
  private async runCycle(task: Task): Promise<void> {
    // 1. IDLE -> THINKING (Requires token)
    await this.rateLimiter.consume(1);
    this.transition(LoopState.THINKING);

    // THINKING Phase (simulated/callback based)
    try {
      if (task.onExecute) {
        const result = task.onExecute();
        if (result instanceof Promise) {
          await this.withTimeout(result, this.config.stateTimeout);
        }
      }

      // 2. THINKING -> ACTING (If tools used, here simulated as always occurring or skipped)
      // For this generic loop, we assume a simple flow if no specific tool calls are present
      const hasActions = task.metadata?.hasActions === true;
      
      if (hasActions) {
        this.transition(LoopState.ACTING);
        // ACTING Phase (Tool execution simulated)
        await new Promise(resolve => setTimeout(resolve, 100)); // Minimal overhead
        this.transition(LoopState.REFLECTING);
      } else {
        this.transition(LoopState.REFLECTING);
      }

      // 3. REFLECTING Phase
      // Process results, determine if done
      await new Promise(resolve => setTimeout(resolve, 50)); 

      // 4. REFLECTING -> IDLE (Completion)
      this.transition(LoopState.IDLE);

    } catch (error) {
      // Any error during the cycle triggers recovery logic handled in processTask
      throw error;
    }
  }

  /**
   * Wrap a promise with a timeout
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Cognitive state timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    
    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
  }

  /**
   * Get copies of tasks that failed fatally
   */
  public getDeadLetterQueue(): Task[] {
    return [...this.dlq];
  }
}

export default CognitiveLoop;
