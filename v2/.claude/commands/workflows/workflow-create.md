# workflow-create

Create reusable workflow templates.

## Usage
```bash
npx hive-flow workflow create [options]
```

## Options
- `--name <name>` - Workflow name
- `--from-history` - Create from history
- `--interactive` - Interactive creation

## Examples
```bash
# Create workflow
npx hive-flow workflow create --name "deploy-api"

# From history
npx hive-flow workflow create --name "test-suite" --from-history

# Interactive mode
npx hive-flow workflow create --interactive
```
