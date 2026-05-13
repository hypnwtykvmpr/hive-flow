/**
 * OpenRouter Model Config
 *
 * Config-driven tier pools and allowlist for OpenRouter provider.
 * OpenRouter proxies 200+ models — this module provides per-tier random
 * selection from configurable model pools and a strict allowlist.
 *
 * Config is read from `.hive-flow/config.json` → `values["openrouter"]`
 * with mtime-based caching (30s TTL).
 *
 * @module @hive-flow/providers/openrouter-model-config
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';

/** Per-tier model pools — each tier maps to an array of model strings */
export interface OpenRouterTierPoolConfig {
  opus: string[];
  sonnet: string[];
  haiku: string[];
}

/** Full OpenRouter model config — tier pools + strict allowlist */
export interface OpenRouterModelConfig {
  tiers: OpenRouterTierPoolConfig;
  allowedModels: string[];
  contextWindows?: Record<string, number>;
}

/** Default context window sizes (tokens) for known OpenRouter models */
export const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  'xiaomi/mimo-v2.5-pro': 1048576,
  'x-ai/grok-4.3': 2000000,
  'minimax/minimax-m2.7': 204800,
  'moonshotai/kimi-k2.6': 262144,
  'qwen/qwen3.6-max-preview': 262144,
  'z-ai/glm-5.1': 202752,
  'qwen/qwen3.6-plus': 1000000,
  'nvidia/nemotron-3-super-120b-a12b:free': 262144,
  'deepseek/deepseek-v4-flash': 1000000,
};

/** Default config used when no `.hive-flow/config.json` exists or is malformed */
export const DEFAULT_CONFIG: OpenRouterModelConfig = {
  tiers: {
    opus: ['xiaomi/mimo-v2.5-pro', 'x-ai/grok-4.3', 'minimax/minimax-m2.7'],
    sonnet: ['moonshotai/kimi-k2.6', 'qwen/qwen3.6-max-preview', 'z-ai/glm-5.1'],
    haiku: ['qwen/qwen3.6-plus', 'nvidia/nemotron-3-super-120b-a12b:free', 'deepseek/deepseek-v4-flash'],
  },
  allowedModels: [
    'xiaomi/mimo-v2.5-pro', 'x-ai/grok-4.3', 'minimax/minimax-m2.7',
    'moonshotai/kimi-k2.6', 'qwen/qwen3.6-max-preview', 'z-ai/glm-5.1',
    'qwen/qwen3.6-plus', 'nvidia/nemotron-3-super-120b-a12b:free', 'deepseek/deepseek-v4-flash',
  ],
};

/** Mtime-based cache state */
let cachedConfig: OpenRouterModelConfig | null = null;
let cachedMtime: number = 0;
let cachedAt: number = 0;
let cachedPath: string | null = null;
const CACHE_TTL_MS = 30_000;

/**
 * Sanitize a user-provided contextWindows map. Drops non-numeric, non-finite,
 * or non-positive entries with a console.warn. Returns undefined if no valid
 * entries remain so that callers fall through to DEFAULT_CONTEXT_WINDOWS.
 */
function sanitizeContextWindows(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[k] = v;
    } else {
      console.warn(`[openrouter-config] Ignoring invalid contextWindows entry: ${k} = ${String(v)}`);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Sanitize a tier pool. Drops non-string and empty-string entries. Falls back
 * to the provided default tier if the user-supplied tier is missing, not an
 * array, empty, or has no valid string entries.
 */
function sanitizeTier(raw: unknown, defaultTier: string[]): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return defaultTier;
  const filtered = raw
    .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    .map((m) => m.trim());
  return filtered.length > 0 ? filtered : defaultTier;
}

/**
 * Load the OpenRouter config from `.hive-flow/config.json`.
 *
 * Precedence semantics (intentional):
 *  - Alias resolution (opus/sonnet/haiku/mini) selects from `tiers.<name>` pools
 *    and does NOT consult `allowedModels`. The pool itself is the source of truth.
 *  - Direct provider-native model strings (e.g., 'xiaomi/mimo-v2.5-pro') are
 *    validated against `allowedModels`. A blocked direct model returns undefined.
 *  - Setting `allowedModels: []` therefore blocks DIRECT slugs only, not aliases.
 *    Operators wanting to lock down everything must also restrict the tier pools.
 *
 * Cache: mtime-based with 30s TTL, keyed by the resolved config path.
 *
 * @param projectDir - Project root directory (defaults to cwd)
 * @returns Resolved OpenRouterModelConfig
 */
