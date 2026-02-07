/**
 * @claude-flow/codex - Templates
 *
 * Built-in templates and skill definitions
 */

import type { AgentsMdTemplate, BuiltInSkill } from '../types.js';

/**
 * Built-in skill definitions
 */
export const BUILT_IN_SKILLS: Record<BuiltInSkill, { name: string; description: string; category: string }> = {
  'swarm-orchestration': {
    name: 'Swarm Orchestration',
    description: 'Multi-agent task coordination',
    category: 'coordination',
  },
  'memory-management': {
    name: 'Memory Management',
    description: 'Pattern storage and retrieval',
    category: 'memory',
  },
  'sparc-methodology': {
    name: 'SPARC Methodology',
    description: 'Structured development workflow',
    category: 'workflow',
  },
  'security-audit': {
    name: 'Security Audit',
    description: 'Security scanning and CVE detection',
    category: 'security',
  },
  'performance-analysis': {
    name: 'Performance Analysis',
    description: 'Profiling and optimization',
    category: 'performance',
  },
  'github-automation': {
    name: 'GitHub Automation',
    description: 'CI/CD and PR management',
    category: 'automation',
  },
};

/**
 * Template descriptions
 */
export const TEMPLATES: Record<AgentsMdTemplate, { name: string; description: string; skillCount: number }> = {
  minimal: {
    name: 'Minimal',
    description: 'Basic setup with essential skills only',
    skillCount: 2,
  },
  default: {
    name: 'Default',
    description: 'Standard setup with common skills',
    skillCount: 4,
  },
  full: {
    name: 'Full',
    description: 'Complete setup with all features',
    skillCount: 6,
  },
  enterprise: {
    name: 'Enterprise',
    description: 'Full setup with governance and compliance',
    skillCount: 6,
  },
};

/**
 * Get template information
 */
export function getTemplate(name: AgentsMdTemplate): typeof TEMPLATES[AgentsMdTemplate] {
  return TEMPLATES[name];
}

/**
 * List all available templates
 */
export function listTemplates(): Array<{ name: AgentsMdTemplate; description: string; skillCount: number }> {
  return Object.entries(TEMPLATES).map(([name, info]) => ({
    name: name as AgentsMdTemplate,
    description: info.description,
    skillCount: info.skillCount,
  }));
}

/**
 * Default skills per template
 */
export const DEFAULT_SKILLS_BY_TEMPLATE: Record<AgentsMdTemplate, BuiltInSkill[]> = {
  minimal: ['swarm-orchestration', 'memory-management'],
  default: ['swarm-orchestration', 'memory-management', 'sparc-methodology', 'security-audit'],
  full: [
    'swarm-orchestration',
    'memory-management',
    'sparc-methodology',
    'security-audit',
    'performance-analysis',
    'github-automation',
  ],
  enterprise: [
    'swarm-orchestration',
    'memory-management',
    'sparc-methodology',
    'security-audit',
    'performance-analysis',
    'github-automation',
  ],
};

/**
 * Directory structure template
 */
export const DIRECTORY_STRUCTURE = {
  root: {
    'AGENTS.md': 'Main project instructions',
  },
  '.agents': {
    'config.toml': 'Project-level Codex config',
    'skills/': 'Skill definitions',
  },
  '.codex': {
    'config.toml': 'User-local overrides (gitignored)',
    'AGENTS.override.md': 'Local instruction overrides',
  },
  '.claude-flow': {
    'config.yaml': 'Runtime configuration',
    'data/': 'Memory and cache data',
    'logs/': 'Log files',
  },
};

/**
 * Feature mapping between Claude Code and Codex
 */
export const PLATFORM_MAPPING = {
  claudeCode: {
    configFile: 'CLAUDE.md',
    localConfig: 'CLAUDE.local.md',
    settingsFormat: 'JSON (settings.json)',
    skillInvocation: '/skill-name',
    approvalLevels: 3,
  },
  codex: {
    configFile: 'AGENTS.md',
    localConfig: '.codex/AGENTS.override.md',
    settingsFormat: 'TOML (config.toml)',
    skillInvocation: '$skill-name',
    approvalLevels: 4,
  },
};

/**
 * Gitignore entries for Codex projects
 */
export const GITIGNORE_ENTRIES = [
  '# Codex local configuration',
  '.codex/',
  '',
  '# Claude Flow runtime data',
  '.claude-flow/data/',
  '.claude-flow/logs/',
  '',
  '# Environment variables',
  '.env',
  '.env.local',
  '.env.*.local',
];

/**
 * Default AGENTS.override.md content
 */
export const AGENTS_OVERRIDE_TEMPLATE = `# Local Development Overrides

## Environment
- Development mode: full-auto
- Sandbox: workspace-write
- Web search: live

## Personal Preferences
[Add your specific preferences here]

## Debug Settings
Enable verbose logging for development.

## Notes
This file is gitignored and contains local-only settings.
`;
