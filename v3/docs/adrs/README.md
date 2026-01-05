# V3 Architecture Decision Records (ADRs)

This directory contains all Architecture Decision Records for Claude-Flow v3.

## ADR Index

| ADR | Title | Status | File |
|-----|-------|--------|------|
| ADR-001 | Adopt agentic-flow as Core Foundation | ✅ Implemented | [ADR-001-AGENT-IMPLEMENTATION.md](./ADR-001-AGENT-IMPLEMENTATION.md) |
| ADR-002 | Implement Domain-Driven Design Structure | ✅ Implemented | [ADR-002-DDD-STRUCTURE.md](./ADR-002-DDD-STRUCTURE.md) |
| ADR-003 | Single Coordination Engine | ✅ Implemented | [ADR-003-CONSOLIDATION-COMPLETE.md](./ADR-003-CONSOLIDATION-COMPLETE.md) |
| ADR-004 | Plugin-Based Architecture | ✅ Implemented | [ADR-004-PLUGIN-ARCHITECTURE.md](./ADR-004-PLUGIN-ARCHITECTURE.md) |
| ADR-005 | MCP-First API Design | ✅ Implemented | [ADR-005-implementation-summary.md](./ADR-005-implementation-summary.md) |
| ADR-006 | Unified Memory Service | ✅ Implemented | [ADR-006-UNIFIED-MEMORY.md](./ADR-006-UNIFIED-MEMORY.md) |
| ADR-007 | Event Sourcing for State Changes | ✅ Implemented | [ADR-007-EVENT-SOURCING.md](./ADR-007-EVENT-SOURCING.md) |
| ADR-008 | Vitest Over Jest | ✅ Implemented | [ADR-008-VITEST.md](./ADR-008-VITEST.md) |
| ADR-009 | Hybrid Memory Backend as Default | ✅ Implemented | [ADR-009-IMPLEMENTATION.md](./ADR-009-IMPLEMENTATION.md) |
| ADR-010 | Remove Deno Support | ✅ Implemented | [ADR-010-NODE-ONLY.md](./ADR-010-NODE-ONLY.md) |

## Quick Summary

### Core Decisions

1. **ADR-001**: Build on agentic-flow@alpha instead of duplicating (eliminates 10,000+ lines)
2. **ADR-002**: Domain-Driven Design with bounded contexts for clean architecture
3. **ADR-003**: Single UnifiedSwarmCoordinator as canonical coordination engine
4. **ADR-004**: Microkernel with plugins for optional features (HiveMind, Neural, etc.)
5. **ADR-005**: MCP tools as primary API, CLI as thin wrapper

### Technical Decisions

6. **ADR-006**: Single MemoryService with SQLite, AgentDB, or Hybrid backends
7. **ADR-007**: Event sourcing for audit trail and state reconstruction
8. **ADR-008**: Vitest for 10x faster testing with native ESM
9. **ADR-009**: Hybrid backend (SQLite + AgentDB) as default for best performance
10. **ADR-010**: Node.js 20+ only, removing Deno complexity

## Additional Files

- [v3-adrs.md](./v3-adrs.md) - Complete ADR master document with all decisions
- [ADR-003-implementation-status.md](./ADR-003-implementation-status.md) - Detailed implementation tracking

## Performance Targets (from ADRs)

| Metric | Target | ADR Reference |
|--------|--------|---------------|
| Code reduction | <5,000 lines vs 15,000+ | ADR-001 |
| HNSW search | 150x-12,500x faster | ADR-009 |
| Flash Attention | 2.49x-7.47x speedup | ADR-001 |
| Test execution | <5s (10x improvement) | ADR-008 |
| Startup time | <500ms | ADR-004 |
| Query latency | <100ms | ADR-006 |

## Security Improvements

All ADRs consider security:
- CVE-1: Command injection prevention (ADR-005 input validation)
- CVE-2: Path traversal prevention (ADR-006 memory sandboxing)
- CVE-3: Credential generation (secure random with rejection sampling)

---

**Last Updated:** 2026-01-05
**Project:** Claude-Flow V3
