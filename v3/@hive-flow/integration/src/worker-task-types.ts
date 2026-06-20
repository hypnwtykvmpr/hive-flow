/**
 * Worker task types — neutral home for the agent task/result/status/message
 * contracts used across the worker subsystem.
 *
 * These are generic worker-execution contracts with no optional bridge
 * dependency, so worker files can import them without pulling in unrelated
 * integration modules.
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
