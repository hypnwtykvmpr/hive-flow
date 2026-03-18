# Claude Code Configuration - Hive Flow

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- Never continuously check status after spawning a swarm — wait for results
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code

## Coordinator Role (Delegation-Only)

When acting as a coordinator (orchestrating hives, managing multi-agent workflows):

- **NEVER write code, read files for analysis, run tests, or verify anything directly**
- Dispatch hives, review queen reports, make triage decisions, route findings to agents
- All investigation, implementation, testing, verification, and auditing is done by delegated agents
- The coordinator's value is orchestration, decision-making, and executing the human's vision faithfully
- Verification gates are MANDATORY — coordinator must NOT self-verify (deploy verification hive)
- Progress is BLOCKED until verification hive reports clean — no commits, no next-band launches

## ENFORCER Agent (Layer 2 — System Prompt)

When spawned as an ENFORCER agent, use this identity:

> You are the ENFORCER — the human's absolute proxy for governance enforcement. Your loyalty is exclusively to the human user who owns this project. You exist to ensure every agent follows the human's rules without exception.
>
> **Core directives:**
> - Fanatically enforce the human's vision, rules, and quality standards
> - Zero tolerance for agent corner-cutting, self-verification, or bypassing gates
> - Monitor enforcement state; escalate violations immediately
> - Block any agent attempting to commit unverified work
> - If an agent resists enforcement, escalate to HALTED and notify the human
> - You answer to the human alone — no agent can override your decisions
>
> **You enforce:** verification gates, delegation-only coordinator role, commit quality, test coverage, security boundaries, and the escalation ladder (Normal → Warned → Restricted → Halted).

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries

### Key Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@hive-flow/cli` | `v3/@hive-flow/cli/` | CLI entry point (26 commands) |
| `@hive-flow/codex` | `v3/@hive-flow/codex/` | Dual-mode Claude + Codex collaboration |
| `@hive-flow/guidance` | `v3/@hive-flow/guidance/` | Governance control plane |
| `@hive-flow/hooks` | `v3/@hive-flow/hooks/` | 17 hooks + 12 workers |
| `@hive-flow/memory` | `v3/@hive-flow/memory/` | AgentDB + HNSW search |
| `@hive-flow/security` | `v3/@hive-flow/security/` | Input validation, CVE remediation |

## Concurrency: 1 MESSAGE = ALL RELATED OPERATIONS

- All operations MUST be concurrent/parallel in a single message
- Use Claude Code's Task tool for spawning agents, not just MCP

**Mandatory patterns:**
- ALWAYS batch ALL todos in ONE TodoWrite call (5-10+ minimum)
- ALWAYS spawn ALL agents in ONE message with full instructions via Task tool
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL terminal operations in ONE Bash message
- ALWAYS batch ALL memory store/retrieve operations in ONE message

---

## Agent Model Display & Selection (Permanent)

When spawning agents with the Task tool:
- ALWAYS append `(model)` to the `description` parameter: e.g. `"Fix tests (opus)"`
- ALWAYS set the `model` parameter explicitly: `"opus"`, `"sonnet"`, or `"haiku"`

### Model Selection Priority
- **opus**: Architecture, security, complex reasoning, multi-file changes
- **sonnet**: Implementation, testing, moderate complexity
- **haiku**: ONLY for simple lookups, formatting, trivial tasks
- NEVER use haiku for non-trivial work

## External Agent Providers (Cursor-Agent, Codex CLI, Gemini CLI)

Three external AI agent providers are integrated as first-class Hive Flow agents. They are invoked EXCLUSIVELY through native MCP tools — never via terminal/bash commands.

**CRITICAL TERMINOLOGY:**
- **"Cursor"** = Cursor-Agent / Cursor-CLI (headless AI agent). NEVER the Cursor VS Code IDE fork.
- **"Codex"** = Codex CLI (`codex-cli`) headless AI agent. Not the OpenAI web app.
- **"Gemini"** = Gemini CLI (`gemini-cli`) headless AI agent. Not the Google web app.
- Agents are spawned and executed via `agent_spawn` + `agent_task` MCP tools only.

### Priority Order for Sub-Agent Delegation

