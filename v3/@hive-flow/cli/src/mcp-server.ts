/**
 * V3 CLI MCP Server Management
 *
 * Provides server lifecycle management for MCP integration:
 * - Start/stop/status methods with process management
 * - Health check endpoint integration
 * - Graceful shutdown handling
 * - PID file management for daemon detection
 * - Event-based status monitoring
 *
 * Performance Targets:
 * - Server startup: <400ms
 * - Health check: <10ms
 * - Graceful shutdown: <5s
 *
 * @module @hive-flow/cli/mcp-server
 * @version 3.0.0
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { createServer, Server, request as httpRequest_ } from 'http';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadHive, saveHive, listHives, type HiveRecord, type HiveStatus } from './mcp-tools/hive-store.js';
import {
  resolveClientKindFromEnv,
  type OperatorClientKind,
} from './mcp-tools/session-id.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _mcpClientModule: any = null;
async function getMcpClient() {
  if (!_mcpClientModule) _mcpClientModule = await import('./mcp-client.js');
  return _mcpClientModule;
}

/**
 * MCP Server configuration
 */
export interface MCPServerOptions {
  transport?: 'stdio' | 'http' | 'websocket';
  host?: string;
  port?: number;
  pidFile?: string;
  logFile?: string;
  tools?: string[] | 'all';
  daemonize?: boolean;
  timeout?: number;
}

/**
 * MCP Server status
 */
export interface MCPServerStatus {
  running: boolean;
  pid?: number;
  transport?: string;
  host?: string;
  port?: number;
  uptime?: number;
  tools?: number;
  startedAt?: string;
  health?: {
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  };
}

/**
 * JSON-RPC error codes (MCP / JSON-RPC 2.0 spec)
 * Mirrors local MCP ErrorCodes — kept local so stdio startup stays light.
 */
const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Default configuration
 */
const DEFAULT_OPTIONS: Required<MCPServerOptions> = {
  transport: 'stdio',
  host: 'localhost',
  port: 3000,
  pidFile: path.join(os.tmpdir(), 'hive-flow-mcp.pid'),
  logFile: path.join(os.tmpdir(), 'hive-flow-mcp.log'),
  tools: 'all',
  daemonize: false,
  timeout: 30000,
};

export type MCPClientKind = OperatorClientKind;

type HiveStatusNotificationInput = Pick<HiveRecord, 'hiveId' | 'queenId' | 'status' | 'updatedAt' | 'completedAt' | 'error'>;
type MCPClientClassificationOptions = {
  trustEnvFallback?: boolean;
};

function readNestedString(value: unknown, keys: readonly string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function hasClaudeRuntimeMarker(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.CLAUDECODE
    || env.CLAUDE_CODE
    || env.CLAUDE_CODE_ENTRYPOINT
    || env.CLAUDE_CODE_SESSION_ID
  );
}

function classifyClientText(text: string): MCPClientKind {
  const normalized = text.toLowerCase();
  if (normalized.includes('forgecode') || normalized.includes('forge-code') || normalized.includes('forge code')) return 'forgecode';
  if (normalized.includes('opencode') || normalized.includes('open-code') || normalized.includes('open code')) return 'opencode';
  if (normalized.includes('antigravity') || /\bagy\b/.test(normalized)) return 'antigravity';
  if (normalized.includes('cursor-agent') || normalized.includes('cursor-cli') || normalized.includes('cursor')) return 'cursor';
  if (normalized.includes('gemini-cli') || normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('claude')) return 'claude';
  return 'unknown';
}

