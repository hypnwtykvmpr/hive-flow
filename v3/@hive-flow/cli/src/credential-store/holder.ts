import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { normalizeProviderKeyName } from './credential-store.js';
import type { PeerCredential, PeerCredentialResolver } from './peer-credentials.js';

export interface CapabilityTokenIssuerOptions {
  ttlMs?: number;
  now?: () => number;
  randomToken?: () => string;
}

export interface CapabilityTokenRequest {
  taskId: string;
  provider: string;
  callerPid: number;
  callerStartTime: string;
}

export interface CapabilityTokenGrant {
  capability: 'provider-use';
  token: string;
  taskId: string;
  provider: string;
  expiresAt: number;
}

type StoredCapabilityToken = CapabilityTokenRequest & {
  token: string;
  expiresAt: number;
  used: boolean;
};

export class CapabilityTokenIssuer {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly tokens = new Map<string, StoredCapabilityToken>();

  constructor(options: CapabilityTokenIssuerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
  }

  issue(request: CapabilityTokenRequest): CapabilityTokenGrant {
    const provider = normalizeProviderKeyName(request.provider);
    const taskId = String(request.taskId || '').trim();
    if (!taskId) throw new Error('credential capability task id is required');
    if (!Number.isInteger(request.callerPid) || request.callerPid <= 0) throw new Error('credential capability caller PID is required');
    if (!request.callerStartTime) throw new Error('credential capability PID start-time is required');
    const token = this.randomToken();
    const stored: StoredCapabilityToken = {
      token,
      taskId,
      provider,
      callerPid: request.callerPid,
      callerStartTime: request.callerStartTime,
      expiresAt: this.now() + this.ttlMs,
      used: false,
    };
    this.tokens.set(token, stored);
    return {
      capability: 'provider-use',
      token,
      taskId,
      provider,
      expiresAt: stored.expiresAt,
    };
  }

  consume(token: string, request: CapabilityTokenRequest): CapabilityTokenRequest {
    const stored = this.tokens.get(token);
    if (!stored) throw new Error('credential capability token is unknown');
    if (stored.used) throw new Error('credential capability token is single-use and already used');
    if (this.now() > stored.expiresAt) throw new Error('credential capability token expired');
    if (stored.taskId !== request.taskId) throw new Error('credential capability task mismatch');
    if (stored.provider !== normalizeProviderKeyName(request.provider)) throw new Error('credential capability provider mismatch');
    if (stored.callerPid !== request.callerPid) throw new Error('credential capability PID mismatch');
    if (stored.callerStartTime !== request.callerStartTime) throw new Error('credential capability PID start-time mismatch');
    stored.used = true;
    return {
      taskId: stored.taskId,
      provider: stored.provider,
      callerPid: stored.callerPid,
      callerStartTime: stored.callerStartTime,
    };
  }

  invalidateProvider(provider: string): void {
    const normalized = normalizeProviderKeyName(provider);
    for (const [token, stored] of this.tokens) {
      if (stored.provider === normalized) this.tokens.delete(token);
    }
  }
}

export interface CredentialHolderServiceOptions {
  socketPath: string;
  uid?: number;
  peerCredentialResolver: PeerCredentialResolver['lookup'];
  tokenTtlMs?: number;
  now?: () => number;
  randomToken?: () => string;
}

export interface UseGrantRequest {
  taskId: string;
  provider: string;
  callerPid: number;
  callerRole?: 'coordinator' | 'sub-agent' | 'provider-worker';
  socket?: Socket;
}

export interface ProviderUseContext {
  taskId: string;
  provider: string;
  callerPid: number;
  callerStartTime: string;
}

export interface ProviderUseHandlerInput {
  provider: string;
  taskId: string;
  secret: Buffer;
}

export class CredentialHolderService {
  private readonly socketPath: string;
  private readonly uid: number;
  private readonly peerCredentialResolver: PeerCredentialResolver['lookup'];
  private readonly tokenIssuer: CapabilityTokenIssuer;
  private readonly secrets = new Map<string, Buffer>();
  private server: Server | null = null;

