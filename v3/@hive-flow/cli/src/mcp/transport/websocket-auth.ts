/**
 * @hive-flow/cli/mcp - WebSocket Authentication Middleware
 *
 * Provides token-based authentication for WebSocket connections.
 * Guards all non-authenticate messages behind a handshake that must
 * complete within a configurable timeout (default: 5 seconds).
 *
 * Usage:
 *   const guard = createAuthMiddleware({ secret: 'my-secret' });
 *   wss.on('connection', (ws) => {
 *     const authenticator = guard(ws);
 *     ws.on('message', (data) => {
 *       if (!authenticator.handle(data)) return;
 *       // message is authenticated — forward to handler
 *     });
 *   });
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { WebSocket, RawData } from 'ws';
import { ErrorCodes, type MCPResponse, type ILogger } from '../types.js';

// ============================================================================
// Public Interfaces
// ============================================================================

/**
 * Configuration for the WebSocket authenticator.
 */
export interface AuthConfig {
  /** HMAC secret used to verify signed tokens. */
  secret: string;
  /**
   * Maximum milliseconds a connection may remain unauthenticated.
   * Connections that do not send a valid `authenticate` message within
   * this window are closed with code 4001 (Authentication timeout).
   * Default: 5000
   */
  timeout?: number;
}

/**
 * Result returned by `WebSocketAuthenticator.authenticate()`.
 */
export interface AuthResult {
  success: boolean;
  error?: string;
}

// ============================================================================
// WebSocketAuthenticator
// ============================================================================

/**
 * Per-connection authentication state machine.
 *
 * Lifecycle:
 *   1. On construction, a timeout is started.
 *   2. When the client sends `{ method: "authenticate", params: { token } }`,
 *      call `authenticate(ws, message)`.
 *   3. Once authenticated, `isAuthenticated` is true and `handle()` passes all
 *      subsequent messages through.
 *   4. If the timeout fires before authentication, the connection is closed.
 */
const MAX_AUTH_ATTEMPTS = 3;

export class WebSocketAuthenticator {
  private _isAuthenticated = false;
  private _failedAttempts = 0;
  private readonly _timer: NodeJS.Timeout;
  private readonly _timeoutMs: number;

  get isAuthenticated(): boolean {
    return this._isAuthenticated;
  }

  constructor(
    private readonly ws: WebSocket,
    private readonly config: AuthConfig,
    private readonly logger?: ILogger,
  ) {
    this._timeoutMs = config.timeout ?? 5000;
    this._timer = setTimeout(() => this._onTimeout(), this._timeoutMs);
  }

  /**
   * Verifies a token extracted from an `authenticate` JSON-RPC message.
   *
   * The token must be a signed value produced by signing an arbitrary payload
   * with HMAC-SHA256 using `config.secret`, formatted as:
   *   `<base64url-payload>.<base64url-hmac-signature>`
   *
   * @param ws      - The WebSocket connection to authenticate.
   * @param message - Parsed JSON-RPC message (must have method === 'authenticate').
   * @returns       AuthResult indicating success or failure reason.
   */
  authenticate(ws: WebSocket, message: Record<string, unknown>): AuthResult {
    if (this._isAuthenticated) {
      return { success: true };
    }

    const params = message['params'] as Record<string, unknown> | undefined;
    const token = params?.['token'];

    if (typeof token !== 'string' || token.length === 0) {
      return { success: false, error: 'Token missing or invalid type' };
    }

    const valid = this._verifyToken(token);
    if (!valid) {
      this._failedAttempts++;
      this.logger?.warn('WebSocket auth failed — invalid token', { attempt: this._failedAttempts });
      if (this._failedAttempts >= MAX_AUTH_ATTEMPTS) {
        this.logger?.warn('WebSocket auth max attempts reached — closing connection');
        clearTimeout(this._timer);
        try {
          this._sendError(null, ErrorCodes.AUTHENTICATION_REQUIRED, 'Too many failed authentication attempts');
          this.ws.close(4001, 'Too many failed authentication attempts');
        } catch {
          // Connection may already be gone
        }
      }
      return { success: false, error: 'Invalid token' };
    }

    this._isAuthenticated = true;
    clearTimeout(this._timer);
    this.logger?.info('WebSocket client authenticated');
    return { success: true };
  }

