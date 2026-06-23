/**
 * Resilient WebSocket Client Transport
 * Ported from Neo.mjs self-healing patterns
 */

import { EventEmitter } from 'events';
import { WebSocket, RawData } from 'ws';
import type {
  ITransport,
  TransportType,
  MCPRequest,
  MCPResponse,
  MCPNotification,
  RequestHandler,
  NotificationHandler,
  TransportHealthStatus,
  ILogger,
} from '../types.js';

/**
 * WebSocket Client States
 */
export enum WebSocketState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  FAILED = 'FAILED',
}

/**
 * Resilient WebSocket Client Configuration
 */
export interface ResilientWebSocketConfig {
  url: string;
  maxRetries?: number;
  initialRetryDelay?: number;
  maxRetryDelay?: number;
  backoffFactor?: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  maxBufferSize?: number;
  requestTimeout?: number;
}

/**
 * Resilient WebSocket Client Implementation
 */
const MAX_BUFFER_BYTES = 50 * 1024 * 1024; // 50 MB

export class ResilientWebSocketClient extends EventEmitter implements ITransport {
  public readonly type: TransportType = 'websocket';

  private state: WebSocketState = WebSocketState.DISCONNECTED;
  private ws?: WebSocket;
  private retryCount = 0;
  private _bufferedBytes = 0;
  private pendingMessages: Array<{
    message: MCPRequest | MCPNotification;
    resolve?: (value: any) => void;
    reject?: (reason?: any) => void;
    timestamp: number;
  }> = [];
  
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatTimeoutTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  
  private requestHandler?: RequestHandler;
  private notificationHandler?: NotificationHandler;
  
  private metrics = {
    messagesSent: 0,
    messagesReceived: 0,
    errors: 0,
    reconnects: 0,
  };

  constructor(
    private readonly logger: ILogger,
    private readonly config: ResilientWebSocketConfig
  ) {
    super();
    this.config.maxRetries = config.maxRetries ?? 10;
    this.config.initialRetryDelay = config.initialRetryDelay ?? 1000;
    this.config.maxRetryDelay = config.maxRetryDelay ?? 30000;
    this.config.backoffFactor = config.backoffFactor ?? 2;
    this.config.heartbeatInterval = config.heartbeatInterval ?? 30000;
    this.config.heartbeatTimeout = config.heartbeatTimeout ?? 10000;
    this.config.maxBufferSize = config.maxBufferSize ?? 1000;
  }

  /**
   * Start the transport (connect)
   */
  async start(): Promise<void> {
    if (this.state !== WebSocketState.DISCONNECTED && this.state !== WebSocketState.FAILED) {
      return;
    }
    await this.connect();
  }

  /**
   * Stop the transport (disconnect)
   */
  async stop(): Promise<void> {
    this.state = WebSocketState.DISCONNECTED;
    this.clearTimers();
    
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }
    
