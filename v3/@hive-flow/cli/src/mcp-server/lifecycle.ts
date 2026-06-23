import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEmitter } from 'node:events';
import { resolveHiveHome } from '../shared/index.js';

export interface CredentialHolderProbeLike {
  available: boolean;
  socketPath?: string;
  pid?: number;
  reason?: string;
}

export type CredentialHolderStartupDecision =
  | { mode: 'client'; reason: string; socketPath?: string; pid?: number }
  | { mode: 'bootstrap'; reason: string; socketPath?: string }
  | { mode: 'required-missing'; reason: string; socketPath?: string };

export interface McpServerRegistryRecord {
  pid: number;
  ppid: number;
  sessionId: string;
  startedAt: string;
  lastHeartbeatAt: string;
  command: string;
}

export interface McpServerRegistration {
  path: string;
  stop(): void;
}

export function decideCredentialHolderStartup(
  status: CredentialHolderProbeLike,
  env: Record<string, unknown> = process.env,
): CredentialHolderStartupDecision {
  if (status.available) {
    return {
      mode: 'client',
      reason: 'credential holder already serving',
      socketPath: status.socketPath,
      pid: status.pid,
    };
  }
  if (isDesignatedCredentialHolderOwner(env)) {
    return {
      mode: 'bootstrap',
      reason: 'credential holder unavailable and this process is designated holder owner',
      socketPath: status.socketPath,
    };
  }
  if (env.HIVE_FLOW_CREDENTIAL_HOLDER_REQUIRED === '1') {
    return {
      mode: 'required-missing',
      reason: status.reason || 'credential holder required but not available',
      socketPath: status.socketPath,
    };
  }
  return {
    mode: 'client',
    reason: 'credential holder unavailable; MCP server will run as a client without bootstrapping',
    socketPath: status.socketPath,
  };
}

export function installStdioClientLifecycle(
  stdin: EventEmitter,
  shutdown: (reason: string) => Promise<void> | void,
  options: { sessionId: string } = { sessionId: 'mcp' },
): () => void {
  let requested = false;
  const requestShutdown = (reason: string) => {
    if (requested) return;
    requested = true;
    void shutdown(`(${options.sessionId}) ${reason}`);
  };
  const onEnd = () => requestShutdown('stdin closed');
  const onClose = () => requestShutdown('stdin closed');
  const onError = () => requestShutdown('stdin error');

  stdin.once('end', onEnd);
  stdin.once('close', onClose);
  stdin.once('error', onError);

  return () => {
    stdin.off('end', onEnd);
    stdin.off('close', onClose);
    stdin.off('error', onError);
  };
}

export function mcpServerRegistryDir(env: Record<string, unknown> = process.env): string {
  return join(resolveHiveHome(env as NodeJS.ProcessEnv).home, 'run', 'mcp-servers');
}

export function mcpServerRegistryPath(
  pid = process.pid,
  env: Record<string, unknown> = process.env,
): string {
  return join(mcpServerRegistryDir(env), `${pid}.json`);
}

export function readMcpServerRegistryRecord(
  pid: number,
  env: Record<string, unknown> = process.env,
): McpServerRegistryRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(mcpServerRegistryPath(pid, env), 'utf8')) as Partial<McpServerRegistryRecord>;
    if (parsed.pid !== pid || typeof parsed.lastHeartbeatAt !== 'string') return null;
    return {
      pid,
      ppid: Number(parsed.ppid || 0),
      sessionId: String(parsed.sessionId || ''),
      startedAt: String(parsed.startedAt || ''),
      lastHeartbeatAt: parsed.lastHeartbeatAt,
      command: String(parsed.command || ''),
    };
  } catch {
    return null;
  }
}

export function removeMcpServerRegistryRecord(
  pid = process.pid,
  env: Record<string, unknown> = process.env,
): void {
  rmSync(mcpServerRegistryPath(pid, env), { force: true });
}

export function registerMcpServerProcess(options: {
  env?: Record<string, unknown>;
  pid?: number;
  ppid?: number;
  sessionId: string;
  now?: () => Date;
  heartbeatIntervalMs?: number;
  command?: string;
}): McpServerRegistration {
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const ppid = options.ppid ?? process.ppid;
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const command = options.command ?? process.argv.join(' ');
  const registryPath = mcpServerRegistryPath(pid, env);
  const writeHeartbeat = () => {
    mkdirSync(mcpServerRegistryDir(env), { recursive: true, mode: 0o700 });
    const record: McpServerRegistryRecord = {
      pid,
      ppid,
      sessionId: options.sessionId,
      startedAt,
      lastHeartbeatAt: (options.now ?? (() => new Date()))().toISOString(),
      command,
    };
    writeFileSync(registryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  };
  writeHeartbeat();
  const timer = setInterval(writeHeartbeat, options.heartbeatIntervalMs ?? 30_000);
  timer.unref?.();

  return {
    path: registryPath,
    stop() {
      clearInterval(timer);
      removeMcpServerRegistryRecord(pid, env);
    },
  };
}

function isDesignatedCredentialHolderOwner(env: Record<string, unknown>): boolean {
  return env.HIVE_FLOW_CREDENTIAL_HOLDER_OWNER === '1' || env.HIVE_FLOW_DAEMON === '1';
}
