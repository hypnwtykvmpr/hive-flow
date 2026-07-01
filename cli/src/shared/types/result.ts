import { ErrorEnvelope } from './errors.js';

/**
 * Standardized Result Type
 * Based on Neo Pattern 12
 *
 * Used across all v3 services for consistent response shapes.
 * Replaces the basic Result type in types.ts with a more structured one.
 */

export interface ResultSuccess<T> {
  success: true;
  data: T;
  /** @deprecated Use 'data' instead. Kept for backward compatibility. */
  value?: T;
  error?: never;
  metadata?: Record<string, unknown>;
}

export interface ResultFailure {
  success: false;
  data?: never;
  error: ErrorEnvelope;
  metadata?: Record<string, unknown>;
}

/**
 * Unified Result shape for v3 services
 */
export type Result<T> = ResultSuccess<T> | ResultFailure;

/**
 * Convenience helper to create a successful result
 */
export function success<T>(data: T, metadata?: Record<string, unknown>): ResultSuccess<T> {
  return {
    success: true,
    data,
    value: data,
    metadata,
  };
}

/**
 * Convenience helper to create a failed result
 */
export function failure(error: ErrorEnvelope, metadata?: Record<string, unknown>): ResultFailure {
  return {
    success: false,
    error,
    metadata,
  };
}

/**
 * Type guard to check if a result is successful
 */
export function isSuccess<T>(result: Result<T>): result is ResultSuccess<T> {
  return result.success === true;
}

/**
 * Type guard to check if a result failed
 */
export function isFailure<T>(result: Result<T>): result is ResultFailure {
  return result.success === false;
}
