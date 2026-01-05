/**
 * V3 Federation Types
 *
 * Multi-cluster coordination and synchronization types aligned with agentic-flow@alpha:
 * - Federation hub for cross-cluster sync
 * - Vector clock conflict resolution
 * - Ephemeral agent management
 * - Multi-tenant support
 *
 * Performance Targets:
 * - Sync latency: <50ms
 * - Conflict detection: <5ms
 * - Vector clock update: <1ms
 */

// ============================================================================
// Federation Hub Types
// ============================================================================

/**
 * Federation hub configuration
 */
export interface FederationHubConfig {
  /** Hub endpoint (quic://host:port) */
  endpoint: string;

  /** Agent identifier */
  agentId: string;

  /** Tenant identifier */
  tenantId: string;

  /** JWT authentication token */
  token: string;

  /** Enable mTLS */
  enableMTLS?: boolean;

  /** Certificate path */
  certPath?: string;

  /** Key path */
  keyPath?: string;

  /** CA path */
  caPath?: string;

  /** Sync interval in ms */
  syncInterval?: number;

  /** Conflict resolution strategy */
  conflictResolution?: ConflictResolutionStrategy;
}

/**
 * Conflict resolution strategies
 */
export type ConflictResolutionStrategy =
  | 'last-write-wins'
  | 'first-write-wins'
  | 'custom'
  | 'merge';

// ============================================================================
// Vector Clock Types
// ============================================================================

/**
 * Vector clock for conflict detection
 */
export interface VectorClock {
  /** Map of agent ID to timestamp */
  [agentId: string]: number;
}

/**
 * Clock comparison result
 */
export type ClockComparison = 'before' | 'after' | 'concurrent' | 'equal';

// ============================================================================
// Sync Types
// ============================================================================

/**
 * Sync message types
 */
export type SyncMessageType = 'pull' | 'push' | 'ack' | 'nack';

/**
 * Sync message
 */
export interface SyncMessage {
  /** Message type */
  type: SyncMessageType;

  /** Source agent ID */
  agentId: string;

  /** Tenant ID */
  tenantId: string;

  /** Vector clock */
  vectorClock: VectorClock;

  /** Message timestamp */
  timestamp: number;

  /** Data payload (for push) */
  data?: SyncUpdate[];

  /** Request ID */
  requestId?: string;
}

/**
 * Sync update operation
 */
export type SyncOperation = 'insert' | 'update' | 'delete';

/**
 * Sync update record
 */
export interface SyncUpdate {
  /** Record ID */
  id: string;

  /** Operation type */
  operation: SyncOperation;

  /** Record data */
  data?: Record<string, unknown>;

  /** Vector clock at time of update */
  vectorClock: VectorClock;

  /** Timestamp */
  timestamp: number;
}

/**
 * Sync result
 */
export interface SyncResult {
  /** Whether sync was successful */
  success: boolean;

  /** Number of records pulled */
  pullCount: number;

  /** Number of records pushed */
  pushCount: number;

  /** Number of conflicts detected */
  conflictCount: number;

  /** Conflicts that were resolved */
  resolvedConflicts: ConflictInfo[];

  /** Sync duration in ms */
  durationMs: number;

  /** New vector clock after sync */
  vectorClock: VectorClock;
}

/**
 * Conflict information
 */
export interface ConflictInfo {
  /** Record ID */
  recordId: string;

  /** Local version */
  localVersion: SyncUpdate;

  /** Remote version */
  remoteVersion: SyncUpdate;

  /** Resolution applied */
  resolution: 'local' | 'remote' | 'merge' | 'skip';

  /** Resolution reason */
  reason: string;
}

// ============================================================================
// Ephemeral Agent Types
// ============================================================================

/**
 * Ephemeral agent configuration
 */
export interface EphemeralAgentConfig {
  /** Agent ID */
  agentId: string;

  /** Agent type */
  agentType: string;

  /** Tenant ID */
  tenantId: string;