    this.logger.info('WebSocket client stopped');
  }

  /**
   * Connect to the server
   */
  private async connect(): Promise<void> {
    if (this.state === WebSocketState.CONNECTED) return;
    
    if (this.state !== WebSocketState.RECONNECTING) {
      this.state = WebSocketState.CONNECTING;
    }
    
    const safeUrl = this.config.url
      .replace(/:\/\/[^@]+@/, '://[redacted]@')
      .replace(/([?&](token|key|secret|password)=)[^&]+/gi, '$1[redacted]');
    this.logger.info('Connecting to WebSocket server', { url: safeUrl, state: this.state });
    
    try {
      this.ws = new WebSocket(this.config.url);
      this.setupHandlers();
    } catch (error) {
      this.handleConnectionError(error as Error);
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected');
      this.state = WebSocketState.CONNECTED;
      this.retryCount = 0;
      this.startHeartbeat();
      this.flushBuffer();
      this.emit('connected');
    });

    this.ws.on('message', (data: RawData) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      this.logger.error('WebSocket error', { error });
      this.metrics.errors++;
      this.handleConnectionError(error);
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn('WebSocket closed', { code, reason: reason.toString() });
      if (this.state !== WebSocketState.DISCONNECTED) {
        this.handleConnectionError(new Error(`WebSocket closed: ${code} ${reason}`));
      }
    });

    this.ws.on('pong', () => {
      if (this.heartbeatTimeoutTimer) {
        clearTimeout(this.heartbeatTimeoutTimer);
        this.heartbeatTimeoutTimer = undefined;
      }
    });
  }

  /**
   * Handle connection errors and trigger reconnection
   */
  private handleConnectionError(error: Error): void {
    if (this.state === WebSocketState.DISCONNECTED) return;
    
    this.state = WebSocketState.RECONNECTING;
    this.clearTimers();
    
    this.retryCount++;
    if (this.retryCount >= (this.config.maxRetries ?? 10)) {
      this.logger.error('Max reconnection retries reached');
      this.state = WebSocketState.FAILED;
      this.emit('failed', error);
      return;
    }

    const delay = Math.min(
      (this.config.initialRetryDelay || 1000) * Math.pow(this.config.backoffFactor || 2, this.retryCount),
      this.config.maxRetryDelay || 30000
    );

    this.logger.info(`Attempting reconnection in ${delay}ms`, { attempt: this.retryCount });

    this.reconnectTimer = setTimeout(() => {
      this.metrics.reconnects++;
      this.connect();
    }, delay);
  }

  /**
   * Handle incoming messages
   */
  private async handleMessage(data: RawData): Promise<void> {
    this.metrics.messagesReceived++;
    try {
      const message = JSON.parse(data.toString());
      
      if (message.id !== undefined) {
        // This is a response to a request we sent, or a request from server
        // If it has 'method', it's a request from server
        if (message.method) {
          if (this.requestHandler) {
            const response = await this.requestHandler(message as MCPRequest);
            this.sendInternal(response);
          }
        } else {
          // It's a response - but in ITransport, we don't have a way to match responses to requests
          // unless we handle it here or through an external caller.
          // For now, we'll emit it so callers can handle it.
          this.emit('response', message);
        }
      } else if (message.method) {
        // Notification
        if (this.notificationHandler) {
          await this.notificationHandler(message as MCPNotification);
        }
      }
    } catch (error) {
      this.logger.error('Failed to parse WebSocket message', { error });
      this.metrics.errors++;
    }
  }

  /**
   * Flush buffered messages
   */
  private flushBuffer(): void {
    if (this.state !== WebSocketState.CONNECTED || !this.ws) return;

    this.logger.info(`Flushing ${this.pendingMessages.length} buffered messages`);

    while (this.pendingMessages.length > 0) {
      const entry = this.pendingMessages.shift()!;
      const entryBytes = Buffer.byteLength(JSON.stringify(entry.message), 'utf8');
      this._bufferedBytes = Math.max(0, this._bufferedBytes - entryBytes);
      this.sendInternal(entry.message);
    }
  }

  /**
   * Send a message through the WebSocket
   */
  private sendInternal(message: any): void {
    if (this.state === WebSocketState.CONNECTED && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      this.metrics.messagesSent++;
    } else {
      this.bufferMessage(message);
    }
  }

  /**
   * Buffer message if not connected.
   * Enforces both a count limit (maxBufferSize) and a byte limit (MAX_BUFFER_BYTES).
   * Oldest entries are evicted when either limit is exceeded.
   */
  private bufferMessage(message: any): void {
    const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');

    while (
      this.pendingMessages.length > 0 &&
      (
        this.pendingMessages.length >= (this.config.maxBufferSize || 1000) ||
        this._bufferedBytes + messageBytes > MAX_BUFFER_BYTES
      )
    ) {
      const evicted = this.pendingMessages.shift()!;
      const evictedBytes = Buffer.byteLength(JSON.stringify(evicted.message), 'utf8');
      this._bufferedBytes = Math.max(0, this._bufferedBytes - evictedBytes);
      this.logger.warn('Message buffer limit reached, dropping oldest message');
    }

    this.pendingMessages.push({
      message,
      timestamp: Date.now()
    });
    this._bufferedBytes += messageBytes;

    this.logger.debug('Buffered message', { method: message.method, queueSize: this.pendingMessages.length, bufferedBytes: this._bufferedBytes });
  }

  /**
   * ITransport Implementation
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  async sendNotification(notification: MCPNotification): Promise<void> {
    this.sendInternal(notification);
  }

  async getHealthStatus(): Promise<TransportHealthStatus> {
    return {
      healthy: this.state === WebSocketState.CONNECTED,
      metrics: {
        ...this.metrics,
        queueSize: this.pendingMessages.length,
      },
    };
  }

  /**
   * Heartbeat logic
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.state === WebSocketState.CONNECTED) {
        this.ws.ping();
        
        this.heartbeatTimeoutTimer = setTimeout(() => {
          this.logger.warn('Heartbeat timeout, terminating connection');
          // Clear timers before terminate to prevent re-entry
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
          }
          if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = undefined;
          }
          if (this.ws) {
            this.ws.terminate();
          }
        }, this.config.heartbeatTimeout);
      }
    }, this.config.heartbeatInterval);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    
    this.heartbeatTimer = undefined;
    this.heartbeatTimeoutTimer = undefined;
    this.reconnectTimer = undefined;
  }

  public getState(): WebSocketState {
    return this.state;
  }
}
