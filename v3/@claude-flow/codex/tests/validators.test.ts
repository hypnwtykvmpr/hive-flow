/**
 * @claude-flow/codex - Validator Tests
 *
 * Tests for AGENTS.md, SKILL.md, and config.toml validators
 */

import { describe, it, expect } from 'vitest';
import {
  validateAgentsMd,
  validateSkillMd,
  validateConfigToml,
} from '../src/validators/index.js';

// =============================================================================
// AGENTS.md Validator Tests
// =============================================================================

describe('validateAgentsMd', () => {
  describe('valid AGENTS.md files', () => {
    it('should pass for a well-formed AGENTS.md', async () => {
      const content = `# My Project

> Project description

## Setup

\`\`\`bash
npm install
\`\`\`

## Code Standards

- Keep files under 500 lines
- Use typed interfaces

## Security

- NEVER commit secrets
- Validate all inputs

## Skills

| Skill | Purpose |
|-------|---------|
| \`$swarm-orchestration\` | Multi-agent coordination |
`;

      const result = await validateAgentsMd(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass with multiple code blocks', async () => {
      const content = `# Project

## Setup

\`\`\`bash
npm install
\`\`\`

## Code Standards

\`\`\`typescript
const x = 1;
\`\`\`

## Security

\`\`\`yaml
security: enabled
\`\`\`

Skills: $memory-management
`;

      const result = await validateAgentsMd(content);

      expect(result.valid).toBe(true);
    });
  });

  describe('invalid AGENTS.md files', () => {
    it('should fail when file does not start with heading', async () => {
      const content = `This is not a heading

## Setup

Some content`;

      const result = await validateAgentsMd(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.message).toContain('level-1 heading');
      expect(result.errors[0]!.line).toBe(1);
    });

    it('should detect hardcoded API keys', async () => {
      const content = `# Project

## Setup

api_key: "sk-1234567890abcdefghijklmnopqrstuvwxyz1234"

## Code Standards

Nothing here
`;

      const result = await validateAgentsMd(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('secret'))).toBe(true);
    });

    it('should detect hardcoded passwords', async () => {
      const content = `# Project

## Setup

password: "mysecretpassword"

## Code Standards

Standard rules
`;

      const result = await validateAgentsMd(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('secret'))).toBe(true);
    });

    it('should detect hardcoded API key patterns', async () => {
      const content = `# Project

## Setup

API_KEY = "mykey123456"

## Code Standards

Rules here
`;

      const result = await validateAgentsMd(content);

      expect(result.valid).toBe(false);
    });
  });

  describe('warnings', () => {
    it('should warn about missing Setup section', async () => {
      const content = `# Project

## Code Standards

Rules

## Security

Security rules

$skill-name here
`;

      const result = await validateAgentsMd(content);

      expect(result.warnings.some(w => w.message.includes('Setup'))).toBe(true);
    });

    it('should warn about missing Code Standards section', async () => {
      const content = `# Project

## Setup

npm install

## Security

No secrets

$skill-name
`;

      const result = await validateAgentsMd(content);

      expect(result.warnings.some(w => w.message.includes('Code Standards'))).toBe(true);
    });

    it('should warn about missing Security section', async () => {
      const content = `# Project

## Setup

npm install

## Code Standards

Rules here

$skill-name
`;

      const result = await validateAgentsMd(content);

      expect(result.warnings.some(w => w.message.includes('Security'))).toBe(true);
    });

    it('should warn when no skill references found', async () => {
      const content = `# Project

## Setup

npm install

## Code Standards

Rules

## Security

No secrets allowed
`;

      const result = await validateAgentsMd(content);

      expect(result.warnings.some(w => w.message.includes('skill references'))).toBe(true);
    });

    it('should warn when few code examples', async () => {
      const content = `# Project

## Setup

npm install (no code block)

## Code Standards

Rules here

## Security

Security rules

$some-skill
`;

      const result = await validateAgentsMd(content);

      expect(result.warnings.some(w => w.message.includes('code examples'))).toBe(true);
    });

    it('should provide suggestions for warnings', async () => {
      const content = `# Project

Description

$skill-name

\`\`\`bash
npm install
\`\`\`

\`\`\`bash
npm test
\`\`\`
`;

      const result = await validateAgentsMd(content);

      for (const warning of result.warnings) {
        expect(warning).toHaveProperty('suggestion');
      }
    });
  });
});