  /** Time-to-live in seconds */
  ttlSeconds: number;

  /** Federation hub endpoint */
  hubEndpoint: string;

  /** Authentication token */
  token: string;

  /** Capabilities */
  capabilities?: string[];

  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Ephemeral agent state
 */
export type EphemeralAgentState =
  | 'initializing'
  | 'active'
  | 'syncing'
  | 'idle'
  | 'terminating'
  | 'terminated';

/**
 * Ephemeral agent info
 */
export interface EphemeralAgentInfo {
  /** Agent ID */
  agentId: string;

  /** Agent type */
  agentType: string;

  /** Current state */
  state: EphemeralAgentState;

  /** Creation time */
  createdAt: Date;

  /** Last activity time */
  lastActivity: Date;

  /** Remaining TTL in seconds */
  remainingTtl: number;

  /** Current vector clock */
  vectorClock: VectorClock;

  /** Connected to hub */
  connected: boolean;

  /** Last sync time */
  lastSync?: Date;
}

// ============================================================================
// Federation Hub Interface
// ============================================================================

/**
 * Federation hub interface
 */
export interface IFederationHub {
  /** Connect to the hub */
  connect(): Promise<void>;

  /** Disconnect from the hub */
  disconnect(): Promise<void>;

  /** Synchronize with the hub */
  sync(db: unknown): Promise<SyncResult>;

  /** Check if connected */
  isConnected(): boolean;

  /** Get sync statistics */
  getSyncStats(): SyncStats;

  /** Get current vector clock */
  getVectorClock(): VectorClock;

  /** Force push local changes */
  forcePush(updates: SyncUpdate[]): Promise<void>;

  /** Force pull remote changes */
  forcePull(): Promise<SyncUpdate[]>;
}

/**
 * Sync statistics
 */
export interface SyncStats {
  /** Last sync time */
  lastSyncTime: number;

  /** Total syncs performed */
  totalSyncs: number;

  /** Total records pulled */
  totalPulled: number;

  /** Total records pushed */
  totalPushed: number;

  /** Total conflicts detected */
  totalConflicts: number;

  /** Total conflicts resolved */
  totalResolved: number;

  /** Average sync duration in ms */
  avgSyncDurationMs: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Federation events
 */
export type FederationEvent =
  | { type: 'connected'; agentId: string; endpoint: string }
  | { type: 'disconnected'; agentId: string; reason?: string }
  | { type: 'sync_started'; agentId: string }
  | { type: 'sync_completed'; agentId: string; result: SyncResult }
  | { type: 'sync_failed'; agentId: string; error: string }
  | { type: 'conflict_detected'; recordId: string; local: VectorClock; remote: VectorClock }
  | { type: 'conflict_resolved'; recordId: string; resolution: string }
  | { type: 'agent_joined'; agentId: string; agentType: string }
  | { type: 'agent_left'; agentId: string; reason: string };

/**
 * Event listener type
 */
export type FederationEventListener = (event: FederationEvent) => void | Promise<void>;

// ============================================================================
// Multi-Tenant Types
// ============================================================================

/**
 * Tenant information
 */
export interface TenantInfo {
  /** Tenant ID */
  tenantId: string;

  /** Tenant name */
  name: string;

  /** Active agents */
  activeAgents: string[];

  /** Data isolation level */
  isolation: 'strict' | 'shared' | 'hierarchical';

  /** Quota limits */
  quotas?: {
    maxAgents: number;
    maxSyncSize: number;
    maxStorageBytes: number;
  };
}

/**
 * Tenant configuration
 */
export interface TenantConfig {
  /** Tenant ID */
  tenantId: string;

  /** Encryption key for tenant data */
  encryptionKey?: string;

  /** Allowed federation endpoints */
  allowedEndpoints?: string[];

  /** Sync policies */
  syncPolicies?: {
    syncInterval: number;
    maxRetries: number;
    backoffMs: number;
  };
}
