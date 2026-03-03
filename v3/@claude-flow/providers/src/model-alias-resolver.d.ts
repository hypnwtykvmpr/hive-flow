/**
 * Model Alias Resolver
 *
 * Maps Claude model aliases (haiku, sonnet, opus) to provider-native model names
 * for CLI providers. This enables seamless model switching across providers — users
 * can specify 'haiku' and get the equivalent fast model for whichever provider they're using.
 *
 * @module @claude-flow/providers/model-alias-resolver
 */
/** Claude model aliases that users can specify */
export declare const CLAUDE_ALIASES: readonly ["haiku", "sonnet", "opus", "inherit"];
export type ClaudeAlias = typeof CLAUDE_ALIASES[number];
/** Provider names that support alias resolution */
export type CLIProviderName = 'gemini-cli' | 'codex-cli' | 'cursor-cli';
/**
 * Maps Claude aliases to provider-native model names.
 *
 * Design decisions:
 * - opus → best/flagship model for each provider
 * - sonnet → balanced/mid-tier model
 * - haiku → fastest/cheapest model
 * - inherit → provider default (varies)
 */
export declare const PROVIDER_ALIAS_MAP: Record<CLIProviderName, Record<string, string | undefined>>;
/** Default models when no model is specified at all */
export declare const PROVIDER_DEFAULTS: Record<CLIProviderName, string | undefined>;
/** Known valid model names per provider (for passthrough validation) */
export declare const KNOWN_PROVIDER_MODELS: Record<CLIProviderName, Set<string>>;
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
export declare function resolveProviderModel(provider: string | undefined, userModel: string | undefined): string | undefined;
//# sourceMappingURL=model-alias-resolver.d.ts.map