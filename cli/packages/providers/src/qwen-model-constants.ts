import type { LLMModel, ProviderCapabilities } from './types.js';

/** Hive Flow default based on Model Studio's current general recommendation. */
export const QWEN_DEFAULT_MODEL = 'qwen3.7-plus';

export const QWEN_MODELS: LLMModel[] = [
  QWEN_DEFAULT_MODEL,
  'qwen3.7-max',
  // Compatibility aliases retained for existing configurations.
  'qwen-max',
  'qwen-plus',
  'qwen-turbo',
  'qwen-long',
];

export const QWEN_MODEL_DESCRIPTIONS: Record<string, string> = {
  'qwen3.7-plus': 'Qwen 3.7 Plus - current recommended agentic model',
  'qwen3.7-max': 'Qwen 3.7 Max - current highest-capability model',
  'qwen-max': 'Qwen Max - legacy flagship alias',
  'qwen-plus': 'Qwen Plus - legacy balanced alias',
  'qwen-turbo': 'Qwen Turbo - legacy fast alias',
  'qwen-long': 'Qwen Long - legacy long-context alias',
};

export const QWEN_CONTEXT_WINDOWS: Record<string, number> = {
  'qwen3.7-plus': 1_000_000,
  'qwen3.7-max': 1_000_000,
  'qwen-max': 32_768,
  'qwen-plus': 131_072,
  'qwen-turbo': 131_072,
  'qwen-long': 10_000_000,
};

export const QWEN_OUTPUT_LIMITS: Record<string, number> = {
  'qwen3.7-plus': 65_536,
  'qwen3.7-max': 65_536,
  'qwen-max': 8_192,
  'qwen-plus': 8_192,
  'qwen-turbo': 8_192,
  'qwen-long': 8_192,
};

/**
 * Static international-service estimates, matching the API provider's default
 * endpoint. Qwen 3.7 Plus uses its highest 1M-window tier so long requests are
 * not systematically under-estimated by a single-price capability model.
 */
export const QWEN_PRICING: ProviderCapabilities['pricing'] = {
  'qwen3.7-plus': { promptCostPer1k: 0.0012, completionCostPer1k: 0.0048, currency: 'USD' },
  'qwen3.7-max': { promptCostPer1k: 0.0025, completionCostPer1k: 0.0075, currency: 'USD' },
  'qwen-max': { promptCostPer1k: 0.0016, completionCostPer1k: 0.0064, currency: 'USD' },
  'qwen-plus': { promptCostPer1k: 0.0004, completionCostPer1k: 0.0012, currency: 'USD' },
  'qwen-turbo': { promptCostPer1k: 0.0002, completionCostPer1k: 0.0006, currency: 'USD' },
  'qwen-long': { promptCostPer1k: 0.00005, completionCostPer1k: 0.0002, currency: 'USD' },
};
