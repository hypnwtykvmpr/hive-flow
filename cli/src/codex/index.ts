/**
 * @hive-flow/cli/codex
 *
 * OpenAI Codex platform adapter for Hive Flow
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Re-export all types
export * from './types.js';

// Re-export generators
export {
  generateAgentsMd,
  generateSkillMd,
  generateConfigToml,
} from './generators/index.js';

// Re-export skill generator helper
export { generateBuiltInSkill } from './generators/skill-md.js';

// Re-export config generator helpers
export { generateMinimalConfigToml, generateCIConfigToml } from './generators/config-toml.js';

// Re-export migrations
export {
  migrateFromClaudeCode,
  analyzeClaudeMd,
  generateMigrationReport,
  convertSkillSyntax,
  convertSettingsToToml,
  FEATURE_MAPPINGS,
} from './migrations/index.js';

// Re-export validators
export {
  validateAgentsMd,
  validateSkillMd,
  validateConfigToml,
} from './validators/index.js';

// Main initializer class and helper function
export { CodexInitializer, initializeCodexProject } from './initializer.js';

// Dual-mode collaborative execution
export { DualModeOrchestrator, CollaborationTemplates, createDualModeCommand } from './dual-mode/index.js';
export type { DualModeConfig, WorkerConfig, WorkerResult, CollaborationResult } from './dual-mode/index.js';

// Template utilities
export {
  getTemplate,
  listTemplates,
  BUILT_IN_SKILLS,
  TEMPLATES,
  DEFAULT_SKILLS_BY_TEMPLATE,
  DIRECTORY_STRUCTURE,
  PLATFORM_MAPPING,
  GITIGNORE_ENTRIES,
  AGENTS_OVERRIDE_TEMPLATE,
} from './templates/index.js';

/**
 * Package version
 */
function getPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // src/codex/index.ts -> package root
    join(here, '..', '..', 'package.json'),
    // dist/src/codex/index.js -> package root
    join(here, '..', '..', '..', 'package.json'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
      if ((pkg.name === 'hive-flow' || pkg.name === '@hive-flow/cli') && pkg.version) {
        return pkg.version;
      }
    } catch {
      // Keep searching; malformed package.json files are handled by normal gates.
    }
  }

  return '3.0.0';
}

export const VERSION = getPackageVersion();

/**
 * Package metadata
 */
export const PACKAGE_INFO = {
  name: '@hive-flow/cli/codex',
  version: VERSION,
  description: 'Codex CLI integration for Hive Flow',
  futureUmbrella: 'coflow',
} as const;

/**
 * Default export for convenient imports
 */
export default {
  VERSION,
  PACKAGE_INFO,
};
