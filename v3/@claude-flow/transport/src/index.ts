/**
 * V3 Transport Layer Module
 *
 * QUIC transport and connection pooling aligned with agentic-flow@alpha:
 * - QUIC client/server
 * - Connection pooling
 * - Stream multiplexing
 * - mTLS support
 *
 * @module @claude-flow/transport
 */

export * from './types.js';
export * from './quic-transport.js';

// Re-export commonly used items at top level
export {
  QUICClient,
  QUICServer,
  QUICConnectionPool,
  createQUICClient,
  createQUICServer,
  createConnectionPool,
} from './quic-transport.js';

export type {
  QUICClientConfig,
  QUICServerConfig,
  ConnectionInfo,
  ConnectionState,
  StreamInfo,
  StreamState,
  IStream,
  IQUICClient,
  IQUICServer,
  HTTP3Request,
  HTTP3Response,
  TransportStats,
  ConnectionPoolConfig,
  IConnectionPool,
  PoolStats,
  TransportEvent,
  TransportEventListener,
} from './types.js';
