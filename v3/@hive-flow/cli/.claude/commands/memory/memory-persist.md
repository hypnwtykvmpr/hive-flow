# memory-persist

Persist memory across sessions.

## Usage
```bash
hive-flow memory persist [options]
```

## Options
- `--export <file>` - Export to file
- `--import <file>` - Import from file
- `--compress` - Compress memory data

## Examples
```bash
# Export memory
hive-flow memory persist --export memory-backup.json

# Import memory
hive-flow memory persist --import memory-backup.json

# Compressed export
hive-flow memory persist --export memory.gz --compress
```
