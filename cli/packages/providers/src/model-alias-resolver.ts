/**
 * Model Alias Resolver
 *
 * Maps Claude model aliases (opus, sonnet, mini, haiku, inherit) to provider-native
 * model names for CLI providers. This enables seamless model switching across providers.
 *
 * Use `mini` for fast/efficient agent tasks. `haiku` is a legacy resolver alias and is
 * BLOCKED by the enforcement gate for agent spawning (agent_spawn, queen_spawn_worker,
 * queen_mission_assign, agent_task) — use `mini` instead.
 *
 * @module @hive-flow/providers/model-alias-resolver
 */

import { getAllowedModelCanonical, loadOpenRouterConfig, selectFromPool } from './openrouter-model-config.js';

/** Claude model aliases that users can specify */
export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus', 'inherit', 'mini'] as const;
export type ClaudeAlias = typeof CLAUDE_ALIASES[number];

/** Provider names that support alias resolution */
export type CLIProviderName = 'anthropic-cli' | 'gemini-cli' | 'codex-cli' | 'cursor-cli' | 'deepseek' | 'openrouter' | 'lm-studio';

/** Current provider-enforced defaults, verified against the installed CLIs. */
export const ANTHROPIC_CLI_DEFAULT_MODEL = 'claude-opus-5';
export const ANTHROPIC_SONNET_MODEL = 'claude-sonnet-5';
export const ANTHROPIC_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const GEMINI_CLI_DEFAULT_MODEL = 'gemini-3.6-flash-high';
export const GEMINI_API_DEFAULT_MODEL = 'gemini-3.6-flash';
export const CODEX_CLI_DEFAULT_MODEL = 'gpt-5.6-sol';
export const OPENAI_API_DEFAULT_MODEL = CODEX_CLI_DEFAULT_MODEL;
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro';
export const DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash';

/**
 * Maps Claude aliases to provider-native model names.
 *
 * Design decisions:
 * - opus → best/flagship model for each provider
 * - sonnet → balanced/mid-tier model
 * - haiku → flash tier for deepseek; sonnet-equivalent for other CLI providers (resolver alias only — agent tasks reject haiku via the enforcement gate)
 * - mini → fast/efficient alias (agent-task-safe replacement for haiku)
 * - inherit → provider default (varies)
 */
export const PROVIDER_ALIAS_MAP: Record<CLIProviderName, Record<string, string | undefined>> = {
  'anthropic-cli': {
    'opus': ANTHROPIC_CLI_DEFAULT_MODEL,
    'sonnet': ANTHROPIC_SONNET_MODEL,
    'haiku': ANTHROPIC_SONNET_MODEL,
    'mini': ANTHROPIC_SONNET_MODEL,
    'inherit': undefined,  // Let claude -p use its default
  },
  'gemini-cli': {
    'opus': GEMINI_CLI_DEFAULT_MODEL,
    'sonnet': GEMINI_CLI_DEFAULT_MODEL,
    'haiku': GEMINI_CLI_DEFAULT_MODEL,  // haiku alias → same as sonnet
    'mini': GEMINI_CLI_DEFAULT_MODEL,   // mini alias → same as sonnet
    'inherit': GEMINI_CLI_DEFAULT_MODEL,
  },
  'codex-cli': {
    'opus': CODEX_CLI_DEFAULT_MODEL,
    'sonnet': CODEX_CLI_DEFAULT_MODEL,
    'haiku': CODEX_CLI_DEFAULT_MODEL,  // haiku alias → same as sonnet
    'mini': CODEX_CLI_DEFAULT_MODEL,   // mini alias → same as sonnet
    'inherit': CODEX_CLI_DEFAULT_MODEL,
  },
  'cursor-cli': {
    'opus': 'auto',
    'sonnet': 'auto',
    'haiku': 'auto',  // haiku alias → same as sonnet
    'mini': 'auto',   // mini alias → same as sonnet
    'inherit': 'auto',
  },
  'deepseek': {
    'opus': DEEPSEEK_DEFAULT_MODEL,
    'sonnet': DEEPSEEK_DEFAULT_MODEL,
    'haiku': DEEPSEEK_FLASH_MODEL,   // flash tier for haiku
    'mini': DEEPSEEK_FLASH_MODEL,    // mini alias → same as haiku (flash)
    'inherit': DEEPSEEK_DEFAULT_MODEL,
  },
  'openrouter': {
    'opus': undefined,
    'sonnet': undefined,
    'haiku': undefined,
    'mini': undefined,
    'inherit': undefined,
  },
  'lm-studio': {
    'opus': 'local-model',
    'sonnet': 'local-model',
    'haiku': 'local-model',
    'mini': 'local-model',
    'inherit': 'local-model',
  },
};