// =============================================================================
// SKILL.md Validator Tests
// =============================================================================

describe('validateSkillMd', () => {
  describe('valid SKILL.md files', () => {
    it('should pass for a well-formed SKILL.md', async () => {
      const content = `---
name: my-skill
description: >
  This is a description of my skill.
  Use when: complex tasks.
---

# My Skill Skill

## Purpose

This skill does something useful.

## When to Trigger

- Complex tasks
- Multi-file changes
`;

      const result = await validateSkillMd(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass with minimal valid structure', async () => {
      const content = `---
name: minimal-skill
description: >
  Minimal skill
---

# Minimal Skill

## Purpose

Does something

## When to Trigger

- Always
`;

      const result = await validateSkillMd(content);

      expect(result.valid).toBe(true);
    });
  });

  describe('invalid SKILL.md files', () => {
    it('should fail when frontmatter is missing', async () => {
      const content = `# My Skill

## Purpose

This skill does something.
`;

      const result = await validateSkillMd(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('frontmatter'))).toBe(true);
    });

    it('should fail when frontmatter is not closed', async () => {
      const content = `---
name: broken-skill
description: >
  This skill is broken

# Broken Skill

## Purpose

Missing closing frontmatter
`;

      const result = await validateSkillMd(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('not properly closed'))).toBe(true);
    });

    it('should fail when name is missing in frontmatter', async () => {
      const content = `---
description: >
  Skill without name
---

# Skill

## Purpose

Something
`;

      const result = await validateSkillMd(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('name'))).toBe(true);
    });

    it('should fail when description is missing in frontmatter', async () => {
      const content = `---
name: no-description-skill
---

# No Description Skill

## Purpose

Something
`;

      const result = await validateSkillMd(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('description'))).toBe(true);
    });
  });

  describe('warnings', () => {
    it('should warn about missing Purpose section', async () => {
      const content = `---
name: no-purpose
description: >
  Skill without purpose section
---

# No Purpose Skill

## When to Trigger

- Always
`;

      const result = await validateSkillMd(content);

      expect(result.warnings.some(w => w.message.includes('Purpose'))).toBe(true);
    });

    it('should warn about missing trigger conditions', async () => {
      const content = `---
name: no-triggers
description: >
  Skill without trigger conditions
---

# No Triggers Skill

## Purpose

Does something
`;

      const result = await validateSkillMd(content);

      expect(result.warnings.some(w => w.message.includes('trigger'))).toBe(true);
    });

    it('should not warn when "When to Use" section exists', async () => {
      const content = `---
name: when-to-use
description: >
  Skill with When to Use
---

# When To Use Skill

## Purpose

Does something

## When to Use

- For complex tasks
`;

      const result = await validateSkillMd(content);

      expect(result.warnings.every(w => !w.message.includes('trigger'))).toBe(true);
    });

    it('should provide suggestions for warnings', async () => {
      const content = `---
name: warning-skill
description: >
  Skill with warnings
---

# Warning Skill

Content without required sections
`;

      const result = await validateSkillMd(content);

      for (const warning of result.warnings) {
        expect(warning).toHaveProperty('suggestion');
      }
    });
  });
});

// =============================================================================
// config.toml Validator Tests
// =============================================================================

