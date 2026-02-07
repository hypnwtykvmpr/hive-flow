/**
 * @claude-flow/codex - SKILL.md Generator
 *
 * Generates SKILL.md files for OpenAI Codex CLI skills
 * Uses YAML frontmatter for metadata
 */

import type { SkillMdOptions, SkillCommand } from '../types.js';

/**
 * Generate a SKILL.md file based on the provided options
 */
export async function generateSkillMd(options: SkillMdOptions): Promise<string> {
  const {
    name,
    description,
    triggers = [],
    skipWhen = [],
    scripts = [],
    references = [],
    commands = [],
  } = options;

  // Build YAML frontmatter
  const triggerText = triggers.length > 0
    ? `Use when: ${triggers.join(', ')}.`
    : '';
  const skipText = skipWhen.length > 0
    ? `Skip when: ${skipWhen.join(', ')}.`
    : '';

  const frontmatter = `---
name: ${name}
description: >
  ${description}
  ${triggerText}
  ${skipText}
---`;

  // Build commands section
  const commandsSection = commands.length > 0
    ? buildCommandsSection(commands)
    : '';

  // Build scripts section
  const scriptsSection = scripts.length > 0
    ? buildScriptsSection(scripts)
    : '';

  // Build references section
  const referencesSection = references.length > 0
    ? buildReferencesSection(references)
    : '';

  // Combine all sections
  return `${frontmatter}

# ${formatSkillName(name)} Skill

## Purpose
${description}

## When to Trigger
${triggers.length > 0 ? triggers.map(t => `- ${t}`).join('\n') : '- Define triggers for this skill'}

## When to Skip
${skipWhen.length > 0 ? skipWhen.map(s => `- ${s}`).join('\n') : '- Define skip conditions for this skill'}
${commandsSection}
${scriptsSection}
${referencesSection}
## Best Practices
1. Check memory for existing patterns before starting
2. Use hierarchical topology for coordination
3. Store successful patterns after completion
4. Document any new learnings
`;
}

/**
 * Build the commands section of the SKILL.md
 */
function buildCommandsSection(commands: SkillCommand[]): string {
  const lines = commands.map(cmd => {
    let block = `### ${cmd.name}\n${cmd.description}\n\n\`\`\`bash\n${cmd.command}\n\`\`\``;
    if (cmd.example) {
      block += `\n\n**Example:**\n\`\`\`bash\n${cmd.example}\n\`\`\``;
    }
    return block;
  });

  return `
## Commands

${lines.join('\n\n')}
`;
}

/**
 * Build the scripts section
 */
function buildScriptsSection(scripts: { name: string; path: string; description: string }[]): string {
  const lines = scripts.map(s => `| \`${s.name}\` | \`${s.path}\` | ${s.description} |`);

  return `
## Scripts

| Script | Path | Description |
|--------|------|-------------|
${lines.join('\n')}
`;
}

/**
 * Build the references section
 */
function buildReferencesSection(references: { name: string; path: string; description?: string }[]): string {
  const lines = references.map(r =>
    `| \`${r.name}\` | \`${r.path}\` | ${r.description ?? ''} |`
  );

  return `
## References

| Document | Path | Description |
|----------|------|-------------|
${lines.join('\n')}
`;
}

/**
 * Format skill name for display (kebab-case to Title Case)
 */
function formatSkillName(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Generate a skill from a built-in template
 */
export async function generateBuiltInSkill(
  skillName: string
): Promise<{ skillMd: string; scripts: Record<string, string>; references: Record<string, string> }> {
  const skillTemplates: Record<string, SkillMdOptions> = {
    'swarm-orchestration': {
      name: 'swarm-orchestration',
      description: 'Multi-agent swarm coordination for complex tasks.',
      triggers: ['3+ files need changes', 'new features', 'refactoring'],
      skipWhen: ['single file edits', 'simple fixes', 'documentation'],
      commands: [
        {
          name: 'Initialize Swarm',
          description: 'Start a new swarm with hierarchical topology',
          command: 'npx @claude-flow/cli swarm init --topology hierarchical --max-agents 8',
        },
        {
          name: 'Route Task',
          description: 'Route a task to the appropriate agents',
          command: 'npx @claude-flow/cli hooks route --task "[task description]"',
        },
        {
          name: 'Monitor Status',
          description: 'Check the current swarm status',
          command: 'npx @claude-flow/cli swarm status',
        },
      ],
    },
    'memory-management': {
      name: 'memory-management',
      description: 'AgentDB memory system with HNSW vector search.',
      triggers: ['need to store patterns', 'search for solutions', 'semantic lookup'],
      skipWhen: ['no learning needed', 'ephemeral tasks'],
      commands: [
        {
          name: 'Store Data',
          description: 'Store a pattern in memory',
          command: 'npx @claude-flow/cli memory store --key "key" --value "value" --namespace patterns',
        },
        {
          name: 'Search Data',
          description: 'Semantic search in memory',
          command: 'npx @claude-flow/cli memory search --query "search terms" --limit 10',
        },
      ],
    },
    'sparc-methodology': {
      name: 'sparc-methodology',
      description: 'SPARC development workflow (Specification, Pseudocode, Architecture, Refinement, Completion).',
      triggers: ['new features', 'complex implementations', 'architectural changes'],
      skipWhen: ['simple fixes', 'documentation', 'configuration'],
      commands: [
        {
          name: 'Specification Phase',
          description: 'Define requirements and acceptance criteria',
          command: 'npx @claude-flow/cli hooks route --task "specification: [requirements]"',
        },
        {
          name: 'Architecture Phase',
          description: 'Design system structure',
          command: 'npx @claude-flow/cli hooks route --task "architecture: [design]"',
        },
      ],
    },
    'security-audit': {
      name: 'security-audit',
      description: 'Security scanning and vulnerability detection.',
      triggers: ['authentication', 'authorization', 'payment processing', 'user data'],
      skipWhen: ['read-only operations', 'internal tooling'],
      commands: [
        {
          name: 'Full Security Scan',
          description: 'Run comprehensive security analysis',
          command: 'npx @claude-flow/cli security scan --depth full',
        },
        {
          name: 'Input Validation Check',
          description: 'Check for input validation issues',
          command: 'npx @claude-flow/cli security scan --check input-validation',
        },
      ],
    },
    'performance-analysis': {
      name: 'performance-analysis',
      description: 'Performance profiling and optimization.',
      triggers: ['slow operations', 'memory issues', 'optimization needed'],
      skipWhen: ['feature development', 'documentation'],
      commands: [
        {
          name: 'Run Benchmark',
          description: 'Execute performance benchmarks',
          command: 'npx @claude-flow/cli performance benchmark --suite all',
        },
        {
          name: 'Profile Code',
          description: 'Profile code execution',
          command: 'npx @claude-flow/cli performance profile --target ./src',
        },
      ],
    },
    'github-automation': {
      name: 'github-automation',
      description: 'CI/CD and PR management automation.',
      triggers: ['PR creation', 'CI setup', 'release management'],
      skipWhen: ['local development', 'prototyping'],
      commands: [
        {
          name: 'Create PR',
          description: 'Create a pull request',
          command: 'gh pr create --title "title" --body "description"',
        },
        {
          name: 'Run CI',
          description: 'Trigger CI workflow',
          command: 'gh workflow run ci.yml',
        },
      ],
    },
  };

  const template = skillTemplates[skillName];
  if (!template) {
    throw new Error(`Unknown built-in skill: ${skillName}`);
  }

  const skillMd = await generateSkillMd(template);

  return {
    skillMd,
    scripts: {},
    references: {},
  };
}
