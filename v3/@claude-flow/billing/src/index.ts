/**
 * V3 Billing/Metering Module
 *
 * Usage tracking and billing aligned with agentic-flow@alpha:
 * - Subscription management
 * - Usage metering
 * - Quota tracking
 * - Payment processing
 *
 * @module @claude-flow/billing
 */

export * from './types.js';
export * from './metering-engine.js';

// Re-export commonly used items at top level
export {
  MeteringEngine,
  InMemoryBillingStorage,
  createMeteringEngine,
  createMeteringEngineWithStorage,
} from './metering-engine.js';

export {
  SubscriptionTier,
  BillingCycle,
  SubscriptionStatus,
  UsageMetric,
  PaymentProvider,
  PaymentStatus,
  CouponType,
  BillingEventType,
} from './types.js';

export type {
  Subscription,
  ResourceLimits,
  UsageRecord,
  UsageSummary,
  QuotaCheckResult,
  Payment,
  Coupon,
  AppliedCoupon,
  BillingEvent,
  BillingEventListener,
  MeteringConfig,
  IMeteringEngine,
  IBillingStorage,
} from './types.js';
