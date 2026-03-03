/**
 * Health Status types for Claude Flow V3
 */

export enum HealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown',
}

export interface HealthResult {
  status: HealthStatus;
  healthy: boolean;
  error?: string;
  metrics?: Record<string, number>;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface HealthCheckConfig {
  /** How often to run periodic checks (ms) */
  checkInterval?: number;
  /** TTL for healthy cache (ms). Defaults to 5 minutes. */
  cacheTTL?: number;
  /** Whether to log status transitions */
  logTransitions?: boolean;
}
