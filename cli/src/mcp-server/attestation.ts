import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  OPERATOR_CLIENT_KINDS,
  normalizeClientKind,
  operatorSessionEnvKeys,
  resolveClientKindFromEnv,
  sanitizeSessionId,
  type OperatorClientKind,
} from '../mcp-tools/session-id.js';
import { resolveProjectRoot } from '../permission-guard/protected-paths.js';

type Env = Record<string, string | undefined>;

export const MCP_ATTESTATION_VERSION = 1;
export const MCP_ATTESTATION_PATH_ENV = 'HIVE_FLOW_MCP_ATTESTATION_PATH';
export const MCP_ATTESTATION_TOKEN_ENV = 'HIVE_FLOW_MCP_ATTESTATION_TOKEN';
export const MCP_ATTESTATION_MAX_TTL_MS = 24 * 60 * 60 * 1000;

export type MCPAttestationPidMode = 'spawned-child' | 'in-process';
export type MCPAttestationEntrypoint = 'bin/mcp-server.js' | 'cli/mcp-stdio-inprocess';
export type AttestedMCPToolContext = {
  sessionId: string;
  clientKind: Exclude<OperatorClientKind, 'unknown'>;
  attested: true;
  attestationEntryPoint: MCPAttestationEntrypoint;
};

export interface MCPAttestationRecord {
  version: number;
  projectRoot: string;
  entrypoint: MCPAttestationEntrypoint;
  pidMode: MCPAttestationPidMode;
  ownerClientKind: Exclude<OperatorClientKind, 'unknown'>;
  ownerSessionId: string;
  sessionEnvKey: string;
  createdAt: string;
  expiresAt: string;
  epoch: number;
  tokenSha256: string;
  launcherPid?: number;
  mcpPid?: number;
  entrypointPath?: string;
}

export type MCPAttestationErrorCode =
  | 'missing-env'
  | 'missing-operator'
  | 'invalid-json'
  | 'invalid-record'
  | 'invalid-token'
  | 'invalid-project-root'
  | 'invalid-owner'
  | 'expired'
  | 'stale-epoch'
  | 'invalid-entrypoint'
  | 'invalid-pid'
  | 'io-error';

export interface MCPAttestationFailure {
  success: false;
  code: MCPAttestationErrorCode;
  error: string;
}

export interface MCPAttestationSuccess {
  success: true;
  record: MCPAttestationRecord;
  context: AttestedMCPToolContext;
  attestationPath: string;
  token: string;
  cleanup: () => void;
}

export type MCPAttestationValidation = MCPAttestationSuccess | MCPAttestationFailure;
export type MCPAttestationMintResult =
  | (MCPAttestationSuccess & { envPatch: Record<typeof MCP_ATTESTATION_PATH_ENV | typeof MCP_ATTESTATION_TOKEN_ENV, string> })
  | MCPAttestationFailure;

export const OWNER_SENSITIVE_MCP_TOOLS = Object.freeze([
  'agent_spawn',
  'agent_pool',
  'agent_message_send',
  'agent_message_inbox',
  'agent_message_ack',
  'queen_mission_assign',
  'queen_spawn_worker',
  'queen_task_worker',
  'queen_collect_results',
  'queen_permission_requests',
  'queen_permission_decide',
  'hive_terminate',
  'hive_poll_workers',
  'hive-mind_spawn',
  'hive-mind_join',
  'daa_agent_create',
] as const);

const OWNER_SENSITIVE_MCP_TOOL_SET = new Set<string>(OWNER_SENSITIVE_MCP_TOOLS);
const EPOCH_FILE = 'epoch.json';
const LOCK_STALE_MS = 30_000;

interface MintOptions {
  env?: Env;
  cwd?: string;
  now?: () => Date;
  ttlMs?: number;
  token?: string;
  projectRoot?: string;
  entrypoint: MCPAttestationEntrypoint;
  pidMode: MCPAttestationPidMode;
  launcherPid?: number;
  mcpPid?: number;
  entrypointPath?: string;
}

interface ValidateOptions {
  env?: Env;
  cwd?: string;
  now?: () => Date;
  projectRoot?: string;
  pid?: number;
  ppid?: number;
  entrypointPath?: string;
}

