import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { normalizeProviderKeyName } from './credential-store.js';
import { parsePeerCredentialJson, type PeerCredential, type PeerCredentialResolver } from './peer-credentials.js';
import { redactCredentialMaterial } from './safe-serialization.js';
import {
  HELPER_BINARIES,
  configuredOrInstalledHelperPath,
} from './helper-paths.js';

export interface CapabilityTokenIssuerOptions {
  ttlMs?: number;
  now?: () => number;
  randomToken?: () => string;
  holderSecret?: Uint8Array;
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
  nonce: string;
  token: string;
  expiresAt: number;
  used: boolean;
};

export class CapabilityTokenIssuer {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly holderSecret: Buffer;
  private readonly tokens = new Map<string, StoredCapabilityToken>();

  constructor(options: CapabilityTokenIssuerOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.holderSecret = Buffer.from(options.holderSecret ?? randomBytes(32));
  }

  issue(request: CapabilityTokenRequest): CapabilityTokenGrant {
    this.sweepExpired();
    const provider = normalizeProviderKeyName(request.provider);
    const taskId = String(request.taskId || '').trim();
    if (!taskId) throw new Error('credential capability task id is required');
    if (!Number.isInteger(request.callerPid) || request.callerPid <= 0) throw new Error('credential capability caller PID is required');
    if (!request.callerStartTime) throw new Error('credential capability PID start-time is required');
    const nonce = this.randomToken();
    const token = `${nonce}.${this.sign({
      taskId,
      provider,
      callerPid: request.callerPid,
      callerStartTime: request.callerStartTime,
      nonce,
    })}`;
    const stored: StoredCapabilityToken = {
      token,
      nonce,
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
    const expected = `${stored.nonce}.${this.sign({
      taskId: stored.taskId,
      provider: stored.provider,
      callerPid: request.callerPid,
      callerStartTime: request.callerStartTime,
      nonce: stored.nonce,
    })}`;
    if (!constantTimeEqual(token, expected)) throw new Error('credential capability identity signature mismatch');
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

  private sign(input: CapabilityTokenRequest & { nonce: string }): string {
    return createHmac('sha256', this.holderSecret)
      .update(input.taskId)
      .update('\0')
      .update(input.provider)
      .update('\0')
      .update(String(input.callerPid))
      .update('\0')
      .update(input.callerStartTime)
      .update('\0')
      .update(input.nonce)
      .digest('base64url');
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [token, stored] of this.tokens) {
      if (stored.used || now > stored.expiresAt) this.tokens.delete(token);
    }
  }
}

export interface CredentialHolderServiceOptions {
  socketPath: string;
  /**
   * Host platform. Defaults to process.platform. On 'win32' the holder binds a named pipe
   * (\\.\pipe\...) instead of a Unix-domain socket and skips POSIX directory/socket permissions,
   * which do not exist for pipe kernel objects.
   */
  platform?: NodeJS.Platform;
  uid?: number;
  peerCredentialResolver: PeerCredentialResolver['lookup'];
  providerInvoker?: (input: ProviderUseHandlerInput) => Promise<unknown> | unknown;
  tokenTtlMs?: number;
  now?: () => number;
  randomToken?: () => string;
  holderSecret?: Uint8Array;
  windowsPipeHelperCommand?: string;
  windowsPipeBridgeFactory?: WindowsCredentialHolderPipeBridgeFactory;
}

export interface CredentialHolderProcessHardeningOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  setCoreDumpLimit?: () => void;
  setLinuxDumpable?: () => void;
}

export interface CredentialHolderProcessHardeningStatus {
  coreDumpDisabled: boolean;
  dumpableDisabled: boolean;
  errors?: string[];
}

export interface CredentialHolderGrantCommand {
  action: 'grant';
  taskId: string;
  provider: string;
}

export interface CredentialHolderRedeemCommand {
  action: 'redeem';
  token: string;
  taskId: string;
  provider: string;
  request?: unknown;
}

export interface CredentialHolderProviderCallCommand {
  action: 'provider_call';
  taskId: string;
  provider: string;
  request?: unknown;
}

export interface CredentialHolderPingCommand {
  action: 'ping';
}

