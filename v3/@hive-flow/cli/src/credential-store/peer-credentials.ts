import { execFileSync as nodeExecFileSync } from 'node:child_process';
import type { Socket } from 'node:net';

type ExecOptions = {
  encoding?: BufferEncoding;
  stdio?: unknown;
};

type ExecFileSync = (file: string, args: readonly string[], options?: ExecOptions) => Buffer | string;

export interface PeerCredential {
  pid: number;
  uid: number;
  gid?: number;
  startTime: string;
}

export interface PeerCredentialLookup {
  pid?: number;
  socket?: Socket;
  socketFd?: number;
}

export interface PeerCredentialResolver {
  lookup(target: PeerCredentialLookup): Promise<PeerCredential | null>;
}

export interface PeerCredentialResolverOptions {
  platform?: NodeJS.Platform;
  helperCommand?: string;
  execFileSync?: ExecFileSync;
}

export function parsePeerCredentialJson(raw: string | Buffer): PeerCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  } catch (error) {
    throw new Error(`native peer credential helper returned invalid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('native peer credential helper returned ambiguous peer credentials');
  }
  const record = parsed as Record<string, unknown>;
  if (!Number.isInteger(record.pid) || Number(record.pid) <= 0) {
    throw new Error('native peer credential helper returned ambiguous pid');
  }
  if (!Number.isInteger(record.uid) || Number(record.uid) < 0) {
    throw new Error('native peer credential helper returned ambiguous uid');
  }
  if (typeof record.startTime !== 'string' || record.startTime.length === 0) {
    throw new Error('native peer credential helper returned ambiguous PID start-time');
  }
  const credential: PeerCredential = {
    pid: Number(record.pid),
    uid: Number(record.uid),
    startTime: record.startTime,
  };
  if (Number.isInteger(record.gid) && Number(record.gid) >= 0) credential.gid = Number(record.gid);
  return credential;
}

function socketFd(socket: Socket | undefined): number | undefined {
  if (!socket) return undefined;
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  return typeof handle?.fd === 'number' && handle.fd >= 0 ? handle.fd : undefined;
}

export function createPeerCredentialResolver(options: PeerCredentialResolverOptions = {}): PeerCredentialResolver {
  const platform = options.platform ?? process.platform;
  const helperCommand = options.helperCommand ?? 'hive-flow-peer-cred-helper';
  const execFileSync = options.execFileSync ?? ((file, args, execOptions = {}) => nodeExecFileSync(file, [...args], execOptions as Parameters<typeof nodeExecFileSync>[2]));

  return {
    async lookup(target: PeerCredentialLookup): Promise<PeerCredential | null> {
      if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
        throw new Error(`native peer credential helper unsupported on ${platform}`);
      }
      const fd = target.socketFd ?? socketFd(target.socket);
      try {
        if (fd !== undefined && platform !== 'win32') {
          return parsePeerCredentialJson(execFileSync(helperCommand, ['fd', '3'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe', fd],
          }));
        }
        if (target.pid !== undefined) {
          return parsePeerCredentialJson(execFileSync(helperCommand, ['lookup', String(target.pid)], {
            encoding: 'utf8',
            stdio: 'pipe',
          }));
        }
        throw new Error('no socket fd or pid supplied');
      } catch (error) {
        throw new Error(`native peer credential helper failed closed: ${(error as Error).message}`);
      }
    },
  };
}
