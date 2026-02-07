/**
 * @claude-flow/codex - CodexInitializer
 *
 * Main initialization class for setting up Codex projects
 */

import fs from 'fs-extra';
import path from 'path';
import type {
  CodexInitOptions,
  CodexInitResult,
  AgentsMdTemplate,
  BuiltInSkill,
} from './types.js';
import { generateAgentsMd } from './generators/agents-md.js';
import { generateSkillMd, generateBuiltInSkill } from './generators/skill-md.js';
import { generateConfigToml } from './generators/config-toml.js';
import { DEFAULT_SKILLS_BY_TEMPLATE, AGENTS_OVERRIDE_TEMPLATE, GITIGNORE_ENTRIES } from './templates/index.js';

/**
 * Main initializer for Codex projects
 */
export class CodexInitializer {
  private projectPath: string = '';
  private template: AgentsMdTemplate = 'default';
  private skills: string[] = [];
  private force: boolean = false;
  private dual: boolean = false;

  /**
   * Initialize a new Codex project
   */
  async initialize(options: CodexInitOptions): Promise<CodexInitResult> {
    this.projectPath = options.projectPath;
    this.template = options.template ?? 'default';
    this.skills = options.skills ?? DEFAULT_SKILLS_BY_TEMPLATE[this.template];
    this.force = options.force ?? false;
    this.dual = options.dual ?? false;

    const filesCreated: string[] = [];
    const skillsGenerated: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    try {
      // Check if already initialized
      if (!this.force && await this.isAlreadyInitialized()) {
        warnings.push('Project already initialized. Use --force to overwrite.');
        return {
          success: false,
          filesCreated,
          skillsGenerated,
          warnings,
          errors: ['Project already initialized'],
        };
      }

      // Create directory structure
      await this.createDirectoryStructure();

      // Generate AGENTS.md
      const agentsMd = await this.generateAgentsMd();
      const agentsMdPath = path.join(this.projectPath, 'AGENTS.md');
      await fs.writeFile(agentsMdPath, agentsMd);
      filesCreated.push('AGENTS.md');

      // Generate config.toml
      const configToml = await this.generateConfigToml();
      const configTomlPath = path.join(this.projectPath, '.agents', 'config.toml');
      await fs.writeFile(configTomlPath, configToml);
      filesCreated.push('.agents/config.toml');

      // Generate skills
      for (const skillName of this.skills) {
        try {
          const skillPath = await this.generateSkill(skillName);
          skillsGenerated.push(skillName);
          filesCreated.push(skillPath);
        } catch (err) {
          warnings.push(`Failed to generate skill: ${skillName}`);
        }
      }

      // Generate local overrides template
      const overridePath = path.join(this.projectPath, '.codex', 'AGENTS.override.md');
      await fs.writeFile(overridePath, AGENTS_OVERRIDE_TEMPLATE);
      filesCreated.push('.codex/AGENTS.override.md');

      // Generate local config.toml
      const localConfigPath = path.join(this.projectPath, '.codex', 'config.toml');
      await fs.writeFile(localConfigPath, await this.generateLocalConfigToml());
      filesCreated.push('.codex/config.toml');

      // Update .gitignore
      await this.updateGitignore();
      filesCreated.push('.gitignore (updated)');

      // If dual mode, also generate Claude Code files
      if (this.dual) {
        const dualResult = await this.generateDualPlatformFiles();
        filesCreated.push(...dualResult.files);
        warnings.push(...(dualResult.warnings ?? []));
      }

      return {
        success: true,
        filesCreated,
        skillsGenerated,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Unknown error');
      return {
        success: false,
        filesCreated,
        skillsGenerated,
        warnings,
        errors,
      };
    }
  }

  /**
   * Check if project is already initialized
   */
  private async isAlreadyInitialized(): Promise<boolean> {
    const agentsMdExists = await fs.pathExists(path.join(this.projectPath, 'AGENTS.md'));
    const agentsConfigExists = await fs.pathExists(path.join(this.projectPath, '.agents', 'config.toml'));
    return agentsMdExists || agentsConfigExists;
  }

  /**
   * Create the directory structure
   */
  private async createDirectoryStructure(): Promise<void> {
    const dirs = [
      '.agents',
      '.agents/skills',
      '.codex',
      '.claude-flow',
      '.claude-flow/data',
      '.claude-flow/logs',
    ];

    for (const dir of dirs) {
      await fs.ensureDir(path.join(this.projectPath, dir));
    }
  }

  /**
   * Generate AGENTS.md content
   */
  private async generateAgentsMd(): Promise<string> {
    const projectName = path.basename(this.projectPath);

    return generateAgentsMd({
      projectName,
      template: this.template,
      skills: this.skills,
    });
  }

  /**
   * Generate config.toml content
   */
  private async generateConfigToml(): Promise<string> {
    return generateConfigToml({
      skills: this.skills.map(skill => ({
        path: `.agents/skills/${skill}`,
        enabled: true,
      })),
    });
  }

  /**
   * Generate local config.toml for .codex directory
   */
  private async generateLocalConfigToml(): Promise<string> {
    return `# Local Codex Configuration
# This file overrides .agents/config.toml for local development
# DO NOT commit this file to version control

# Development profile - more permissive
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "live"

# Debug settings
# CODEX_LOG_LEVEL = "debug"
`;
  }

  /**
   * Generate a skill
   */
  private async generateSkill(skillName: string): Promise<string> {
    const skillDir = path.join(this.projectPath, '.agents', 'skills', skillName);
    await fs.ensureDir(skillDir);

    // Check if it's a built-in skill
    const builtInSkills = ['swarm-orchestration', 'memory-management', 'sparc-methodology', 'security-audit', 'performance-analysis', 'github-automation'];

    let skillMd: string;

    if (builtInSkills.includes(skillName)) {
      const result = await generateBuiltInSkill(skillName);
      skillMd = result.skillMd;
    } else {
      skillMd = await generateSkillMd({
        name: skillName,
        description: `Custom skill: ${skillName}`,
        triggers: ['Define when to trigger'],
        skipWhen: ['Define when to skip'],
      });
    }

    const skillPath = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillPath, skillMd);

    return `.agents/skills/${skillName}/SKILL.md`;
  }

