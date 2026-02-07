# @claude-flow/codex

OpenAI Codex CLI adapter for Claude Flow V3. Enables multi-agent orchestration for OpenAI Codex CLI following the [Agentic AI Foundation](https://agenticfoundation.org) standard.

## Features

- **AGENTS.md Generation** - Creates project instructions in Codex format
- **Skill Management** - 137+ skills with `$skill-name` invocation
- **Config Generation** - `.agents/config.toml` for Codex configuration
- **Dual Platform** - Supports both Claude Code and Codex simultaneously
- **Migration** - Convert CLAUDE.md to AGENTS.md format

## Installation

```bash
# Via claude-flow CLI (recommended)
npx claude-flow@alpha init --codex

# Or install package directly
npm install @claude-flow/codex
```

## Quick Start

### Using the CLI

```bash
# Initialize for Codex
npx claude-flow@alpha init --codex

# Full setup with all 137+ skills
npx claude-flow@alpha init --codex --full

# Dual mode (both Claude Code and Codex)
npx claude-flow@alpha init --dual
```

### Programmatic Usage

```typescript
import { CodexInitializer, initializeCodexProject } from '@claude-flow/codex';

// Quick initialization
const result = await initializeCodexProject('/path/to/project', {
  template: 'full',
  force: true,
  dual: false,
});

// Or use the class directly
const initializer = new CodexInitializer();
const result = await initializer.initialize({
  projectPath: '/path/to/project',
  template: 'enterprise',
  skills: ['swarm-orchestration', 'memory-management'],
  force: false,
  dual: true,
});
```

## Directory Structure

```
project/
├── AGENTS.md              # Main project instructions (Codex format)
├── .agents/
│   ├── config.toml        # Project configuration
│   ├── skills/            # 137+ skills
│   │   ├── swarm-orchestration/
│   │   │   └── SKILL.md
│   │   ├── memory-management/
│   │   │   └── SKILL.md
│   │   └── ...
│   └── README.md          # Directory documentation
├── .codex/
│   ├── config.toml        # Local overrides (gitignored)
│   └── AGENTS.override.md # Local instruction overrides
└── .claude-flow/
    ├── config.yaml        # Runtime configuration
    ├── data/              # Memory and cache
    └── logs/              # Log files
```

## Templates

| Template | Skills | Description |
|----------|--------|-------------|
| `minimal` | 2 | Core skills only |
| `default` | 4 | Standard setup |
| `full` | 137+ | All available skills |
| `enterprise` | 137+ | Full + governance |

## Platform Comparison

| Feature | Claude Code | OpenAI Codex |
|---------|-------------|--------------|
| Config File | CLAUDE.md | AGENTS.md |
| Skills Dir | .claude/skills/ | .agents/skills/ |
| Skill Syntax | `/skill-name` | `$skill-name` |
| Settings | settings.json | config.toml |
| Approval | 3 levels | 4 levels |

## Skill Invocation

In OpenAI Codex CLI, invoke skills with `$` prefix:

```
$swarm-orchestration
$memory-management
$sparc-methodology
$security-audit
$agent-coder
$agent-tester
```

## Configuration

### .agents/config.toml

```toml
# Model configuration
model = "gpt-4"

# Approval policy
approval_policy = "on-request"

# Sandbox mode
sandbox_mode = "workspace-write"

# Skills
[[skills]]
path = ".agents/skills/swarm-orchestration"
enabled = true

[[skills]]
path = ".agents/skills/memory-management"
enabled = true
```

### .codex/config.toml (Local)

```toml
# Local development overrides (gitignored)
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "live"
```

## API Reference

### CodexInitializer

```typescript
class CodexInitializer {
  async initialize(options: CodexInitOptions): Promise<CodexInitResult>;
  async dryRun(options: CodexInitOptions): Promise<string[]>;
}
```

### initializeCodexProject

```typescript
async function initializeCodexProject(
  projectPath: string,
  options?: Partial<CodexInitOptions>
): Promise<CodexInitResult>;
```

### Types

```typescript
interface CodexInitOptions {
  projectPath: string;
  template?: 'minimal' | 'default' | 'full' | 'enterprise';
  skills?: string[];
  force?: boolean;
  dual?: boolean;
}

interface CodexInitResult {
  success: boolean;
  filesCreated: string[];
  skillsGenerated: string[];
  warnings?: string[];
  errors?: string[];
}
```

## Migration

Convert an existing CLAUDE.md project to Codex format:

```typescript
import { migrate } from '@claude-flow/codex';

const result = await migrate({
  sourcePath: './CLAUDE.md',
  targetPath: './AGENTS.md',
  preserveComments: true,
  generateSkills: true,
});
```

## Related Packages

- [@claude-flow/cli](https://www.npmjs.com/package/@claude-flow/cli) - Main CLI
- [claude-flow](https://www.npmjs.com/package/claude-flow) - Umbrella package
- [@claude-flow/memory](https://www.npmjs.com/package/@claude-flow/memory) - AgentDB memory
- [@claude-flow/security](https://www.npmjs.com/package/@claude-flow/security) - Security module

## License

MIT

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
