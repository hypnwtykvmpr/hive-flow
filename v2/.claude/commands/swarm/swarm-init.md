# swarm-init

Initialize a new swarm with specified topology.

## Usage
```bash
npx hive-flow swarm init [options]
```

## Options
- `--topology <type>` - Swarm topology (mesh, hierarchical, ring, star)
- `--max-agents <n>` - Maximum agents
- `--strategy <type>` - Distribution strategy

## Examples
```bash
npx hive-flow swarm init --topology mesh
npx hive-flow swarm init --topology hierarchical --max-agents 8
```
