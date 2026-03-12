/**
 * V3 MCP Types and Interfaces
 *
 * Optimized type definitions for the V3 MCP server with:
 * - Strict typing for performance
 * - Connection pooling types
 * - Transport layer abstractions
 * - Tool registry interfaces
 *
 * Performance Targets:
 * - Server startup: <400ms
 * - Tool registration: <10ms
 * - Tool execution: <50ms overhead
 */

// ============================================================================
// Core Protocol Types
// ============================================================================

/**
 * JSON-RPC 2.0 Protocol Version
 */
export type JsonRpcVersion = '2.0';

/**
 * MCP Protocol Version
 */
export interface MCPProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * MCP Request ID (can be string, number, or null)
 */
export type RequestId = string | number | null;

/**
 * Base MCP Message
 */
export interface MCPMessage {
  jsonrpc: JsonRpcVersion;
}

/**
 * MCP Request
 */
export interface MCPRequest extends MCPMessage {
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * MCP Notification (request without id)
 */
export interface MCPNotification extends MCPMessage {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * MCP Error
 */
export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * MCP Response
 */
export interface MCPResponse extends MCPMessage {
  id: RequestId;
  result?: unknown;
  error?: MCPError;
}

// ============================================================================
// Server Configuration
// ============================================================================

/**
 * Transport type options
 */
export type TransportType = 'stdio' | 'http' | 'websocket' | 'in-process';

/**
 * Authentication method
 */
export type AuthMethod = 'token' | 'oauth' | 'api-key' | 'none';

/**
 * Authentication configuration
 */
export interface AuthConfig {
  enabled: boolean;
  method: AuthMethod;
  tokens?: string[];
  apiKeys?: string[];
  jwtSecret?: string;
  oauth?: {
    clientId: string;
    clientSecret: string;
    authorizationUrl: string;
    tokenUrl: string;
  };
}

/**
 * Load balancer configuration
 */
export interface LoadBalancerConfig {
  enabled: boolean;
  maxConcurrentRequests: number;
  rateLimit?: {
    requestsPerSecond: number;
    burstSize: number;
  };
  circuitBreaker?: {
    failureThreshold: number;
    resetTimeout: number;
  };
}

/**
 * Connection pool configuration
 */
export interface ConnectionPoolConfig {
  maxConnections: number;
  minConnections: number;
  idleTimeout: number;
  acquireTimeout: number;
  maxWaitingClients: number;
  evictionRunInterval: number;
}

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  name: string;
  version: string;
  transport: TransportType;
  host?: string;
  port?: number;
  tlsEnabled?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  auth?: AuthConfig;
  loadBalancer?: LoadBalancerConfig;
  connectionPool?: ConnectionPoolConfig;
  corsEnabled?: boolean;
  corsOrigins?: string[];
  maxRequestSize?: number;
  requestTimeout?: number;
  enableMetrics?: boolean;
  enableCaching?: boolean;
  cacheTTL?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * MCP Session state
 */
export type SessionState = 'created' | 'initializing' | 'ready' | 'closing' | 'closed' | 'error';

/**
 * MCP Session
 */
export interface MCPSession {
  id: string;
  state: SessionState;
  transport: TransportType;
  createdAt: Date;
  lastActivityAt: Date;
  isInitialized: boolean;
  isAuthenticated: boolean;
  clientInfo?: MCPClientInfo;
  protocolVersion?: MCPProtocolVersion;
  capabilities?: MCPCapabilities;
  metadata?: Record<string, unknown>;
}

/**
 * Client information from initialization
 */
export interface MCPClientInfo {
  name: string;
  version: string;
}

// ============================================================================
// Capability Types
// ============================================================================

/**
 * MCP Capabilities
 */
export interface MCPCapabilities {
  logging?: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
  tools?: {
    listChanged: boolean;
  };
  resources?: {
    listChanged: boolean;
    subscribe: boolean;
  };
  prompts?: {
    listChanged: boolean;
  };
  experimental?: Record<string, unknown>;
}

/**
 * Initialize request parameters
 */
export interface MCPInitializeParams {
  protocolVersion: MCPProtocolVersion;
  capabilities: MCPCapabilities;
  clientInfo: MCPClientInfo;
}

/**
 * Initialize response result
 */
export interface MCPInitializeResult {
  protocolVersion: MCPProtocolVersion;
  capabilities: MCPCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
}

// ============================================================================
// Tool Types
// ============================================================================

/**
 * JSON Schema type for tool input
 */
export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: string[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  additionalProperties?: boolean | JSONSchema;
}

// ============================================================================
// Service Interfaces (used by ToolContext consumers to avoid `as any` casts)
// ============================================================================

/** Minimal shape of an agent record returned by the orchestrator / coordinator */
export interface AgentRecord {
  id: string;
  type: string;
  status: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt?: Date | string;
  lastActivityAt?: Date | string;
  role?: string;
  connections?: string[];
  capabilities?: unknown[];
  priority?: number;
  metrics?: Record<string, unknown>;
  history?: Array<{ timestamp: Date | string; event: string; details?: unknown }>;
  assignedAgent?: string;
}

/** Minimal shape of a task record returned by the orchestrator */
export interface TaskRecord {
  id: string;
  type: string;
  description: string;
  status: string;
  priority: number;
  dependencies?: string[];
  assignedAgent?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  timeout?: number;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Orchestrator-like service – the subset of methods used by MCP tools */
export interface OrchestratorLike {
  getStatus(): Promise<{ healthy?: boolean; [key: string]: unknown }>;
  submitTask(params: Record<string, unknown>): Promise<{ id?: string; status?: string; queuePosition?: number; [key: string]: unknown }>;
  listTasks(params: Record<string, unknown>): Promise<{ tasks: TaskRecord[]; total: number; [key: string]: unknown }>;
  getTaskStatus?(taskId: string, opts?: Record<string, unknown>): Promise<TaskRecord & { metrics?: Record<string, unknown>; history?: Array<{ timestamp: string; status: string; message?: string }> }>;
  cancelTask?(taskId: string, opts?: Record<string, unknown>): Promise<{ cancelled: boolean; previousStatus: string; [key: string]: unknown }>;
  assignTask?(taskId: string, agentId: string, opts?: Record<string, unknown>): Promise<{ assigned: boolean; previousAgent?: string; [key: string]: unknown }>;
  updateTask?(taskId: string, updates: Record<string, unknown>): Promise<{ updated: boolean; changes?: Record<string, unknown>; [key: string]: unknown }>;
  addTaskDependencies?(taskId: string, deps: string[]): Promise<{ dependencies: string[]; [key: string]: unknown }>;
  removeTaskDependencies?(taskId: string, deps: string[]): Promise<{ dependencies: string[]; [key: string]: unknown }>;
  getTaskDependencies?(taskId: string): Promise<{ dependencies: string[]; [key: string]: unknown }>;
  clearTaskDependencies?(taskId: string): Promise<{ dependencies: string[]; [key: string]: unknown }>;
  getTaskResults?(taskId: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancelAll?(): Promise<void>;
  healthCheck?(): Promise<boolean>;
}

/** Swarm coordinator-like service – the subset of methods used by MCP tools */
export interface SwarmCoordinatorLike {
  getStatus(): Promise<{
    swarmId?: string;
    state?: string;
    agents: AgentRecord[];
    topology?: { type?: string; maxAgents?: number; edges?: Array<{ from: string; to: string; weight?: number }>; depth?: number; fanout?: number };
    consensus?: Record<string, unknown>;
    createdAt?: Date;
    [key: string]: unknown;
  }>;
  getMetrics?(): Promise<{
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    activeTasks: number;
    averageTaskDuration: number;
    throughput: number;
    successRate: number;
    [key: string]: unknown;
  }>;
  spawnAgent(params: Record<string, unknown>): Promise<void>;
  terminateAgent(agentId: string): Promise<void>;
  terminateAll?(): Promise<void>;
  getAgentStatus?(agentId: string): Promise<AgentRecord>;
  setTopology?(params: Record<string, unknown>): Promise<void>;
  initialize?(params: Record<string, unknown>): Promise<void>;
  healthCheck?(): Promise<boolean>;
}

/** Memory service – the subset of methods used by MCP tools */
export interface MemoryServiceLike {
  storeEntry(params: Record<string, unknown>): Promise<{ id: string; createdAt: Date; [key: string]: unknown }>;
  query(params: Record<string, unknown>): Promise<Array<{
    id: string;
    content: string;
    type: string;
    namespace?: string;
    tags?: string[];
    metadata: Record<string, unknown>;
    createdAt: Date;
    lastAccessedAt?: Date;
    accessCount?: number;
    [key: string]: unknown;
  }>>;
  semanticSearch?(query: string, limit?: number, minRelevance?: number): Promise<Array<{
    entry: { id: string; content: string; type: string; namespace?: string; tags?: string[]; metadata: Record<string, unknown>; createdAt: Date; lastAccessedAt?: Date; accessCount?: number };
    score?: number;
    distance?: number;
  }>>;
  getStats?(): Promise<{ entryCount?: number; size?: number; [key: string]: unknown }>;
  healthCheck?(): Promise<boolean>;
}

/** Resource manager – the subset of methods used by MCP tools */
export interface ResourceManagerLike {
  memoryService?: MemoryServiceLike;
}

/**
 * Tool execution context
 */
export interface ToolContext {
  sessionId: string;
  requestId?: RequestId;
  orchestrator?: OrchestratorLike;
  swarmCoordinator?: SwarmCoordinatorLike;
  agentManager?: unknown;
  resourceManager?: ResourceManagerLike;
  messageBus?: unknown;
  monitor?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Tool handler function type
 */
export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context?: ToolContext
) => Promise<TOutput>;

/**
 * MCP Tool definition
 */
export interface MCPTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: ToolHandler<TInput, TOutput>;
  category?: string;
  tags?: string[];
  version?: string;
  deprecated?: boolean;
  cacheable?: boolean;
  cacheTTL?: number;
  timeout?: number;
}

/**
 * Tool call result
 */
export interface ToolCallResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError: boolean;
}

/**
 * Tool registration options
 */
export interface ToolRegistrationOptions {
  override?: boolean;
  validate?: boolean;
  preload?: boolean;
}

// ============================================================================
// Transport Types
// ============================================================================

/**
 * Request handler function type
 */
export type RequestHandler = (request: MCPRequest) => Promise<MCPResponse>;

/**
 * Notification handler function type
 */
export type NotificationHandler = (notification: MCPNotification) => Promise<void>;

/**
 * Transport health status
 */
export interface TransportHealthStatus {
  healthy: boolean;
  error?: string;
  metrics?: Record<string, number>;
}

/**
 * Transport interface
 */
export interface ITransport {
  readonly type: TransportType;

