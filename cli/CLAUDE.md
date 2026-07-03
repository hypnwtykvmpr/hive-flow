# Claude Code Configuration - Hive Flow CLI

## Scope
This file contains CLI-specific guidance for `@hive-flow/cli`.

For shared behavior and general agent workflow (task complexity rules, swarm protocol details, file organization rules, and broad agent guidance), use the root `CLAUDE.md`.

## Execution Model (CLI + Claude Code)
- CLI coordinates state and routing.
- Hive Flow provider agents execute delegated work whenever they have the required tools and permissions.
- Claude Code tools execute direct operator work (file edits, Bash, tests) only when the main Claude operator is the assigned worker or Hive Flow agents are genuinely blocked.
- Claude native Task agents are forbidden when Hive Flow provider agents can complete the same task. If native Task is used, record the concrete Hive Flow blocker or explicit human instruction.
- For complex tasks: run CLI coordination first, then spawn queen-led Hive Flow hives or provider agents in one coordinated step, then wait for results without tight polling.
- After task completion, do not run manual learning hooks unless explicitly needed; background systems already handle normal learning flow.

## Anti-Drift Swarm Init
Use these defaults when initializing swarms from CLI:

```bash
# 6-8 agents
node cli/bin/cli.js swarm init --topology hierarchical --max-agents 8 --strategy specialized

# 10-15 agents
node cli/bin/cli.js swarm init --topology hierarchical-mesh --max-agents 15 --strategy specialized
```

Common topologies:
- `hierarchical` (tight coordinator control)
- `hierarchical-mesh` (hybrid queen + peer)
- `mesh`, `ring`, `star`, `hybrid`

## V3 CLI Commands (37 Commands, 269 Subcommands)

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 5 | Project initialization with wizard, check, skills, hooks, upgrade |
| `agent` | 8 | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm` | 6 | Multi-agent swarm coordination and orchestration |
| `memory` | 12 | HiveMemory memory with vector search where available |
| `mcp` | 10 | MCP server management and tool execution |
| `task` | 6 | Task creation, assignment, and lifecycle |
| `session` | 8 | Session state management and persistence |
| `config` | 8 | Configuration management and provider setup |
| `status` | 3 | System status monitoring with watch mode |
| `workflow` | 6 | Workflow execution and template management |
| `hooks` | 35 | Hook CLI subcommands + 10 configured workers |
| `hive-mind` | 11 | Queen-led Byzantine fault-tolerant consensus |

### Advanced Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `daemon` | 5 | Background worker daemon (start, stop, status, trigger, enable) |
| `neural` | 9 | Deterministic local pattern utilities (not runtime neural-model training) |
| `security` | 6 | Security scanning (scan, audit, cve, threats, validate, report) |
| `performance` | 5 | Performance profiling (benchmark, profile, metrics, optimize, report) |
| `providers` | 5 | AI providers (list, add, remove, test, configure) |
| `plugins` | 9 | Plugin management (list, search, install, uninstall, upgrade, toggle, info, create, rate) |
| `deployment` | 6 | Deployment management (deploy, status, rollback, history, environments, logs) |
| `embeddings` | 15 | Vector embeddings (init, generate, search, compare, collections, index, providers, chunk, normalize, hyperbolic, neural, models, cache, warmup, benchmark) |
| `claims` | 6 | Claims-based authorization (list, check, grant, revoke, roles, policies) |
| `migrate` | 5 | V2 to V3 migration with rollback support |
| `doctor` | 0 | System diagnostics with health checks |
| `completions` | 4 | Shell completions (bash, zsh, fish, powershell) |

## Quick CLI Examples

```bash
node cli/bin/cli.js init wizard
node cli/bin/cli.js daemon start
node cli/bin/cli.js swarm init --v3-mode
node cli/bin/cli.js memory search --query "authentication patterns"
node cli/bin/cli.js doctor --fix
```

## Hooks System (35 CLI Hook Subcommands + 10 Configured Workers)

### Hook Groups

| Group | Hooks |
|------|-------|
| Edit lifecycle | `pre-edit`, `post-edit` |
| Command lifecycle | `pre-command`, `post-command`, `pre-bash`, `post-bash` |
| Task/session lifecycle | `pre-task`, `post-task`, `session-start`, `session-end`, `session-restore` |
| Routing/intelligence | `route`, `route-task`, `explain`, `intelligence`, `metrics`, `progress` |
| Agent and model prep | `pretrain`, `build-agents`, `transfer` |
| Utilities | `list`, `worker`, `statusline`, `coverage-route`, `coverage-suggest`, `coverage-gaps` |

Use `node cli/bin/cli.js hooks list --format table` for full hook detail.

### Worker Shortcuts
`ultralearn`, `optimize`, `consolidate`, `predict`, `audit`, `map`, `preload`, `deepdive`, `document`, `refactor`, `benchmark`, `testgaps`

The hooks runtime has 10 configured worker entries; the CLI exposes these 12 user-facing worker shortcuts.

### Essential Hook Commands

```bash
# Core lifecycle
node cli/bin/cli.js hooks pre-task --description "[task]"
node cli/bin/cli.js hooks post-task --task-id "[id]" --success true
node cli/bin/cli.js hooks post-edit --file "[file]" --train-neural true