export type CredentialHolderCommand =
  | CredentialHolderGrantCommand
  | CredentialHolderRedeemCommand
  | CredentialHolderProviderCallCommand
  | CredentialHolderPingCommand;

export type CredentialHolderResponse = {
  ok: true;
  grant?: CapabilityTokenGrant;
  ping?: {
    pid: number;
  };
  response?: unknown;
} | {
  ok: false;
  error: string;
};

export interface WindowsCredentialHolderPipeBridgeRequest {
  peer: PeerCredential;
  line: string;
}

export interface WindowsCredentialHolderPipeBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WindowsCredentialHolderPipeBridgeFactoryOptions {
  socketPath: string;
  helperCommand?: string;
  onRequest(request: WindowsCredentialHolderPipeBridgeRequest): Promise<CredentialHolderResponse>;
}

export type WindowsCredentialHolderPipeBridgeFactory = (
  options: WindowsCredentialHolderPipeBridgeFactoryOptions,
) => WindowsCredentialHolderPipeBridge;

export interface ProviderUseContext {
  taskId: string;
  provider: string;
  peer: PeerCredential;
  request?: unknown;
}

export interface ProviderUseHandlerInput {
  provider: string;
  taskId: string;
  secret: Buffer;
  peer: PeerCredential;
  request?: unknown;
}

export class CredentialHolderService {
  readonly socketPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly uid: number;
  private readonly peerCredentialResolver: PeerCredentialResolver['lookup'];
  private readonly providerInvoker: (input: ProviderUseHandlerInput) => Promise<unknown> | unknown;
  private readonly windowsPipeHelperCommand?: string;
  private readonly windowsPipeBridgeFactory: WindowsCredentialHolderPipeBridgeFactory;
  private readonly tokenIssuer: CapabilityTokenIssuer;
  private readonly secrets = new Map<string, Buffer>();
  private server: Server | null = null;
  private windowsPipeBridge: WindowsCredentialHolderPipeBridge | null = null;

  constructor(options: CredentialHolderServiceOptions) {
    this.socketPath = options.socketPath;
    this.platform = options.platform ?? process.platform;
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.peerCredentialResolver = options.peerCredentialResolver;
    this.providerInvoker = options.providerInvoker ?? (() => {
      throw new Error('credential holder has no internal provider invoker configured');
    });
    this.windowsPipeHelperCommand = options.windowsPipeHelperCommand;
    this.windowsPipeBridgeFactory = options.windowsPipeBridgeFactory ?? createNativeWindowsCredentialHolderPipeBridge;
    this.tokenIssuer = new CapabilityTokenIssuer({
      ttlMs: options.tokenTtlMs,
      now: options.now,
      randomToken: options.randomToken,
      holderSecret: options.holderSecret,
    });
  }