export function classifyMCPClient(
  params: unknown,
  env: Record<string, string | undefined> = process.env,
  options: MCPClientClassificationOptions = {},
): MCPClientKind {
  const runtimeKind = resolveClientKindFromEnv(env);
  if (runtimeKind === 'claude' && hasClaudeRuntimeMarker(env)) return 'claude';

  const clientInfoText = [
    readNestedString(params, ['clientInfo', 'name']),
    readNestedString(params, ['clientInfo', 'title']),
    readNestedString(params, ['clientInfo', 'version']),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');

  const clientInfoKind = classifyClientText(clientInfoText);
  if (clientInfoKind !== 'unknown') return clientInfoKind;

  if (options.trustEnvFallback === false) {
    return 'unknown';
  }

  if (runtimeKind !== 'unknown') return runtimeKind;

  const envText = [
    env.CODEX_HOME ? `CODEX_HOME ${env.CODEX_HOME}` : undefined,
    env.CODEX_SANDBOX ? `CODEX_SANDBOX ${env.CODEX_SANDBOX}` : undefined,
    env.GEMINI_API_KEY ? 'GEMINI_API_KEY configured' : undefined,
    env.GOOGLE_API_KEY ? 'GOOGLE_API_KEY configured gemini' : undefined,
    env.GEMINI_HOME ? `GEMINI_HOME ${env.GEMINI_HOME}` : undefined,
    env.CURSOR_API_KEY ? 'CURSOR_API_KEY configured' : undefined,
    env.CURSOR_HOME ? `CURSOR_HOME ${env.CURSOR_HOME}` : undefined,
    env.AGENT_SESSION_ID ? `AGENT_SESSION_ID ${env.AGENT_SESSION_ID} cursor` : undefined,
    env.AGY_SESSION_ID ? `AGY_SESSION_ID ${env.AGY_SESSION_ID} agy` : undefined,
    env.ANTIGRAVITY_SESSION_ID ? `ANTIGRAVITY_SESSION_ID ${env.ANTIGRAVITY_SESSION_ID}` : undefined,
    env.OPENCODE_SESSION_ID ? `OPENCODE_SESSION_ID ${env.OPENCODE_SESSION_ID}` : undefined,
    env.FORGECODE_SESSION_ID ? `FORGECODE_SESSION_ID ${env.FORGECODE_SESSION_ID}` : undefined,
    env.FORGE_SESSION_ID ? `FORGE_SESSION_ID ${env.FORGE_SESSION_ID} forgecode` : undefined,
    env.CLAUDE_PROJECT_DIR ? `CLAUDE_PROJECT_DIR ${env.CLAUDE_PROJECT_DIR}` : undefined,
    env.CLAUDECODE ? `CLAUDECODE ${env.CLAUDECODE}` : undefined,
    env.CLAUDE_CODE ? `CLAUDE_CODE ${env.CLAUDE_CODE}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');

  return classifyClientText(envText);
}

export function clientKindForMCPToolContext(clientKind: MCPClientKind): Exclude<MCPClientKind, 'unknown'> {
  if (clientKind !== 'unknown') return clientKind;
  // Stdio MCP process env can belong to the operator that reconnected the
  // server, not the operator that owns this MCP connection. Avoid leaking stale
  // ambient Codex/Cursor/etc. markers into agent ownership; unclassified local
  // MCP clients use the Claude-compatible default and explicit tool inputs can
  // still override it.
  return 'claude';
}

function readExplicitToolSessionId(params: Record<string, unknown>): string | undefined {
  const sessionId = typeof params.session_id === 'string'
    ? params.session_id.trim()
    : typeof params.sessionId === 'string'
      ? params.sessionId.trim()
      : '';
  return sessionId || undefined;
}

export function buildMCPToolContextForCall(
  transportSessionId: string,
  clientKind: MCPClientKind,
  toolParams: Record<string, unknown>,
): { sessionId: string; clientKind: Exclude<MCPClientKind, 'unknown'> } {
  const explicitSessionId = readExplicitToolSessionId(toolParams);
  return {
    sessionId: clientKind !== 'unknown' && explicitSessionId ? explicitSessionId : transportSessionId,
    clientKind: clientKindForMCPToolContext(clientKind),
  };
}

export function buildHiveStatusNotification(
  hive: HiveStatusNotificationInput,
  clientKind: MCPClientKind = 'unknown',
) {
  const failed = hive.status === 'failed' || hive.status === 'terminated';
  const reviewAction = clientKind === 'codex'
    ? 'Codex should call hive_poll_workers or queen_collect_results to pick up the finished hive.'
    : clientKind === 'claude'
      ? 'Claude may also receive an asyncRewake hook; call hive_poll_workers or queen_collect_results to review.'
      : clientKind === 'gemini'
        ? 'Gemini should call hive_poll_workers or queen_collect_results to pick up the finished hive.'
        : clientKind === 'cursor'
          ? 'Cursor should call hive_poll_workers or queen_collect_results to pick up the finished hive.'
          : clientKind === 'antigravity'
            ? 'Antigravity should call hive_poll_workers or queen_collect_results to pick up the finished hive.'
            : clientKind === 'opencode'
              ? 'OpenCode should call hive_poll_workers or queen_collect_results to pick up the finished hive.'
              : clientKind === 'forgecode'
                ? 'ForgeCode should call hive_poll_workers or queen_collect_results to pick up the finished hive.'
                : 'Call hive_poll_workers or queen_collect_results to review.';

  return {
    jsonrpc: '2.0' as const,
    method: 'notifications/message' as const,
    params: {
      level: failed ? 'error' as const : 'info' as const,
      logger: 'hive-flow',
      data: {
        type: 'hive_status_update',
        clientKind,
        message: `Hive ${hive.hiveId} ${hive.status}. ${reviewAction}`,
        hiveId: hive.hiveId,
        queenId: hive.queenId,
        status: hive.status,
        completedAt: hive.completedAt,
        updatedAt: hive.updatedAt,
        error: hive.error,
      },
    },
  };
}

/**
 * Stdout write queue/mutex to prevent race conditions
 */
class StdoutWriteQueue {
  private queue: Array<() => Promise<void>> = [];
  private isWriting = false;
  private writePromise: Promise<void> = Promise.resolve();

  write(data: string): void {
    const writeFunc = async () => {
      // Use synchronous write to avoid interleaving
      process.stdout.write(data + '\n');
    };
    
    this.queue.push(writeFunc);
    this.processQueue();
  }

  private processQueue(): void {
    if (this.isWriting || this.queue.length === 0) {
      return;
    }

    this.isWriting = true;
    const task = this.queue.shift()!;
    
    this.writePromise = this.writePromise
      .then(() => task())
      .catch((error) => {
        console.error(`[${new Date().toISOString()}] ERROR [hive-flow-mcp] Stdout write error:`, error);
      })
      .finally(() => {
        this.isWriting = false;
        setImmediate(() => this.processQueue());
      });
  }
}

/**
 * MCP Server Manager
 *
 * Manages the lifecycle of the MCP server process
 */
export class MCPServerManager extends EventEmitter {
  private options: Required<MCPServerOptions>;
  private process?: ChildProcess;
  private server?: Server;
  private startTime?: Date;
  private healthCheckInterval?: NodeJS.Timeout;
  private stdoutQueue = new StdoutWriteQueue();
  private registerHiveForMonitoring?: (hiveId: string) => Promise<void>;

  constructor(options: MCPServerOptions = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<MCPServerStatus> {
    // Check if already running
    const status = await this.getStatus();
    if (status.running) {
      throw new Error(`MCP Server already running (PID: ${status.pid})`);
    }

    const startTime = performance.now();
    this.startTime = new Date();

    this.emit('starting', { options: this.options });

    try {
      if (this.options.transport === 'stdio') {
        // For stdio transport, spawn the server process
        await this.startStdioServer();
      } else {
        // For HTTP/WebSocket, start in-process server
        await this.startHttpServer();
      }

      const duration = performance.now() - startTime;

      // Write PID file
      await this.writePidFile();

      // Start health check monitoring
      this.startHealthMonitoring();

      const finalStatus = await this.getStatus();

      this.emit('started', {
        ...finalStatus,
        startupTime: duration,
      });

      return finalStatus;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the MCP server
   */
  async stop(force = false): Promise<void> {
    const status = await this.getStatus();

    if (!status.running) {
      return;
    }

    this.emit('stopping', { force });

    try {
      // Stop health monitoring
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = undefined;
      }

      if (this.process) {
        // Graceful shutdown
        if (!force) {
          this.process.kill('SIGTERM');
          await this.waitForExit(5000);
        }

        // Force kill if still running
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }

        this.process = undefined;
      }

      if (this.server) {
        await new Promise<void>((resolve) => {
          this.server!.close(() => resolve());
        });
        this.server = undefined;
      }

      // Remove PID file
      await this.removePidFile();

      this.startTime = undefined;
      this.emit('stopped');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get server status
   */
  async getStatus(): Promise<MCPServerStatus> {
    // Check PID file
    const pid = await this.readPidFile();

    if (!pid) {
      return { running: false };
    }

    // Check if process is running
    const isRunning = this.isProcessRunning(pid);

    if (!isRunning) {
      // Clean up stale PID file
      await this.removePidFile();
      return { running: false };
    }

    // Build status
    const status: MCPServerStatus = {
      running: true,
      pid,
      transport: this.options.transport,
      host: this.options.host,
      port: this.options.port,
      startedAt: this.startTime?.toISOString(),
      uptime: this.startTime
        ? Math.floor((Date.now() - this.startTime.getTime()) / 1000)
        : undefined,
    };

    // Get health status for HTTP transport
    if (this.options.transport !== 'stdio') {
      status.health = await this.checkHealth();
    }

    return status;
  }

  /**
   * Check server health
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    error?: string;
    metrics?: Record<string, number>;
  }> {
    if (this.options.transport === 'stdio') {
      // For stdio, check if process is running
      const pid = await this.readPidFile();
      if (pid === null) {
        return { healthy: false, error: 'No PID file found' };
      }
      if (!this.isProcessRunning(pid)) {
        // Clean up stale PID file
        await this.removePidFile();
        return { healthy: false, error: 'Process not running (cleaned up stale PID)' };
      }
      return { healthy: true };
    }

    // For HTTP/WebSocket, make health check request
    try {
      const response = await this.httpRequest(
        `http://${this.options.host}:${this.options.port}/health`,
        'GET',
        this.options.timeout
      );

      return {
        healthy: response.status === 'ok',
        metrics: {
          connections: response.connections || 0,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Restart the server
   */
  async restart(): Promise<MCPServerStatus> {
    await this.stop();
    return await this.start();
  }

  /**
   * Start stdio server in-process
   * Handles stdin/stdout directly like V2 implementation
   */
  private async startStdioServer(): Promise<void> {
    // Import the tool registry
    const { listMCPTools, callMCPTool, hasTool } = await getMcpClient();

    const VERSION = '3.0.0';
    const sessionId = `mcp-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // Log to stderr to not corrupt stdout
    console.error(
      `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Starting in stdio mode`
    );
    console.error(JSON.stringify({
      arch: process.arch,
      mode: 'mcp-stdio',
      nodeVersion: process.version,
      pid: process.pid,
      platform: process.platform,
      protocol: 'stdio',
      sessionId,
      version: VERSION,
    }));

    let clientKind: MCPClientKind = 'unknown';

    // Handle stdin messages
    let buffer = '';

    process.stdin.on('data', async (chunk) => {
      buffer += chunk.toString();

      // Process complete JSON messages
      let lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            if (message && typeof message === 'object' && message.method === 'initialize') {
              clientKind = classifyMCPClient(message.params, process.env, { trustEnvFallback: false });
            }
            const response = await this.handleMCPMessage(message, sessionId, clientKind);
            if (response) {
              this.stdoutQueue.write(JSON.stringify(response));
            }
          } catch (error) {
            console.error(
              `[${new Date().toISOString()}] ERROR [hive-flow-mcp] Failed to parse message:`,
              error instanceof Error ? error.message : String(error)
            );
            // Send JSON-RPC parse error response per spec
            this.stdoutQueue.write(JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: ErrorCodes.PARSE_ERROR, message: 'Parse error', data: error instanceof Error ? error.message : String(error) }
            }));
          }
        }
      }
    });

    process.stdin.on('end', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) stdin closed, shutting down...`
      );
      process.exit(0);
    });

    // Handle process termination
    process.on('SIGINT', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Received SIGINT, shutting down...`
      );
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.error(
        `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Received SIGTERM, shutting down...`
      );
      process.exit(0);
    });

    const monitoredHiveIds = new Set<string>();
    const notifiedTerminalHives = new Set<string>();
    let pollingInterval: NodeJS.Timeout | null = null;

    const HIVE_POLL_INTERVAL = 5000;
    const TERMINAL_HIVE_STATUSES = new Set<HiveStatus>(['completed', 'failed', 'terminated']);

    const sendHiveStatusNotification = (hive: HiveStatusNotificationInput) => {
      if (notifiedTerminalHives.has(hive.hiveId)) {
        return;
      }

      notifiedTerminalHives.add(hive.hiveId);

      this.stdoutQueue.write(JSON.stringify(buildHiveStatusNotification(hive, clientKind)));

      console.error(
        `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Hive status update: ${hive.hiveId} - ${hive.status}`
      );
    };

    const pollHiveStatus = async (hiveId: string) => {
      // Diagnostic: write breadcrumb to confirm poll fires
      try {
        const diagPath = path.join(process.cwd(), '.hive-flow', 'data', 'poll-diagnostic.jsonl');
        fs.appendFileSync(diagPath, JSON.stringify({ event: 'poll', hiveId, ts: new Date().toISOString() }) + '\n');
      } catch { /* ignore */ }

      try {
        let hive = loadHive(hiveId);

        if (!hive) {
          monitoredHiveIds.delete(hiveId);
          console.error(
            `[${new Date().toISOString()}] WARN [hive-flow-mcp] (${sessionId}) Hive ${hiveId} disappeared during monitoring`
          );
          return;
        }

        // If already terminal, just notify
        if (TERMINAL_HIVE_STATUSES.has(hive.status)) {
          sendHiveStatusNotification({
            hiveId: hive.hiveId,
            queenId: hive.queenId,
            status: hive.status,
            completedAt: hive.completedAt,
            updatedAt: hive.updatedAt,
            error: hive.error,
          });
          monitoredHiveIds.delete(hiveId);
          return;
        }

        // Not terminal — invoke hive_poll_workers to check result files + auto-transition
        try {
          const pollResult = await callMCPTool('hive_poll_workers', { hiveId }, {
            sessionId,
            clientKind: clientKindForMCPToolContext(clientKind),
          }) as Record<string, unknown> | null;
          if (pollResult && (pollResult.allWorkersSettled || pollResult.allComplete)) {
            // Re-read hive — hive_poll_workers may have transitioned it to completed
            const freshHive = loadHive(hiveId);
            if (freshHive && TERMINAL_HIVE_STATUSES.has(freshHive.status)) {
              console.error(
                `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Hive ${hiveId} completed — detected by internal poll`
              );
              sendHiveStatusNotification({
                hiveId: freshHive.hiveId,
                queenId: freshHive.queenId,
                status: freshHive.status,
                completedAt: freshHive.completedAt,
                updatedAt: freshHive.updatedAt,
                error: freshHive.error,
              });
              monitoredHiveIds.delete(hiveId);
              return;
            }
          }
        } catch (pollErr) {
          console.error(
            `[${new Date().toISOString()}] WARN [hive-flow-mcp] Internal poll failed for hive ${hiveId}:`,
            pollErr instanceof Error ? pollErr.message : String(pollErr)
          );
        }

        // Fallback: send notification if hive somehow reached terminal after poll
        hive = loadHive(hiveId);
        if (hive && TERMINAL_HIVE_STATUSES.has(hive.status)) {
          sendHiveStatusNotification({
            hiveId: hive.hiveId,
            queenId: hive.queenId,
            status: hive.status,
            completedAt: hive.completedAt,
            updatedAt: hive.updatedAt,
            error: hive.error,
          });
          monitoredHiveIds.delete(hiveId);
        }
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] WARN [hive-flow-mcp] Failed to poll hive ${hiveId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    const startHivePolling = () => {
      if (pollingInterval) {
        return;
      }

      pollingInterval = setInterval(async () => {
        const monitoredHiveIdsArray = Array.from(monitoredHiveIds);
        // Diagnostic: confirm interval fires
        try {
          const diagPath = path.join(process.cwd(), '.hive-flow', 'data', 'poll-diagnostic.jsonl');
          fs.appendFileSync(diagPath, JSON.stringify({ event: 'interval-tick', count: monitoredHiveIdsArray.length, ts: new Date().toISOString() }) + '\n');
        } catch { /* ignore */ }
        if (monitoredHiveIdsArray.length === 0) {
          return;
        }

        await Promise.allSettled(
          monitoredHiveIdsArray.map(hiveId => pollHiveStatus(hiveId))
        );
      }, HIVE_POLL_INTERVAL);

      pollingInterval.unref();

      console.error(
        `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Hive polling started`
      );

      void Promise.allSettled(
        Array.from(monitoredHiveIds).map(hiveId => pollHiveStatus(hiveId))
      );
    };

    const registerHiveForMonitoring = async (hiveId: string) => {
      if (monitoredHiveIds.has(hiveId) || notifiedTerminalHives.has(hiveId)) {
        return;
      }

      monitoredHiveIds.add(hiveId);
      console.error(
        `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Registered hive ${hiveId} for monitoring`
      );

      // Diagnostic: write breadcrumb to confirm registration fires
      try {
        const diagPath = path.join(process.cwd(), '.hive-flow', 'data', 'poll-diagnostic.jsonl');
        fs.appendFileSync(diagPath, JSON.stringify({ event: 'register', hiveId, ts: new Date().toISOString() }) + '\n');
      } catch { /* ignore */ }

      startHivePolling();
      await pollHiveStatus(hiveId);
    };

    this.registerHiveForMonitoring = registerHiveForMonitoring;

    void (async () => {
      try {
        const activeHives = listHives('active');
        for (const hive of activeHives) {
          monitoredHiveIds.add(hive.hiveId);
        }

        if (activeHives.length > 0) {
          startHivePolling();
          console.error(
            `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Restored ${activeHives.length} active hive(s) for monitoring`
          );
        }
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] WARN [hive-flow-mcp] Failed to restore active hive monitoring:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    })();
    
    /**
     * Clean up interval on process exit
     */
    process.on('exit', () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    });

    // Mark as ready immediately for stdio
    this.emit('ready');
  }

  /**
   * Handle incoming MCP message
   */
  private async handleMCPMessage(
    message: { jsonrpc: string; id?: string | number; method?: string; params?: unknown },
    sessionId: string,
    clientKind: MCPClientKind = 'unknown',
  ): Promise<{ jsonrpc: string; id?: string | number; result?: unknown; error?: { code: number; message: string } } | null> {
    const { listMCPTools, callMCPTool, hasTool } = await getMcpClient();

    if (!message.method) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid Request: missing method' },
      };
    }

    const params = (message.params || {}) as Record<string, unknown>;

    try {
      switch (message.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0' as const,
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'hive-flow', version: '3.0.0' },
              capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
                logging: {},
              },
            },
          };

        case 'tools/list':
          const tools = listMCPTools();
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: tools.map(tool => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
            },
          };

        case 'tools/call':
          const toolName = params.name as string;
          const toolParams = (params.arguments || {}) as Record<string, unknown>;

          if (!hasTool(toolName)) {
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: ErrorCodes.METHOD_NOT_FOUND, message: `Tool not found: ${toolName}` },
            };
          }

          try {
            const result = await callMCPTool(
              toolName,
              toolParams,
              buildMCPToolContextForCall(sessionId, clientKind, toolParams),
            );
            
            // Intercept queen_mission_assign success to auto-register hive for monitoring
            if (toolName === 'queen_mission_assign' && result && typeof result === 'object' && 'success' in result && result.success === true) {
              try {
                const hiveId = typeof (result as { hiveId?: unknown }).hiveId === 'string'
                  ? (result as { hiveId: string }).hiveId
                  : undefined;
                // Diagnostic: confirm interception fires
                try {
                  const diagPath = path.join(process.cwd(), '.hive-flow', 'data', 'poll-diagnostic.jsonl');
                  fs.appendFileSync(diagPath, JSON.stringify({ event: 'intercept', toolName, hiveId: hiveId || 'NONE', hasRegisterFn: !!this.registerHiveForMonitoring, ts: new Date().toISOString() }) + '\n');
                } catch { /* ignore */ }
                if (hiveId) {
                  await this.registerHiveForMonitoring?.(hiveId);
                }
              } catch (monitoringError) {
                // Log but don't fail the original mission assignment
                console.error(
                  `[${new Date().toISOString()}] WARN [hive-flow-mcp] Failed to start hive monitoring:`,
                  monitoringError instanceof Error ? monitoringError.message : String(monitoringError)
                );
              }
            }
            
            return {
              jsonrpc: '2.0',
              id: message.id,
              result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
            };
          } catch (error) {
            return {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: ErrorCodes.INTERNAL_ERROR,
                message: error instanceof Error ? error.message : 'Tool execution failed',
              },
            };
          }

        case 'notifications/initialized':
          // Client notification - no response needed
          console.error(
            `[${new Date().toISOString()}] INFO [hive-flow-mcp] (${sessionId}) Client initialized`
          );
          return null;

        case 'ping':
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {},
          };

        case 'logging/setLevel':
          // Client requests a log level change — acknowledge with an empty result
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: {},
          };

        default:
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: ErrorCodes.METHOD_NOT_FOUND, message: `Method not found: ${message.method}` },
          };
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ERROR [hive-flow-mcp] Error handling ${message.method}:`,
        error
      );
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
    }
  }

  /**
   * Start HTTP server in-process
   */
  private async startHttpServer(): Promise<void> {
    // Dynamically import the local MCP implementation (HTTP/WS transport only).
    // The stdio path stays dependency-light; HTTP/WebSocket loads the heavier
    // transport stack only when requested.
    let createMCPServer: (typeof import('./mcp/index.js'))['createMCPServer'];
    try {
      ({ createMCPServer } = await import('./mcp/index.js'));
    } catch (importErr) {
      throw new Error(
        `HTTP/WebSocket MCP transport requires the local MCP implementation which could not be loaded: ${(importErr as Error).message}. ` +
        `Use --transport stdio (default) or run 'pnpm install' and 'pnpm --filter @hive-flow/cli build'.`,
      );
    }

    const logger = {
      debug: (msg: string, data?: unknown) => this.emit('log', { level: 'debug', msg, data }),
      info: (msg: string, data?: unknown) => this.emit('log', { level: 'info', msg, data }),
      warn: (msg: string, data?: unknown) => this.emit('log', { level: 'warn', msg, data }),
      error: (msg: string, data?: unknown) => this.emit('log', { level: 'error', msg, data }),
    };

    const mcpServer = createMCPServer(
      {
        name: 'Hive-Flow MCP Server V3',
        version: '3.0.0',
        transport: this.options.transport as 'http' | 'websocket',
        host: this.options.host,
        port: this.options.port,
        enableMetrics: true,
        enableCaching: true,
      },
      logger
    );

    await mcpServer.start();

    // Store reference for stopping
    // SAFETY: dynamic property on class instance to hold MCP server reference for shutdown
    (this as unknown as Record<string, unknown>)._mcpServer = mcpServer;
  }

  /**
   * Wait for server to be ready
   */
  private async waitForReady(timeout = 10000): Promise<void> {
    // For stdio transport, we're ready immediately (in-process)
    if (this.options.transport === 'stdio') {
      return;
    }

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const health = await this.checkHealth();
      if (health.healthy) {
        return;
      }
      await this.sleep(100);
    }

    throw new Error('Server failed to start within timeout');
  }

  /**
   * Wait for process to exit
   */
  private async waitForExit(timeout: number): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, timeout);

      this.process!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.checkHealth();
        this.emit('health', health);

        if (!health.healthy) {
          this.emit('unhealthy', health);
        }
      } catch (error) {
        this.emit('health-error', error);
      }
    }, 30000).unref();
  }

  /**
   * Write PID file
   */
  private async writePidFile(): Promise<void> {
    const pid = this.process?.pid || process.pid;
    await fs.promises.writeFile(this.options.pidFile, String(pid), 'utf8');
  }

  /**
   * Read PID file
   */
  private async readPidFile(): Promise<number | null> {
    try {
      const content = await fs.promises.readFile(this.options.pidFile, 'utf8');
      const pid = parseInt(content.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Remove PID file
   */
  private async removePidFile(): Promise<void> {
    try {
      await fs.promises.unlink(this.options.pidFile);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Check if process is running
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Make HTTP request
   */
  private async httpRequest(
    url: string,
    method: string,
    timeout: number
  ): Promise<{ status?: string; connections?: number }> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);

      const req = httpRequest_(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method,
          timeout,
        },
        (res: import('http').IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: string) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ status: res.statusCode === 200 ? 'ok' : 'error' });
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create MCP server manager
 */
export function createMCPServerManager(
  options?: MCPServerOptions
): MCPServerManager {
  return new MCPServerManager(options);
}

/**
 * Singleton server manager instance
 */
let serverManager: MCPServerManager | null = null;
let currentTransport: string | undefined = undefined;

/**
 * Get or create server manager singleton
 *
 * FIX for issue #942: Recreate singleton if transport type changes
 * Previously, once created with stdio (default), HTTP options were ignored
 */
export function getServerManager(
  options?: MCPServerOptions
): MCPServerManager {
  const requestedTransport = options?.transport;

  // Recreate if transport type changes (fixes HTTP transport not working)
  if (serverManager && requestedTransport && requestedTransport !== currentTransport) {
    serverManager = new MCPServerManager(options);
    currentTransport = requestedTransport;
  }

  if (!serverManager) {
    serverManager = new MCPServerManager(options);
    currentTransport = options?.transport;
  }
  return serverManager;
}

/**
 * Quick start MCP server
 */
export async function startMCPServer(
  options?: MCPServerOptions
): Promise<MCPServerStatus> {
  const manager = getServerManager(options);
  return await manager.start();
}

/**
 * Quick stop MCP server
 */
export async function stopMCPServer(force = false): Promise<void> {
  if (serverManager) {
    await serverManager.stop(force);
  }
}

/**
 * Get MCP server status
 */
export async function getMCPServerStatus(): Promise<MCPServerStatus> {
  const manager = getServerManager();
  return await manager.getStatus();
}

export default MCPServerManager;
