/**
 * @claude-flow/codex - AGENTS.md Generator
 *
 * Generates AGENTS.md files for OpenAI Codex CLI
 * Following the Agentic AI Foundation standard
 */

import type { AgentsMdOptions, AgentsMdTemplate } from '../types.js';
import { BUILT_IN_SKILLS } from '../templates/index.js';

/**
 * Generate an AGENTS.md file based on the provided options
 */
export async function generateAgentsMd(options: AgentsMdOptions): Promise<string> {
  const template = options.template ?? 'default';

  switch (template) {
    case 'minimal':
      return generateMinimal(options);
    case 'full':
      return generateFull(options);
    case 'enterprise':
      return generateEnterprise(options);
    case 'default':
    default:
      return generateDefault(options);
  }
}

/**
 * Generate minimal AGENTS.md template
 */
function generateMinimal(options: AgentsMdOptions): string {
  const {
    projectName,
    description = 'A Claude Flow powered project',
    buildCommand = 'npm run build',
    testCommand = 'npm test',
  } = options;

  return `# ${projectName}

> ${description}

## Quick Start

### Setup
\`\`\`bash
npm install && ${buildCommand}
\`\`\`

### Test
\`\`\`bash
${testCommand}
\`\`\`

## Agent Behavior

### Code Standards
- Keep files under 500 lines
- No hardcoded secrets or credentials
- Validate input at system boundaries
- Use typed interfaces for public APIs

### File Organization
- \`/src\` - Source code files
- \`/tests\` - Test files
- \`/docs\` - Documentation
- \`/config\` - Configuration files

## Skills

| Skill | Purpose |
|-------|---------|
| \`$swarm-orchestration\` | Multi-agent coordination for complex tasks |
| \`$memory-management\` | Pattern storage and semantic search |

## Security Rules

- NEVER commit .env files or secrets
- Always validate user inputs
- Prevent directory traversal attacks
- Use parameterized queries for databases
- Sanitize output to prevent XSS

## Links

- Documentation: https://github.com/ruvnet/claude-flow
`;
}

/**
 * Generate default AGENTS.md template
 */
function generateDefault(options: AgentsMdOptions): string {
  const {
    projectName,
    description = 'A Claude Flow powered project',
    techStack = 'TypeScript, Node.js',
    buildCommand = 'npm run build',
    testCommand = 'npm test',
    devCommand = 'npm run dev',
    skills = ['swarm-orchestration', 'memory-management', 'sparc-methodology', 'security-audit'],
  } = options;

  const skillsTable = skills
    .map((skill) => {
      const info = BUILT_IN_SKILLS[skill as keyof typeof BUILT_IN_SKILLS];
      return info
        ? `| \`$${skill}\` | ${info.description} |`
        : `| \`$${skill}\` | Custom skill |`;
    })
    .join('\n');

  return `# ${projectName}

> Multi-agent orchestration framework for agentic coding

## Project Overview

${description}

**Tech Stack**: ${techStack}
**Architecture**: Domain-Driven Design with bounded contexts

## Quick Start

### Installation
\`\`\`bash
npm install
\`\`\`

### Build
\`\`\`bash
${buildCommand}
\`\`\`

### Test
\`\`\`bash
${testCommand}
\`\`\`

### Development
\`\`\`bash
${devCommand}
\`\`\`

## Agent Coordination

### Swarm Configuration

This project uses hierarchical swarm coordination for complex tasks:

| Setting | Value | Purpose |
|---------|-------|---------|
| Topology | \`hierarchical\` | Queen-led coordination (anti-drift) |
| Max Agents | 8 | Optimal team size |
| Strategy | \`specialized\` | Clear role boundaries |
| Consensus | \`raft\` | Leader-based consistency |

### When to Use Swarms

**Invoke swarm for:**
- Multi-file changes (3+ files)
- New feature implementation
- Cross-module refactoring
- API changes with tests
- Security-related changes
- Performance optimization

**Skip swarm for:**
- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes

### Available Skills

Use \`$skill-name\` syntax to invoke:

| Skill | Use Case |
|-------|----------|
${skillsTable}

### Agent Types

| Type | Role | Use Case |
|------|------|----------|
| \`researcher\` | Requirements analysis | Understanding scope |
| \`architect\` | System design | Planning structure |
| \`coder\` | Implementation | Writing code |
| \`tester\` | Test creation | Quality assurance |
| \`reviewer\` | Code review | Security and quality |

## Code Standards

### File Organization
- **NEVER** save to root folder
- \`/src\` - Source code files
- \`/tests\` - Test files
- \`/docs\` - Documentation
- \`/config\` - Configuration files

### Quality Rules
- Files under 500 lines
- No hardcoded secrets
- Input validation at boundaries
- Typed interfaces for public APIs
- TDD London School (mock-first) preferred

### Commit Messages
\`\`\`
<type>(<scope>): <description>

[optional body]

Co-Authored-By: claude-flow <ruv@ruv.net>
\`\`\`

Types: \`feat\`, \`fix\`, \`docs\`, \`style\`, \`refactor\`, \`perf\`, \`test\`, \`chore\`

## Security

### Critical Rules
- NEVER commit secrets, credentials, or .env files
- NEVER hardcode API keys
- Always validate user input
- Use parameterized queries for SQL
- Sanitize output to prevent XSS

### Path Security
- Validate all file paths
- Prevent directory traversal (../)
- Use absolute paths internally

## Memory System

### Storing Patterns
\`\`\`bash
npx @claude-flow/cli memory store \\
  --key "pattern-name" \\
  --value "pattern description" \\
  --namespace patterns
\`\`\`

### Searching Memory
\`\`\`bash
npx @claude-flow/cli memory search \\
  --query "search terms" \\
  --namespace patterns
\`\`\`

## Links

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
`;
}

