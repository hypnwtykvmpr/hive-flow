# parallel-execute

Execute tasks in parallel for maximum efficiency.

## Usage
```bash
hive-flow optimization parallel-execute [options]
```

## Options
- `--tasks <file>` - Task list file
- `--max-parallel <n>` - Maximum parallel tasks
- `--strategy <type>` - Execution strategy

## Examples
```bash
# Execute task list
hive-flow optimization parallel-execute --tasks tasks.json

# Limit parallelism
hive-flow optimization parallel-execute --tasks tasks.json --max-parallel 5

# Custom strategy
hive-flow optimization parallel-execute --strategy adaptive
```