  async start(): Promise<void> {
    applyCredentialHolderProcessHardening();
    if (this.platform === 'win32') {
      await this.startWindowsNamedPipe();
      return;
    }
    mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.socketPath), 0o700);
    await this.prepareUnixSocketPathForBind();
    this.server = createServer(socket => this.handleSocket(socket));
    await awaitPrivateUnixSocketListening(this.server, this.socketPath);
    chmodSync(this.socketPath, 0o600);
    const stat = statSync(this.socketPath);
    if (!stat.isSocket()) throw new Error('credential holder path is not a socket after bind');
    if ((stat.mode & 0o777) !== 0o600) throw new Error('credential holder socket permissions must be 0600');
  }

  /**
   * Windows named-pipe bind. The native helper owns the pipe handle so it can apply the security
   * descriptor at CreateNamedPipe time and validate each connected client before forwarding the
   * request into this TypeScript holder. If the helper is unavailable, startup fails closed before
   * any insecure Node-created pipe is bound.
   */
  private async startWindowsNamedPipe(): Promise<void> {
    if (!isWindowsNamedPipePath(this.socketPath)) {
      throw new Error(`credential holder on win32 requires a \\\\.\\pipe\\ named pipe path, got: ${this.socketPath}`);
    }
    const bridge = this.windowsPipeBridgeFactory({
      socketPath: this.socketPath,
      helperCommand: this.windowsPipeHelperCommand,
      onRequest: request => this.dispatchPeerCommand(request.peer, request.line),
    });
    this.windowsPipeBridge = bridge;
    await bridge.start();
  }

  async stop(): Promise<void> {
    const windowsPipeBridge = this.windowsPipeBridge;
    this.windowsPipeBridge = null;
    if (windowsPipeBridge) {
      await windowsPipeBridge.stop().catch(() => undefined);
    }
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      }).catch(() => undefined);
    }
    // Unix-domain sockets leave a filesystem entry that must be unlinked. A Windows named pipe is
    // released by the OS when the server handle closes, so there is nothing to unlink on win32.
    if (this.platform !== 'win32' && existsSync(this.socketPath)) {
      const stat = lstatSync(this.socketPath);
      if (stat.isSocket()) unlinkSync(this.socketPath);
    }
    this.zeroizeSecrets();
  }

  setProviderSecret(provider: string, secret: Uint8Array): void {
    const normalized = normalizeProviderKeyName(provider);
    this.zeroizeSecret(normalized);
    this.secrets.set(normalizeProviderKeyName(provider), Buffer.from(secret));
    this.tokenIssuer.invalidateProvider(provider);
  }

  deleteProviderSecret(provider: string): void {
    this.zeroizeSecret(normalizeProviderKeyName(provider));
    this.tokenIssuer.invalidateProvider(provider);
  }

  private requestUseGrantForPeer(command: CredentialHolderGrantCommand, peer: PeerCredential): CapabilityTokenGrant {
    this.assertPeerCredential(peer);
    if (peer.uid !== this.uid) throw new Error(`credential holder same-user uid check failed: ${peer.uid} !== ${this.uid}`);
    const provider = normalizeProviderKeyName(command.provider);
    if (!this.secrets.has(provider)) throw new Error(`credential holder has no secret for provider ${provider}`);
    return this.tokenIssuer.issue({
      taskId: command.taskId,
      provider,
      callerPid: peer.pid,
      callerStartTime: peer.startTime,
    });
  }

  private async redeemUseGrantForPeer(command: CredentialHolderRedeemCommand, peer: PeerCredential): Promise<unknown> {
    this.assertPeerCredential(peer);
    const consumed = this.tokenIssuer.consume(command.token, {
      taskId: command.taskId,
      provider: command.provider,
      callerPid: peer.pid,
      callerStartTime: peer.startTime,
    });
    const provider = normalizeProviderKeyName(consumed.provider);
    const secret = this.secrets.get(provider);
    if (!secret) throw new Error(`credential holder has no secret for provider ${provider}`);
    const requestSecret = Buffer.from(secret);
    try {
      const response = await this.providerInvoker({
        provider,
        taskId: consumed.taskId,
        secret: requestSecret,
        peer,
        request: command.request,
      });
      assertResponseDoesNotContainSecret(response, secret);
      return response;
    } finally {
      requestSecret.fill(0);
    }
  }

  private async invokeProviderCallForPeer(command: CredentialHolderProviderCallCommand, peer: PeerCredential): Promise<unknown> {
    this.assertPeerCredential(peer);
    if (peer.uid !== this.uid) throw new Error(`credential holder same-user uid check failed: ${peer.uid} !== ${this.uid}`);
    const provider = normalizeProviderKeyName(command.provider);
    const secret = this.secrets.get(provider);
    if (!secret) throw new Error(`credential holder has no secret for provider ${provider}`);
    const requestSecret = Buffer.from(secret);
    try {
      const response = await this.providerInvoker({
        provider,
        taskId: command.taskId,
        secret: requestSecret,
        peer,
        request: command.request,
      });
      assertResponseDoesNotContainSecret(response, secret);
      return response;
    } finally {
      requestSecret.fill(0);
    }
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      handled = true;
      socket.pause();
      void this.handleCommandLine(socket, buffer.slice(0, buffer.indexOf('\n')));
    });
    socket.on('error', () => undefined);
  }

  private async handleCommandLine(socket: Socket, line: string): Promise<void> {
    const response = await this.dispatchSocketCommand(socket, line);
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private async dispatchSocketCommand(socket: Socket, line: string): Promise<CredentialHolderResponse> {
    try {
      const command = parseCredentialHolderCommand(line);
      if (command.action === 'ping') {
        return { ok: true, ping: { pid: process.pid } };
      }
      const peer = await this.lookupPeer(socket);
      return await this.dispatchAuthenticatedCommand(command, peer);
    } catch (error) {
      return { ok: false, error: String(redactCredentialMaterial((error as Error).message)) };
    }
  }

  private async dispatchPeerCommand(peer: PeerCredential, line: string): Promise<CredentialHolderResponse> {
    try {
      const command = parseCredentialHolderCommand(line);
      if (command.action === 'ping') {
        this.assertPeerCredential(peer);
        return { ok: true, ping: { pid: process.pid } };
      }
      return await this.dispatchAuthenticatedCommand(command, peer);
    } catch (error) {
      return { ok: false, error: String(redactCredentialMaterial((error as Error).message)) };
    }
  }

  private async dispatchAuthenticatedCommand(
    command: Exclude<CredentialHolderCommand, CredentialHolderPingCommand>,
    peer: PeerCredential,
  ): Promise<CredentialHolderResponse> {
    if (command.action === 'grant') return { ok: true, grant: this.requestUseGrantForPeer(command, peer) };
    if (command.action === 'provider_call') return { ok: true, response: await this.invokeProviderCallForPeer(command, peer) };
    return { ok: true, response: await this.redeemUseGrantForPeer(command, peer) };
  }

  private async prepareUnixSocketPathForBind(): Promise<void> {
    if (!existsSync(this.socketPath)) return;
    const stat = lstatSync(this.socketPath);
    if (!stat.isSocket()) {
      throw new Error(`credential holder socket squat refused: pre-existing path is not a socket`);
    }
    const liveness = await pingCredentialHolder(this.socketPath, { timeoutMs: 500 });
    if (liveness.available) {
      throw new Error(`credential holder socket already has a live holder${liveness.pid ? ` (PID: ${liveness.pid})` : ''}`);
    }
    if (liveness.securityFailure) {
      throw new Error(`credential holder socket squat refused: ${liveness.reason}`);
    }
    unlinkSync(this.socketPath);
  }

  private async lookupPeer(socket: Socket): Promise<PeerCredential> {
    const peer = await this.peerCredentialResolver({
      socket,
      socketFd: socketFd(socket),
      // On Windows the peer-credential helper authenticates the connected client through the named
      // pipe itself (GetNamedPipeClientProcessId), so it needs the pipe path rather than a fd.
      ...(this.platform === 'win32' ? { namedPipeName: this.socketPath } : {}),
    });
    if (!peer || !Number.isInteger(peer.pid) || !Number.isInteger(peer.uid) || !peer.startTime) {
      throw new Error('credential holder failed closed: ambiguous peer credential');
    }
    this.assertPeerCredential(peer);
    return peer;
  }

  private assertPeerCredential(peer: PeerCredential): void {
    if (!peer || !Number.isInteger(peer.pid) || peer.pid <= 0 || !Number.isInteger(peer.uid) || peer.uid < 0 || !peer.startTime) {
      throw new Error('credential holder failed closed: ambiguous peer credential');
    }
    if (this.platform === 'win32' && (typeof peer.sid !== 'string' || !peer.sid.startsWith('S-'))) {
      throw new Error('credential holder failed closed: Windows peer SID is required');
    }
  }

  private zeroizeSecret(provider: string): void {
    const secret = this.secrets.get(provider);
    if (secret) secret.fill(0);
    this.secrets.delete(provider);
  }

  private zeroizeSecrets(): void {
    for (const secret of this.secrets.values()) secret.fill(0);
    this.secrets.clear();
  }
}

