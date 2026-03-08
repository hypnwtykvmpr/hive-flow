# workflow-export

Export workflows for sharing.

## Usage
```bash
npx hive-flow workflow export [options]
```

## Options
- `--name <name>` - Workflow to export
- `--format <type>` - Export format
- `--include-history` - Include execution history

## Examples
```bash
# Export workflow
npx hive-flow workflow export --name "deploy-api"

# As YAML
npx hive-flow workflow export --name "test-suite" --format yaml

# With history
npx hive-flow workflow export --name "deploy-api" --include-history
```
