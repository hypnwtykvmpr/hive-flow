/**
 * Resilience Patterns
 *
 * Production-ready resilience utilities:
 * - Retry with exponential backoff
 * - Circuit breaker pattern
 * - Rate limiting
 *
 * @module v3/shared/resilience
 */

export {
  retry,
  RetryOptions,
  RetryError,
  type RetryResult,
} from './retry.js';

export {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitBreakerState,
  type CircuitBreakerStats,
} from './circuit-breaker.js';

export {
  RateLimiter,
  RateLimiterOptions,
  SlidingWindowRateLimiter,
  TokenBucketRateLimiter,
  type RateLimitResult,
} from './rate-limiter.js';

export {
  Bulkhead,
  BulkheadOptions,
  type BulkheadStats,
} from './bulkhead.js';
