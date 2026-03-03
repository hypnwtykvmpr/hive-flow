/**
 * Role Normalizer Utility
 *
 * Normalizes generic LLM roles (system, user, assistant, tool) for specific providers.
 *
 * Created with ❤️ by ruv.io
 */

import { LLMProvider } from '@claude-flow/providers';

/**
 * Normalizes a role string based on the target provider.
 */
export class RoleNormalizer {
  /**
   * Maps a generic role to a provider-specific role.
   */
  static normalize(role: 'system' | 'user' | 'assistant' | 'tool', provider: LLMProvider): string {
    switch (provider) {
      case 'anthropic':
        return this.normalizeAnthropic(role);
      case 'openai':
        return this.normalizeOpenAI(role);
      case 'google':
      case 'gemini-cli':
        return this.normalizeGemini(role);
      case 'ollama':
        return this.normalizeOllama(role);
      default:
        return role;
    }
  }

  private static normalizeAnthropic(role: string): string {
    switch (role) {
      case 'system': return 'system';
      case 'user': return 'user';
      case 'assistant': return 'assistant';
      case 'tool': return 'tool';
      default: return 'user';
    }
  }

  private static normalizeOpenAI(role: string): string {
    switch (role) {
      case 'system': return 'system';
      case 'user': return 'user';
      case 'assistant': return 'assistant';
      case 'tool': return 'tool';
      default: return 'user';
    }
  }

  private static normalizeGemini(role: string): string {
    switch (role) {
      case 'system': return 'systemInstruction';
      case 'user': return 'user';
      case 'assistant': return 'model';
      case 'tool': return 'function_response';
      default: return 'user';
    }
  }

  private static normalizeOllama(role: string): string {
    switch (role) {
      case 'system': return 'system';
      case 'user': return 'user';
      case 'assistant': return 'assistant';
      case 'tool': return 'tool';
      default: return 'user';
    }
  }
}