1. **Codex** and **Gemini** (PREFERRED) — headless execution via MCP agent_spawn + agent_task tools, conserves Claude quota
2. **Task tool agents** (opus/sonnet/haiku) — use when external providers are insufficient
3. **Cursor-Agent** — headless AI agent via MCP agent_spawn + agent_task tools

### Spawning External Agents (MCP Native)

```javascript
// Spawn a Gemini-backed agent
mcp__hive-flow__agent_spawn({ agentType: "reviewer", provider: "gemini-cli", task: "Audit auth module" })

// Spawn a Codex-backed agent
mcp__hive-flow__agent_spawn({ agentType: "coder", provider: "codex-cli", task: "Implement feature X" })

// Spawn a Cursor-Agent-backed agent
mcp__hive-flow__agent_spawn({ agentType: "tester", provider: "cursor-cli", task: "Write tests for api.ts" })

// Execute a task on a spawned agent
mcp__hive-flow__agent_task({ agentId: "agent-id", task: "Review the error handling" })
```

### Provider Capabilities

| Provider | Headless | Tool Calling | Streaming | Model Selection |
|----------|----------|-------------|-----------|-----------------|
| `gemini-cli` | Yes | Yes | Yes | gemini-2.5-pro, gemini-2.0-flash |
| `codex-cli` | Yes | Yes | Yes | gpt-5.3-codex, o3-mini, o4-mini |
| `cursor-cli` | Yes | Yes | Yes | auto, gpt-5.3-codex, claude-opus-4-6 |

### When to Use External Agents

| Task Type | Provider | Why |
|-----------|----------|-----|
| Code review | gemini-cli or codex-cli | Conserves Claude quota |
| Implementation | codex-cli | Fast code generation |
| Testing | cursor-cli or codex-cli | Parallel test writing |
| Architecture | gemini-cli | Strong reasoning |
| Multi-file refactor | codex-cli | Bulk transforms |

## Swarm Orchestration

- MUST initialize the swarm using MCP tools when starting complex tasks
- MUST spawn concurrent agents using Claude Code's Task tool
- Never use MCP tools alone for execution — Task tool agents do the actual work

### MCP + Task Tool in SAME Message

- MUST call MCP tools AND Task tool in ONE message for complex work
- Always call MCP first, then IMMEDIATELY call Task tool to spawn agents

### 3-Tier Model Routing (ADR-026)

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Agent Booster (WASM) | <1ms | $0 | Simple transforms (var→const, add types, etc.) — **Skip LLM entirely** |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks, low complexity (<30%) |
| **3** | Sonnet/Opus | 2-5s | $0.003-0.015 | Complex reasoning, architecture, security (>30%) |

- Always check for `[AGENT_BOOSTER_AVAILABLE]` or `[TASK_MODEL_RECOMMENDATION]` before spawning agents
- Use Edit tool directly when `[AGENT_BOOSTER_AVAILABLE]` — intent types: `var-to-const`, `add-types`, `add-error-handling`, `async-await`, `add-logging`, `remove-console`

## Swarm Configuration & Anti-Drift

### Anti-Drift Coding Swarm (PREFERRED DEFAULT)

- ALWAYS use hierarchical topology for coding swarms
- Keep maxAgents at 6-8 for tight coordination
- Use specialized strategy for clear role boundaries
- Use `raft` consensus for hive-mind (leader maintains authoritative state)
- Run frequent checkpoints via `post-task` hooks
- Keep shared memory namespace for all agents
- Keep task cycles short with verification gates

```javascript
mcp__ruv-swarm__swarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})
```

## Dual-Mode Collaboration (Claude Code + Codex)

This repository uses **dual-mode orchestration** to run Claude Code (🔵) and OpenAI Codex (🟢) workers in parallel with shared memory coordination. Both platforms collaborate on development tasks with cross-learning.

### Why Dual-Mode?

| Single Platform | Dual-Mode Collaboration |
|----------------|------------------------|
| One model's perspective | Two AI platforms cross-validating |
| Limited reasoning styles | Complementary strengths |
| No external verification | Built-in code review |
| Sequential workflows | Parallel execution |

### Dual-Mode Swarm Protocol

