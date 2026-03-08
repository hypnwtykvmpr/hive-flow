# memory-search

Search through stored memory.

## Usage
```bash
npx hive-flow memory search [options]
```

## Options
- `--query <text>` - Search query
- `--pattern <regex>` - Pattern matching
- `--limit <n>` - Result limit

## Examples
```bash
# Search memory
npx hive-flow memory search --query "authentication"

# Pattern search
npx hive-flow memory search --pattern "api-.*"

# Limited results
npx hive-flow memory search --query "config" --limit 10
```
