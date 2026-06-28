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
| HNSW Search | Substantially faster | Implemented for memory/vector backends where configured |
| Flash Attention | Validated optimization | Source present; runtime availability is module-gated |
| Memory Reduction | Substantially lower | Implemented where compression/quantization paths are enabled |
| MCP Response | <100ms | Target retained; verify against the active runtime |
| CLI Startup | <500ms | Target retained; verify against the active runtime |

## Neural Features (alpha.102+)

| Component | Status | Lines | Notes |
|-----------|--------|-------|-------|
| SONA Optimizer | Source present; runtime-gated | 841 | Lazy-loaded trajectory pattern utility when available |
| EWC++ Consolidation | Source present; runtime-gated | ~600 | Lazy-loaded consolidation helper when available |
| MoE Router | Source present; runtime-gated | ~500 | Lazy-loaded routing helper when available |
| Flash Attention | Source present; runtime-gated | ~500 | Lazy-loaded attention helper when available |
| LoRA Adapter | Source present; runtime-gated | ~400 | Lazy-loaded adapter helper when available |
| Hyperbolic Embeddings | Source present; runtime-gated | - | Poincare/hyperbolic embedding support where enabled |
| Int8 Quantization | Source present; runtime-gated | - | Quantization support where enabled |

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