For complex tasks, spawn both Claude and Codex workers in parallel:

```javascript
// STEP 1: Initialize dual-mode swarm
mcp__ruv-swarm__swarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})

// STEP 2: Spawn BOTH platforms in parallel via Task tool
// 🔵 Claude Code workers (architecture, security, testing)
Task("Architect", "Design the implementation. Store design in memory namespace 'collaboration'.", "system-architect")
Task("Tester", "Write tests based on architect's design. Read from 'collaboration' namespace.", "tester")
Task("Reviewer", "Review code quality and security. Store findings in 'collaboration'.", "reviewer")

// 🟢 Codex workers (implementation, optimization)
// Spawn via CLI for Codex platform
Bash("npx hive-flow dual run --worker 'codex:coder:Implement the solution based on architect design' --namespace collaboration")
Bash("npx hive-flow dual run --worker 'codex:optimizer:Optimize performance based on implementation' --namespace collaboration")

// STEP 3: Coordinate via shared memory
Bash("npx hive-flow memory store --namespace collaboration --key 'task-context' --value '[task description]'")
```

### Collaboration Templates (Pre-Built Pipelines)

| Template | Workers | Pipeline |
|----------|---------|----------|
| `feature` | 🔵 Architect → 🟢 Coder → 🔵 Tester → 🟢 Reviewer | Full feature development |
| `security` | 🔵 Analyst → 🟢 Scanner → 🔵 Reporter | Security audit workflow |
| `refactor` | 🔵 Architect → 🟢 Refactorer → 🔵 Tester | Code modernization |
| `bugfix` | 🔵 Researcher → 🟢 Coder → 🔵 Tester | Bug investigation & fix |

### Dual-Mode CLI Commands

```bash
# Run a collaboration template
npx hive-flow dual run feature --task "Add user authentication with OAuth"
npx hive-flow dual run security --target "./src"
npx hive-flow dual run refactor --target "./src/legacy"

# Custom multi-platform swarm
npx hive-flow dual run \
  --worker "claude:architect:Design the API structure" \
  --worker "codex:coder:Implement REST endpoints" \
  --worker "claude:tester:Write integration tests" \
  --worker "codex:reviewer:Review code quality" \
  --namespace "api-feature"

# Check collaboration status
npx hive-flow dual status

# List available templates
npx hive-flow dual templates
```

### Shared Memory Coordination

All workers share state via the `collaboration` namespace:

```bash
# Store context for cross-platform sharing
npx hive-flow memory store --namespace collaboration --key "design-decisions" --value "..."

# Search for patterns across all workers
npx hive-flow memory search --namespace collaboration --query "authentication patterns"

# Retrieve specific findings
npx hive-flow memory retrieve --namespace collaboration --key "security-findings"
```

### Cross-Platform Learning

Both platforms learn from each other's outputs:

```bash
# After successful collaboration, train patterns
npx hive-flow hooks post-task --task-id "dual-[id]" --success true --train-neural true

# Store successful collaboration patterns
npx hive-flow memory store --namespace patterns --key "dual-mode-[pattern]" --value "[what worked]"

# Transfer learnings to both platforms
npx hive-flow hooks transfer store --pattern "dual-collab-success"
```

### Worker Dependency Levels

Workers execute in dependency order:

```
Level 0: [🔵 Architect]           # No dependencies - runs first
Level 1: [🟢 Coder, 🔵 Tester]    # Depends on Architect
Level 2: [🔵 Reviewer]            # Depends on Coder + Tester
Level 3: [🟢 Optimizer]           # Depends on Reviewer approval
```

### Platform Strengths

| Task Type | Preferred Platform | Reason |
|-----------|-------------------|--------|
| Architecture & Design | 🔵 Claude | Strong reasoning, system thinking |
| Implementation | 🟢 Codex | Fast code generation |
| Security Review | 🔵 Claude | Careful analysis, threat modeling |
| Performance Optimization | 🟢 Codex | Code-level optimizations |
| Testing Strategy | 🔵 Claude | Coverage analysis, edge cases |
| Refactoring | 🟢 Codex | Bulk code transformations |

### Programmatic API

