# swarm-init

Initialize a new swarm with specified topology.

## Usage
```bash
hive-flow swarm init [options]
```

## Options
- `--topology <type>` - Swarm topology (mesh, hierarchical, ring, star)
- `--max-agents <n>` - Maximum agents
- `--strategy <type>` - Distribution strategy

## Examples
```bash
hive-flow swarm init --topology mesh
hive-flow swarm init --topology hierarchical --max-agents 8
```
