/**
 * V3 Transport Layer Types
 *
 * QUIC transport and connection pooling types aligned with agentic-flow@alpha:
 * - QUIC client/server
 * - Connection pooling
 * - Stream multiplexing
 * - mTLS support
 *
 * Performance Targets:
 * - Connection latency: <50ms
 * - Stream creation: <5ms
 * - Message latency: <10ms
 */

// ============================================================================
// Transport Types
// ============================================================================

/**
 * Supported transport protocols
 */
export type TransportProtocol = 'quic' | 'http2' | 'websocket' | 'tcp';

/**
 * Connection state
 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

/**
 * Stream state
 */
export type StreamState = 'open' | 'half-closed' | 'closed';

// ============================================================================
// QUIC Configuration
// ============================================================================

/**
 * QUIC client configuration
 */
export interface QUICClientConfig {
  /** Server host */
  host: string;

  /** Server port */
  port: number;

  /** Certificate path for mTLS */
  certPath?: string;

  /** Key path for mTLS */
  keyPath?: string;

  /** CA certificate path */
  caPath?: string;

  /** Verify server certificate */
  verifyPeer?: boolean;

  /** Maximum concurrent connections */
  maxConnections?: number;

  /** Connection timeout in ms */
  connectionTimeout?: number;

  /** Idle timeout in ms */
  idleTimeout?: number;

  /** Maximum concurrent streams per connection */
  maxConcurrentStreams?: number;

  /** Stream timeout in ms */
  streamTimeout?: number;

  /** Initial congestion window */
  initialCongestionWindow?: number;

  /** Maximum datagram size */
  maxDatagramSize?: number;

  /** Enable 0-RTT early data */
  enableEarlyData?: boolean;

  /** ALPN protocols */
  alpnProtocols?: string[];
}

/**
 * QUIC server configuration
 */
export interface QUICServerConfig extends QUICClientConfig {
  /** Bind address */
  bindAddress?: string;

  /** Client certificate requirement */
  requireClientCert?: boolean;

  /** Maximum pending connections */
  maxPendingConnections?: number;
}

// ============================================================================
// Connection Types
// ============================================================================

/**
 * Connection information
 */
export interface ConnectionInfo {
  /** Unique connection ID */
  id: string;

  /** Remote address */
  remoteAddr: string;

  /** Local address */
  localAddr?: string;

  /** Connection state */
  state: ConnectionState;

  /** Current stream count */
  streamCount: number;

  /** Connection creation time */
  createdAt: Date;

  /** Last activity time */
  lastActivity: Date;

  /** Round-trip time in ms */
  rttMs?: number;

  /** Bytes sent */
  bytesSent?: number;

  /** Bytes received */
  bytesReceived?: number;
}

/**
 * Stream information
 */
export interface StreamInfo {
  /** Stream ID */
  id: number;

  /** Parent connection ID */
  connectionId: string;

  /** Stream state */
  state: StreamState;

  /** Bidirectional or unidirectional */
  bidirectional: boolean;

  /** Creation time */
  createdAt: Date;
}

// ============================================================================
// Stream Interface
// ============================================================================

/**
 * QUIC stream interface
 */
export interface IStream {
  /** Stream ID */
  readonly id: number;

  /** Connection ID */
  readonly connectionId: string;

  /** Stream state */
  readonly state: StreamState;

  /** Send data on the stream */
  send(data: Uint8Array): Promise<void>;

  /** Receive data from the stream */
  receive(): Promise<Uint8Array>;

  /** Close the stream */
  close(): Promise<void>;

  /** Get stream info */
  getInfo(): StreamInfo;
}

// ============================================================================
// Client/Server Interfaces
// ============================================================================

/**
 * QUIC client interface
 */
export interface IQUICClient {
  /** Initialize the client */
  initialize(): Promise<void>;

  /** Connect to server */
  connect(host?: string, port?: number): Promise<ConnectionInfo>;

  /** Create a stream on a connection */
  createStream(connectionId: string): Promise<IStream>;

  /** Send HTTP/3 request */
  sendRequest(
    connectionId: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: Uint8Array
  ): Promise<HTTP3Response>;