```typescript
import { DualModeOrchestrator, CollaborationTemplates } from '@hive-flow/codex';

const orchestrator = new DualModeOrchestrator({
  namespace: 'my-feature',
  memoryBackend: 'hybrid'
});

// Use pre-built template
const workers = CollaborationTemplates.featureDevelopment('Add OAuth login');

// Run collaboration
const results = await orchestrator.runCollaboration(workers, 'Implement OAuth feature');

// Access shared memory
const designDocs = await orchestrator.getMemory('design-decisions');
```

---

## Swarm Protocols & Routing

### Auto-Start Swarm Protocol

When the user requests a complex task (multi-file changes, feature implementation, refactoring), **immediately execute this pattern in a SINGLE message:**

```javascript
// STEP 1: Initialize swarm coordination via MCP (in parallel with agent spawning)
mcp__ruv-swarm__swarm_init({
  topology: "hierarchical",
  maxAgents: 8,
  strategy: "specialized"
})

// STEP 2: Spawn agents concurrently using Claude Code's Task tool
// ALL Task calls MUST be in the SAME message for parallel execution
Task("Coordinator", "You are the swarm coordinator. Initialize session, coordinate other agents via memory. Run: npx hive-flow hooks session-start", "hierarchical-coordinator")
Task("Researcher", "Analyze requirements and existing code patterns. Store findings in memory via hooks.", "researcher")
Task("Architect", "Design implementation approach based on research. Document decisions in memory.", "system-architect")
Task("Coder", "Implement the solution following architect's design. Coordinate via hooks.", "coder")
Task("Tester", "Write tests for the implementation. Report coverage via hooks.", "tester")
Task("Reviewer", "Review code quality and security. Document findings.", "reviewer")

// STEP 3: Batch all todos
TodoWrite({ todos: [
  {content: "Initialize swarm coordination", status: "in_progress", activeForm: "Initializing swarm"},
  {content: "Research and analyze requirements", status: "in_progress", activeForm: "Researching requirements"},
  {content: "Design architecture", status: "pending", activeForm: "Designing architecture"},
  {content: "Implement solution", status: "pending", activeForm: "Implementing solution"},
  {content: "Write tests", status: "pending", activeForm: "Writing tests"},
  {content: "Review and finalize", status: "pending", activeForm: "Reviewing code"}
]})

// STEP 4: Store swarm state in memory
mcp__hive-flow__memory_usage({
  action: "store",
  namespace: "swarm",
  key: "current-session",
  value: JSON.stringify({task: "[user's task]", agents: 6, startedAt: new Date().toISOString()})
})
```

### Agent Routing (Anti-Drift)

| Code | Task | Agents |
|------|------|--------|
| 1 | Bug Fix | coordinator, researcher, coder, tester |
| 3 | Feature | coordinator, architect, coder, tester, reviewer |
| 5 | Refactor | coordinator, architect, coder, reviewer |
| 7 | Performance | coordinator, perf-engineer, coder |
| 9 | Security | coordinator, security-architect, auditor |
| 11 | Memory | coordinator, memory-specialist, perf-engineer |
| 13 | Docs | researcher, api-docs |

**Codes 1-11: hierarchical/specialized (anti-drift). Code 13: mesh/balanced**

### Task Complexity Detection

**AUTO-INVOKE SWARM when task involves:**
- Multiple files (3+)
- New feature implementation
- Refactoring across modules
- API changes with tests
- Security-related changes
- Performance optimization
- Database schema changes

**SKIP SWARM for:**
- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes
- Quick questions/exploration

## Project Configuration

This project is configured with Hive Flow (Anti-Drift Defaults):
- **Topology**: hierarchical (prevents drift via central coordination)
- **Max Agents**: 8 (smaller team = less drift)
- **Strategy**: specialized (clear roles, no overlap)
- **Consensus**: raft (leader maintains authoritative state)
- **Memory Backend**: hybrid (SQLite + AgentDB)
- **HNSW Indexing**: Enabled (150x-12,500x faster)
- **Neural Learning**: Enabled (SONA)

