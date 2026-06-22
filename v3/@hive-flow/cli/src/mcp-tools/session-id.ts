import { sanitizeScopeId } from '../permission-guard/protected-paths.js';

type SessionEnv = Record<string, string | undefined>;
export type OperatorClientKind = 'claude' | 'codex' | 'gemini' | 'cursor' | 'unknown';

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
  const source =
    asNonEmptyString(input?.session_id)
    ?? asNonEmptyString(input?.sessionId)
    ?? asNonEmptyString(env.CODEX_SESSION_ID)
    ?? asNonEmptyString(env.CODEX_THREAD_ID)
    ?? asNonEmptyString(env.CLAUDE_SESSION_ID)
    ?? asNonEmptyString(env.HIVE_FLOW_SESSION_ID)
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
  const normalized = raw.toLowerCase();
  if (normalized === 'claude' || normalized === 'claude-code') return 'claude';
  if (normalized === 'codex' || normalized === 'codex-cli') return 'codex';
  if (normalized === 'gemini' || normalized === 'gemini-cli') return 'gemini';
  if (normalized === 'cursor' || normalized === 'cursor-cli' || normalized === 'cursor-agent') return 'cursor';
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
    env.HIVE_FLOW_CLIENT_KIND,
  ];
  for (const candidate of candidates) {
    const kind = normalizeClientKind(candidate);
    if (kind !== 'unknown') return kind;
  }
  if (asNonEmptyString(env.CODEX_SESSION_ID) || asNonEmptyString(env.CODEX_THREAD_ID)) return 'codex';
  if (asNonEmptyString(env.CLAUDE_SESSION_ID) || asNonEmptyString(env.CLAUDE_PROJECT_DIR)) return 'claude';
  return 'unknown';
}
