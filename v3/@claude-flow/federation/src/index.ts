/**
 * V3 Federation Module
 *
 * Multi-cluster coordination and synchronization aligned with agentic-flow@alpha:
 * - Federation hub for cross-cluster sync
 * - Vector clock conflict resolution
 * - Ephemeral agent management
 * - Multi-tenant support
 *
 * @module @claude-flow/federation
 */

export * from './types.js';
export * from './federation-hub.js';

// Re-export commonly used items at top level
export {
  FederationHub,
  createFederationHub,
  compareVectorClocks,
  mergeVectorClocks,
  incrementVectorClock,
} from './federation-hub.js';

export type {
  FederationHubConfig,
  VectorClock,
  ClockComparison,
  SyncMessage,
  SyncUpdate,
  SyncResult,
  ConflictInfo,
  IFederationHub,
  SyncStats,
  FederationEvent,
  FederationEventListener,
  EphemeralAgentConfig,
  EphemeralAgentState,
  EphemeralAgentInfo,
  TenantInfo,
  TenantConfig,
} from './types.js';