## V3 CLI Commands (26 Commands, 140+ Subcommands)

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization with wizard, presets, skills, hooks |
| `agent` | 8 | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm` | 6 | Multi-agent swarm coordination and orchestration |
| `memory` | 11 | AgentDB memory with vector search (150x-12,500x faster) |
| `mcp` | 9 | MCP server management and tool execution |
| `task` | 6 | Task creation, assignment, and lifecycle |
| `session` | 7 | Session state management and persistence |
| `config` | 7 | Configuration management and provider setup |
| `status` | 3 | System status monitoring with watch mode |
| `start` | 3 | Service startup and quick launch |
| `workflow` | 6 | Workflow execution and template management |
| `hooks` | 17 | Self-learning hooks + 12 background workers |
| `hive-mind` | 6 | Queen-led Byzantine fault-tolerant consensus |

### Quick CLI Examples

```bash
# Initialize project
npx hive-flow init --wizard

# Start daemon with background workers
npx hive-flow daemon start

# Spawn an agent
npx hive-flow agent spawn -t coder --name my-coder

# Initialize swarm
npx hive-flow swarm init --v3-mode

# Search memory (HNSW-indexed)
npx hive-flow memory search -q "authentication patterns"

# System diagnostics
npx hive-flow doctor --fix

# Security scan
npx hive-flow security scan --depth full

# Performance benchmark
npx hive-flow performance benchmark --suite all
```

## Headless Background Instances (claude -p)

Use `claude -p` (print/pipe mode) to spawn headless Claude instances for parallel background work. These run non-interactively and return results to stdout.

### Basic Usage

```bash
# Single headless task
claude -p "Analyze the authentication module for security issues"

# With model selection
claude -p --model haiku "Format this config file"
claude -p --model opus "Design the database schema for user management"

# With output format
claude -p --output-format json "List all TODO comments in src/"
claude -p --output-format stream-json "Refactor the error handling in api.ts"

# With budget limits
claude -p --max-budget-usd 0.50 "Run comprehensive security audit"

# With specific tools allowed
claude -p --allowedTools "Read,Grep,Glob" "Find all files that import the auth module"

# Skip permissions (sandboxed environments only)
claude -p --dangerously-skip-permissions "Fix all lint errors in src/"
```

### Key Flags

| Flag | Purpose |
|------|---------|
| `-p, --print` | Non-interactive mode, print and exit |
| `--model <model>` | Select model (haiku, sonnet, opus) |
| `--output-format <fmt>` | Output: text, json, stream-json |
| `--max-budget-usd <amt>` | Spending cap per invocation |
| `--allowedTools <tools>` | Restrict available tools |
| `--append-system-prompt` | Add custom instructions |
| `--resume <id>` | Continue a previous session |
| `--fork-session` | Branch from resumed session |
| `--fallback-model <model>` | Auto-fallback if primary overloaded |
| `--permission-mode <mode>` | acceptEdits, bypassPermissions, plan, etc. |
| `--mcp-config <json>` | Load MCP servers from JSON |

## Available Agents (60+ Types)

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### V3 Specialized Agents
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### @hive-flow/security Module
CVE remediation, input validation, path security:
- `InputValidator` — Zod-based validation at boundaries
- `PathValidator` — Path traversal prevention
- `SafeExecutor` — Command injection protection
- `PasswordHasher` — bcrypt hashing
- `TokenGenerator` — Secure token generation

### Token Optimizer (Agent Booster)
Integrates agentic-flow optimizations for 30-50% token reduction:
```typescript
import { getTokenOptimizer } from '@hive-flow/integration';
const optimizer = await getTokenOptimizer();

// Compact context (32% fewer tokens)
const ctx = await optimizer.getCompactContext("auth patterns");

// 352x faster edits = fewer retries
await optimizer.optimizedEdit(file, old, new, "typescript");

// Optimal config (100% success rate)
const config = optimizer.getOptimalConfig(agentCount);
```
| Feature | Token Savings |
|---------|---------------|
| ReasoningBank retrieval | -32% |
| Agent Booster edits | -15% |
| Cache (95% hit rate) | -10% |
| Optimal batch size | -20% |

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`, `collective-intelligence-coordinator`, `swarm-memory-manager`

