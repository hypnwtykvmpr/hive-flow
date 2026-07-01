# swarm-monitor

Real-time swarm monitoring.

## Usage
```bash
hive-flow swarm monitor [options]
```

## Options
- `--interval <ms>` - Update interval
- `--metrics` - Show detailed metrics
- `--export` - Export monitoring data

## Examples
```bash
# Start monitoring
hive-flow swarm monitor

# Custom interval
hive-flow swarm monitor --interval 5000

# With metrics
hive-flow swarm monitor --metrics
```