interface OperatorIdentity {
  ownerClientKind: Exclude<OperatorClientKind, 'unknown'>;
  ownerSessionId: string;
  sessionEnvKey: string;
}

interface EpochState {
  keys?: Record<string, number>;
}

export function isOwnerSensitiveMCPTool(toolName: unknown): boolean {
  return typeof toolName === 'string' && OWNER_SENSITIVE_MCP_TOOL_SET.has(toolName);
}

export function formatMCPAttestationFailure(toolName: string, validation: MCPAttestationValidation): string {
  if (validation.success) return '';
  return `MCP tool '${toolName}' requires an attested operator session for stdio ownership: ${validation.error}`;
}

export function resolveProjectRootForMCPAttestation(
  env: Env = process.env,
  cwd = process.cwd(),
  explicitProjectRoot?: string,
): string {
  return normalizePath(resolveProjectRoot({ env, cwd, fallbackRoot: explicitProjectRoot }));
}

export function mintMCPAttestation(options: MintOptions): MCPAttestationMintResult {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const ttlMs = Math.max(1, Math.min(options.ttlMs ?? MCP_ATTESTATION_MAX_TTL_MS, MCP_ATTESTATION_MAX_TTL_MS));
  const projectRoot = resolveProjectRootForMCPAttestation(env, options.cwd, options.projectRoot);
  const identity = resolveOperatorIdentity(env);
  if (!identity) {
    return {
      success: false,
      code: 'missing-operator',
      error: 'No non-generated operator session id and client kind were present in the MCP server environment.',
    };
  }

  const token = options.token ?? randomBytes(32).toString('hex');
  const created = now();
  const expires = new Date(created.getTime() + ttlMs);
  const dir = attestationDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const epochKey = epochKeyFor(projectRoot, options.entrypoint, identity);
  let epoch: number;
  try {
    epoch = incrementEpoch(dir, epochKey);
  } catch (error) {
    return {
      success: false,
      code: 'io-error',
      error: `Failed to update MCP attestation epoch: ${errorMessage(error)}`,
    };
  }

  const record: MCPAttestationRecord = {
    version: MCP_ATTESTATION_VERSION,
    projectRoot,
    entrypoint: options.entrypoint,
    pidMode: options.pidMode,
    ownerClientKind: identity.ownerClientKind,
    ownerSessionId: identity.ownerSessionId,
    sessionEnvKey: identity.sessionEnvKey,
    createdAt: created.toISOString(),
    expiresAt: expires.toISOString(),
    epoch,
    tokenSha256: sha256(token),
  };
  if (options.pidMode === 'spawned-child') {
    record.launcherPid = options.launcherPid ?? process.pid;
    record.entrypointPath = options.entrypointPath ? normalizePath(options.entrypointPath) : undefined;
  } else {
    record.mcpPid = options.mcpPid ?? process.pid;
  }

  const attestationPath = join(dir, `${epochKey}.${epoch}.${process.pid}.${randomBytes(8).toString('hex')}.json`);
  try {
    writeJsonAtomic(attestationPath, record);
  } catch (error) {
    return {
      success: false,
      code: 'io-error',
      error: `Failed to write MCP attestation: ${errorMessage(error)}`,
    };
  }

  const tokenValue = token;
  const cleanup = () => {
    try {
      rmSync(attestationPath, { force: true });
    } catch {}
  };
  return {
    success: true,
    record,
    context: contextFromRecord(record),
    attestationPath,
    token: tokenValue,
    envPatch: {
      [MCP_ATTESTATION_PATH_ENV]: attestationPath,
      [MCP_ATTESTATION_TOKEN_ENV]: tokenValue,
    },
    cleanup,
  };
}

export function mintInProcessMCPAttestation(options: Omit<MintOptions, 'entrypoint' | 'pidMode'> = {}): MCPAttestationMintResult {
  const env = options.env ?? process.env;
  const minted = mintMCPAttestation({
    ...options,
    env,
    entrypoint: 'cli/mcp-stdio-inprocess',
    pidMode: 'in-process',
    mcpPid: options.mcpPid ?? process.pid,
  });
  if (minted.success) {
    env[MCP_ATTESTATION_PATH_ENV] = minted.envPatch[MCP_ATTESTATION_PATH_ENV];
    env[MCP_ATTESTATION_TOKEN_ENV] = minted.envPatch[MCP_ATTESTATION_TOKEN_ENV];
  }
  return minted;
}