  /** Close a connection */
  closeConnection(connectionId: string): Promise<void>;

  /** Shutdown the client */
  shutdown(): Promise<void>;

  /** Get client statistics */
  getStats(): TransportStats;

  /** Check if initialized */
  isInitialized(): boolean;
}

/**
 * QUIC server interface
 */
export interface IQUICServer {
  /** Initialize the server */
  initialize(): Promise<void>;

  /** Start listening for connections */
  listen(): Promise<void>;

  /** Stop the server */
  stop(): Promise<void>;

  /** Close a specific connection */
  closeConnection(connectionId: string): Promise<void>;

  /** Get server statistics */
  getStats(): TransportStats;

  /** Check if listening */
  isListening(): boolean;

  /** Set connection handler */
  onConnection(handler: ConnectionHandler): void;

  /** Set request handler */
  onRequest(handler: RequestHandler): void;
}

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Connection handler
 */
export type ConnectionHandler = (connection: ConnectionInfo) => void | Promise<void>;

/**
 * Request handler
 */
export type RequestHandler = (
  request: HTTP3Request,
  connectionId: string
) => Promise<HTTP3Response>;

/**
 * Stream handler
 */
export type StreamHandler = (stream: IStream) => void | Promise<void>;

// ============================================================================
// HTTP/3 Types
// ============================================================================

/**
 * HTTP/3 request
 */
export interface HTTP3Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/**
 * HTTP/3 response
 */
export interface HTTP3Response {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array;
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Transport statistics
 */
export interface TransportStats {
  /** Total connections established */
  totalConnections: number;

  /** Currently active connections */
  activeConnections: number;

  /** Total streams created */
  totalStreams: number;

  /** Currently active streams */
  activeStreams: number;

  /** Bytes received */
  bytesReceived: number;

  /** Bytes sent */
  bytesSent: number;

  /** Packets lost */
  packetsLost: number;

  /** Average RTT in ms */
  avgRttMs: number;

  /** Connection errors */
  connectionErrors: number;

  /** Stream errors */
  streamErrors: number;
}

// ============================================================================
// Connection Pool Types
// ============================================================================

/**
 * Connection pool configuration
 */
export interface ConnectionPoolConfig {
  /** Maximum pool size */
  maxSize: number;

  /** Minimum pool size */
  minSize?: number;

  /** Idle timeout before eviction */
  idleTimeout?: number;

  /** Connection acquisition timeout */
  acquireTimeout?: number;

  /** Enable health checks */
  enableHealthCheck?: boolean;

  /** Health check interval */
  healthCheckInterval?: number;
}

/**
 * Connection pool interface
 */
export interface IConnectionPool {
  /** Acquire a connection */
  acquire(host: string, port: number): Promise<ConnectionInfo>;

  /** Release a connection back to pool */
  release(connectionId: string): void;

  /** Remove a connection from pool */
  remove(connectionId: string): Promise<void>;

  /** Clear all connections */
  clear(): Promise<void>;

  /** Get pool statistics */
  getStats(): PoolStats;
}

/**
 * Pool statistics
 */
export interface PoolStats {
  /** Total connections in pool */
  totalConnections: number;

  /** Available connections */
  availableConnections: number;

  /** Connections in use */
  inUseConnections: number;

  /** Connections created */
  connectionsCreated: number;

  /** Connections destroyed */
  connectionsDestroyed: number;

  /** Wait time in ms */
  avgWaitTimeMs: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Transport events
 */
export type TransportEvent =
  | { type: 'connection_established'; connectionId: string; remoteAddr: string }
  | { type: 'connection_closed'; connectionId: string; reason?: string }
  | { type: 'connection_error'; connectionId: string; error: string }
  | { type: 'stream_opened'; connectionId: string; streamId: number }
  | { type: 'stream_closed'; connectionId: string; streamId: number }
  | { type: 'data_received'; connectionId: string; bytes: number }
  | { type: 'data_sent'; connectionId: string; bytes: number };

/**
 * Event listener type
 */
export type TransportEventListener = (event: TransportEvent) => void | Promise<void>;