/** Default models when no model is specified at all */
export const PROVIDER_DEFAULTS: Record<CLIProviderName, string | undefined> = {
  'anthropic-cli': ANTHROPIC_CLI_DEFAULT_MODEL,
  'gemini-cli': GEMINI_CLI_DEFAULT_MODEL,
  'codex-cli': CODEX_CLI_DEFAULT_MODEL,
  'cursor-cli': 'auto',
  'deepseek': DEEPSEEK_DEFAULT_MODEL,
  // DO-NOT-REVERT: human-selected OpenRouter default is MiniMax M3.
  // Xiaomi may remain an allowlisted fallback, but it is not the default.
  'openrouter': 'minimax/minimax-m3',
  'lm-studio': 'local-model',
};

/**
 * Known valid model names per provider. Used by `provider_models` MCP tool
 * introspection and by tests. Not consulted by `resolveProviderModel` itself
 * after the model-alias enforcement rewrite — gemini-cli, codex-cli, and
 * cursor-cli return hardcoded canonical models regardless of caller input,
 * and anthropic-cli/deepseek use substring matching against alias tokens.
 */
export const KNOWN_PROVIDER_MODELS: Record<CLIProviderName, Set<string>> = {
  'anthropic-cli': new Set([
    ANTHROPIC_CLI_DEFAULT_MODEL, 'claude-fable-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest',
    'claude-3-opus-20240229', 'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
  ]),
  'gemini-cli': new Set([
    GEMINI_CLI_DEFAULT_MODEL, 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'auto', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
    'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview', 'gemini-3.5-flash',
  ]),
  'codex-cli': new Set([
    CODEX_CLI_DEFAULT_MODEL, 'gpt-5.6-terra', 'gpt-5.6-luna',
    'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max',
    'gpt-5.1-codex', 'gpt-5-codex', 'gpt-5-codex-mini', 'auto',
  ]),
  'cursor-cli': new Set([
    'auto',
    'composer-2.5', 'composer-2.5-fast',
    'composer-2', 'composer-2-fast', 'composer-1.5', 'composer-1',
    'claude-fable-5-high', 'claude-fable-5-thinking-high',
    'claude-opus-4-8-high', 'claude-opus-4-8-thinking-high',
    'claude-sonnet-5-high', 'claude-sonnet-5-thinking-high',
    'gpt-5.5-high', 'gpt-5.5-medium',
    'gpt-5.4-high', 'gpt-5.4-medium',
    'gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.5-flash',
    'gpt-5.3-codex-xhigh', 'gpt-5.3-codex-xhigh-fast',
    'gpt-5.3-codex-high', 'gpt-5.3-codex-high-fast',
    'gpt-5.3-codex', 'gpt-5.3-codex-fast',
    'gpt-5.3-codex-low', 'gpt-5.3-codex-low-fast',
    'gpt-5.3-codex-spark-preview', 'gpt-5.3-codex-spark-preview-xhigh',
    'gpt-5.3-codex-spark-preview-high', 'gpt-5.3-codex-spark-preview-low',
    'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.2-codex-low',
  ]),
  'deepseek': new Set([
    'deepseek-v4-pro', 'deepseek-v4-flash',
  ]),
  'openrouter': new Set([
    'xiaomi/mimo-v2.5-pro', 'x-ai/grok-4.3', 'minimax/minimax-m3',
    'moonshotai/kimi-k2.6', 'qwen/qwen3.7-plus', 'z-ai/glm-5.2',
    'qwen/qwen3.6-plus', 'nvidia/nemotron-3-super-120b-a12b:free', 'deepseek/deepseek-v4-flash',
  ]),
  'lm-studio': new Set([
    'local-model',
  ]),
};

/**
 * Resolve a user-provided model string to a provider-native model name.
 *
 * Resolution order:
 * 1. If provider is not a CLI provider → passthrough unchanged
 * 2. OpenRouter → config-driven tier pools plus strict direct-model allowlist
 * 3. gemini-cli/codex-cli/cursor-cli → provider policy model, regardless of input
 * 4. anthropic-cli/deepseek → case-insensitive alias and legacy-name policy
 *
 * @returns The resolved model name, or undefined if model should be omitted
 */
