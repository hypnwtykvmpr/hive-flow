/**
 * Safe Environment Utility
 *
 * Filters process.env to only allowed variables to prevent accidental exposure
 * of sensitive credentials to child processes.
 *
 * @module v3/shared/security/safe-env
 */

/**
 * List of environment variable keys that are always allowed
 */
export const ALLOWED_ENV_KEYS = [
  'PATH',
  'NODE_ENV',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'PWD',
  'SHELL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
];

/**
 * List of prefixes for allowed configuration (non-sensitive).
 * Logging and tracing prefixes are intentionally excluded to prevent
 * forwarding LOG_LEVEL or TRACE_* values that may contain sensitive paths.
 */
export const ALLOWED_PREFIXES = [
  'CLAUDE_',
  'ANTHROPIC_',
  'OPENAI_',
  'GOOGLE_',
  'MISTRAL_',
  'COHERE_',
  'GROQ_',
  'PERPLEXITY_',
  'AGENT_',
  'SWARM_',
  'MCP_',
];

/**
 * Suffixes that mark a variable as sensitive. Keys whose names end with one of
 * these suffixes are stripped from the output unless the caller explicitly opts
 * in via `extraAllowedKeys` or `forwardApiKeys`.
 */
export const SENSITIVE_SUFFIXES = [
  '_API_KEY',
  '_SECRET',
  '_TOKEN',
  '_PASSWORD',
  '_CREDENTIAL',
];

/**
 * Options accepted by `getSafeEnv`.
 */
export interface GetSafeEnvOptions {
  /**
   * Additional environment variable names to include regardless of prefix/suffix
   * filtering. Names must match `/^[A-Z_][A-Z0-9_]*$/`.
   */
  extraAllowedKeys?: string[];
  /**
   * When `true`, variables matching one of the `ALLOWED_PREFIXES` that also end
   * with `_API_KEY` are forwarded. All other `SENSITIVE_SUFFIXES` remain
   * blocked unless the key is listed in `extraAllowedKeys`.
   *
   * Default: `false`
   */
  forwardApiKeys?: boolean;
}

/** Pattern for valid environment variable names */
const VALID_ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Filters process.env and returns a safe subset of environment variables.
 *
 * Two layers of filtering are applied:
 *   1. Allow-list: key must be in `ALLOWED_ENV_KEYS`, `extraAllowedKeys`,
 *      or start with a prefix in `ALLOWED_PREFIXES`.
 *   2. Sensitive-suffix block: even if a key passes the allow-list, it is
 *      removed when its name ends with a `SENSITIVE_SUFFIXES` entry — unless
 *      `forwardApiKeys` is `true` (for `_API_KEY` only) or the key is in
 *      `extraAllowedKeys`.
 *
 * @param options - Optional filtering options.
 * @returns Filtered environment object safe to pass to child processes.
 */
export function getSafeEnv(options: GetSafeEnvOptions = {}): NodeJS.ProcessEnv {
  const { extraAllowedKeys = [], forwardApiKeys = false } = options;

  const validatedExtraKeys = extraAllowedKeys.filter((key) => VALID_ENV_KEY_RE.test(key));
  const explicitKeySet = new Set(validatedExtraKeys);
  const safeEnv: NodeJS.ProcessEnv = {};
  const allAllowedKeys = new Set([...ALLOWED_ENV_KEYS, ...validatedExtraKeys]);

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;

    const isAllowedKey = allAllowedKeys.has(key);
    const hasAllowedPrefix = ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));

    if (!isAllowedKey && !hasAllowedPrefix) continue;

    // Second filter: block sensitive suffixes unless explicitly allowed.
    if (!explicitKeySet.has(key)) {
      const hasSensitiveSuffix = SENSITIVE_SUFFIXES.some((suffix) => key.endsWith(suffix));
      if (hasSensitiveSuffix) {
        // Allow _API_KEY vars when the caller opts in via forwardApiKeys.
        if (!(forwardApiKeys && key.endsWith('_API_KEY'))) {
          continue;
        }
      }
    }

    safeEnv[key] = value;
  }

  return safeEnv;
}
