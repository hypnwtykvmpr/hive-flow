# V3 Documentation Index

## 📁 Documentation Structure

### Root Level Documentation
- **[CHANGELOG.md](/workspaces/claude-flow/v3/CHANGELOG.md)** - Version history and changes
- **[MIGRATION.md](/workspaces/claude-flow/v3/MIGRATION.md)** - Migration guide from v2 to v3
- **[README.md](/workspaces/claude-flow/v3/README.md)** - Main project documentation

### Reports (`/docs/reports/`)
- **[BENCHMARK-RESULTS.md](reports/BENCHMARK-RESULTS.md)** - Performance benchmarking results
- **[CLEANUP-REPORT.md](reports/CLEANUP-REPORT.md)** - Consolidated cleanup and refactoring report

### Implementation Documentation (`/docs/`)
- **[ADR-003-CONSOLIDATION-COMPLETE.md](ADR-003-CONSOLIDATION-COMPLETE.md)** - ADR-003 implementation completion
- **[ADR-003-implementation-status.md](ADR-003-implementation-status.md)** - ADR-003 status tracking
- **[adr-005-implementation-summary.md](adr-005-implementation-summary.md)** - ADR-005 implementation summary
- **[CLEANUP-QUICKSTART.md](CLEANUP-QUICKSTART.md)** - Quick start guide for cleanup processes

