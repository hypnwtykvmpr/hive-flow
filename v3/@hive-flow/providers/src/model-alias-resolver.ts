/**
 * Model Alias Resolver
 *
 * Maps Claude model aliases (haiku, sonnet, opus) to provider-native model names
 * for CLI providers. This enables seamless model switching across providers — users
 * can specify 'haiku' and get the equivalent fast model for whichever provider they're using.
 *
 * @module @hive-flow/providers/model-alias-resolver
 */

/** Claude model aliases that users can specify */
export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus', 'inherit'] as const;
export type ClaudeAlias = typeof CLAUDE_ALIASES[number];

/** Provider names that support alias resolution */
export type CLIProviderName = 'anthropic-cli' | 'gemini-cli' | 'codex-cli' | 'cursor-cli';

/**
 * Maps Claude aliases to provider-native model names.
 *
 * Design decisions:
 * - opus → best/flagship model for each provider
 * - sonnet → balanced/mid-tier model
 * - haiku → fastest/cheapest model
 * - inherit → provider default (varies)
 */
export const PROVIDER_ALIAS_MAP: Record<CLIProviderName, Record<string, string | undefined>> = {
  'anthropic-cli': {
    'opus': 'claude-opus-4-6',
    'sonnet': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5-20251001',
    'inherit': undefined,  // Let claude -p use its default
  },
  'gemini-cli': {
    'opus': 'gemini-3.1-pro-preview',
    'sonnet': 'gemini-3.1-pro-preview',
    'haiku': 'gemini-3-flash',
    'inherit': 'gemini-3.1-pro-preview',
  },
  'codex-cli': {
    'opus': 'gpt-5.4',
    'sonnet': 'gpt-5.3-codex',
    'haiku': 'gpt-5.2-codex-mini',
    'inherit': undefined,  // Let Codex use config.toml default
  },
  'cursor-cli': {
    'opus': 'auto',
    'sonnet': 'auto',
    'haiku': 'auto',
    'inherit': 'auto',
  },
};

/** Default models when no model is specified at all */
export const PROVIDER_DEFAULTS: Record<CLIProviderName, string | undefined> = {
  'anthropic-cli': 'claude-opus-4-6',
  'gemini-cli': 'auto',
  'codex-cli': undefined,  // Omit --model, let config.toml decide
  'cursor-cli': 'auto',
};

/** Known valid model names per provider (for passthrough validation) */
export const KNOWN_PROVIDER_MODELS: Record<CLIProviderName, Set<string>> = {
  'anthropic-cli': new Set([
    'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-latest',
    'claude-3-opus-20240229', 'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
  ]),
  'gemini-cli': new Set([
    'auto', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
    'gemini-3-flash-preview', 'gemini-3.1-pro-preview',
  ]),
  'codex-cli': new Set([
    'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max',
    'gpt-5.1-codex', 'gpt-5-codex', 'gpt-5-codex-mini', 'auto',
  ]),
  'cursor-cli': new Set([
    'auto', 'composer-1.5', 'composer-1',
    'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2',
  ]),
};

/**
 * Resolve a user-provided model string to a provider-native model name.
 *
 * Resolution order:
 * 1. If provider is not a CLI provider → passthrough unchanged
 * 2. If model is a Claude alias → map to provider-native name
 * 3. If model is already a known provider-native name → passthrough
 * 4. If model is a model from a DIFFERENT provider → warn and use default
 * 5. If model is undefined/empty → use provider default
 * 6. Unknown string → warn and passthrough (let provider handle it)
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

  // No model specified → use provider default
  if (!userModel || userModel === '') {
    return PROVIDER_DEFAULTS[cliProvider];
  }

  // Claude alias → map to provider-native
  if (isClaudeAlias(userModel)) {
    const mapped = PROVIDER_ALIAS_MAP[cliProvider][userModel];
    return mapped;  // May be undefined (codex-cli + inherit)
  }

  // 'auto' → special handling per provider
  if (userModel === 'auto') {
    return PROVIDER_DEFAULTS[cliProvider];
  }

  // Already a known native model for this provider → passthrough
  if (KNOWN_PROVIDER_MODELS[cliProvider].has(userModel)) {
    return userModel;
  }

  // Check if it's a model from a DIFFERENT provider (common mistake)
  for (const [otherProvider, models] of Object.entries(KNOWN_PROVIDER_MODELS)) {
    if (otherProvider !== cliProvider && models.has(userModel)) {
      console.warn(
        `[model-resolver] Model '${userModel}' belongs to ${otherProvider}, not ${cliProvider}. ` +
        `Using ${cliProvider} default instead.`
      );
      return PROVIDER_DEFAULTS[cliProvider];
    }
  }

  // Unknown string → passthrough with warning (let provider validate)
  console.warn(
    `[model-resolver] Unknown model '${userModel}' for ${cliProvider}. Passing through as-is.`
  );
  return userModel;
}

function isClaudeAlias(model: string): model is ClaudeAlias {
  return (CLAUDE_ALIASES as readonly string[]).includes(model);
}

function isCliProvider(provider: string): provider is CLIProviderName {
  return provider === 'anthropic-cli' || provider === 'gemini-cli' || provider === 'codex-cli' || provider === 'cursor-cli';
}
