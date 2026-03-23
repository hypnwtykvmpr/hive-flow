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
  'anthropic/claude-opus-4-6': 200000,
  'anthropic/claude-sonnet-4-6': 200000,
  'google/gemini-2.5-pro': 2097152,
  'google/gemini-2.5-flash': 1048576,
  'google/gemini-2.5-flash-lite': 1048576,
  'meta-llama/llama-3.3-70b': 131072,
  'deepseek/deepseek-reasoner': 131072,
  'openai/gpt-4o-mini': 128000,
  'mistralai/mistral-small-25': 32768,
};

/** Default config used when no `.hive-flow/config.json` exists or is malformed */
export const DEFAULT_CONFIG: OpenRouterModelConfig = {
  tiers: {
    opus: ['anthropic/claude-opus-4-6', 'google/gemini-2.5-pro', 'deepseek/deepseek-reasoner'],
    sonnet: ['anthropic/claude-sonnet-4-6', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b'],
    haiku: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash-lite', 'mistralai/mistral-small-25'],
  },
  allowedModels: [
    'anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6',
    'google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite',
    'meta-llama/llama-3.3-70b', 'deepseek/deepseek-reasoner',
    'openai/gpt-4o-mini', 'mistralai/mistral-small-25',
  ],
};

/** Mtime-based cache state */
let cachedConfig: OpenRouterModelConfig | null = null;
let cachedMtime: number = 0;
let cachedAt: number = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Load the OpenRouter config from `.hive-flow/config.json`.
 *
 * Uses mtime-based caching with 30s TTL:
 * - If cache is fresh (< 30s old) and file mtime unchanged, returns cached config
 * - On missing file, parse error, or missing openrouter key, returns DEFAULT_CONFIG
 *
 * @param projectDir - Project root directory (defaults to cwd)
 * @returns Resolved OpenRouterModelConfig
 */
export function loadOpenRouterConfig(projectDir?: string): OpenRouterModelConfig {
  const now = Date.now();

  // Return cached if TTL not expired
  if (cachedConfig && (now - cachedAt) < CACHE_TTL_MS) {
    // Check mtime hasn't changed
    try {
      const configPath = join(projectDir || process.cwd(), '.hive-flow', 'config.json');
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
      return DEFAULT_CONFIG;
    }
  }

  // Read and parse config
  try {
    const configPath = join(projectDir || process.cwd(), '.hive-flow', 'config.json');
    const stat = statSync(configPath);
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Extract openrouter section from values or top-level
    const orConfig = parsed?.values?.openrouter ?? parsed?.openrouter;
    if (!orConfig || typeof orConfig !== 'object') {
      cachedConfig = DEFAULT_CONFIG;
      cachedMtime = stat.mtimeMs;
      cachedAt = now;
      return DEFAULT_CONFIG;
    }

    // Build config with defaults for missing fields
    const config: OpenRouterModelConfig = {
      tiers: {
        opus: Array.isArray(orConfig.tiers?.opus) && orConfig.tiers.opus.length > 0 ? orConfig.tiers.opus : DEFAULT_CONFIG.tiers.opus,
        sonnet: Array.isArray(orConfig.tiers?.sonnet) && orConfig.tiers.sonnet.length > 0 ? orConfig.tiers.sonnet : DEFAULT_CONFIG.tiers.sonnet,
        haiku: Array.isArray(orConfig.tiers?.haiku) && orConfig.tiers.haiku.length > 0 ? orConfig.tiers.haiku : DEFAULT_CONFIG.tiers.haiku,
      },
      allowedModels: Array.isArray(orConfig.allowedModels) ? orConfig.allowedModels : DEFAULT_CONFIG.allowedModels,
      ...(orConfig.contextWindows && typeof orConfig.contextWindows === 'object' ? { contextWindows: orConfig.contextWindows } : {}),
    };

    cachedConfig = config;
    cachedMtime = stat.mtimeMs;
    cachedAt = now;
    return config;
  } catch {
    // File missing, unreadable, or malformed JSON → use defaults
    cachedConfig = DEFAULT_CONFIG;
    cachedMtime = 0;
    cachedAt = now;
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
 * @param config - The OpenRouter config
 * @param model - Model string to check
 * @returns true if model is allowed
 */
export function isModelAllowed(config: OpenRouterModelConfig, model: string): boolean {
  if (!config.allowedModels || config.allowedModels.length === 0) return false;
  return config.allowedModels.includes(model);
}

/**
 * Resolve the context window length (in tokens) for a given model.
 *
 * Resolution order:
 * 1. config.contextWindows (user override)
 * 2. DEFAULT_CONTEXT_WINDOWS (built-in known models)
 * 3. 128000 (safe fallback)
 *
 * @param model - Full model identifier (e.g. "google/gemini-2.5-flash")
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
}
