# RuvFlow

Enterprise AI agent orchestration platform. Deploy 60+ specialized agents in coordinated swarms with self-learning, fault-tolerant consensus, vector memory, and MCP integration.

**RuvFlow** is the new name for [claude-flow](https://www.npmjs.com/package/claude-flow). Both packages are fully supported.

## Install

```bash
# Quick start
npx ruvflow@latest init --wizard

# Global install
npm install -g ruvflow

# Add as MCP server
claude mcp add ruvflow -- npx -y ruvflow@latest mcp start
```

## Usage

```bash
ruvflow init --wizard          # Initialize project
ruvflow agent spawn -t coder   # Spawn an agent
ruvflow swarm init             # Start a swarm
ruvflow memory search -q "..."  # Search vector memory
ruvflow doctor                 # System diagnostics
```

## Relationship to claude-flow

| Package | npm | CLI Command |
|---------|-----|-------------|
| `ruvflow` | [npmjs.com/package/ruvflow](https://www.npmjs.com/package/ruvflow) | `ruvflow` |
| `claude-flow` | [npmjs.com/package/claude-flow](https://www.npmjs.com/package/claude-flow) | `claude-flow` |

Both packages use `@claude-flow/cli` under the hood. Choose whichever you prefer.

## Documentation

Full documentation: [github.com/ruvnet/claude-flow](https://github.com/ruvnet/claude-flow)

## License

MIT
