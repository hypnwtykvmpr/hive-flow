# swarm-monitor

Real-time swarm monitoring.

## Usage
```bash
npx hive-flow swarm monitor [options]
```

## Options
- `--interval <ms>` - Update interval
- `--metrics` - Show detailed metrics
- `--export` - Export monitoring data

## Examples
```bash
# Start monitoring
npx hive-flow swarm monitor

# Custom interval
npx hive-flow swarm monitor --interval 5000

# With metrics
npx hive-flow swarm monitor --metrics
```
