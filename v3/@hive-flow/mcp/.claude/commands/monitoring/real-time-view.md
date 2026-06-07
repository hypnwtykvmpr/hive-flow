# real-time-view

Real-time view of swarm activity.

## Usage
```bash
hive-flow monitoring real-time-view [options]
```

## Options
- `--filter <type>` - Filter view
- `--highlight <pattern>` - Highlight pattern
- `--tail <n>` - Show last N events

## Examples
```bash
# Start real-time view
hive-flow monitoring real-time-view

# Filter errors
hive-flow monitoring real-time-view --filter errors

# Highlight pattern
hive-flow monitoring real-time-view --highlight "API"
```
