/**
 * Unified Error Envelope System
 * Based on Neo Pattern 12
 *
 * Provides a standardized way to represent errors across all v3 services.
 */

/**
 * Standardized Error Codes
 */
export enum ErrorCode {
  // General Errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',

  // Client Errors
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR = 'AUTHORIZATION_ERROR',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  // Domain Specific
  UNHEALTHY_STATE = 'UNHEALTHY_STATE', // Ported from Neo Health Gate
  EXECUTION_FAILED = 'EXECUTION_FAILED',
  TASK_ABORTED = 'TASK_ABORTED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
}

/**
 * Structured Error Information
 */
export interface ErrorEnvelope {
  /** Machine-readable error code */
  code: ErrorCode | string;
  /** Human-readable error message */
  message: string;
  /** Additional structured data about the error */
  details?: Record<string, unknown>;
  /** Stack trace (usually only in development) */
  stack?: string;
  /** Request/Correlation ID for tracing */
  correlationId?: string;
  /** ISO timestamp when the error occurred */
  timestamp: string;
}
