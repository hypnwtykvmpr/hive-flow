export type ProviderKeyPreflightResult =
  | { ok: true; degraded?: false; warning?: undefined }
  | { ok: true; degraded: true; warning: string }
  | { ok: false; reason: string };

function hasEnvValue(env: Record<string, unknown>, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0;
}

export function providerKeyPreflight(
  provider: string | undefined,
  env: Record<string, unknown>,
): ProviderKeyPreflightResult {
  const normalized = String(provider || '').trim().toLowerCase();

  if (normalized === 'openrouter' && !hasEnvValue(env, 'OPENROUTER_API_KEY')) {
    return {
      ok: false,
      reason:
        'OpenRouter agent bring-up requires OPENROUTER_API_KEY in the hive-flow/MCP runtime environment. ' +
        'Set OPENROUTER_API_KEY and restart the daemon/MCP server before spawning or dispatching OpenRouter agents.',
    };
  }

  if (normalized === 'deepseek' && !hasEnvValue(env, 'DEEPSEEK_API_KEY')) {
    return {
      ok: true,
      degraded: true,
      warning:
        'DEEPSEEK_API_KEY is not set; DeepSeek agents are allowed to start and will surface provider authentication errors at call time.',
    };
  }

  return { ok: true };
}
