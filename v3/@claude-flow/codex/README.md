# @claude-flow/codex

OpenAI Codex CLI adapter for Claude Flow V3. Enables multi-agent orchestration with **self-learning capabilities** for OpenAI Codex CLI following the [Agentic AI Foundation](https://agenticfoundation.org) standard.

## Key Concept: Execution Model

```
┌─────────────────────────────────────────────────────────────────┐
│  CLAUDE-FLOW = ORCHESTRATOR (tracks state, stores memory)       │
│  CODEX = EXECUTOR (writes code, runs commands, implements)      │
└─────────────────────────────────────────────────────────────────┘
```

**Codex does the work. Claude-flow coordinates and learns.**

## Features

- **AGENTS.md Generation** - Creates project instructions for Codex
- **MCP Integration** - Self-learning via memory and vector search
- **137+ Skills** - Invoke with `$skill-name` syntax
- **Vector Memory** - Semantic pattern search (384-dim embeddings)
- **Dual Platform** - Supports both Claude Code and Codex
- **Auto-Registration** - MCP server registered during init

## Installation

```bash
# Via claude-flow CLI (recommended)
npx claude-flow@alpha init --codex

# Full setup with all 137+ skills
npx claude-flow@alpha init --codex --full

# Dual mode (both Claude Code and Codex)
npx claude-flow@alpha init --dual
```

## MCP Integration (Self-Learning)

When you run `init --codex`, the MCP server is **automatically registered** with Codex:

```bash
# Verify MCP is registered
codex mcp list

# Expected:
# Name         Command  Args                   Status
# claude-flow  npx      claude-flow mcp start  enabled

# If not present, add manually:
codex mcp add claude-flow -- npx claude-flow mcp start
```

### MCP Tools for Learning

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `memory_search` | Semantic vector search | BEFORE starting any task |
| `memory_store` | Save patterns with embeddings | AFTER completing successfully |
| `swarm_init` | Initialize coordination | Start of complex tasks |
| `agent_spawn` | Register agent roles | Multi-agent workflows |
| `neural_train` | Train on patterns | Periodic improvement |

## Self-Learning Workflow

```
1. LEARN:   memory_search(query="task keywords") → Find similar patterns
2. COORD:   swarm_init(topology="hierarchical") → Set up coordination
3. EXECUTE: YOU write code, run commands       → Codex does real work
4. REMEMBER: memory_store(key, value, namespace="patterns") → Save for future
```

### Example Prompt for Codex

```
Build an email validator using a learning-enabled swarm.

STEP 1 - LEARN (use MCP tool):
Use tool: memory_search
  query: "validation utility function patterns"
  namespace: "patterns"
If score > 0.7, use that pattern as reference.

STEP 2 - COORDINATE (use MCP tools):
Use tool: swarm_init with topology="hierarchical", maxAgents=3
Use tool: agent_spawn with type="coder", name="validator"

STEP 3 - EXECUTE (YOU do this):
Create /tmp/validator/email.js with validateEmail() function
Create /tmp/validator/test.js with test cases
Run the tests

STEP 4 - REMEMBER (use MCP tool):
Use tool: memory_store
  key: "pattern-email-validator"
  value: "Email validation: regex, returns boolean, test cases"
  namespace: "patterns"

YOU execute all code. Use MCP tools for learning.
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

| Template | Skills | Learning | Description |
|----------|--------|----------|-------------|
| `minimal` | 2 | Basic | Core skills only |
| `default` | 4 | Yes | Standard setup |
| `full` | 137+ | Yes | All available skills |
| `enterprise` | 137+ | Advanced | Full + governance |

## Platform Comparison

| Feature | Claude Code | OpenAI Codex |
|---------|-------------|--------------|
| Config File | CLAUDE.md | AGENTS.md |
| Skills Dir | .claude/skills/ | .agents/skills/ |
| Skill Syntax | `/skill-name` | `$skill-name` |
| Settings | settings.json | config.toml |
| MCP | Native | Via `codex mcp add` |

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

# MCP Servers
[mcp_servers.claude-flow]
command = "npx"
args = ["claude-flow", "mcp", "start"]
enabled = true

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
  mcpRegistered?: boolean;
  warnings?: string[];
  errors?: string[];
}
```

## Programmatic Usage

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

console.log(`MCP registered: ${result.mcpRegistered}`);
console.log(`Skills created: ${result.skillsGenerated.length}`);
```

## Vector Search Details

- **Embedding Dimensions**: 384
- **Search Algorithm**: HNSW (150x-12,500x faster)
- **Similarity Scoring**: 0-1 (higher = better match)
  - Score > 0.7: Strong match, use pattern
  - Score 0.5-0.7: Partial match, adapt
  - Score < 0.5: Weak match, create new

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
- [@claude-flow/memory](https://www.npmjs.com/package/@claude-flow/memory) - AgentDB memory with vector search
- [@claude-flow/security](https://www.npmjs.com/package/@claude-flow/security) - Security module

## License

MIT

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
