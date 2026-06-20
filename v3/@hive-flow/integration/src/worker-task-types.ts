/**
 * Worker task types — neutral home for the agent task/result/status/message
 * contracts used across the worker subsystem.
 *
 * These types were historically declared in `agentic-flow-agent.ts`. They are
 * generic worker-execution contracts with no dependency on the (removed)
 * `agentic-flow` package, so they live here under a neutral filename to keep
 * the worker files (`worker-base`, `worker-pool`, `specialized-worker`,
 * `long-running-worker`, `provider-adapter`) free of legacy import targets.
 *
 * @module v3/integration/worker-task-types
 */

/**
 * Agent status in the system
 */
export type AgentStatus = 'spawning' | 'active' | 'idle' | 'busy' | 'error' | 'terminated';

/**
 * Task interface for agent execution
 */
export interface Task {
  /** Unique task identifier */
  id: string;
  /** Task type/category */
  type: string;
  /** Task description */
  description: string;
  /** Task input data */
  input?: Record<string, unknown>;
  /** Task priority (0-10) */
  priority?: number;
  /** Task timeout in milliseconds */
  timeout?: number;
  /** Task metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Task result interface
 */
export interface TaskResult {
  /** Task identifier */
  taskId: string;
  /** Success status */
  success: boolean;
  /** Result data */
  output?: unknown;
  /** Error if failed */
  error?: Error;
  /** Execution duration in milliseconds */
  duration: number;
  /** Tokens used (if applicable) */
  tokensUsed?: number;
  /** Result metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Message interface for agent communication
 */
export interface Message {
  /** Message identifier */
  id: string;
  /** Sender agent ID */
  from: string;
  /** Message type */
  type: string;
  /** Message payload */
  payload: unknown;
  /** Timestamp */
  timestamp: number;
  /** Correlation ID for request-response */
  correlationId?: string;
}
