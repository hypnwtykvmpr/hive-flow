# V3 Module Development

This directory contains the V3 monorepo packages. Root CLAUDE.md rules apply here.

## Build & Test

```bash
# From v3/@hive-flow/<package>
```

## Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@hive-flow/cli` | `@hive-flow/cli/` | CLI entry point (40 commands, 140+ subcommands) |
| `@hive-flow/guidance` | `@hive-flow/guidance/` | Governance control plane (compile, enforce, prove, evolve) |
| `@hive-flow/hooks` | `@hive-flow/hooks/` | 17 hooks + 12 background workers |
| `@hive-flow/memory` | `@hive-flow/memory/` | HiveMemory + HNSW vector search |
| `@hive-flow/shared` | `@hive-flow/shared/` | Shared types and utilities |
| `@hive-flow/security` | `@hive-flow/security/` | Input validation, path security, CVE remediation |

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
| Memory Reduction | 50-75% (Int8 quantization) | Implemented |
| MCP Response | <100ms | Achieved |
| CLI Startup | <500ms | Achieved |
| Flash Attention | Flash Attention optimization | In progress |
