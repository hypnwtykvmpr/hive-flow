# workflow-execute

Execute saved workflows.

## Usage
```bash
hive-flow workflow execute [options]
```

## Options
- `--name <name>` - Workflow name
- `--params <json>` - Workflow parameters
- `--dry-run` - Preview execution

## Examples
```bash
# Execute workflow
hive-flow workflow execute --name "deploy-api"

# With parameters
hive-flow workflow execute --name "test-suite" --params '{"env": "staging"}'

# Dry run
hive-flow workflow execute --name "deploy-api" --dry-run
```
