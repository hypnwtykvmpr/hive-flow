import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type HiveHomeSource = 'env' | 'default';

export interface ResolveHiveHomeOptions {
  readonly homeDir?: string;
  readonly exists?: (path: string) => boolean;
}

export interface HiveHomeResolution {
  /** Primary CLI-neutral Hive Flow home. New writes belong here. */
  readonly home: string;
  /** Why the primary home was selected. */
  readonly source: HiveHomeSource;
  /** Legacy Claude-specific home, retained only for migration/read fallback. */
  readonly legacyHome: string;
  /** Whether the legacy fallback exists at resolution time. */
  readonly legacyExists: boolean;
  /** Existing fallback homes that readers may consult during migration. */
  readonly readFallbacks: readonly string[];
}

export interface SessionKeyInput {
  readonly sessionKey?: unknown;
  readonly sessionId?: unknown;
  readonly session_id?: unknown;
  readonly transcriptPath?: unknown;
  readonly transcript_path?: unknown;
  readonly clientKind?: unknown;
  readonly client_kind?: unknown;
}

function absoluteEnvPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) return undefined;
  return resolve(trimmed);
}

function effectiveHomeDir(opts: ResolveHiveHomeOptions): string {
  const configured = opts.homeDir;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return resolve(configured);
  }
  return homedir();
}

export function resolveLegacyClaudeHiveHome(
  _env: NodeJS.ProcessEnv = process.env,
  opts: ResolveHiveHomeOptions = {},
): string {
  return join(effectiveHomeDir(opts), '.claude', 'hive-flow');
}

export function resolveHiveHome(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveHiveHomeOptions = {},
): HiveHomeResolution {
  const envHome = absoluteEnvPath(env.HIVE_FLOW_HOME);
  const homeDir = effectiveHomeDir(opts);
  const legacyHome = resolveLegacyClaudeHiveHome(env, { ...opts, homeDir });
  const exists = opts.exists ?? existsSync;
  const legacyExists = exists(legacyHome);
  const home = envHome ?? join(homeDir, '.hive-flow');
  return Object.freeze({
    home,
    source: envHome === undefined ? 'default' : 'env',
    legacyHome,
    legacyExists,
    readFallbacks: legacyExists ? Object.freeze([legacyHome]) : Object.freeze([]),
  });
}

function canonicalPath(input: string): string {
  const resolved = resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function projectKeyFor(root: string): string {
  return sha256Hex(canonicalPath(root));
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultClientKind(env: NodeJS.ProcessEnv): string {
  if (stringValue(env.CODEX_SESSION_ID)) return 'codex';
  if (stringValue(env.CLAUDE_SESSION_ID) || stringValue(env.CLAUDE_PROJECT_DIR)) return 'claude-code';
  return 'claude-code';
}

function sessionInputValue(input: unknown): { value?: string; clientKind?: string } {
  if (typeof input === 'string') return { value: stringValue(input) };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const record = input as SessionKeyInput;
  return {
    value:
      stringValue(record.sessionKey) ??
      stringValue(record.sessionId) ??
      stringValue(record.session_id) ??
      stringValue(record.transcriptPath) ??
      stringValue(record.transcript_path),
    clientKind: stringValue(record.clientKind) ?? stringValue(record.client_kind),
  };
}

export function sessionKeyFor(
  input?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromInput = sessionInputValue(input);
  const rawSession =
    fromInput.value ??
    stringValue(env.CODEX_SESSION_ID) ??
    stringValue(env.CLAUDE_SESSION_ID) ??
    stringValue(env.HIVE_FLOW_SESSION_ID) ??
    `pid:${process.pid}`;
  const clientKind =
    fromInput.clientKind ??
    stringValue(env.HIVE_FLOW_CLIENT_KIND) ??
    stringValue(env.CLAUDE_CODE_ENTRYPOINT) ??
    defaultClientKind(env);
  return `s_${sha256Hex(`${clientKind}\0${rawSession}`).slice(0, 32)}`;
}