describe('validateConfigToml', () => {
  describe('valid config.toml files', () => {
    it('should pass for a complete config.toml', async () => {
      const content = `# Codex Configuration

model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.claude-flow]
command = "npx"
args = ["-y", "@claude-flow/cli@latest"]
enabled = true

[profiles.dev]
approval_policy = "never"
sandbox_mode = "danger-full-access"
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass with minimal required fields', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.claude-flow]
command = "npx"
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(true);
    });

    it('should pass with all valid approval policies', async () => {
      const policies = ['untrusted', 'on-failure', 'on-request', 'never'];

      for (const policy of policies) {
        const content = `model = "gpt-5.3-codex"
approval_policy = "${policy}"
sandbox_mode = "workspace-write"

[mcp_servers.test]
command = "test"
`;

        const result = await validateConfigToml(content);
        expect(result.valid).toBe(true);
      }
    });

    it('should pass with all valid sandbox modes', async () => {
      const modes = ['read-only', 'workspace-write', 'danger-full-access'];

      for (const mode of modes) {
        const content = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "${mode}"

[mcp_servers.test]
command = "test"
`;

        const result = await validateConfigToml(content);
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('invalid config.toml files', () => {
    it('should fail when model is missing', async () => {
      const content = `approval_policy = "on-request"
sandbox_mode = "workspace-write"
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('model'))).toBe(true);
    });

    it('should fail when approval_policy is missing', async () => {
      const content = `model = "gpt-5.3-codex"
sandbox_mode = "workspace-write"
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('approval_policy'))).toBe(true);
    });

    it('should fail when sandbox_mode is missing', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "on-request"
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('sandbox_mode'))).toBe(true);
    });

    it('should fail with invalid approval_policy value', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "invalid-policy"
sandbox_mode = "workspace-write"
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid approval_policy'))).toBe(true);
    });

    it('should fail with invalid sandbox_mode value', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "invalid-mode"
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid sandbox_mode'))).toBe(true);
    });
  });

  describe('warnings', () => {
    it('should warn when no MCP servers configured', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
`;

      const result = await validateConfigToml(content);

      expect(result.warnings.some(w => w.message.includes('MCP servers'))).toBe(true);
    });

    it('should warn about never approval policy without profiles', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "never"
sandbox_mode = "workspace-write"

[mcp_servers.test]
command = "test"
`;

      const result = await validateConfigToml(content);

      expect(result.warnings.some(w =>
        w.message.includes('"never" approval policy')
      )).toBe(true);
    });

    it('should not warn about never policy when profiles exist', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "never"
sandbox_mode = "workspace-write"

[mcp_servers.test]
command = "test"

[profiles.dev]
approval_policy = "never"
`;

      const result = await validateConfigToml(content);

      expect(result.warnings.every(w =>
        !w.message.includes('"never" approval policy')
      )).toBe(true);
    });

    it('should warn about danger-full-access without profiles', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "danger-full-access"

[mcp_servers.test]
command = "test"
`;

      const result = await validateConfigToml(content);

      expect(result.warnings.some(w =>
        w.message.includes('danger-full-access')
      )).toBe(true);
    });

    it('should not warn about danger-full-access when profiles exist', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "danger-full-access"

[mcp_servers.test]
command = "test"

[profiles.dev]
sandbox_mode = "danger-full-access"
`;

      const result = await validateConfigToml(content);

      expect(result.warnings.every(w =>
        !w.message.includes('danger-full-access')
      )).toBe(true);
    });

    it('should provide suggestions for all warnings', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "never"
sandbox_mode = "danger-full-access"
`;

      const result = await validateConfigToml(content);

      for (const warning of result.warnings) {
        expect(warning).toHaveProperty('suggestion');
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty content', async () => {
      const content = '';

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle content with only comments', async () => {
      const content = `# This is a comment
# Another comment
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(false);
    });

    it('should handle multiline values', async () => {
      const content = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.test]
command = "test"
`;

      const result = await validateConfigToml(content);

      expect(result.valid).toBe(true);
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('validator integration', () => {
  it('should validate content from generators', async () => {
    // This simulates validating generator output
    const agentsMd = `# Test Project

> A test project

## Setup

\`\`\`bash
npm install
\`\`\`

## Code Standards

- Clean code
- Typed APIs

## Security

- No secrets
- Validate inputs

$swarm-orchestration
\`\`\`
npm test
\`\`\`
`;

    const skillMd = `---
name: test-skill
description: >
  A test skill for testing.
---

# Test Skill Skill

## Purpose

Testing purposes

## When to Trigger

- Tests needed
`;

    const configToml = `model = "gpt-5.3-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.claude-flow]
command = "npx"
args = ["-y", "@claude-flow/cli@latest"]
`;

    const agentsResult = await validateAgentsMd(agentsMd);
    const skillResult = await validateSkillMd(skillMd);
    const configResult = await validateConfigToml(configToml);

    expect(agentsResult.valid).toBe(true);
    expect(skillResult.valid).toBe(true);
    expect(configResult.valid).toBe(true);
  });
});
