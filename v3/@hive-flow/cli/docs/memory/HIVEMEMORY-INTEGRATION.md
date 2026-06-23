# CLI-Owned HiveMemory-Compatible Memory Backend

Hive Flow no longer installs or imports the external `hivememory` package. The CLI-owned memory module keeps the HiveMemory terminology for user-facing features, but the exported implementation is local to `@hive-flow/cli/memory`.

## Current Behavior

- No external HiveMemory installation step is required.
- `UnifiedMemoryService`, `HybridBackend`, and `LocalVectorBackend` initialize local storage and vector search behavior.
- Missing external packages are not treated as errors.
- Existing tests should assert local fallback behavior, not external package availability.

## Migration Guidance

Remove any instructions that fetch `hivememory` from npm. If future work needs a stronger vector backend, add it as a first-party workspace package or a clearly scoped local implementation instead of restoring external package loading.
