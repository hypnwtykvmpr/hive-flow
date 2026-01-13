/**
 * V3 Production Hardening Module
 *
 * Provides production-grade utilities:
 * - Error handling middleware
 * - Rate limiting
 * - Retry mechanisms with exponential backoff
 * - Circuit breaker pattern
 * - Monitoring and observability hooks
 *
 * @module @claude-flow/cli/production
 */

export { ErrorHandler, withErrorHandling, type ErrorContext, type ErrorHandlerConfig } from './error-handler.js';
export { RateLimiter, createRateLimiter, type RateLimiterConfig, type RateLimitResult } from './rate-limiter.js';
export { RetryStrategy, withRetry, type RetryConfig, type RetryResult } from './retry.js';
export { CircuitBreaker, type CircuitBreakerConfig, type CircuitState } from './circuit-breaker.js';
export { MonitoringHooks, createMonitor, type MonitorConfig, type MetricEvent } from './monitoring.js';
