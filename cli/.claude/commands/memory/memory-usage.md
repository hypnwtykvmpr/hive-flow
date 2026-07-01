# memory-usage

Manage persistent memory storage.

## Usage
```bash
hive-flow memory usage [options]
```

## Options
- `--action <type>` - Action (store, retrieve, list, clear)
- `--key <key>` - Memory key
- `--value <data>` - Data to store (JSON)

## Examples
```bash
# Store memory
hive-flow memory usage --action store --key "project-config" --value '{"api": "v2"}'

# Retrieve memory
hive-flow memory usage --action retrieve --key "project-config"

# List all keys
hive-flow memory usage --action list
```