export function loadOpenRouterConfig(projectDir?: string): OpenRouterModelConfig {
  const now = Date.now();
  const configPath = join(projectDir || process.cwd(), '.hive-flow', 'config.json');

  // Return cached if TTL not expired
  if (cachedConfig && cachedPath === configPath && (now - cachedAt) < CACHE_TTL_MS) {
    // Check mtime hasn't changed
    try {
      const stat = statSync(configPath);
      if (stat.mtimeMs === cachedMtime) {
        return cachedConfig;
      }
    } catch {
      // File gone — use cached until TTL expires
      if (cachedConfig && (now - cachedAt) < CACHE_TTL_MS) {
        return cachedConfig;
      }
      cachedConfig = DEFAULT_CONFIG;
      cachedMtime = 0;
      cachedAt = now;
      cachedPath = configPath;
      return DEFAULT_CONFIG;
    }
  }

  // Read and parse config
  try {
    const stat = statSync(configPath);
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Extract openrouter section from values or top-level
    const orConfig = parsed?.values?.openrouter ?? parsed?.openrouter;
    if (!orConfig || typeof orConfig !== 'object') {
      cachedConfig = DEFAULT_CONFIG;
      cachedMtime = stat.mtimeMs;
      cachedAt = now;
      cachedPath = configPath;
      return DEFAULT_CONFIG;
    }

    // Build config with defaults for missing fields. Tiers and contextWindows
    // are validated entry-by-entry via sanitize helpers (drops non-strings /
    // non-positive-finite-numbers with a console.warn).
    const sanitizedContextWindows = sanitizeContextWindows(orConfig.contextWindows);
    const config: OpenRouterModelConfig = {
      tiers: {
        opus: sanitizeTier(orConfig.tiers?.opus, DEFAULT_CONFIG.tiers.opus),
        sonnet: sanitizeTier(orConfig.tiers?.sonnet, DEFAULT_CONFIG.tiers.sonnet),
        haiku: sanitizeTier(orConfig.tiers?.haiku, DEFAULT_CONFIG.tiers.haiku),
      },
      allowedModels: Array.isArray(orConfig.allowedModels)
        ? orConfig.allowedModels
          .filter((m: unknown): m is string => typeof m === 'string' && m.trim().length > 0)
          .map((m: string) => m.trim())
        : DEFAULT_CONFIG.allowedModels,
      ...(sanitizedContextWindows ? { contextWindows: sanitizedContextWindows } : {}),
    };

    cachedConfig = config;
    cachedMtime = stat.mtimeMs;
    cachedAt = now;
    cachedPath = configPath;
    return config;
  } catch {
    // File missing, unreadable, or malformed JSON → use defaults
    cachedConfig = DEFAULT_CONFIG;
    cachedMtime = 0;
    cachedAt = now;
    cachedPath = configPath;
    return DEFAULT_CONFIG;
  }
}

/**
 * Select a random model from a tier pool.
 *
 * @param pool - Array of model strings to select from
 * @returns A randomly selected model string
 */
export function selectFromPool(pool: string[]): string | undefined {
  if (!pool || pool.length === 0) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Check if a model is in the allowedModels list.
 *
 * Matching is case-insensitive and whitespace-tolerant on both sides so that
 * trivial typing variations (' xiaomi/mimo-v2.5-pro ', 'Xiaomi/MIMO-...') do
 * not silently bypass the allowlist or block legitimate models.
 *
 * @param config - The OpenRouter config
 * @param model - Model string to check
 * @returns true if model is allowed
 */
export function isModelAllowed(config: OpenRouterModelConfig, model: string): boolean {
  return getAllowedModelCanonical(config, model) !== undefined;
}

/**
 * Return the canonical allowlist entry for a direct OpenRouter model, or
 * undefined when the direct model is blocked.
 */
export function getAllowedModelCanonical(config: OpenRouterModelConfig, model: string): string | undefined {
  if (!config.allowedModels || config.allowedModels.length === 0) return undefined;
  const normalized = model.trim().toLowerCase();
  return config.allowedModels.find((m) => m.trim().toLowerCase() === normalized)?.trim();
}

/**
 * Resolve the context window length (in tokens) for a given model.
 *
 * Resolution order:
 * 1. config.contextWindows (user override)
 * 2. DEFAULT_CONTEXT_WINDOWS (built-in known models)
 * 3. 128000 (safe fallback)
 *
 * @param model - Full model identifier (e.g. "xiaomi/mimo-v2.5-pro")
 * @param config - Optional OpenRouterModelConfig (loaded automatically if omitted)
 * @returns Context window length in tokens
 */
export function getModelContextLength(model: string, config?: OpenRouterModelConfig): number {
  const resolved = config ?? loadOpenRouterConfig();

  // 1. User-configured override
  if (resolved.contextWindows?.[model] !== undefined) {
    const val = resolved.contextWindows[model];
    if (typeof val === 'number' && val > 0 && Number.isFinite(val)) return val;
  }

  // 2. Built-in defaults
  if (DEFAULT_CONTEXT_WINDOWS[model] !== undefined) {
    return DEFAULT_CONTEXT_WINDOWS[model];
  }

  // 3. Safe fallback
  return 128000;
}

/**
 * Reset the config cache. Exported for testing.
 */
export function resetOpenRouterConfigCache(): void {
  cachedConfig = null;
  cachedMtime = 0;
  cachedAt = 0;
  cachedPath = null;
}
