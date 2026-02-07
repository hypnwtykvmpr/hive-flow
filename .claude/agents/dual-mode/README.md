# Dual-Mode Agents (Claude Code + Codex)

Optional agent configurations for running Claude Code interactively alongside headless Codex workers.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CLAUDE CODE (Interactive)     CODEX (Headless Background)  │
│  ────────────────────────      ────────────────────────────  │
│  Direct conversation           claude -p "task" &            │
│  Real-time feedback            Parallel execution            │
│  Complex reasoning             Batch processing              │
│                                                              │
│  CLAUDE-FLOW (Shared Orchestrator)                           │
│  • MCP tools shared by both                                  │
│  • Vector memory persists across sessions                    │
│  • Patterns learned and reused                               │
└─────────────────────────────────────────────────────────────┘
```

## Available Agents

| Agent | File | Purpose |
|-------|------|---------|
| `codex-worker` | codex-worker.yaml | Headless background worker |
| `codex-coordinator` | codex-coordinator.yaml | Coordinates headless swarm |
| `dual-orchestrator` | dual-orchestrator.yaml | Claude+Codex coordination |

## Usage

### Spawn Headless Workers from Claude Code

```bash
# Spawn parallel Codex workers
claude -p "Implement feature X" --session-id task-1 &
claude -p "Write tests for X" --session-id task-2 &
claude -p "Document feature X" --session-id task-3 &
wait
```

### Coordinate via Shared Memory

```bash
# Initialize shared coordination
npx claude-flow swarm init --topology hierarchical

# Workers store results
npx claude-flow memory store --key "task-1-result" --value "..." --namespace results

# Interactive Claude Code reads results
npx claude-flow memory list --namespace results
```

## Installation

These agents are optional. To use them:

```bash
# Already included in .claude/agents/dual-mode/
# Reference in your workflows as needed
```