  /**
   * Processes a raw WebSocket data frame.
   *
   * - If the connection is not yet authenticated and the message method is
   *   `authenticate`, the authentication handshake is performed and a
   *   JSON-RPC response is sent back to the client.
   * - If the connection is not authenticated and the message is anything else,
   *   an error response is sent and `false` is returned.
   * - If authenticated, `true` is returned so the caller can forward the
   *   message to its normal handler.
   *
   * @returns `true` if the message should be processed by the caller,
   *          `false` if it has been consumed (auth handshake or rejected).
   */
  handle(data: RawData): boolean {
    if (this._isAuthenticated) {
      return true;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      this._sendError(null, ErrorCodes.PARSE_ERROR, 'Parse error');
      return false;
    }

    const id = message['id'] ?? null;

    if (message['method'] === 'authenticate') {
      const result = this.authenticate(this.ws, message);
      if (result.success) {
        this._sendResult(id as string | number | null, { authenticated: true });
      } else {
        this._sendError(id as string | number | null, ErrorCodes.AUTHENTICATION_REQUIRED, result.error ?? 'Authentication failed');
      }
      return false;
    }

    // Non-auth message before handshake completes
    this._sendError(id as string | number | null, ErrorCodes.AUTHENTICATION_REQUIRED, 'Authentication required');
    return false;
  }

  /**
   * Cancels the authentication timeout and marks the connection as closed.
   * Call this from the WebSocket `close` event handler.
   */
  dispose(): void {
    clearTimeout(this._timer);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private _verifyToken(combined: string): boolean {
    const dotIndex = combined.lastIndexOf('.');
    if (dotIndex === -1) {
      return false;
    }

    const payload = combined.slice(0, dotIndex);
    const providedSig = combined.slice(dotIndex + 1);

    const expectedSig = createHmac('sha256', this.config.secret)
      .update(payload)
      .digest('base64url');

    try {
      const a = Buffer.from(providedSig, 'base64url');
      const b = Buffer.from(expectedSig, 'base64url');
      if (a.length !== b.length) {
        return false;
      }
      if (!timingSafeEqual(a, b)) {
        return false;
      }
    } catch {
      return false;
    }

    // Replay protection: check token expiry if the payload is a JSON object.
    try {
      const decoded = Buffer.from(payload, 'base64url').toString('utf8');
      const claims = JSON.parse(decoded) as Record<string, unknown>;
      const nowSec = Math.floor(Date.now() / 1000);

      if (typeof claims['exp'] === 'number' && nowSec > claims['exp']) {
        this.logger?.warn('WebSocket token rejected — expired (exp)');
        return false;
      }

      if (typeof claims['iat'] === 'number') {
        const maxAgeSeconds = 300; // 5 minutes
        if (nowSec - claims['iat'] > maxAgeSeconds) {
          this.logger?.warn('WebSocket token rejected — issued too long ago (iat)');
          return false;
        }
      }
    } catch {
      // Non-JSON payload (legacy token) — accept as before.
    }

    return true;
  }

  private _onTimeout(): void {
    if (this._isAuthenticated) {
      return;
    }
    this.logger?.warn('WebSocket auth timeout — closing connection', {
      timeoutMs: this._timeoutMs,
    });
    try {
      this._sendError(null, ErrorCodes.AUTHENTICATION_REQUIRED, 'Authentication timeout');
      this.ws.close(4001, 'Authentication timeout');
    } catch {
      // Connection may already be gone
    }
  }

  private _sendResult(id: string | number | null, result: unknown): void {
    const response: MCPResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this._send(response);
  }

  private _sendError(id: string | number | null, code: number, message: string): void {
    const response: MCPResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    this._send(response);
  }

  private _send(payload: MCPResponse): void {
    try {
      if (this.ws.readyState === 1 /* OPEN */) {
        this.ws.send(JSON.stringify(payload));
      }
    } catch {
      // Swallow send errors — connection is closing
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a reusable authentication middleware factory.
 *
 * Call the returned function once per new WebSocket connection to obtain a
 * `WebSocketAuthenticator` bound to that connection. Wire its `handle` method
 * into the `message` event and call `dispose()` on the `close` event.
 *
 * @example
 * ```typescript
 * const guard = createAuthMiddleware({ secret: process.env.WS_SECRET! });
 *
 * wss.on('connection', (ws) => {
 *   const auth = guard(ws);
 *
 *   ws.on('message', async (data) => {
 *     if (!auth.handle(data)) return;
 *     // authenticated message — forward to your handler
 *   });
 *
 *   ws.on('close', () => auth.dispose());
 * });
 * ```
 */
export function createAuthMiddleware(
  config: AuthConfig,
  logger?: ILogger,
): (ws: WebSocket) => WebSocketAuthenticator {
  if (!config.secret || config.secret.length < 32) {
    throw new Error('AuthConfig.secret must be at least 32 characters');
  }

  return (ws: WebSocket): WebSocketAuthenticator =>
    new WebSocketAuthenticator(ws, config, logger);
}
