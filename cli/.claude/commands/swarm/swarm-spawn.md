# swarm-spawn

Spawn agents in the swarm.

## Usage
```bash
hive-flow swarm spawn [options]
```

## Options
- `--type <type>` - Agent type
- `--count <n>` - Number to spawn
- `--capabilities <list>` - Agent capabilities

## Examples
```bash
hive-flow swarm spawn --type coder --count 3
hive-flow swarm spawn --type researcher --capabilities "web-search,analysis"
```