  start(): Promise<void>;
  stop(): Promise<void>;

  onRequest(handler: RequestHandler): void;
  onNotification(handler: NotificationHandler): void;

  sendNotification?(notification: MCPNotification): Promise<void>;

  getHealthStatus(): Promise<TransportHealthStatus>;
}

// ============================================================================
// Connection Pool Types
// ============================================================================

/**
 * Connection state
 */
export type ConnectionState = 'idle' | 'busy' | 'closing' | 'closed' | 'error';

/**
 * Pooled connection
 */
export interface PooledConnection {
  id: string;
  state: ConnectionState;
  createdAt: Date;
  lastUsedAt: Date;
  useCount: number;
  transport: TransportType;
  metadata?: Record<string, unknown>;
}

/**
 * Connection pool statistics
 */
export interface ConnectionPoolStats {
  totalConnections: number;
  idleConnections: number;
  busyConnections: number;
  pendingRequests: number;
  totalAcquired: number;
  totalReleased: number;
  totalCreated: number;
  totalDestroyed: number;
  avgAcquireTime: number;
}

/**
 * Connection pool interface
 */
export interface IConnectionPool {
  acquire(): Promise<PooledConnection>;
  release(connection: PooledConnection): void;
  destroy(connection: PooledConnection): void;

  getStats(): ConnectionPoolStats;

