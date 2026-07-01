# pattern-learn

Learn patterns from successful operations.

## Usage
```bash
hive-flow training pattern-learn [options]
```

## Options
- `--source <type>` - Pattern source
- `--threshold <score>` - Success threshold
- `--save <name>` - Save pattern set

## Examples
```bash
# Learn from all ops
hive-flow training pattern-learn

# High success only
hive-flow training pattern-learn --threshold 0.9

# Save patterns
hive-flow training pattern-learn --save optimal-patterns
```
