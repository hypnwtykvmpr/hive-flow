/**
 * @claude-flow/codex
 *
 * OpenAI Codex platform adapter for Claude Flow
 * First step in the coflow rebranding initiative
 *
 * @packageDocumentation
 */

// Re-export all types
export * from './types.js';

// Re-export generators
export {
  generateAgentsMd,
  generateSkillMd,
  generateConfigToml,
} from './generators/index.js';

// Re-export migrations
export {
  migrateFromClaudeCode,
  analyzeClaudeMd,
} from './migrations/index.js';

// Re-export validators
export {
  validateAgentsMd,
  validateSkillMd,
  validateConfigToml,
} from './validators/index.js';

// Main initializer class
export { CodexInitializer } from './initializer.js';

// Template utilities
export {
  getTemplate,
  listTemplates,
  BUILT_IN_SKILLS,
} from './templates/index.js';

/**
 * Package version
 */
export const VERSION = '3.0.0-alpha.1';

/**
 * Package metadata
 */
export const PACKAGE_INFO = {
  name: '@claude-flow/codex',
  version: VERSION,
  description: 'Codex CLI integration for Claude Flow',
  futureUmbrella: 'coflow',
  repository: 'https://github.com/ruvnet/claude-flow',
} as const;
