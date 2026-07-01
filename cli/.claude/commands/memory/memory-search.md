# memory-search

Search through stored memory.

## Usage
```bash
hive-flow memory search [options]
```

## Options
- `--query <text>` - Search query
- `--pattern <regex>` - Pattern matching
- `--limit <n>` - Result limit

## Examples
```bash
# Search memory
hive-flow memory search --query "authentication"

# Pattern search
hive-flow memory search --pattern "api-.*"

# Limited results
hive-flow memory search --query "config" --limit 10
```