/**
 * Generate full AGENTS.md template with all sections
 */
function generateFull(options: AgentsMdOptions): string {
  const base = generateDefault(options);

  const additionalSections = `
## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| HNSW Search | 150x-12,500x faster | Vector operations |
| Memory Reduction | 50-75% | Int8 quantization |
| MCP Response | <100ms | API latency |
| CLI Startup | <500ms | Cold start |
| SONA Adaptation | <0.05ms | Neural learning |

## Testing

### Running Tests
\`\`\`bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Coverage
npm run test:coverage

# Security tests
npm run test:security
\`\`\`

### Test Philosophy
- TDD London School (mock-first)
- Unit tests for business logic
- Integration tests for boundaries
- E2E tests for critical paths
- Security tests for sensitive operations

### Coverage Requirements
- Minimum 80% line coverage
- 100% coverage for security-critical code
- All public APIs must have tests

## MCP Integration

Claude Flow exposes tools via Model Context Protocol:

\`\`\`bash
# Start MCP server
npx @claude-flow/cli mcp start

# List available tools
npx @claude-flow/cli mcp tools
\`\`\`

### Available Tools

| Tool | Purpose | Example |
|------|---------|---------|
| \`swarm_init\` | Initialize swarm coordination | \`swarm_init({topology: "hierarchical"})\` |
| \`agent_spawn\` | Spawn new agents | \`agent_spawn({type: "coder", name: "dev-1"})\` |
| \`memory_store\` | Store in AgentDB | \`memory_store({key: "pattern", value: "..."})\` |
| \`memory_search\` | Semantic search | \`memory_search({query: "auth patterns"})\` |
| \`task_orchestrate\` | Task coordination | \`task_orchestrate({task: "implement feature"})\` |
| \`neural_train\` | Train neural patterns | \`neural_train({iterations: 10})\` |
| \`benchmark_run\` | Performance benchmarks | \`benchmark_run({type: "all"})\` |

## Hooks System

Claude Flow uses hooks for lifecycle automation:

### Core Hooks

| Hook | Trigger | Purpose |
|------|---------|---------|
| \`pre-task\` | Before task starts | Get context, load patterns |
| \`post-task\` | After task completes | Record completion, train |
| \`pre-edit\` | Before file changes | Validate, backup |
| \`post-edit\` | After file changes | Train patterns, verify |
| \`pre-command\` | Before shell commands | Security check |
| \`post-command\` | After shell commands | Log results |

### Session Hooks

| Hook | Purpose |
|------|---------|
| \`session-start\` | Initialize context, load memory |
| \`session-end\` | Export metrics, consolidate memory |
| \`session-restore\` | Resume from checkpoint |
| \`notify\` | Send notifications |

### Intelligence Hooks

| Hook | Purpose |
|------|---------|
| \`route\` | Route task to appropriate agents |
| \`explain\` | Generate explanations |
| \`pretrain\` | Pre-train neural patterns |
| \`build-agents\` | Build specialized agents |
| \`transfer\` | Transfer learning between domains |

### Example Usage
\`\`\`bash
# Before starting a task
npx @claude-flow/cli hooks pre-task \\
  --description "implementing authentication"

# After completing a task
npx @claude-flow/cli hooks post-task \\
  --task-id "task-123" \\
  --success true

# Route a task to agents
npx @claude-flow/cli hooks route \\
  --task "implement OAuth2 login flow"
\`\`\`

## Background Workers

12 background workers provide continuous optimization:

| Worker | Priority | Purpose |
|--------|----------|---------|
| \`ultralearn\` | normal | Deep knowledge acquisition |
| \`optimize\` | high | Performance optimization |
| \`consolidate\` | low | Memory consolidation |
| \`predict\` | normal | Predictive preloading |
| \`audit\` | critical | Security analysis |
| \`map\` | normal | Codebase mapping |
| \`preload\` | low | Resource preloading |
| \`deepdive\` | normal | Deep code analysis |
| \`document\` | normal | Auto-documentation |
| \`refactor\` | normal | Refactoring suggestions |
| \`benchmark\` | normal | Performance benchmarking |
| \`testgaps\` | normal | Test coverage analysis |

### Managing Workers
\`\`\`bash
# List workers
npx @claude-flow/cli hooks worker list

# Trigger specific worker
npx @claude-flow/cli hooks worker dispatch --trigger audit

# Check worker status
npx @claude-flow/cli hooks worker status
\`\`\`

## Intelligence System

The RuVector Intelligence System provides neural learning:

### Components
- **SONA**: Self-Optimizing Neural Architecture (<0.05ms adaptation)
- **MoE**: Mixture of Experts for specialized routing
- **HNSW**: Hierarchical Navigable Small World for fast search
- **EWC++**: Elastic Weight Consolidation (prevents forgetting)
- **Flash Attention**: Optimized attention mechanism

### 4-Step Pipeline
1. **RETRIEVE** - Fetch relevant patterns via HNSW
2. **JUDGE** - Evaluate with verdicts (success/failure)
3. **DISTILL** - Extract key learnings via LoRA
4. **CONSOLIDATE** - Prevent catastrophic forgetting via EWC++

## Debugging

### Log Levels
\`\`\`bash
# Set log level
export CLAUDE_FLOW_LOG_LEVEL=debug

# Enable verbose mode
npx @claude-flow/cli --verbose <command>
\`\`\`

### Health Checks
\`\`\`bash
# Run diagnostics
npx @claude-flow/cli doctor --fix

# Check system status
npx @claude-flow/cli status
\`\`\`
`;

  return base + additionalSections;
}

/**
 * Generate enterprise AGENTS.md template with governance
 */
function generateEnterprise(options: AgentsMdOptions): string {
  const full = generateFull(options);

  const enterpriseSections = `
## Governance

### Approval Workflow
All significant changes require:
1. Code review by designated reviewer
2. Security scan passing
3. Test coverage > 80%
4. Documentation update

### Audit Trail
All agent actions are logged to:
- \`/logs/agent-actions.log\`
- Central audit system (if configured)

### Compliance
- SOC2 compatible logging
- GDPR data handling patterns
- PCI-DSS security controls (if applicable)

## Incident Response

### On Security Issue
1. Immediately stop affected agents
2. Isolate compromised resources
3. Document timeline
4. Notify security team

### On Production Bug
1. Roll back if safe
2. Document reproduction steps
3. Create hotfix branch
4. Deploy with expedited review
`;

  return full + enterpriseSections;
}