type WindowsHelperReadyMessage = {
  type: 'ready';
  pipeName?: string;
  currentSid?: string;
};

type WindowsHelperRequestMessage = {
  type: 'request';
  id: string;
  peer: unknown;
  line: string;
};

type WindowsHelperMessage = WindowsHelperReadyMessage | WindowsHelperRequestMessage;

class NativeWindowsCredentialHolderPipeBridge implements WindowsCredentialHolderPipeBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: ReadlineInterface | null = null;
  private stderr = '';
  private ready = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly helperCommand: string,
    private readonly onRequest: (request: WindowsCredentialHolderPipeBridgeRequest) => Promise<CredentialHolderResponse>,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.helperCommand, ['serve', this.socketPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      this.stderr += String(chunk);
    });
    child.once('error', error => {
      this.rejectReady(new Error(`credential holder Windows named-pipe helper failed closed: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (!this.ready) {
        const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : '';
        this.rejectReady(new Error(`credential holder Windows named-pipe helper exited before ready (${signal ?? code})${suffix}`));
      }
    });
    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', line => void this.handleHelperLine(line));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('credential holder Windows named-pipe helper timed out before ready'));
      }, 10_000);
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.readyReject = error => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.reader?.close();
    this.reader = null;
    if (!child) return;
    child.stdin.end();
    if (child.exitCode === null && !child.killed) {
      child.kill();
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 1000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private async handleHelperLine(line: string): Promise<void> {
    let message: WindowsHelperMessage;
    try {
      message = JSON.parse(line) as WindowsHelperMessage;
    } catch (error) {
      this.rejectReady(new Error(`credential holder Windows named-pipe helper emitted invalid JSON: ${(error as Error).message}`));
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (message.type !== 'request') return;
    const child = this.child;
    if (!child || !child.stdin.writable) return;
    const response = await this.handleRequestMessage(message);
    child.stdin.write(`${JSON.stringify({ id: message.id, response })}\n`);
  }

  private async handleRequestMessage(message: WindowsHelperRequestMessage): Promise<CredentialHolderResponse> {
    try {
      if (!message.id || typeof message.line !== 'string') {
        throw new Error('credential holder Windows named-pipe helper request is malformed');
      }
      const peer = parsePeerCredentialJson(JSON.stringify(message.peer));
      return await this.onRequest({ peer, line: message.line });
    } catch (error) {
      return { ok: false, error: String(redactCredentialMaterial((error as Error).message)) };
    }
  }

  private rejectReady(error: Error): void {
    if (this.readyReject) {
      this.readyReject(error);
      this.readyReject = null;
      this.readyResolve = null;
    }
  }
}

function createNativeWindowsCredentialHolderPipeBridge(
  options: WindowsCredentialHolderPipeBridgeFactoryOptions,
): WindowsCredentialHolderPipeBridge {
  const helperCommand = options.helperCommand
    ?? configuredOrInstalledHelperPath(HELPER_BINARIES.winPeerCred)
    ?? HELPER_BINARIES.winPeerCred;
  return new NativeWindowsCredentialHolderPipeBridge(options.socketPath, helperCommand, options.onRequest);
}

export async function sendCredentialHolderCommand(
  socketPath: string,
  command: CredentialHolderCommand,
  options: { timeoutMs?: number } = {},
): Promise<CredentialHolderResponse> {
  assertHolderSocketIdentity(socketPath);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
        socket.destroy();
        settle(() => reject(new Error(`credential holder command timed out after ${options.timeoutMs}ms`)));
      }, options.timeoutMs)
      : null;
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(command)}\n`);
    });
    socket.on('data', chunk => {
      response += chunk;
    });
    socket.once('error', error => settle(() => reject(error)));
    socket.once('end', () => {
      try {
        settle(() => resolve(JSON.parse(response.trim()) as CredentialHolderResponse));
      } catch (error) {
        settle(() => reject(error));
      }
    });
  });
}

