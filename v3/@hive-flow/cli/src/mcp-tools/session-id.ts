import { sanitizeScopeId } from '../permission-guard/protected-paths.js';

type SessionEnv = Record<string, string | undefined>;

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function sanitizeSessionId(value: unknown): string | null {
  const sanitized = sanitizeScopeId(value, '', 64);
  return sanitized || null;
}

export function resolveSessionId(
  input: Record<string, unknown> | null | undefined = null,
  env: SessionEnv = process.env,
): string | null {
  const source =
    asNonEmptyString(input?.session_id)
    ?? asNonEmptyString(input?.sessionId)
    ?? asNonEmptyString(env.CLAUDE_SESSION_ID)
    ?? asNonEmptyString(env.HIVE_FLOW_SESSION_ID);

  return source ? sanitizeSessionId(source) : null;
}
