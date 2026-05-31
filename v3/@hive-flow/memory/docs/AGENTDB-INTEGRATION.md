# Local AgentDB-Compatible Memory Backend

Hive Flow no longer installs or imports the external `agentdb` package. The memory module keeps the AgentDB-compatible API names for existing callers, but all behavior routes through local fallback implementations.

## Current Behavior

- No external AgentDB installation step is required.
- `AgentDBBackend` initializes local storage and local vector search behavior.
- Missing external packages are not treated as errors.
- Existing tests should assert local fallback behavior, not external package availability.

## Migration Guidance

Remove any instructions that fetch `agentdb` from npm. If future work needs a stronger vector backend, add it as a first-party workspace package or a clearly scoped local implementation instead of restoring external package loading.
