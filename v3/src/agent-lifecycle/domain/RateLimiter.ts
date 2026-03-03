import { IRateLimiter, RateLimiterConfig } from './types';

/**
 * Token-Bucket Rate Limiter
 */
export class RateLimiter implements IRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;

  constructor(config: RateLimiterConfig) {
    this.capacity = config.capacity;
    this.refillRate = config.refillRate;
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume tokens immediately.
   * Returns true if tokens were available and consumed.
   */
  public tryConsume(tokens = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  /**
   * Wait until tokens are available and consume them.
   */
  public async consume(tokens = 1): Promise<void> {
    if (tokens > this.capacity) {
      throw new Error(`Requested tokens (${tokens}) exceeds rate limiter capacity (${this.capacity})`);
    }

    while (!this.tryConsume(tokens)) {
      // Calculate wait time until enough tokens are likely to be available
      const needed = tokens - this.tokens;
      const waitTimeMs = (needed / this.refillRate) * 1000;
      
      // Wait at least 100ms to avoid busy-waiting
      await new Promise(resolve => setTimeout(resolve, Math.max(waitTimeMs, 100)));
    }
  }

  /**
   * Returns current available tokens after refill.
   */
  public getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Refill tokens based on time elapsed since last refill.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;

    const tokensToAdd = elapsedSeconds * this.refillRate;
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

export default RateLimiter;