export function validateMCPAttestation(options: ValidateOptions = {}): MCPAttestationValidation {
  const env = options.env ?? process.env;
  const attestationPath = nonEmpty(env[MCP_ATTESTATION_PATH_ENV]);
  const token = nonEmpty(env[MCP_ATTESTATION_TOKEN_ENV]);
  if (!attestationPath || !token) {
    return {
      success: false,
      code: 'missing-env',
      error: `Missing ${MCP_ATTESTATION_PATH_ENV} or ${MCP_ATTESTATION_TOKEN_ENV}.`,
    };
  }

  let record: MCPAttestationRecord;
  try {
    record = JSON.parse(readFileSync(attestationPath, 'utf8')) as MCPAttestationRecord;
  } catch (error) {
    return {
      success: false,
      code: 'invalid-json',
      error: `Unable to read MCP attestation record: ${errorMessage(error)}`,
    };
  }

  const common = validateCommonRecord(record, token, env, options);
  if (!common.success) return common;

  const pid = options.pid ?? process.pid;
  const ppid = options.ppid ?? process.ppid;
  if (record.pidMode === 'spawned-child') {
    if (record.entrypoint !== 'bin/mcp-server.js') {
      return { success: false, code: 'invalid-entrypoint', error: 'Spawned-child attestation used the wrong entrypoint.' };
    }
    if (!Number.isInteger(record.launcherPid) || ppid !== record.launcherPid) {
      return { success: false, code: 'invalid-pid', error: 'Spawned-child attestation parent pid did not match the launcher pid.' };
    }
    if (!record.entrypointPath || !options.entrypointPath || normalizePath(record.entrypointPath) !== normalizePath(options.entrypointPath)) {
      return { success: false, code: 'invalid-entrypoint', error: 'Spawned-child attestation entrypoint path did not match the running MCP server.' };
    }
  } else if (record.pidMode === 'in-process') {
    if (record.entrypoint !== 'cli/mcp-stdio-inprocess') {
      return { success: false, code: 'invalid-entrypoint', error: 'In-process attestation used the wrong entrypoint.' };
    }
    if (!Number.isInteger(record.mcpPid) || pid !== record.mcpPid) {
      return { success: false, code: 'invalid-pid', error: 'In-process attestation pid did not match the running MCP server.' };
    }
  } else {
    return { success: false, code: 'invalid-record', error: 'MCP attestation pidMode is not recognized.' };
  }

  return {
    success: true,
    record,
    context: contextFromRecord(record),
    attestationPath,
    token,
    cleanup: () => {
      try {
        rmSync(attestationPath, { force: true });
      } catch {}
    },
  };
}

function validateCommonRecord(
  record: MCPAttestationRecord,
  token: string,
  env: Env,
  options: ValidateOptions,
): MCPAttestationFailure | { success: true } {
  if (!record || typeof record !== 'object' || record.version !== MCP_ATTESTATION_VERSION) {
    return { success: false, code: 'invalid-record', error: 'MCP attestation record version is not supported.' };
  }
  if (record.tokenSha256 !== sha256(token)) {
    return { success: false, code: 'invalid-token', error: 'MCP attestation token did not match the record hash.' };
  }
  const projectRoot = resolveProjectRootForMCPAttestation(env, options.cwd, options.projectRoot);
  if (normalizePath(record.projectRoot) !== projectRoot) {
    return { success: false, code: 'invalid-project-root', error: 'MCP attestation project root did not match this process.' };
  }
  const sanitizedOwnerSessionId = sanitizeSessionId(record.ownerSessionId);
  if (
    !isRecognizedClientKind(record.ownerClientKind)
    || !sanitizedOwnerSessionId
    || sanitizedOwnerSessionId !== record.ownerSessionId
    || isGeneratedMcpSessionId(record.ownerSessionId)
  ) {
    return { success: false, code: 'invalid-owner', error: 'MCP attestation owner session or client kind is invalid.' };
  }
  if (!nonEmpty(record.sessionEnvKey)) {
    return { success: false, code: 'invalid-owner', error: 'MCP attestation did not record the owner session env key.' };
  }
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const createdMs = Date.parse(record.createdAt);
  const expiresMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) || expiresMs <= createdMs || nowMs >= expiresMs) {
    return { success: false, code: 'expired', error: 'MCP attestation is expired or has invalid timestamps.' };
  }
  if (expiresMs - createdMs > MCP_ATTESTATION_MAX_TTL_MS) {
    return { success: false, code: 'expired', error: 'MCP attestation TTL exceeds the maximum allowed lifetime.' };
  }
  const epoch = readEpoch(attestationDir(projectRoot), epochKeyFor(projectRoot, record.entrypoint, {
    ownerClientKind: record.ownerClientKind,
    ownerSessionId: record.ownerSessionId,
  }));
  if (record.epoch !== epoch) {
    return { success: false, code: 'stale-epoch', error: 'MCP attestation epoch is stale.' };
  }
  return { success: true };
}

