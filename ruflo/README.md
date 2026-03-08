# HiveFlow

Enterprise AI agent orchestration platform. Deploy 60+ specialized agents in coordinated swarms with self-learning, fault-tolerant consensus, vector memory, and MCP integration.

## Install

```bash
# Quick start
npx hiveflow init --wizard

# Global install
npm install -g hiveflow

# Add as MCP server
claude mcp add hiveflow -- npx -y hiveflow mcp start
```

## Usage

```bash
hiveflow init --wizard          # Initialize project
hiveflow agent spawn -t coder   # Spawn an agent
hiveflow swarm init             # Start a swarm
hiveflow memory search -q "..."  # Search vector memory
hiveflow doctor                 # System diagnostics
```

## Acknowledgments

Forked from [claude-flow](https://github.com/ruvnet/claude-flow) by [RuvNet](https://github.com/ruvnet).

## License

MIT
