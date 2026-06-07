# swarm

Main swarm orchestration command for Hive Flow.

## Usage
```bash
hive-flow swarm <objective> [options]
```

## Options
- `--strategy <type>` - Execution strategy (research, development, analysis, testing)
- `--mode <type>` - Coordination mode (centralized, distributed, hierarchical, mesh)
- `--max-agents <n>` - Maximum number of agents (default: 5)
- `--claude` - Open Claude Code CLI with swarm prompt
- `--parallel` - Enable parallel execution

## Examples
```bash
# Basic swarm
hive-flow swarm "Build REST API"

# With strategy
hive-flow swarm "Research AI patterns" --strategy research

# Open in Claude Code
hive-flow swarm "Build API" --claude
```
