# workflow-select

Automatically select optimal workflow based on task type.

## Usage
```bash
hive-flow automation workflow-select [options]
```

## Options
- `--task <description>` - Task description
- `--constraints <list>` - Workflow constraints
- `--preview` - Preview without executing

## Examples
```bash
# Select workflow for task
hive-flow automation workflow-select --task "Deploy to production"

# With constraints
hive-flow automation workflow-select --constraints "no-downtime,rollback"

# Preview mode
hive-flow automation workflow-select --task "Database migration" --preview
```
