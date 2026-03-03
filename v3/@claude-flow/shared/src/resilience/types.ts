/**
 * Resilience and Self-Healing Types
 * Aligned with Neo.mjs self-healing patterns
 */

import type { IHealthStatus } from '../core/interfaces/coordinator.interface.js';
import { HealthStatus } from '../services/health/types.js';

/**
 * Configuration for self-healing capabilities
 */
export interface SelfHealingConfig {
  enableAutonomousFixes: boolean;
  maxRetryAttempts: number;
  backoffFactor: number;
  driftCheckInterval: number;
}

/**
 * Health status for resilience monitoring.
 *
 * Extends IHealthStatus (from coordinator.interface) adding dependency-level
 * detail. Use IHealthStatus when only top-level orchestrator health is needed;
 * use IResilienceHealthStatus when per-dependency up/down latency is required
 * (e.g., self-healing bridges, circuit-breaker checks).
 *
 * The `status` field narrows IHealthStatus's union to the HealthStatus enum
 * so callers can use either string literals or the enum constant.
 */
export interface IResilienceHealthStatus extends Omit<IHealthStatus, 'status'> {
  /** Aggregate health using the canonical HealthStatus enum values. */
  status: HealthStatus;
  dependencies: Record<string, {
    status: 'up' | 'down';
    latency: number;
    lastChecked: Date;
    error?: string;
    latencyMs?: number; // Added to match Neo.mjs patterns better
  }>;
}

/**
 * Entry in the Dead Letter Queue (DLQ)
 */
export interface DLQEntry {
  taskId: string;
  agentType: string;
  input: any;
  errors: Array<{ 
    message: string; 
    stack?: string;
    timestamp: number;
  }>;
  contextSnapshot: any;
  metadata?: Record<string, any>;
  failedAt: Date;
  retryCount: number;
}
