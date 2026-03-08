# Hive Flow

Enterprise AI agent orchestration platform. Deploy 60+ specialized agents in coordinated swarms with self-learning, fault-tolerant consensus, vector memory, and MCP integration.

## Install

```bash
# Quick start
npx hive-flow init --wizard

# Global install
npm install -g hive-flow

# Add as MCP server
claude mcp add hive-flow -- npx -y hive-flow mcp start
```

## Usage

```bash
hive-flow init --wizard          # Initialize project
hive-flow agent spawn -t coder   # Spawn an agent
hive-flow swarm init             # Start a swarm
hive-flow memory search -q "..."  # Search vector memory
hive-flow doctor                 # System diagnostics
```

## Acknowledgments

Forked from [hive-flow](https://github.com/ruvnet/hive-flow) by [RuvNet](https://github.com/ruvnet).

## License

MIT