function resolveOperatorIdentity(env: Env): OperatorIdentity | null {
  const kind = resolveClientKindFromEnv(env);
  if (!isRecognizedClientKind(kind)) return null;
  const explicitKind = normalizeClientKind(env.HIVE_FLOW_CLIENT_KIND);
  const keys = [
    ...operatorSessionEnvKeys(kind),
    ...(explicitKind === kind ? ['HIVE_FLOW_SESSION_ID'] : []),
  ];
  for (const key of keys) {
    const raw = nonEmpty(env[key]);
    if (!raw || isGeneratedMcpSessionId(raw)) continue;
    const sanitized = sanitizeSessionId(raw);
    if (sanitized) {
      return { ownerClientKind: kind, ownerSessionId: sanitized, sessionEnvKey: key };
    }
  }
  return null;
}

function contextFromRecord(record: MCPAttestationRecord): AttestedMCPToolContext {
  return {
    sessionId: record.ownerSessionId,
    clientKind: record.ownerClientKind,
    attested: true,
    attestationEntryPoint: record.entrypoint,
  };
}

function attestationDir(projectRoot: string): string {
  return join(projectRoot, '.hive-flow', 'data', 'mcp-attestations');
}

function epochKeyFor(
  projectRoot: string,
  entrypoint: MCPAttestationEntrypoint,
  identity: Pick<OperatorIdentity, 'ownerClientKind' | 'ownerSessionId'>,
): string {
  return sha256([
    normalizePath(projectRoot),
    entrypoint,
    identity.ownerClientKind,
    identity.ownerSessionId,
  ].join('\0')).slice(0, 32);
}

function incrementEpoch(dir: string, key: string): number {
  mkdirSync(dir, { recursive: true });
  return withLock(dir, () => {
    const filePath = join(dir, EPOCH_FILE);
    const state = readEpochState(filePath);
    const keys = state.keys ?? {};
    const next = Number.isFinite(keys[key]) ? Math.trunc(keys[key]) + 1 : 1;
    keys[key] = next;
    writeJsonAtomic(filePath, { keys });
    return next;
  });
}

function readEpoch(dir: string, key: string): number {
  const state = readEpochState(join(dir, EPOCH_FILE));
  const value = state.keys?.[key];
  return Number.isFinite(value) ? Math.trunc(value as number) : -1;
}

function readEpochState(filePath: string): EpochState {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as EpochState;
  } catch {
    return { keys: {} };
  }
}

function withLock<T>(dir: string, fn: () => T): T {
  const lockDir = join(dir, '.epoch.lock');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(lockDir);
      try {
        return fn();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      try {
        const stale = Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
        if (stale) rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      sleepSync(10);
    }
  }
  throw new Error(`Timed out waiting for MCP attestation epoch lock at ${lockDir}`);
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, filePath);
}

function normalizePath(filePath: string): string {
  const absolute = resolve(filePath);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isRecognizedClientKind(kind: unknown): kind is Exclude<OperatorClientKind, 'unknown'> {
  return typeof kind === 'string' && (OPERATOR_CLIENT_KINDS as readonly string[]).includes(kind);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isGeneratedMcpSessionId(value: string): boolean {
  return /^mcp-\d+-[a-z0-9]+$/i.test(value.trim());
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sleepSync(ms: number): void {
  const array = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(array, 0, 0, ms);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
