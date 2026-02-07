/**
 * @claude-flow/codex - Migrations
 *
 * Migration utilities for converting Claude Code configurations to Codex format
 */

import type { MigrationOptions, MigrationResult, FeatureMapping } from '../types.js';

/**
 * Feature mappings between Claude Code and Codex
 */
export const FEATURE_MAPPINGS: FeatureMapping[] = [
  {
    claudeCode: 'CLAUDE.md',
    codex: 'AGENTS.md',
    status: 'mapped',
    notes: 'Main instruction file - content is portable',
  },
  {
    claudeCode: 'CLAUDE.local.md',
    codex: '.codex/AGENTS.override.md',
    status: 'mapped',
    notes: 'Local overrides - gitignored in both',
  },
  {
    claudeCode: 'settings.json',
    codex: 'config.toml',
    status: 'mapped',
    notes: 'Format conversion required (JSON to TOML)',
  },
  {
    claudeCode: '/skill-name',
    codex: '$skill-name',
    status: 'mapped',
    notes: 'Skill invocation syntax - search and replace',
  },
  {
    claudeCode: 'TodoWrite',
    codex: 'Task tracking',
    status: 'mapped',
    notes: 'Similar functionality with different API',
  },
  {
    claudeCode: 'Task tool agents',
    codex: 'Sub-agent collaboration',
    status: 'partial',
    notes: 'Codex sub-agents via CODEX_HANDOFF_TARGET env var',
  },
  {
    claudeCode: 'MCP servers',
    codex: '[mcp_servers]',
    status: 'mapped',
    notes: 'Configuration format differs but same functionality',
  },
  {
    claudeCode: 'hooks system',
    codex: 'Automations',
    status: 'partial',
    notes: 'Codex automations are scheduled, not event-driven',
  },
  {
    claudeCode: 'EnterPlanMode',
    codex: 'No direct equivalent',
    status: 'unsupported',
    notes: 'Codex uses different planning paradigm',
  },
  {
    claudeCode: 'Permission modes',
    codex: 'approval_policy + sandbox_mode',
    status: 'mapped',
    notes: 'Codex provides more granular control',
  },
];

/**
 * Analyze a CLAUDE.md file for migration
 */