export interface CredentialHolderLiveness {
  available: boolean;
  socketPath: string;
  pid?: number;
  reason?: string;
  securityFailure?: boolean;
}

export async function pingCredentialHolder(
  socketPath: string,
  options: { timeoutMs?: number } = {},
): Promise<CredentialHolderLiveness> {
  try {
    const response = await sendCredentialHolderCommand(socketPath, { action: 'ping' }, { timeoutMs: options.timeoutMs ?? 500 });
    if (!response.ok) {
      return { available: false, socketPath, reason: response.error };
    }
    const pid = response.ping?.pid;
    if (!Number.isInteger(pid) || Number(pid) <= 0) {
      return { available: false, socketPath, reason: 'credential holder ping response was malformed' };
    }
    return { available: true, socketPath, pid };
  } catch (error) {
    const reason = (error as Error).message;
    return {
      available: false,
      socketPath,
      reason,
      securityFailure: /identity check|owner|permission|not a socket|symbolic/i.test(reason),
    };
  }
}

function assertHolderSocketIdentity(socketPath: string): void {
  // The POSIX owner/mode gate is skipped ONLY on a real Windows host. The skip must be
  // platform-gated, not path-spelling-gated: on POSIX, backslashes are ordinary filename
  // characters, so a path that merely starts with \\.\pipe\ is a relative Unix-socket filename and
  // MUST still pass the lstat/owner/mode identity check. Gating on process.platform prevents a path
  // spelling alone from bypassing the gate.
  if (process.platform === 'win32' && isWindowsNamedPipePath(socketPath)) {
    // SECURITY — NEEDS-REAL-WINDOWS-VALIDATION. A Windows named pipe has no filesystem owner or
    // mode bits to stat; the client authenticates the server by inspecting the pipe's DACL / server
    // SID via a native call Node does not expose. Until that native check exists and is validated
    // on a real Windows host, the POSIX owner/permission gate below cannot run for pipe paths.
    return;
  }
  const stat = lstatSync(socketPath);
  if (!stat.isSocket()) throw new Error('credential holder identity check failed: path is not a socket');
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error('credential holder identity check failed: socket owner does not match current user');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('credential holder identity check failed: socket permissions must not grant group/other access');
  }
}