  constructor(options: CredentialHolderServiceOptions) {
    this.socketPath = options.socketPath;
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.peerCredentialResolver = options.peerCredentialResolver;
    this.tokenIssuer = new CapabilityTokenIssuer({
      ttlMs: options.tokenTtlMs,
      now: options.now,
      randomToken: options.randomToken,
    });
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.socketPath), 0o700);
    if (existsSync(this.socketPath)) {
      const stat = lstatSync(this.socketPath);
      throw new Error(`credential holder socket squat refused: pre-existing path is ${stat.isSocket() ? 'a socket' : 'not a socket'}`);
    }
    this.server = createServer(socket => {
      socket.end('hive-flow credential holder\n');
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });
    chmodSync(this.socketPath, 0o600);
    const stat = statSync(this.socketPath);
    if (!stat.isSocket()) throw new Error('credential holder path is not a socket after bind');
    if ((stat.mode & 0o777) !== 0o600) throw new Error('credential holder socket permissions must be 0600');
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      }).catch(() => undefined);
    }
    if (existsSync(this.socketPath)) {
      const stat = lstatSync(this.socketPath);
      if (stat.isSocket()) unlinkSync(this.socketPath);
    }
  }

  setProviderSecret(provider: string, secret: Uint8Array): void {
    this.secrets.set(normalizeProviderKeyName(provider), Buffer.from(secret));
    this.tokenIssuer.invalidateProvider(provider);
  }

  deleteProviderSecret(provider: string): void {
    this.secrets.delete(normalizeProviderKeyName(provider));
    this.tokenIssuer.invalidateProvider(provider);
  }

  async requestUseGrant(request: UseGrantRequest): Promise<CapabilityTokenGrant> {
    if (request.callerRole === 'sub-agent' || request.callerRole === 'provider-worker') {
      throw new Error('sub-agent/provider-worker PIDs never receive reusable credential holder tokens');
    }
    const peer = await this.lookupPeer(request);
    if (peer.uid !== this.uid) throw new Error(`credential holder same-user uid check failed: ${peer.uid} !== ${this.uid}`);
    return this.tokenIssuer.issue({
      taskId: request.taskId,
      provider: request.provider,
      callerPid: peer.pid,
      callerStartTime: peer.startTime,
    });
  }

  async useProviderGrant<T>(
    token: string,
    context: ProviderUseContext,
    handler: (input: ProviderUseHandlerInput) => Promise<T> | T,
  ): Promise<T> {
    const consumed = this.tokenIssuer.consume(token, context);
    const provider = normalizeProviderKeyName(consumed.provider);
    const secret = this.secrets.get(provider);
    if (!secret) throw new Error(`credential holder has no secret for provider ${provider}`);
    const response = await handler({
      provider,
      taskId: consumed.taskId,
      secret: Buffer.from(secret),
    });
    const rendered = JSON.stringify(response);
    const utf8 = secret.toString('utf8');
    const base64 = secret.toString('base64');
    if ((utf8 && rendered?.includes(utf8)) || rendered?.includes(base64)) {
      throw new Error('credential holder refused to return raw key material in provider response');
    }
    return response;
  }

  private async lookupPeer(request: UseGrantRequest): Promise<PeerCredential> {
    const peer = await this.peerCredentialResolver({ pid: request.callerPid, socket: request.socket });
    if (!peer || !Number.isInteger(peer.pid) || !Number.isInteger(peer.uid) || !peer.startTime) {
      throw new Error('credential holder failed closed: ambiguous peer credential');
    }
    if (peer.pid !== request.callerPid) throw new Error('credential holder failed closed: peer PID mismatch');
    return peer;
  }
}

export interface SameRuntimeRestartState {
  sameRuntime: boolean;
  rawKeyReleased: boolean;
  sessionValid: boolean;
}

export function sameRuntimeRestartCanRecover(state: SameRuntimeRestartState): boolean {
  return state.sameRuntime && state.sessionValid && !state.rawKeyReleased;
}

export interface FullRestartState {
  fullRuntimeRestart: boolean;
  osUnlockFresh: boolean;
  backendAvailable: boolean;
}

export function assertFullRestartRequiresUnlock(state: FullRestartState): void {
  if (!state.fullRuntimeRestart) return;
  if (!state.osUnlockFresh) throw new Error('full daemon/MCP runtime restart requires a fresh OS unlock');
  if (!state.backendAvailable) throw new Error('full daemon/MCP runtime restart fails closed when credential backend is unavailable');
}