# Session
node cli/bin/cli.js hooks session-start --session-id "[id]"
node cli/bin/cli.js hooks session-end --export-metrics true
node cli/bin/cli.js hooks session-restore --session-id "[id]"

# Routing/intelligence
node cli/bin/cli.js hooks route --task "[task]"
node cli/bin/cli.js hooks explain --topic "[topic]"
node cli/bin/cli.js hooks pretrain --model-type moe --epochs 10

# Worker and coverage operations
node cli/bin/cli.js hooks worker list
node cli/bin/cli.js hooks worker dispatch --trigger audit
node cli/bin/cli.js hooks coverage-gaps --format table
node cli/bin/cli.js hooks coverage-route --task "[task]"

# Statusline
node cli/bin/cli.js hooks statusline
node cli/bin/cli.js hooks statusline --json
```

## Migration (V2 to V3)

```bash
node cli/bin/cli.js migrate status
node cli/bin/cli.js migrate run --backup
node cli/bin/cli.js migrate rollback
node cli/bin/cli.js migrate validate
```

## Quick Setup

```bash
# Add MCP servers (stdin-piped mode auto-detected)
claude mcp add hive-flow -- node cli/bin/mcp-server.js
claude mcp add hive-flow -- hive-flow mcp start
claude mcp add flow-nexus -- flow-nexus mcp start

# Start services and verify
node cli/bin/cli.js daemon start
node cli/bin/cli.js doctor --fix
```

## Memory Commands Reference

```bash
# Store (required: --key, --value; optional: --namespace, --ttl, --tags)
node cli/bin/cli.js memory store --key "pattern-auth" --value "JWT with refresh tokens" --namespace patterns

# Search (required: --query; optional: --namespace, --limit, --threshold)
node cli/bin/cli.js memory search --query "authentication patterns" --namespace patterns --limit 5

# List (optional: --namespace, --limit)
node cli/bin/cli.js memory list --namespace patterns --limit 10

# Retrieve (required: --key; optional: --namespace)
node cli/bin/cli.js memory retrieve --key "pattern-auth" --namespace patterns

# Initialize
node cli/bin/cli.js memory init --force --verbose
```

## Environment Variables

```bash
# Configuration
HIVE_FLOW_CONFIG=./hive-flow.config.json
HIVE_FLOW_LOG_LEVEL=info

# Provider API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# MCP Server
HIVE_FLOW_MCP_PORT=3000
HIVE_FLOW_MCP_HOST=localhost
HIVE_FLOW_MCP_TRANSPORT=stdio

# Memory
HIVE_FLOW_MEMORY_BACKEND=hybrid
HIVE_FLOW_MEMORY_PATH=./data/memory
```

## Doctor Health Checks
Run `node cli/bin/cli.js doctor` to validate:
- Node.js and npm versions
- Git and TypeScript availability
- Config validity
- Daemon and memory DB status
- API keys and MCP server setup
- Disk space

## References
- Full generated capabilities: `.hive-flow/CAPABILITIES.md`

CLI coordinates; Hive Flow provider agents handle delegated execution; Claude Code executes only direct operator work or documented Hive Flow fallback cases.
