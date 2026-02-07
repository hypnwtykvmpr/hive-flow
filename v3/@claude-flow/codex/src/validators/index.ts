/**
 * @claude-flow/codex - Validators
 *
 * Validation functions for AGENTS.md, SKILL.md, and config.toml
 */

import type { ValidationResult, ValidationError, ValidationWarning } from '../types.js';

/**
 * Validate an AGENTS.md file
 */
export async function validateAgentsMd(content: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Check for required sections
  const requiredSections = ['## Setup', '## Code Standards', '## Security'];
  for (const section of requiredSections) {
    if (!content.includes(section)) {
      warnings.push({
        path: 'AGENTS.md',
        message: `Missing recommended section: ${section}`,
        suggestion: `Add a ${section} section for better agent guidance`,
      });
    }
  }

  // Check for title
  if (!content.startsWith('# ')) {
    errors.push({
      path: 'AGENTS.md',
      message: 'AGENTS.md should start with a level-1 heading',
      line: 1,
    });
  }

  // Check for hardcoded secrets patterns
  const secretPatterns = [
    /sk-[a-zA-Z0-9]{32,}/,
    /api[_-]?key\s*[:=]\s*["'][^"']+["']/i,
    /password\s*[:=]\s*["'][^"']+["']/i,
  ];

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of secretPatterns) {
      if (pattern.test(lines[i]!)) {
        errors.push({
          path: 'AGENTS.md',
          message: 'Potential hardcoded secret detected',
          line: i + 1,
        });
      }
    }
  }

  // Check for skill references
  const skillPattern = /\$([a-z-]+)/g;
  const skills = content.match(skillPattern);
  if (!skills || skills.length === 0) {
    warnings.push({
      path: 'AGENTS.md',
      message: 'No skill references found',
      suggestion: 'Add skill references using $skill-name syntax',
    });
  }

  // Check for code blocks
  const codeBlocks = content.match(/```/g);
  if (!codeBlocks || codeBlocks.length < 2) {
    warnings.push({
      path: 'AGENTS.md',
      message: 'Few or no code examples',
      suggestion: 'Add code examples for common operations',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a SKILL.md file
 */
export async function validateSkillMd(content: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Check for YAML frontmatter
  if (!content.startsWith('---')) {
    errors.push({
      path: 'SKILL.md',
      message: 'SKILL.md must start with YAML frontmatter (---)',
      line: 1,
    });
  } else {
    // Check frontmatter closes
    const secondDash = content.indexOf('---', 3);
    if (secondDash === -1) {
      errors.push({
        path: 'SKILL.md',
        message: 'YAML frontmatter not properly closed',
      });
    } else {
      // Validate frontmatter content
      const frontmatter = content.substring(3, secondDash);

      if (!frontmatter.includes('name:')) {
        errors.push({
          path: 'SKILL.md',
          message: 'Missing required field: name',
        });
      }

      if (!frontmatter.includes('description:')) {
        errors.push({
          path: 'SKILL.md',
          message: 'Missing required field: description',
        });
      }
    }
  }

  // Check for purpose section
  if (!content.includes('## Purpose')) {
    warnings.push({
      path: 'SKILL.md',
      message: 'Missing Purpose section',
      suggestion: 'Add a ## Purpose section to describe the skill',
    });
  }

  // Check for trigger conditions
  if (!content.includes('When to Trigger') && !content.includes('When to Use')) {
    warnings.push({
      path: 'SKILL.md',
      message: 'Missing trigger conditions',
      suggestion: 'Add a section describing when to trigger this skill',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a config.toml file
 */
export async function validateConfigToml(content: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Check for required fields
  const requiredFields = ['model', 'approval_policy', 'sandbox_mode'];
  for (const field of requiredFields) {
    if (!content.includes(`${field} =`)) {
      errors.push({
        path: 'config.toml',
        message: `Missing required field: ${field}`,
      });
    }
  }

  // Validate approval_policy value
  const approvalMatch = content.match(/approval_policy\s*=\s*"([^"]+)"/);
  if (approvalMatch) {
    const validPolicies = ['untrusted', 'on-failure', 'on-request', 'never'];
    if (!validPolicies.includes(approvalMatch[1]!)) {
      errors.push({
        path: 'config.toml',
        message: `Invalid approval_policy: ${approvalMatch[1]}`,
      });
    }
  }

  // Validate sandbox_mode value
  const sandboxMatch = content.match(/sandbox_mode\s*=\s*"([^"]+)"/);
  if (sandboxMatch) {
    const validModes = ['read-only', 'workspace-write', 'danger-full-access'];
    if (!validModes.includes(sandboxMatch[1]!)) {
      errors.push({
        path: 'config.toml',
        message: `Invalid sandbox_mode: ${sandboxMatch[1]}`,
      });
    }
  }

  // Check for MCP servers
  if (!content.includes('[mcp_servers')) {
    warnings.push({
      path: 'config.toml',
      message: 'No MCP servers configured',
      suggestion: 'Add [mcp_servers.claude-flow] for Claude Flow integration',
    });
  }

  // Check for dangerous settings in production
  if (content.includes('approval_policy = "never"') && !content.includes('[profiles.')) {
    warnings.push({
      path: 'config.toml',
      message: 'Using "never" approval policy without profiles',
      suggestion: 'Consider using profiles to restrict this to dev environment',
    });
  }

  if (content.includes('sandbox_mode = "danger-full-access"') && !content.includes('[profiles.')) {
    warnings.push({
      path: 'config.toml',
      message: 'Using "danger-full-access" sandbox mode',
      suggestion: 'Restrict this to dev profile using [profiles.dev]',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