export function resolveProviderModel(
  provider: string | undefined,
  userModel: string | undefined,
): string | undefined {
  // No provider specified → passthrough
  if (!provider) return userModel;

  // Not a CLI provider → passthrough
  if (!isCliProvider(provider)) return userModel;

  const cliProvider = provider as CLIProviderName;

  // OpenRouter: config-driven tier pools with random selection and allowlist
  if (cliProvider === 'openrouter') {
    const config = loadOpenRouterConfig();
    const requestedModel = typeof userModel === 'string' ? userModel.trim() : userModel;
    const lower = typeof requestedModel === 'string' ? requestedModel.toLowerCase() : requestedModel;

    // No model → random from default tier (opus per user directive)
    if (!requestedModel || requestedModel === '' || lower === 'inherit') {
      return selectFromPool(config.tiers.opus) ?? PROVIDER_DEFAULTS['openrouter'];
    }

    // Claude alias → random from tier pool
    // Note: 'inherit' / empty / undefined already handled above, so userModel
    // here is guaranteed to be a non-'inherit' value.
    if (typeof lower === 'string' && isClaudeAlias(lower)) {
      // 'mini' → sonnet tier (not haiku) per user directive
      const tierName = lower === 'mini' ? 'sonnet' : lower as 'opus' | 'sonnet' | 'haiku';
      const pool = config.tiers[tierName];
      if (!pool || pool.length === 0) return selectFromPool(config.tiers.opus) ?? PROVIDER_DEFAULTS['openrouter'];
      return selectFromPool(pool) ?? PROVIDER_DEFAULTS['openrouter'];
    }

    // Direct model → check allowlist
    const canonicalModel = getAllowedModelCanonical(config, requestedModel);
    if (!canonicalModel) {
      console.warn(`[model-resolver] OpenRouter model '${requestedModel}' not in allowedModels. Blocked.`);
      return undefined;
    }
    return canonicalModel;
  }

  // LM Studio: local OpenAI-compatible server. Operators load arbitrary models
  // in the LM Studio app, so direct model names pass through. Claude-style
  // aliases collapse to the local default placeholder; users can pass the exact
  // loaded model id when LM Studio requires one.
  if (cliProvider === 'lm-studio') {
    const requestedModel = typeof userModel === 'string' ? userModel.trim() : userModel;
    const lower = typeof requestedModel === 'string' ? requestedModel.toLowerCase() : requestedModel;
    if (!requestedModel || requestedModel === '' || lower === 'inherit') return PROVIDER_DEFAULTS['lm-studio'];
    if (typeof lower === 'string' && isClaudeAlias(lower)) return PROVIDER_DEFAULTS['lm-studio'];
    return requestedModel;
  }

  // ── Per-provider enforcement (ADR-026): alias schema is MANDATORY, not advisory ──

  // cursor-cli, gemini-cli, codex-cli → IGNORE INPUT entirely
  // These providers each have exactly ONE pre-scripted model.
  // Applied BEFORE alias/default checks so empty/undefined/inherit also get enforced.
  if (cliProvider === 'cursor-cli') {
    return 'auto';
  }
  if (cliProvider === 'gemini-cli') {
    return GEMINI_CLI_DEFAULT_MODEL;
  }
  if (cliProvider === 'codex-cli') {
    return CODEX_CLI_DEFAULT_MODEL;
  }

  // anthropic-cli → token-anchored alias / legacy-name resolution
  // Tightened to block cross-provider leaks (e.g. 'gpt-5-codex-mini') while still
  // mapping canonical aliases and legacy Anthropic names to the sonnet tier.
  if (cliProvider === 'anthropic-cli') {
    if (!userModel || userModel === '') return ANTHROPIC_CLI_DEFAULT_MODEL;
    const lower = userModel.toLowerCase();
    // Exact alias match
    if (lower === 'sonnet' || lower === 'haiku' || lower === 'mini') {
      return 'claude-sonnet-5';
    }
    // Legacy Anthropic Sonnet/Haiku names start with 'claude-' AND contain the tier word
    if (lower.startsWith('claude-') && (lower.includes('sonnet') || lower.includes('haiku'))) {
      return 'claude-sonnet-5';
    }
    return ANTHROPIC_CLI_DEFAULT_MODEL;
  }

  // deepseek → token-anchored alias / legacy-name resolution
  // Tightened to block cross-provider leaks (e.g. 'gemini-2.5-flash') while still
  // mapping canonical aliases and legacy DeepSeek flash names to the flash tier.
  // NOTE: 'sonnet' maps to deepseek-v4-pro per PROVIDER_ALIAS_MAP; only haiku/
  // mini/flash route to the flash tier.
  if (cliProvider === 'deepseek') {
    if (!userModel || userModel === '') return 'deepseek-v4-pro'; // default
    const lower = userModel.toLowerCase();
    // Exact alias match for flash-tier aliases
    if (lower === 'haiku' || lower === 'mini' || lower === 'flash') {
      return 'deepseek-v4-flash';
    }
    // Legacy DeepSeek flash names start with 'deepseek-' AND contain the tier word
    if (lower.startsWith('deepseek-') && lower.includes('flash')) {
      return 'deepseek-v4-flash';
    }
    return 'deepseek-v4-pro';  // default (covers 'sonnet', 'opus', 'inherit', unknown)
  }

  // Safety net: unreachable for known CLI providers (all branches above return).
  // Kept to surface any future provider that's added to CLIProviderName but
  // not wired into the resolver.
  throw new Error(`[model-resolver] unreachable: unknown CLI provider '${cliProvider}'`);
}

