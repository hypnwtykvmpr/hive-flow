# token-usage

Analyze token usage patterns and optimize for efficiency.

## Usage
```bash
hive-flow analysis token-usage [options]
```

## Options
- `--period <time>` - Analysis period (1h, 24h, 7d, 30d)
- `--by-agent` - Break down by agent
- `--by-operation` - Break down by operation type

## Examples
```bash
# Last 24 hours token usage
hive-flow analysis token-usage --period 24h

# By agent breakdown
hive-flow analysis token-usage --by-agent

# Export detailed report
hive-flow analysis token-usage --period 7d --export tokens.csv
```
