---
name: stop
description: Stop a running agent
aliases: [kill]
type: command
---

# Agent Stop Command

Stop a running agent with graceful or forced shutdown options.

## Usage

```bash
hive-flow agent stop <agent-id> [options]
hive-flow agent kill <agent-id> [options]  # Alias
```

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--force` | `-f` | Force stop without graceful shutdown | false |
| `--timeout` | | Graceful shutdown timeout in seconds | 30 |

## Examples

```bash
# Graceful stop (completes current task)
hive-flow agent stop coder-lx7m9k2

# Force stop (immediate termination)
hive-flow agent stop coder-lx7m9k2 --force

# Custom shutdown timeout
hive-flow agent stop coder-lx7m9k2 --timeout 60

# Using kill alias
hive-flow agent kill researcher-abc123 -f
```

## Graceful vs Force Stop

### Graceful Shutdown (Default)
1. Completes current task
2. Saves agent state to memory
3. Releases resources cleanly
4. Notifies swarm coordinator

```bash
hive-flow agent stop coder-lx7m9k2

# Output:
# Stopping agent coder-lx7m9k2...
#   Completing current task...
#   Saving state...
#   Releasing resources...
# Agent coder-lx7m9k2 stopped successfully
```

### Force Stop
1. Immediate termination
2. No state preservation
3. May leave tasks incomplete

```bash
hive-flow agent stop coder-lx7m9k2 --force

# Output:
# Stopping agent coder-lx7m9k2...
# Agent coder-lx7m9k2 stopped successfully
```

## Interactive Confirmation

Without `--force`, you'll be prompted to confirm:

```
? Are you sure you want to stop agent coder-lx7m9k2? (y/N)
```

## Batch Operations

To stop multiple agents:

```bash
# Stop all agents of a type
hive-flow agent list -t coder --format json | \
  jq -r '.agents[].id' | \
  xargs -I {} hive-flow agent stop {} -f

# Stop all idle agents
hive-flow agent list -s idle --format json | \
  jq -r '.agents[].id' | \
  xargs -I {} hive-flow agent stop {}
```

## Related Commands

- `hive-flow agent list` - Find agent IDs
- `hive-flow agent status` - Check status before stopping
- `hive-flow swarm destroy` - Stop all agents in swarm