/**
 * Resolve a provider model, degrading to the OpenRouter opus class when the
 * requested model does not resolve — so agent/hive spawns never hard-fail on a
 * blocked or unknown OpenRouter slug.
 *
 * `resolveProviderModel` returns undefined for an OpenRouter direct model that
 * is not in the operator's `allowedModels` allowlist. The opus tier pool
 * (`tiers.opus`) is operator-controlled and is NOT gated by `allowedModels`
 * (the pool itself is the source of truth for class aliases), so resolving the
 * 'opus' alias always succeeds while the pool is non-empty. This makes OpenRouter
 * spawns "always resolve" to an opus-class model instead of erroring. It only
 * yields undefined if the opus pool itself is empty (e.g. every mapped model has
 * been delisted) — the genuine "no model available" case.
 *
 * Non-OpenRouter providers keep their existing resolution result unchanged
 * (which may be undefined — the caller decides how to handle it).
 */
export function resolveProviderModelOrOpus(
  provider: string | undefined,
  userModel: string | undefined,
): string | undefined {
  const resolved = resolveProviderModel(provider, userModel);
  if (resolved !== undefined) return resolved;
  if (provider === 'openrouter') {
    const opusFallback = resolveProviderModel('openrouter', 'opus');
    if (opusFallback !== undefined) {
      console.warn(
        `[model-resolver] OpenRouter model '${String(userModel)}' did not resolve; ` +
          `defaulting to the opus class → '${opusFallback}'.`,
      );
      return opusFallback;
    }
  }
  return resolved;
}

/**
 * Default context window sizes (in tokens) for known models.
 * Used for trimming, chunking, and budget calculations.
 */
export const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-opus-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-sonnet-latest': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,
  // Gemini
  'gemini-3.6-flash-high': 1_048_576,
  'gemini-3.6-flash-medium': 1_048_576,
  'gemini-3.6-flash-low': 1_048_576,
  'gemini-3.5-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.5-flash-lite': 1_000_000,
  'gemini-3-flash-preview': 1_000_000,
  'gemini-3.1-pro-preview': 1_000_000,
  'gemini-3.1-flash-lite': 1_000_000,
  'gemini-3.1-flash-lite-preview': 1_000_000,
  // OpenAI / Codex
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.5': 1_000_000,
  'gpt-5.4': 1_000_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.4-nano': 400_000,
  'gpt-5.3-codex': 256_000,
  'gpt-5.2-codex': 256_000,
  'gpt-5.1-codex-max': 256_000,
  'gpt-5.1-codex': 256_000,
  'gpt-5-codex': 256_000,
  'gpt-5-codex-mini': 128_000,
  'gpt-4o-mini': 128_000,
  // DeepSeek
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
};

/**
 * Look up the context window length for a model name.
 *
 * @param model - Exact model identifier (e.g. 'claude-opus-4-6')
 * @param fallback - Value returned when the model is not in the map (default 128_000)
 * @returns Context window size in tokens
 */
export function getModelContextLength(model: string | undefined, fallback = 128_000): number {
  if (!model) return fallback;
  return DEFAULT_CONTEXT_WINDOWS[model] ?? fallback;
}

function isClaudeAlias(model: string): model is ClaudeAlias {
  return (CLAUDE_ALIASES as readonly string[]).includes(model);
}

function isCliProvider(provider: string): provider is CLIProviderName {
  return provider === 'anthropic-cli'
    || provider === 'gemini-cli'
    || provider === 'codex-cli'
    || provider === 'cursor-cli'
    || provider === 'deepseek'
    || provider === 'openrouter'
    || provider === 'lm-studio';
}
