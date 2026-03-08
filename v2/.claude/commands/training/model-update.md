# model-update

Update neural models with new data.

## Usage
```bash
npx hive-flow training model-update [options]
```

## Options
- `--model <name>` - Model to update
- `--incremental` - Incremental update
- `--validate` - Validate after update

## Examples
```bash
# Update all models
npx hive-flow training model-update

# Specific model
npx hive-flow training model-update --model agent-selector

# Incremental with validation
npx hive-flow training model-update --incremental --validate
```
