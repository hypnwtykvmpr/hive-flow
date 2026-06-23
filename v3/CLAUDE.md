# V3 Module Development

This directory contains the V3 monorepo packages. Root CLAUDE.md rules apply here.

## Build & Test

```bash
# From v3/@hive-flow/<package>
```

## Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@hive-flow/cli` | `@hive-flow/cli/` | CLI entry point (37 commands, 268 subcommands) |
| `@hive-flow/cli/guidance` | `@hive-flow/cli/src/guidance/` | Governance control plane (compile, enforce, prove, evolve) |
| `@hive-flow/cli/hooks` | `@hive-flow/cli/src/hooks/` | 17 hooks + 12 background workers |
| `@hive-flow/cli/memory` | `@hive-flow/cli/src/memory/` | HiveMemory + HNSW vector search |
| `@hive-flow/shared` | `@hive-flow/shared/` | Shared types and utilities |
| `@hive-flow/cli/security` | `@hive-flow/cli/src/security/` | Input validation, path security, CVE remediation |

## Code Quality

- No hardcoded secrets
- Input validation at system boundaries
- Typed interfaces for all public APIs
- TDD London School (mock-first) preferred
- Event sourcing for state changes

## Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| HNSW Search | HNSW-indexed | Implemented |
| Memory Reduction | Int8 quantization | Implemented |
| MCP Response | <100ms | Achieved |
| CLI Startup | <500ms | Achieved |
| Flash Attention | Flash Attention optimization | In progress |