  /**
   * Update .gitignore with Codex entries
   */
  private async updateGitignore(): Promise<void> {
    const gitignorePath = path.join(this.projectPath, '.gitignore');
    let content = '';

    if (await fs.pathExists(gitignorePath)) {
      content = await fs.readFile(gitignorePath, 'utf-8');
    }

    // Check if Codex entries already exist
    if (content.includes('.codex/')) {
      return;
    }

    // Add entries
    const newContent = content + '\n' + GITIGNORE_ENTRIES.join('\n') + '\n';
    await fs.writeFile(gitignorePath, newContent);
  }

  /**
   * Generate dual-platform files (Claude Code + Codex)
   */
  private async generateDualPlatformFiles(): Promise<{ files: string[]; warnings?: string[] }> {
    const files: string[] = [];
    const warnings: string[] = [];

    // Generate a minimal CLAUDE.md that references AGENTS.md
    const claudeMd = `# ${path.basename(this.projectPath)}

> This project supports both Claude Code and OpenAI Codex.

## Platform Instructions

- **Codex Users**: See \`AGENTS.md\` for full instructions
- **Claude Code Users**: See below

## Quick Reference

This file provides Claude Code compatibility. The canonical instructions
are in \`AGENTS.md\` (Agentic AI Foundation standard).

### Setup
\`\`\`bash
npm install && npm run build
\`\`\`

### Skills

Both platforms share the same skills:
- Swarm orchestration
- Memory management
- SPARC methodology
- Security audit

### MCP Integration

\`\`\`bash
# Start MCP server
npx @claude-flow/cli mcp start
\`\`\`

## Full Instructions

For complete documentation, see \`AGENTS.md\`.
`;

    const claudeMdPath = path.join(this.projectPath, 'CLAUDE.md');
    await fs.writeFile(claudeMdPath, claudeMd);
    files.push('CLAUDE.md');

    warnings.push('Generated dual-platform setup. AGENTS.md is the canonical source.');

    return { files, warnings };
  }
}