### Implementation Planning (`/implementation/`)
Organized by category:
- **adrs/** - Architecture Decision Records
- **architecture/** - System architecture analysis
- **integration/** - Integration guides and patterns
- **migration/** - Migration roadmaps and guides
- **optimization/** - Performance optimization plans
- **planning/** - V3 master plans and roadmaps
- **research/** - Technical research documents
- **security/** - Security audits and fixes
- **swarm-plans/** - Multi-agent swarm specifications

## 📦 Module Documentation

### @claude-flow/cli (`/@claude-flow/cli/docs/`)
- **[IMPLEMENTATION_COMPLETE.md](../@claude-flow/cli/docs/IMPLEMENTATION_COMPLETE.md)** - CLI implementation completion report
- **[MCP_CLIENT_GUIDE.md](../@claude-flow/cli/docs/MCP_CLIENT_GUIDE.md)** - MCP client integration guide
- **[REFACTORING_SUMMARY.md](../@claude-flow/cli/docs/REFACTORING_SUMMARY.md)** - CLI refactoring summary

### @claude-flow/memory (`/@claude-flow/memory/docs/`)
- **[ADR-009-IMPLEMENTATION.md](../@claude-flow/memory/docs/ADR-009-IMPLEMENTATION.md)** - Hybrid memory backend implementation
- **[AGENTDB-INTEGRATION.md](../@claude-flow/memory/docs/AGENTDB-INTEGRATION.md)** - AgentDB integration guide
- **[CROSS_PLATFORM.md](../@claude-flow/memory/docs/CROSS_PLATFORM.md)** - Cross-platform memory support
- **[IMPLEMENTATION_SUMMARY.md](../@claude-flow/memory/docs/IMPLEMENTATION_SUMMARY.md)** - Consolidated implementation summary
- **[WINDOWS_SUPPORT.md](../@claude-flow/memory/docs/WINDOWS_SUPPORT.md)** - Windows-specific support documentation

### @claude-flow/neural (`/@claude-flow/neural/docs/`)
- **[SONA_INTEGRATION.md](../@claude-flow/neural/docs/SONA_INTEGRATION.md)** - SONA learning integration
- **[SONA_INTEGRATION_SUMMARY.md](../@claude-flow/neural/docs/SONA_INTEGRATION_SUMMARY.md)** - SONA integration summary
- **[SONA_QUICKSTART.md](../@claude-flow/neural/docs/SONA_QUICKSTART.md)** - SONA quick start guide

### @claude-flow/performance (`/@claude-flow/performance/docs/`)
- **[ATTENTION.md](../@claude-flow/performance/docs/ATTENTION.md)** - Flash Attention implementation
- **[INTEGRATION_COMPLETE.md](../@claude-flow/performance/docs/INTEGRATION_COMPLETE.md)** - Performance integration completion
- **[INTEGRATION_SUMMARY.md](../@claude-flow/performance/docs/INTEGRATION_SUMMARY.md)** - Performance integration summary

### @claude-flow/security (`/@claude-flow/security/docs/`)
- **[EDGE-CASES-FIXED.md](../@claude-flow/security/docs/EDGE-CASES-FIXED.md)** - Security edge case fixes
- **[SECURITY-TEST-REPORT.md](../@claude-flow/security/docs/SECURITY-TEST-REPORT.md)** - Security testing report

### @claude-flow/integration (`/@claude-flow/integration/docs/`)
- **[ADR-001-AGENT-IMPLEMENTATION.md](../@claude-flow/integration/docs/ADR-001-AGENT-IMPLEMENTATION.md)** - ADR-001 agent implementation guide

### @claude-flow/shared (`/@claude-flow/shared/docs/`)
- **[EVENTS_IMPLEMENTATION_SUMMARY.md](../@claude-flow/shared/docs/EVENTS_IMPLEMENTATION_SUMMARY.md)** - Event system implementation
- **[EVENTS_QUICK_REFERENCE.md](../@claude-flow/shared/docs/EVENTS_QUICK_REFERENCE.md)** - Event system quick reference
- **[EVENTS_README.md](../@claude-flow/shared/docs/EVENTS_README.md)** - Event system documentation

### @claude-flow/swarm (`/@claude-flow/swarm/`)
- **[MIGRATION.md](../@claude-flow/swarm/MIGRATION.md)** - Swarm module migration guide
- **[README.md](../@claude-flow/swarm/README.md)** - Swarm module documentation

## 🧪 Test Documentation

### Integration Tests (`/__tests__/integration/`)
- **[QUICK_START.md](../__tests__/integration/QUICK_START.md)** - Integration testing quick start
- **[README.md](../__tests__/integration/README.md)** - Integration test suite documentation
- **[TEST_SUMMARY.md](../__tests__/integration/TEST_SUMMARY.md)** - Integration test results summary

## 🛠️ Tools & Helpers

### MCP Tools (`/mcp/tools/`)
- **[IMPLEMENTATION.md](../mcp/tools/IMPLEMENTATION.md)** - MCP tools implementation details
- **[README.md](../mcp/tools/README.md)** - MCP tools usage guide

### Helpers (`/helpers/docs/`)
- **[installation.md](../helpers/docs/installation.md)** - Helper utilities installation guide

## 📋 Documentation Organization Rules

1. **Root Level** - Keep only CHANGELOG.md, MIGRATION.md, README.md
2. **Module Docs** - Each @claude-flow module has a `docs/` subdirectory
3. **Reports** - Benchmarks and cleanup reports in `/docs/reports/`
4. **Implementation** - Planning, architecture, and research in `/implementation/`
5. **No Root Clutter** - Never save working files, text/mds to root folder

## 🔍 Finding Documentation

### By Topic
- **Architecture**: `/implementation/architecture/`, `/implementation/adrs/`
- **Migration**: `MIGRATION.md`, `/implementation/migration/`
- **Performance**: `@claude-flow/performance/docs/`, `/docs/reports/BENCHMARK-RESULTS.md`
- **Security**: `@claude-flow/security/docs/`, `/implementation/security/`
- **Swarm Coordination**: `@claude-flow/swarm/`, `/implementation/swarm-plans/`
- **Memory Management**: `@claude-flow/memory/docs/`
- **Neural/SONA**: `@claude-flow/neural/docs/`

### By Module
Each module follows this structure:
```
@claude-flow/<module>/
├── docs/               # Module-specific documentation
├── src/                # Source code
├── package.json        # Module configuration
├── README.md          # Module overview (if applicable)
└── tsconfig.json      # TypeScript configuration
```

## 📝 Documentation Standards

- **Markdown Format** - All documentation in Markdown (.md)
- **Clear Naming** - Descriptive filenames in UPPER_CASE or kebab-case
- **Consolidation** - Merge duplicates, keep single source of truth
- **Organization** - Group related docs in subdirectories
- **Cross-References** - Use relative links between documents
- **Timestamps** - Include date/version in reports where applicable

## 🚀 Quick Links

- [V3 Master Plan](/workspaces/claude-flow/v3/implementation/planning/CLAUDE-FLOW-V3-MASTER-PLAN.md)
- [Architecture Decision Records](/workspaces/claude-flow/v3/implementation/adrs/v3-adrs.md)
- [Security Audit Report](/workspaces/claude-flow/v3/implementation/security/SECURITY_AUDIT_REPORT.md)
- [Swarm Agent Specifications](/workspaces/claude-flow/v3/implementation/swarm-plans/AGENT-SPECIFICATIONS.md)
- [Performance Optimization Roadmap](/workspaces/claude-flow/v3/implementation/optimization/V3-OPTIMIZATION-ROADMAP.md)