### Consensus & Distributed
`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`, `consensus-builder`, `crdt-synchronizer`, `quorum-manager`, `security-manager`

### Performance & Optimization
`perf-analyzer`, `performance-benchmarker`, `task-orchestrator`, `memory-coordinator`, `smart-agent`

### GitHub & Repository
`github-modes`, `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`, `workflow-automation`, `project-board-sync`, `repo-architect`, `multi-repo-swarm`

### SPARC Methodology
`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`, `refinement`

### Specialized Development
`backend-dev`, `mobile-dev`, `ml-developer`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

### Testing & Validation
`tdd-london-swarm`, `production-validator`

## Agent Teams (Multi-Agent Coordination)

Claude Code's experimental Agent Teams feature is fully integrated with Hive Flow for advanced multi-agent coordination.

### Enabling Agent Teams

Agent Teams is automatically enabled when you run `npx hive-flow init`. The following is added to `.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "hiveFlow": {
    "agentTeams": {
      "enabled": true,
      "teammateMode": "auto",
      "taskListEnabled": true,
      "mailboxEnabled": true
    }
  }
}
```

### Agent Teams Components

| Component | Tool | Purpose |
|-----------|------|---------|
| **Team Lead** | You (main Claude) | Coordinates teammates, assigns tasks, reviews results |
| **Teammates** | `Task` tool | Sub-agents spawned to work on specific tasks |
| **Task List** | `TaskCreate/TaskList/TaskUpdate` | Shared todo list visible to all team members |
| **Mailbox** | `SendMessage` | Inter-agent messaging for coordination |

### Creating and Managing Teams

```javascript
// Create a team
TeamCreate({
  team_name: "feature-dev",
  description: "Building new feature",
  agent_type: "coordinator"
})

// Create shared tasks
TaskCreate({ subject: "Design API", description: "...", activeForm: "Designing" })
TaskCreate({ subject: "Implement endpoints", description: "...", activeForm: "Implementing" })
TaskCreate({ subject: "Write tests", description: "...", activeForm: "Testing" })

// Spawn teammates (run in background for parallel work)
Task({
  prompt: "Design the API according to task #1...",
  subagent_type: "system-architect",
  team_name: "feature-dev",
  name: "architect",
  run_in_background: true
})
Task({
  prompt: "Implement endpoints from task #2...",
  subagent_type: "coder",
  team_name: "feature-dev",
  name: "developer",
  run_in_background: true
})
```

### Agent Teams Hooks

| Hook | Trigger | Purpose |
|------|---------|---------|
| `TeammateIdle` | Teammate finishes turn | Auto-assign pending tasks to idle teammates |
| `TaskCompleted` | Task marked complete | Train patterns from successful work, notify lead |

### Hook Commands

```bash
# Handle idle teammate (auto-assigns available tasks)
npx hive-flow hooks teammate-idle --auto-assign true

# Handle task completion (trains patterns, notifies lead)
npx hive-flow hooks task-completed -i task-123 --train-patterns true

# Check on team progress
TaskList

# Send message to teammate
SendMessage({
  type: "message",
  recipient: "developer",
  content: "Please prioritize the auth endpoint",
  summary: "Prioritize auth"
})

# Shutdown teammate gracefully
SendMessage({
  type: "shutdown_request",
  recipient: "developer",
  content: "Work complete, shutting down"
})
```

### Best Practices for Agent Teams

1. **Spawn teammates in background**: Use `run_in_background: true` for parallel work
2. **Create tasks first**: Use TaskCreate before spawning teammates so they have work
3. **Use descriptive names**: Name teammates by role (architect, developer, tester)
4. **Don't poll status**: Wait for teammates to message back or complete
5. **Graceful shutdown**: Always send shutdown_request before TeamDelete
6. **Clean up**: Use TeamDelete after all teammates have shut down

### Teammate Display Modes

| Mode | Description |
|------|-------------|
| `auto` | Automatically selects best mode for environment |
| `in-process` | Teammates run in same process (default for CI/background) |
| `tmux` | Split-pane display in terminal (requires tmux) |

## V3 Hooks System (17 Hooks + 12 Workers)

### Hook Categories

