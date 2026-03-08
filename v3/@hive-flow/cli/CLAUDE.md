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
npx @hive-flow/cli swarm init --topology hierarchical --max-agents 8 --strategy specialized

# 10-15 agents
npx @hive-flow/cli swarm init --topology hierarchical-mesh --max-agents 15 --strategy specialized
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
| `memory` | 11 | AgentDB memory with vector search (150x-12,500x faster) |
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
npx @hive-flow/cli init --wizard
npx @hive-flow/cli daemon start
npx @hive-flow/cli swarm init --v3-mode
npx @hive-flow/cli memory search --query "authentication patterns"
npx @hive-flow/cli doctor --fix
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

Use `npx @hive-flow/cli hooks list --format table` for full hook detail.

### Background Workers
`ultralearn`, `optimize`, `consolidate`, `predict`, `audit`, `map`, `preload`, `deepdive`, `document`, `refactor`, `benchmark`, `testgaps`

### Essential Hook Commands

```bash
# Core lifecycle
npx @hive-flow/cli hooks pre-task --description "[task]"
npx @hive-flow/cli hooks post-task --task-id "[id]" --success true
npx @hive-flow/cli hooks post-edit --file "[file]" --train-neural true

# Session
npx @hive-flow/cli hooks session-start --session-id "[id]"
npx @hive-flow/cli hooks session-end --export-metrics true
npx @hive-flow/cli hooks session-restore --session-id "[id]"

# Routing/intelligence
npx @hive-flow/cli hooks route --task "[task]"
npx @hive-flow/cli hooks explain --topic "[topic]"
npx @hive-flow/cli hooks pretrain --model-type moe --epochs 10

# Worker and coverage operations
npx @hive-flow/cli hooks worker list
npx @hive-flow/cli hooks worker dispatch --trigger audit
npx @hive-flow/cli hooks coverage-gaps --format table
npx @hive-flow/cli hooks coverage-route --task "[task]"

# Statusline
npx @hive-flow/cli hooks statusline
npx @hive-flow/cli hooks statusline --json
```

## Migration (V2 to V3)

```bash
npx @hive-flow/cli migrate status
npx @hive-flow/cli migrate run --backup
npx @hive-flow/cli migrate rollback
npx @hive-flow/cli migrate validate
```

## Quick Setup

```bash
# Add MCP servers (stdin-piped mode auto-detected)
claude mcp add hive-flow -- npx -y @hive-flow/cli
claude mcp add ruv-swarm -- npx -y ruv-swarm mcp start
claude mcp add flow-nexus -- npx -y flow-nexus@latest mcp start

# Start services and verify
npx @hive-flow/cli daemon start
npx @hive-flow/cli doctor --fix
```

## Memory Commands Reference

```bash
# Store (required: --key, --value; optional: --namespace, --ttl, --tags)
npx @hive-flow/cli memory store --key "pattern-auth" --value "JWT with refresh tokens" --namespace patterns

# Search (required: --query; optional: --namespace, --limit, --threshold)
npx @hive-flow/cli memory search --query "authentication patterns" --namespace patterns --limit 5

# List (optional: --namespace, --limit)
npx @hive-flow/cli memory list --namespace patterns --limit 10

# Retrieve (required: --key; optional: --namespace)
npx @hive-flow/cli memory retrieve --key "pattern-auth" --namespace patterns

# Initialize
npx @hive-flow/cli memory init --force --verbose
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
Run `npx @hive-flow/cli doctor` to validate:
- Node.js and npm versions
- Git and TypeScript availability
- Config validity
- Daemon and memory DB status
- API keys and MCP server setup
- Disk space

## References
- Full generated capabilities: `.hive-flow/CAPABILITIES.md`
- Docs: https://github.com/hypnwtykvmpr/hive-flow
- Issues: https://github.com/hypnwtykvmpr/hive-flow/issues

CLI coordinates; Claude Code executes.
