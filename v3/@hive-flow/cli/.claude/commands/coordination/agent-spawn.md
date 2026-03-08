# agent-spawn

Spawn a new agent in the current swarm.

## Usage
```bash
npx hive-flow agent spawn [options]
```

## Options
- `--type <type>` - Agent type (coder, researcher, analyst, tester, coordinator)
- `--name <name>` - Custom agent name
- `--skills <list>` - Specific skills (comma-separated)

## Examples
```bash
# Spawn coder agent
npx hive-flow agent spawn --type coder

# With custom name
npx hive-flow agent spawn --type researcher --name "API Expert"

# With specific skills
npx hive-flow agent spawn --type coder --skills "python,fastapi,testing"
```
