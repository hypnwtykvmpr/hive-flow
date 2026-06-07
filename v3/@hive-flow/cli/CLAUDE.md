# Claude Code Configuration - Hive Flow CLI

## Scope
This file contains CLI-specific guidance for `@hive-flow/cli`.

For shared behavior and general agent workflow (task complexity rules, swarm protocol details, file organization rules, and broad agent guidance), use the root `CLAUDE.md`.

## Execution Model (CLI + Claude Code)
- CLI coordinates state and routing.
- Claude Code tools execute work (Task, file edits, Bash, tests).
- For complex tasks: run CLI coordination first, then spawn all Task agents in the same response with `run_in_background: true`, then wait for results.
- After task completion, do not run manual learning hooks unless explicitly needed; background systems already handle normal learning flow.

## Anti-Drift Swarm Init
Use these defaults when initializing swarms from CLI:

```bash
# 6-8 agents
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 8 --strategy specialized

# 10-15 agents
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical-mesh --max-agents 15 --strategy specialized
```

Common topologies:
- `hierarchical` (tight coordinator control)
- `hierarchical-mesh` (hybrid queen + peer)
- `mesh`, `ring`, `star`, `hybrid`

## V3 CLI Commands (26 Commands, 140+ Subcommands)

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 4 | Project initialization with wizard, presets, skills, hooks |
| `agent` | 8 | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm` | 6 | Multi-agent swarm coordination and orchestration |
| `memory` | 11 | AgentDB memory with vector search (fast HNSW-indexed) |
| `mcp` | 9 | MCP server management and tool execution |
| `task` | 6 | Task creation, assignment, and lifecycle |
| `session` | 7 | Session state management and persistence |
| `config` | 7 | Configuration management and provider setup |
| `status` | 3 | System status monitoring with watch mode |
| `workflow` | 6 | Workflow execution and template management |
| `hooks` | 17 | Self-learning hooks + 12 background workers |
| `hive-mind` | 6 | Queen-led Byzantine fault-tolerant consensus |

### Advanced Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `daemon` | 5 | Background worker daemon (start, stop, status, trigger, enable) |
| `neural` | 5 | Neural pattern training (train, status, patterns, predict, optimize) |
| `security` | 6 | Security scanning (scan, audit, cve, threats, validate, report) |
| `performance` | 5 | Performance profiling (benchmark, profile, metrics, optimize, report) |
| `providers` | 5 | AI providers (list, add, remove, test, configure) |
| `plugins` | 5 | Plugin management (list, install, uninstall, enable, disable) |
| `deployment` | 5 | Deployment management (deploy, rollback, status, environments, release) |
| `embeddings` | 4 | Vector embeddings (embed, batch, search, init) |
| `claims` | 4 | Claims-based authorization (check, grant, revoke, list) |
| `migrate` | 5 | V2 to V3 migration with rollback support |
| `doctor` | 1 | System diagnostics with health checks |
| `completions` | 4 | Shell completions (bash, zsh, fish, powershell) |

## Quick CLI Examples

```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js init --wizard
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js daemon start
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --v3-mode
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "authentication patterns"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js doctor --fix
```

## Hooks System (27 Hooks + 12 Workers)

### Hook Groups

| Group | Hooks |
|------|-------|
| Edit lifecycle | `pre-edit`, `post-edit` |
| Command lifecycle | `pre-command`, `post-command`, `pre-bash`, `post-bash` |
| Task/session lifecycle | `pre-task`, `post-task`, `session-start`, `session-end`, `session-restore` |
| Routing/intelligence | `route`, `route-task`, `explain`, `intelligence`, `metrics`, `progress` |
| Agent and model prep | `pretrain`, `build-agents`, `transfer` |
| Utilities | `list`, `worker`, `statusline`, `coverage-route`, `coverage-suggest`, `coverage-gaps` |

Use `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks list --format table` for full hook detail.

### Background Workers
`ultralearn`, `optimize`, `consolidate`, `predict`, `audit`, `map`, `preload`, `deepdive`, `document`, `refactor`, `benchmark`, `testgaps`

### Essential Hook Commands

```bash
# Core lifecycle
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks pre-task --description "[task]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks post-task --task-id "[id]" --success true
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks post-edit --file "[file]" --train-neural true

# Session
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-start --session-id "[id]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-end --export-metrics true
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-restore --session-id "[id]"

# Routing/intelligence
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks route --task "[task]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks explain --topic "[topic]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks pretrain --model-type moe --epochs 10

# Worker and coverage operations
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks worker list
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks worker dispatch --trigger audit
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks coverage-gaps --format table
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks coverage-route --task "[task]"

# Statusline
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks statusline
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks statusline --json
```

## Migration (V2 to V3)

```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js migrate status
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js migrate run --backup
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js migrate rollback
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js migrate validate
```

## Quick Setup

```bash
# Add MCP servers (stdin-piped mode auto-detected)
claude mcp add hive-flow -- node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/mcp-server.js
claude mcp add hive-flow -- hive-flow mcp start
claude mcp add flow-nexus -- flow-nexus mcp start

# Start services and verify
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js daemon start
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js doctor --fix
```

## Memory Commands Reference

```bash
# Store (required: --key, --value; optional: --namespace, --ttl, --tags)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "pattern-auth" --value "JWT with refresh tokens" --namespace patterns

# Search (required: --query; optional: --namespace, --limit, --threshold)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "authentication patterns" --namespace patterns --limit 5

# List (optional: --namespace, --limit)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory list --namespace patterns --limit 10

# Retrieve (required: --key; optional: --namespace)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory retrieve --key "pattern-auth" --namespace patterns

# Initialize
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory init --force --verbose
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
Run `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js doctor` to validate:
- Node.js and npm versions
- Git and TypeScript availability
- Config validity
- Daemon and memory DB status
- API keys and MCP server setup
- Disk space

## References
- Full generated capabilities: `.hive-flow/CAPABILITIES.md`

CLI coordinates; Claude Code executes.
