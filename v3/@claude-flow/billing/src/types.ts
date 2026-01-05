/**
 * V3 Billing/Metering Types
 *
 * Usage tracking and billing types aligned with agentic-flow@alpha:
 * - Subscription management
 * - Usage metering
 * - Quota tracking
 * - Payment processing
 *
 * Performance Targets:
 * - Record usage: <5ms
 * - Check quota: <10ms
 * - Aggregate stats: <50ms
 */

// ============================================================================
// Subscription Types
// ============================================================================

/**
 * Subscription tiers
 */
export enum SubscriptionTier {
  Free = 'free',
  Starter = 'starter',
  Pro = 'pro',
  Enterprise = 'enterprise',
  Custom = 'custom',
}

/**
 * Billing cycles
 */
export enum BillingCycle {
  Monthly = 'monthly',
  Quarterly = 'quarterly',
  Yearly = 'yearly',
}

/**
 * Subscription status
 */
export enum SubscriptionStatus {
  Active = 'active',
  Trialing = 'trialing',
  PastDue = 'past_due',
  Canceled = 'canceled',
  Suspended = 'suspended',
}

/**
 * Subscription information
 */
export interface Subscription {
  /** Subscription ID */
  id: string;

  /** User/org ID */
  userId: string;

  /** Current tier */
  tier: SubscriptionTier;

  /** Billing cycle */
  cycle: BillingCycle;

  /** Current status */
  status: SubscriptionStatus;

  /** Subscription start date */
  startDate: Date;

  /** Current period end */
  currentPeriodEnd: Date;

  /** Trial end date (if applicable) */
  trialEnd?: Date;

  /** Cancellation date (if applicable) */
  canceledAt?: Date;

  /** Resource limits */
  limits: ResourceLimits;

  /** Applied coupons */
  coupons?: AppliedCoupon[];

  /** Payment method ID */
  paymentMethodId?: string;

  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Resource limits for a tier
 */
export interface ResourceLimits {
  /** Maximum agent hours per month */
  maxAgentHours: number;

  /** Maximum deployments */
  maxDeployments: number;

  /** Maximum API requests per month */
  maxAPIRequests: number;

  /** Maximum storage in GB */
  maxStorageGB: number;

  /** Maximum swarm size */
  maxSwarmSize: number;

  /** Maximum GPU hours */
  maxGPUHours: number;

  /** Maximum bandwidth in GB */
  maxBandwidthGB: number;

  /** Maximum concurrent jobs */
  maxConcurrentJobs: number;

  /** Maximum team members */
  maxTeamMembers: number;

  /** Maximum custom domains */
  maxCustomDomains: number;
}

// ============================================================================
// Usage Metrics
// ============================================================================

/**
 * Usage metric types
 */
export enum UsageMetric {
  AgentHours = 'agent_hours',
  Deployments = 'deployments',
  APIRequests = 'api_requests',
  StorageGB = 'storage_gb',
  SwarmSize = 'swarm_size',
  GPUHours = 'gpu_hours',
  BandwidthGB = 'bandwidth_gb',
  ConcurrentJobs = 'concurrent_jobs',
  TeamMembers = 'team_members',
  CustomDomains = 'custom_domains',
}

/**
 * Usage record
 */
export interface UsageRecord {
  /** Record ID */
  id: string;

  /** Subscription ID */
  subscriptionId: string;

  /** Metric type */
  metric: UsageMetric;

  /** Usage amount */
  amount: number;

  /** Timestamp */
  timestamp: Date;

  /** Billing period */
  billingPeriod: string;

  /** Source/origin of usage */
  source?: string;

  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Usage summary
 */
export interface UsageSummary {
  /** Subscription ID */
  subscriptionId: string;

  /** User ID */
  userId: string;

  /** Billing period */
  period: string;

  /** Usage by metric */
  metrics: Map<UsageMetric, number>;

  /** Limits by metric */
  limits: ResourceLimits;

  /** Percentage used by metric */
  percentUsed: Map<UsageMetric, number>;

  /** Overages by metric */
  overages: Map<UsageMetric, number>;

  /** Estimated overage cost */
  estimatedCost: number;
}

/**
 * Quota check result
 */
export interface QuotaCheckResult {
  /** Whether the action is allowed */
  allowed: boolean;

  /** Metric checked */
  metric: UsageMetric;

  /** Current usage */
  current: number;

  /** Limit */
  limit: number;

  /** Percentage used */
  percentUsed: number;

  /** Remaining */
  remaining: number;

  /** Overage amount */
  overage: number;

  /** Warning message (if near limit) */
  warning?: string;
}

// ============================================================================
// Payment Types
// ============================================================================

/**
 * Payment providers
 */
export enum PaymentProvider {
  Stripe = 'stripe',
  PayPal = 'paypal',
  Crypto = 'crypto',
}

/**
 * Payment status
 */
export enum PaymentStatus {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Refunded = 'refunded',
  Canceled = 'canceled',
}

/**
 * Payment record
 */
export interface Payment {
  /** Payment ID */
  id: string;