function isWindowsNamedPipePath(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

function awaitServerListening(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
    server.listen(path);
  });
}

async function awaitPrivateUnixSocketListening(server: Server, path: string): Promise<void> {
  const previousUmask = process.umask(0o177);
  try {
    await awaitServerListening(server, path);
  } finally {
    process.umask(previousUmask);
  }
}

function parseCredentialHolderCommand(line: string): CredentialHolderCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`credential holder command is malformed JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('credential holder command must be an object');
  const record = parsed as Record<string, unknown>;
  const action = record.action;
  if (action === 'ping') return { action };
  const taskId = String(record.taskId || '').trim();
  const provider = String(record.provider || '').trim();
  if (!taskId) throw new Error('credential holder command taskId is required');
  if (!provider) throw new Error('credential holder command provider is required');
  if (action === 'grant') return { action, taskId, provider };
  if (action === 'provider_call') return { action, taskId, provider, request: record.request };
  if (action === 'redeem') {
    const token = String(record.token || '').trim();
    if (!token) throw new Error('credential holder redeem token is required');
    return { action, token, taskId, provider, request: record.request };
  }
  throw new Error(`credential holder command action is unsupported: ${String(action)}`);
}

function assertResponseDoesNotContainSecret(response: unknown, secret: Buffer): void {
  const rendered = JSON.stringify(response);
  if (!rendered) return;
  const encodings = [
    secret.toString('utf8'),
    secret.toString('base64'),
    secret.toString('base64url'),
    secret.toString('hex'),
    encodeURIComponent(secret.toString('utf8')),
  ].filter(value => value.length > 0);
  if (encodings.some(value => rendered.includes(value))) {
    throw new Error('credential holder refused to return raw key material in provider response');
  }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function socketFd(socket: Socket): number | undefined {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  return typeof handle?.fd === 'number' && handle.fd >= 0 ? handle.fd : undefined;
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

export function applyCredentialHolderProcessHardening(
  options: CredentialHolderProcessHardeningOptions = {},
): CredentialHolderProcessHardeningStatus {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const errors: string[] = [];
  let coreDumpDisabled = false;
  let dumpableDisabled = platform !== 'linux';

  try {
    if (options.setCoreDumpLimit) {
      options.setCoreDumpLimit();
      coreDumpDisabled = true;
    } else if (platform === 'linux') {
      execFileSync('prlimit', ['--pid', String(pid), '--core=0:0'], { stdio: 'ignore' });
      coreDumpDisabled = true;
    }
  } catch (error) {
    errors.push(`core dump hardening unavailable: ${(error as Error).message}`);
  }

  if (platform === 'linux') {
    try {
      if (options.setLinuxDumpable) {
        options.setLinuxDumpable();
        dumpableDisabled = true;
      } else {
        errors.push('linux dumpable hardening requires a native in-process PR_SET_DUMPABLE hook');
      }
    } catch (error) {
      dumpableDisabled = false;
      errors.push(`linux dumpable hardening unavailable: ${(error as Error).message}`);
    }
  }

  return {
    coreDumpDisabled,
    dumpableDisabled,
    ...(errors.length ? { errors } : {}),
  };
}