  drain(): Promise<void>;
  clear(): Promise<void>;
}

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Tool call metrics
 */
export interface ToolCallMetrics {
  toolName: string;
  duration: number;
  success: boolean;
  timestamp: number;
  transport: TransportType;
  cached?: boolean;
}

/**
 * MCP Server metrics
 */
export interface MCPServerMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  activeSessions: number;
  toolInvocations: Record<string, number>;
  errors: Record<string, number>;
  lastReset: Date;
  startupTime?: number;
  uptime?: number;
}

/**
 * Session metrics
 */
export interface SessionMetrics {
  total: number;
  active: number;
  authenticated: number;
  expired: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * MCP Event types
 */
export type MCPEventType =
  | 'server:started'
  | 'server:stopped'
  | 'server:error'
  | 'session:created'
  | 'session:initialized'
  | 'session:closed'
  | 'session:error'
  | 'tool:registered'
  | 'tool:unregistered'
  | 'tool:called'
  | 'tool:completed'
  | 'tool:error'
  | 'transport:connected'
  | 'transport:disconnected'
  | 'transport:error'
  | 'pool:connection:acquired'
  | 'pool:connection:released'
  | 'pool:connection:created'
  | 'pool:connection:destroyed';

/**
 * MCP Event
 */
export interface MCPEvent {
  type: MCPEventType;
  timestamp: Date;
  data?: unknown;
}

/**
 * Event handler function type
 */
export type EventHandler = (event: MCPEvent) => void;

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Log level
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger interface
 */
export interface ILogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Standard JSON-RPC error codes
 */
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
  UNKNOWN_ERROR: -32001,
  REQUEST_CANCELLED: -32800,
  RATE_LIMITED: -32000,
  AUTHENTICATION_REQUIRED: -32001,
  AUTHORIZATION_FAILED: -32002,
} as const;

/**
 * MCP Error class
 */
export class MCPServerError extends Error {
  constructor(
    message: string,
    public code: number = ErrorCodes.INTERNAL_ERROR,
    public data?: unknown
  ) {
    super(message);
    this.name = 'MCPServerError';
  }

  toMCPError(): MCPError {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}