  /** Subscription ID */
  subscriptionId: string;

  /** Amount in cents */
  amount: number;

  /** Currency code */
  currency: string;

  /** Payment status */
  status: PaymentStatus;

  /** Payment provider */
  provider: PaymentProvider;

  /** Provider payment ID */
  providerPaymentId?: string;

  /** Invoice ID */
  invoiceId?: string;

  /** Created at */
  createdAt: Date;

  /** Completed at */
  completedAt?: Date;

  /** Failure reason */
  failureReason?: string;

  /** Metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Coupon Types
// ============================================================================

/**
 * Coupon types
 */
export enum CouponType {
  Percentage = 'percentage',
  Fixed = 'fixed',
  Credit = 'credit',
}

/**
 * Coupon definition
 */
export interface Coupon {
  /** Coupon code */
  code: string;

  /** Coupon type */
  type: CouponType;

  /** Discount value (percentage or fixed amount) */
  value: number;

  /** Applicable tiers */
  applicableTiers?: SubscriptionTier[];

  /** Maximum uses */
  maxUses?: number;

  /** Current uses */
  currentUses: number;

  /** Expiration date */
  expiresAt?: Date;

  /** Created at */
  createdAt: Date;

  /** Active status */
  active: boolean;
}

/**
 * Applied coupon
 */
export interface AppliedCoupon {
  /** Coupon code */
  code: string;

  /** Discount amount applied */
  discountAmount: number;

  /** Applied at */
  appliedAt: Date;

  /** Valid until */
  validUntil?: Date;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Billing event types
 */
export enum BillingEventType {
  SubscriptionCreated = 'subscription.created',
  SubscriptionUpdated = 'subscription.updated',
  SubscriptionCanceled = 'subscription.canceled',
  SubscriptionRenewed = 'subscription.renewed',
  UsageRecorded = 'usage.recorded',
  QuotaExceeded = 'quota.exceeded',
  QuotaWarning = 'quota.warning',
  PaymentSucceeded = 'payment.succeeded',
  PaymentFailed = 'payment.failed',
  InvoiceCreated = 'invoice.created',
  CouponApplied = 'coupon.applied',
}

/**
 * Billing event
 */
export interface BillingEvent {
  /** Event type */
  type: BillingEventType;

  /** Timestamp */
  timestamp: Date;

  /** Subscription ID */
  subscriptionId: string;

  /** Event data */
  data: Record<string, unknown>;
}

/**
 * Event listener type
 */
export type BillingEventListener = (event: BillingEvent) => void | Promise<void>;

// ============================================================================
// Metering Engine Interface
// ============================================================================

/**
 * Metering engine configuration
 */
export interface MeteringConfig {
  /** Enable metering */
  enabled: boolean;

  /** Buffer size before flush */
  bufferSize: number;

  /** Flush interval in ms */
  flushInterval: number;

  /** Soft limit percentage (warning threshold) */
  softLimitPercent: number;

  /** Hard limit percentage (block threshold) */
  hardLimitPercent: number;
}

/**
 * Metering engine interface
 */
export interface IMeteringEngine {
  /** Record usage */
  recordUsage(record: Omit<UsageRecord, 'id' | 'timestamp' | 'billingPeriod'>): Promise<void>;

  /** Check quota */
  checkQuota(subscriptionId: string, metric: UsageMetric, limits: ResourceLimits): Promise<QuotaCheckResult>;

  /** Get usage summary */
  getUsageSummary(subscriptionId: string, limits: ResourceLimits): Promise<UsageSummary>;

  /** Get current usage for a metric */
  getCurrentUsage(subscriptionId: string, metric: UsageMetric): Promise<number>;

  /** Flush buffered records */
  flush(): Promise<void>;

  /** Stop the engine */
  stop(): Promise<void>;

  /** Clear cache for subscription */
  clearCache(subscriptionId?: string): void;

  /** Add event listener */
  addEventListener(listener: BillingEventListener): void;

  /** Remove event listener */
  removeEventListener(listener: BillingEventListener): void;
}

// ============================================================================
// Storage Interface
// ============================================================================

/**
 * Billing storage interface
 */
export interface IBillingStorage {
  /** Save subscription */
  saveSubscription(subscription: Subscription): Promise<void>;

  /** Get subscription */
  getSubscription(subscriptionId: string): Promise<Subscription | null>;

  /** Get subscription by user */
  getSubscriptionByUser(userId: string): Promise<Subscription | null>;

  /** Save usage record */
  saveUsageRecord(record: UsageRecord): Promise<void>;

  /** Get usage records */
  getUsageRecords(subscriptionId: string, period: string): Promise<UsageRecord[]>;

  /** Save payment */
  savePayment(payment: Payment): Promise<void>;

  /** Get payments */
  getPayments(subscriptionId: string): Promise<Payment[]>;

  /** Save coupon */
  saveCoupon(coupon: Coupon): Promise<void>;

  /** Get coupon */
  getCoupon(code: string): Promise<Coupon | null>;

  /** Increment coupon usage */
  incrementCouponUsage(code: string): Promise<void>;
}
