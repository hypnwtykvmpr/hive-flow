# workflow-create

Create reusable workflow templates.

## Usage
```bash
hive-flow workflow create [options]
```

## Options
- `--name <name>` - Workflow name
- `--from-history` - Create from history
- `--interactive` - Interactive creation

## Examples
```bash
# Create workflow
hive-flow workflow create --name "deploy-api"

# From history
hive-flow workflow create --name "test-suite" --from-history

# Interactive mode
hive-flow workflow create --interactive
```