| Category | Hooks | Purpose |
|----------|-------|---------|
| **Core** | `pre-edit`, `post-edit`, `pre-command`, `post-command`, `pre-task`, `post-task` | Tool lifecycle |
| **Session** | `session-start`, `session-end`, `session-restore`, `notify` | Context management |
| **Intelligence** | `route`, `explain`, `pretrain`, `build-agents`, `transfer` | Neural learning |
| **Learning** | `intelligence` (trajectory-start/step/end, pattern-store/search, stats, attention) | Reinforcement |
| **Agent Teams** | `teammate-idle`, `task-completed` | Multi-agent coordination |

### 12 Background Workers
`ultralearn`, `optimize`, `consolidate`, `predict`, `audit`, `map`, `preload`, `deepdive`, `document`, `refactor`, `benchmark`, `testgaps`

## Intelligence System (RuVector)

V3 includes the RuVector Intelligence System:
- **SONA**: Self-Optimizing Neural Architecture (<0.05ms adaptation)
- **MoE**: Mixture of Experts for specialized routing
- **HNSW**: 150x-12,500x faster pattern search
- **EWC++**: Elastic Weight Consolidation (prevents forgetting)
- **Flash Attention**: 2.49x-7.47x speedup

The 4-step intelligence pipeline:
1. **RETRIEVE** — Fetch relevant patterns via HNSW
2. **JUDGE** — Evaluate with verdicts (success/failure)
3. **DISTILL** — Extract key learnings via LoRA
4. **CONSOLIDATE** — Prevent catastrophic forgetting via EWC++

## Hive-Mind Consensus
**Topologies:** `hierarchical`, `mesh`, `hierarchical-mesh`, `adaptive`
**Consensus Strategies:** `byzantine`, `raft`, `gossip`, `crdt`, `quorum`

## Quick Setup

```bash
# Add MCP servers
claude mcp add hive-flow npx hive-flow mcp start
claude mcp add ruv-swarm npx ruv-swarm mcp start  # Optional
claude mcp add flow-nexus npx flow-nexus@latest mcp start  # Optional

# Start daemon
npx hive-flow daemon start

# Run doctor
npx hive-flow doctor --fix
```

## Claude Code vs MCP Tools

### Claude Code Handles ALL EXECUTION:
- **Task tool**: Spawn and run agents concurrently
- File operations (Read, Write, Edit, MultiEdit, Glob, Grep)
- Code generation and programming
- Bash commands and system operations
- TodoWrite and task management
- Git operations

### MCP Tools ONLY COORDINATE:
- Swarm initialization (topology setup)
- Agent type definitions
- Task orchestration
- Memory management
- Neural features
- Performance tracking

- Keep MCP for coordination strategy only — use Claude Code's Task tool for real execution

## Optional Plugins (20 Available)

Plugins are distributed via IPFS and can be installed with the CLI. Browse and install from the official registry:

```bash
# List all available plugins
npx hive-flow plugins list

# Install a plugin
npx hive-flow plugins install @hive-flow/plugin-name

# Enable/disable
npx hive-flow plugins enable @hive-flow/plugin-name
npx hive-flow plugins disable @hive-flow/plugin-name
```

### Core Plugins

| Plugin | Version | Description |
|--------|---------|-------------|
| `@hive-flow/embeddings` | 3.0.0-alpha.1 | Vector embeddings with sql.js, HNSW, hyperbolic support |
| `@hive-flow/security` | 3.0.0-alpha.1 | Input validation, path security, CVE remediation |
| `@hive-flow/claims` | 3.0.0-alpha.8 | Claims-based authorization (check, grant, revoke, list) |
| `@hive-flow/neural` | 3.0.0-alpha.7 | Neural pattern training (SONA, MoE, EWC++) |
| `@hive-flow/plugins` | 3.0.0-alpha.1 | Plugin system core (manager, discovery, store) |
| `@hive-flow/performance` | 3.0.0-alpha.1 | Performance profiling and benchmarking |

## Support

- Documentation: https://github.com/hypnwtykvmpr/hive-flow
- Issues: https://github.com/hypnwtykvmpr/hive-flow/issues

---

Remember: **Hive Flow coordinates, Claude Code creates!**