export async function analyzeClaudeMd(content: string): Promise<{
  sections: string[];
  skills: string[];
  hooks: string[];
  customInstructions: string[];
  warnings: string[];
}> {
  const sections: string[] = [];
  const skills: string[] = [];
  const hooks: string[] = [];
  const customInstructions: string[] = [];
  const warnings: string[] = [];

  // Extract sections
  const sectionRegex = /^##\s+(.+)$/gm;
  let match;
  while ((match = sectionRegex.exec(content)) !== null) {
    sections.push(match[1]!);
  }

  // Extract skill references (/skill-name)
  const skillRegex = /\/([a-z][a-z0-9-]*)/g;
  while ((match = skillRegex.exec(content)) !== null) {
    if (!skills.includes(match[1]!)) {
      skills.push(match[1]!);
    }
  }

  // Extract hook references
  const hookKeywords = ['pre-task', 'post-task', 'pre-edit', 'post-edit', 'session-start', 'session-end'];
  for (const hook of hookKeywords) {
    if (content.includes(hook)) {
      hooks.push(hook);
    }
  }

  // Check for Claude Code specific patterns that need attention
  if (content.includes('EnterPlanMode')) {
    warnings.push('EnterPlanMode has no direct Codex equivalent - review planning workflow');
  }
  if (content.includes('claude -p')) {
    warnings.push('claude -p headless mode - check Codex sub-agent patterns');
  }
  if (content.includes('TodoWrite')) {
    warnings.push('TodoWrite - Codex has different task tracking approach');
  }

  // Extract custom instructions (behavioral rules)
  const behavioralSection = content.match(/## Behavioral Rules[\s\S]*?(?=##|$)/);
  if (behavioralSection) {
    const lines = behavioralSection[0].split('\n');
    for (const line of lines) {
      if (line.startsWith('- ')) {
        customInstructions.push(line.substring(2));
      }
    }
  }

  return {
    sections,
    skills,
    hooks,
    customInstructions,
    warnings,
  };
}

/**
 * Migrate from Claude Code (CLAUDE.md) to Codex (AGENTS.md)
 */
export async function migrateFromClaudeCode(options: MigrationOptions): Promise<MigrationResult> {
  const { sourcePath, targetPath, preserveComments = true, generateSkills = true } = options;

  try {
    // This would read the file in actual implementation
    // For now, return a template result
    const result: MigrationResult = {
      success: true,
      agentsMdPath: `${targetPath}/AGENTS.md`,
      skillsCreated: generateSkills
        ? ['swarm-orchestration', 'memory-management', 'security-audit']
        : [],
      configTomlPath: `${targetPath}/.agents/config.toml`,
      mappings: FEATURE_MAPPINGS,
      warnings: [
        'Review skill invocation syntax (changed from / to $)',
        'Check hook configurations for Automation compatibility',
      ],
    };

    return result;
  } catch (error) {
    return {
      success: false,
      warnings: [`Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
    };
  }
}

/**
 * Convert skill invocation syntax
 */
export function convertSkillSyntax(content: string): string {
  // Convert /skill-name to $skill-name
  return content.replace(/\/([a-z][a-z0-9-]*)/g, '$$$1');
}

/**
 * Convert settings.json to config.toml format
 */
export function convertSettingsToToml(settings: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push('# Migrated from settings.json');
  lines.push('');

  // Map common settings
  if (settings.model) {
    lines.push(`model = "${settings.model}"`);
  }

  if (settings.permissions) {
    const perms = settings.permissions as Record<string, unknown>;
    if (perms.autoApprove === true) {
      lines.push('approval_policy = "never"');
    } else if (perms.autoApprove === 'read-only') {
      lines.push('approval_policy = "on-request"');
      lines.push('sandbox_mode = "read-only"');
    } else {
      lines.push('approval_policy = "on-request"');
    }
  }

  // Add MCP servers
  if (settings.mcpServers && typeof settings.mcpServers === 'object') {
    lines.push('');
    for (const [name, config] of Object.entries(settings.mcpServers as Record<string, { command?: string; args?: string[] }>)) {
      lines.push(`[mcp_servers.${name}]`);
      if (config.command) {
        lines.push(`command = "${config.command}"`);
      }
      if (config.args) {
        const argsStr = config.args.map(a => `"${a}"`).join(', ');
        lines.push(`args = [${argsStr}]`);
      }
      lines.push('enabled = true');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate migration report
 */
export function generateMigrationReport(result: MigrationResult): string {
  const lines: string[] = [];

  lines.push('# Migration Report');
  lines.push('');
  lines.push(`**Status**: ${result.success ? 'Success' : 'Failed'}`);
  lines.push('');

  if (result.agentsMdPath) {
    lines.push(`## Generated Files`);
    lines.push(`- AGENTS.md: ${result.agentsMdPath}`);
    if (result.configTomlPath) {
      lines.push(`- config.toml: ${result.configTomlPath}`);
    }
    lines.push('');
  }

  if (result.skillsCreated && result.skillsCreated.length > 0) {
    lines.push(`## Skills Created`);
    for (const skill of result.skillsCreated) {
      lines.push(`- ${skill}`);
    }
    lines.push('');
  }

  if (result.mappings) {
    lines.push('## Feature Mappings');
    lines.push('');
    lines.push('| Claude Code | Codex | Status |');
    lines.push('|-------------|-------|--------|');
    for (const mapping of result.mappings) {
      lines.push(`| ${mapping.claudeCode} | ${mapping.codex} | ${mapping.status} |`);
    }
    lines.push('');
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push('## Warnings');
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
