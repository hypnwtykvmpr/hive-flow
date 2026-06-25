import { sanitizeScopeId } from '../permission-guard/protected-paths.js';

type SessionEnv = Record<string, string | undefined>;
export type OperatorClientKind =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'antigravity'
  | 'opencode'
  | 'forgecode'
  | 'unknown';

const CLIENT_KIND_ALIASES: Record<Exclude<OperatorClientKind, 'unknown'>, readonly string[]> = {
  claude: ['claude', 'claude-code', 'anthropic-cli'],
  codex: ['codex', 'codex-cli'],
  gemini: ['gemini', 'gemini-cli'],
  cursor: ['cursor', 'cursor-cli', 'cursor-agent', 'agent'],
  antigravity: ['antigravity', 'antigravity-cli', 'agy'],
  opencode: ['opencode', 'open-code'],
  forgecode: ['forgecode', 'forge-code', 'forge'],
};

const CLIENT_KIND_BY_ALIAS = new Map<string, Exclude<OperatorClientKind, 'unknown'>>();
for (const [kind, aliases] of Object.entries(CLIENT_KIND_ALIASES) as Array<[Exclude<OperatorClientKind, 'unknown'>, readonly string[]]>) {
  for (const alias of aliases) CLIENT_KIND_BY_ALIAS.set(alias, kind);
}

const SESSION_ENV_KEYS_BY_KIND: Record<Exclude<OperatorClientKind, 'unknown'>, readonly string[]> = {
  codex: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID'],
  claude: ['CLAUDE_SESSION_ID'],
  gemini: ['GEMINI_SESSION_ID', 'GEMINI_THREAD_ID'],
  cursor: ['CURSOR_SESSION_ID', 'CURSOR_THREAD_ID', 'AGENT_SESSION_ID'],
  antigravity: ['ANTIGRAVITY_SESSION_ID', 'ANTIGRAVITY_THREAD_ID', 'AGY_SESSION_ID', 'AGY_THREAD_ID'],
  opencode: ['OPENCODE_SESSION_ID', 'OPENCODE_THREAD_ID'],
  forgecode: ['FORGECODE_SESSION_ID', 'FORGECODE_THREAD_ID', 'FORGE_CODE_SESSION_ID', 'FORGE_SESSION_ID'],
};

const SESSION_ENV_KEY_PRIORITY = Object.freeze([
  ['CODEX_SESSION_ID', 'codex'],
  ['CODEX_THREAD_ID', 'codex'],
  ['OPENCODE_SESSION_ID', 'opencode'],
  ['OPENCODE_THREAD_ID', 'opencode'],
  ['FORGECODE_SESSION_ID', 'forgecode'],
  ['FORGECODE_THREAD_ID', 'forgecode'],
  ['FORGE_CODE_SESSION_ID', 'forgecode'],
  ['FORGE_SESSION_ID', 'forgecode'],
  ['ANTIGRAVITY_SESSION_ID', 'antigravity'],
  ['ANTIGRAVITY_THREAD_ID', 'antigravity'],
  ['AGY_SESSION_ID', 'antigravity'],
  ['AGY_THREAD_ID', 'antigravity'],
  ['GEMINI_SESSION_ID', 'gemini'],
  ['GEMINI_THREAD_ID', 'gemini'],
  ['CURSOR_SESSION_ID', 'cursor'],
  ['CURSOR_THREAD_ID', 'cursor'],
  ['CLAUDE_SESSION_ID', 'claude'],
  ['AGENT_SESSION_ID', 'cursor'],
] as const satisfies ReadonlyArray<readonly [string, Exclude<OperatorClientKind, 'unknown'>]>);

export const OPERATOR_CLIENT_KINDS = Object.freeze([
  'codex',
  'claude',
  'gemini',
  'cursor',
  'antigravity',
  'opencode',
  'forgecode',
] as const satisfies ReadonlyArray<Exclude<OperatorClientKind, 'unknown'>>);

export function operatorSessionEnvKeys(kind?: OperatorClientKind): readonly string[] {
  if (!kind || kind === 'unknown') {
    return [
      ...SESSION_ENV_KEY_PRIORITY.map(([key]) => key),
      'HIVE_FLOW_SESSION_ID',
    ];
  }
  return SESSION_ENV_KEYS_BY_KIND[kind];
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function sanitizeSessionId(value: unknown): string | null {
  const sanitized = sanitizeScopeId(value, '', 64);
  return sanitized || null;
}

function asOperatorContextSessionId(value: unknown): string | null {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  // The stdio MCP wrapper generates process-local ids like
  // `mcp-<timestamp>-<suffix>`. They identify the transport process, not the
  // human/operator session, so they must not become hive/agent ownership.
  if (/^mcp-\d+-[a-z0-9]+$/i.test(raw.trim())) return null;
  return raw;
}

export function resolveSessionId(
  input: Record<string, unknown> | null | undefined = null,
  env: SessionEnv = process.env,
  context: Record<string, unknown> | null | undefined = null,
): string | null {
  const envSource = operatorSessionEnvKeys()
    .map((key) => asNonEmptyString(env[key]))
    .find((value): value is string => Boolean(value));

  const source =
    asNonEmptyString(input?.session_id)
    ?? asNonEmptyString(input?.sessionId)
    ?? envSource
    ?? asOperatorContextSessionId(context?.session_id)
    ?? asOperatorContextSessionId(context?.sessionId);

  return source ? sanitizeSessionId(source) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeClientKind(value: unknown): OperatorClientKind {
  const raw = stringValue(value);
  if (!raw) return 'unknown';
  return CLIENT_KIND_BY_ALIAS.get(raw.toLowerCase()) ?? 'unknown';
}

export function resolveClientKindFromEnv(env: SessionEnv = process.env): OperatorClientKind {
  const explicit = normalizeClientKind(env.HIVE_FLOW_CLIENT_KIND);
  if (explicit !== 'unknown') {
    const explicitHasSession = operatorSessionEnvKeys(explicit)
      .some((key) => Boolean(asNonEmptyString(env[key])));
    if (explicitHasSession || asNonEmptyString(env.HIVE_FLOW_SESSION_ID)) return explicit;

    const sessionKinds = new Set<Exclude<OperatorClientKind, 'unknown'>>();
    for (const [key, kind] of SESSION_ENV_KEY_PRIORITY) {
      if (asNonEmptyString(env[key])) sessionKinds.add(kind);
    }
    if (sessionKinds.size === 1) return [...sessionKinds][0] ?? explicit;
    return explicit;
  }
  for (const [key, kind] of SESSION_ENV_KEY_PRIORITY) {
    if (asNonEmptyString(env[key])) return kind;
  }
  if (asNonEmptyString(env.CLAUDE_PROJECT_DIR)) return 'claude';
  return 'unknown';
}

export function resolveClientKind(
  input: Record<string, unknown> | null | undefined = null,
  env: SessionEnv = process.env,
  context: Record<string, unknown> | null | undefined = null,
): OperatorClientKind {
  const candidates: unknown[] = [
    input?.client_kind,
    input?.clientKind,
    input?.ownerClientKind,
    context?.client_kind,
    context?.clientKind,
  ];
  for (const candidate of candidates) {
    const kind = normalizeClientKind(candidate);
    if (kind !== 'unknown') return kind;
  }
  return resolveClientKindFromEnv(env);
}
