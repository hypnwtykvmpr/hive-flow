# topology-optimize

Optimize swarm topology for current workload.

## Usage
```bash
hive-flow optimization topology-optimize [options]
```

## Options
- `--analyze-first` - Analyze before optimizing
- `--target <metric>` - Optimization target
- `--apply` - Apply optimizations

## Examples
```bash
# Analyze and suggest
hive-flow optimization topology-optimize --analyze-first

# Optimize for speed
hive-flow optimization topology-optimize --target speed

# Apply changes
hive-flow optimization topology-optimize --target efficiency --apply
```
