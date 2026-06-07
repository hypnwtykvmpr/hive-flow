# neural-train

Train neural patterns from operations.

## Usage
```bash
hive-flow training neural-train [options]
```

## Options
- `--data <source>` - Training data source
- `--model <name>` - Target model
- `--epochs <n>` - Training epochs

## Examples
```bash
# Train from recent ops
hive-flow training neural-train --data recent

# Specific model
hive-flow training neural-train --model task-predictor

# Custom epochs
hive-flow training neural-train --epochs 100
```
