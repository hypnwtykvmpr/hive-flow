/**
 * Constants for Gemini CLI Provider
 *
 * Extracted from gemini-cli-provider.ts to keep the provider under 500 lines.
 *
 * @module @claude-flow/providers/gemini-cli-constants
 */

import { LLMModel, ProviderCapabilities } from './types.js';

/** Shape returned by `gemini --output-format json` (batch mode) */
export interface GeminiJsonOutput {
  response?: string;
  type?: string;
  content?: string;
  message?: { content?: string };
  stats?: {
    models?: Record<string, {
      tokens?: { prompt?: number; candidates?: number; total?: number };
    }>;
  };
}

/** Gemini CLI exit codes */
export const GEMINI_EXIT_CODES = {
  Success: 0,
  Generic: 1,
  Auth: 41,
  Input: 42,
  Config: 52,
  Cancel: 130,
} as const;

/** Safety limit to prevent unbounded stdout accumulation */
export const MAX_STDOUT_BYTES = 50 * 1024 * 1024; // 50 MB

export const GEMINI_MODELS: LLMModel[] = [
  'auto',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'gemini-3-flash-preview', 'gemini-3.1-pro-preview',
];

export const GEMINI_MODEL_DESCRIPTIONS: Record<string, string> = {
  'auto': 'Auto - Gemini CLI selects optimal model',
  'gemini-2.5-flash': 'Gemini 2.5 Flash - Fast and cost-effective',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite - Ultra-lightweight',
  'gemini-2.5-pro': 'Gemini 2.5 Pro - High capability reasoning',
  'gemini-3-flash-preview': 'Gemini 3 Flash Preview - Next-gen speed',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview - Next-gen reasoning',
};

function makePricing(prompt: number, completion: number) {
  return { promptCostPer1k: prompt, completionCostPer1k: completion, currency: 'USD' };
}

export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  supportedModels: GEMINI_MODELS,
  maxContextLength: {
    'auto': 1048576,
    'gemini-2.5-flash': 1048576, 'gemini-2.5-flash-lite': 1048576,
    'gemini-2.5-pro': 1048576, 'gemini-3-flash-preview': 1048576,
    'gemini-3.1-pro-preview': 2097152,
  },
  maxOutputTokens: {
    'auto': 65536,
    'gemini-2.5-flash': 65536, 'gemini-2.5-flash-lite': 65536,
    'gemini-2.5-pro': 65536, 'gemini-3-flash-preview': 65536,
    'gemini-3.1-pro-preview': 65536,
  },
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsSystemMessages: true,
  supportsVision: false,
  supportsAudio: false,
  supportsFineTuning: false,
  supportsEmbeddings: false,
  supportsBatching: false,
  rateLimit: { requestsPerMinute: 60, tokensPerMinute: 4000000, concurrentRequests: 5 },
  pricing: {
    'auto': makePricing(0, 0),
    'gemini-2.5-flash': makePricing(0.00015, 0.0006),
    'gemini-2.5-flash-lite': makePricing(0.0001, 0.0004),
    'gemini-2.5-pro': makePricing(0.00125, 0.01),
    'gemini-3-flash-preview': makePricing(0.0005, 0.003),
    'gemini-3.1-pro-preview': makePricing(0.002, 0.012),
  },
};
