# Hive Flow V3 - Architecture Decision Records

> Note: the historical ADR source files (ADR-001 … etc.) are not shipped in this tree; the entries below are listed for reference.

## Quick Links

| ADR | Title | Status |
|-----|-------|--------|
| ADR-001 | Adopt hive-flow as Core Foundation | Complete |
| ADR-002 | Domain-Driven Design Structure | Complete |
| ADR-003 | Single Coordination Engine | Complete |
| ADR-004 | Plugin Architecture | Complete |
| ADR-005 | MCP-First API Design | Complete |
| ADR-006 | Unified Memory Service | Complete |
| ADR-007 | Event Sourcing | Complete |
| ADR-008 | Vitest Testing | Complete |
| ADR-009 | Hybrid Memory Backend | Complete |
| ADR-010 | Node.js Only | Complete |
| ADR-011 | LLM Provider System | Complete |
| ADR-012 | MCP Security Features | Complete |
| ADR-013 | Core Security Module | Complete |
| ADR-014 | Workers System | Complete |
| ADR-015 | Unified Plugin System | Complete |
| ADR-016 | Collaborative Issue Claims | Complete |
| ADR-018 | Claude Code Integration | Complete |
| ADR-019 | Headless Runtime Package | Complete |
| ADR-020 | Headless Worker Integration | Complete |
| ADR-047 | Fast Mode Integration | Proposed |

## Summary Documents

- ADR-STATUS-SUMMARY - Implementation status overview
- V3 ADRs Master - Complete ADR document
- Full README - Detailed index with roadmap

## Performance Targets

| Metric | Target | Status |
|--------|--------|--------|
| HNSW Search | Substantially faster | ✅ Achieved |
| Flash Attention | Validated optimization | ✅ Achieved (alpha.102) |
| Memory Reduction | Substantially lower | ✅ Achieved |
| MCP Response | <100ms | ✅ Achieved |
| CLI Startup | <500ms | ✅ Achieved |

## Neural Features (alpha.102+)

| Component | Status | Lines | Notes |
|-----------|--------|-------|-------|
| SONA Optimizer | ✅ Real | 841 | Pattern learning from trajectories |
| EWC++ Consolidation | ✅ Real | ~600 | Fisher matrix, prevents forgetting |
| MoE Router | ✅ Real | ~500 | 8 experts with gating network |
| Flash Attention | ✅ Real | ~500 | O(N) block attention |
| LoRA Adapter | ✅ Real | ~400 | High compression (rank=8) |
| Hyperbolic Embeddings | ✅ Real | - | Poincaré ball model |
| Int8 Quantization | ✅ Real | - | Significant memory savings |

## Security Status

| CVE | Severity | Status |
|-----|----------|--------|
| CVE-2 | Critical | ✅ Fixed |
| CVE-3 | Critical | ✅ Fixed |
| HIGH-1 | High | ✅ Fixed |
| HIGH-2 | High | ✅ Fixed |

**Security Score:** 10/10

---

**Last Updated:** 2026-01-14
**CLI Version:** @hive-flow/cli@3.0.0-alpha.104
