import { HealthResult, HealthStatus, HealthCheckConfig } from './types.js';

/**
 * Abstract base class for services that require health monitoring.
 *
 * Extend this class and implement {@link BaseHealthService.performCheck} to get
 * automatic result caching (healthy results cached for `cacheTTL` ms),
 * in-flight request deduplication, and optional status-transition logging.
 *
 * @example
 * class MyService extends BaseHealthService {
 *   constructor() { super('MyService'); }
 *   protected async performCheck(): Promise<HealthResult> {
 *     return { status: HealthStatus.HEALTHY, healthy: true, timestamp: new Date() };
 *   }
 * }
 */
export abstract class BaseHealthService {
  protected readonly serviceName: string;
  private healthCache?: HealthResult;
  private cacheTimer?: NodeJS.Timeout;
  private inFlightCheck?: Promise<HealthResult>;
  private readonly config: Required<HealthCheckConfig>;

  /** Default TTL: 5 minutes */
  private static readonly DEFAULT_CACHE_TTL = 5 * 60 * 1000;

  constructor(serviceName: string, config: HealthCheckConfig = {}) {
    this.serviceName = serviceName;
    this.config = {
      checkInterval: config.checkInterval ?? 30000,
      cacheTTL: config.cacheTTL ?? BaseHealthService.DEFAULT_CACHE_TTL,
      logTransitions: config.logTransitions ?? true,
    };
  }

  /**
   * Implement the actual health check logic in subclasses.
   */
  protected abstract performCheck(): Promise<HealthResult>;

  /**
   * Get current health status with caching and deduplication.
   */
  async getHealth(): Promise<HealthResult> {
    // Return cached result if valid (only cache HEALTHY status, not DEGRADED)
    if (this.healthCache && this.healthCache.status === HealthStatus.HEALTHY) {
      return this.healthCache;
    }

    // Deduplicate in-flight checks
    if (this.inFlightCheck) {
      return this.inFlightCheck;
    }

    this.inFlightCheck = this.performCheck().then((result) => {
      this.handleHealthResult(result);
      this.inFlightCheck = undefined;
      return result;
    }).catch((error) => {
      this.inFlightCheck = undefined;
      const failedResult: HealthResult = {
        status: HealthStatus.UNHEALTHY,
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      };
      this.handleHealthResult(failedResult);
      return failedResult;
    });

    return this.inFlightCheck;
  }

  /**
   * Throw an error if the service is not healthy.
   */
  async ensureHealthy(): Promise<void> {
    const health = await this.getHealth();
    if (!health.healthy) {
      throw new Error(`Service "${this.serviceName}" is unhealthy: ${health.error || 'Unknown error'}`);
    }
  }

  /**
   * Handle the result of a health check, managing cache and logging transitions.
   */
  private handleHealthResult(result: HealthResult): void {
    const previousStatus = this.healthCache?.status ?? HealthStatus.UNKNOWN;

    // Transition logging
    if (this.config.logTransitions && previousStatus !== result.status) {
      console.log(`[Health] ${this.serviceName}: ${previousStatus} -> ${result.status}${result.error ? ` (${result.error})` : ''}`);
    }

    // Cache management: only cache healthy results
    if (result.healthy) {
      this.healthCache = result;
      this.resetCacheTimer();
    } else {
      // Never cache unhealthy results to ensure immediate recovery detection
      this.clearCache();
    }
  }

  private resetCacheTimer(): void {
    this.clearCacheTimer();
    this.cacheTimer = setTimeout(() => {
      this.clearCache();
    }, this.config.cacheTTL);
  }

  private clearCacheTimer(): void {
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = undefined;
    }
  }

  protected clearCache(): void {
    this.healthCache = undefined;
    this.clearCacheTimer();
  }

  /**
   * Manual refresh of health status, bypassing cache.
   */
  async refreshHealth(): Promise<HealthResult> {
    this.clearCache();
    return this.getHealth();
  }
}
