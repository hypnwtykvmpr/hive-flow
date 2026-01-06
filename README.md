# Claude-Flow v3: Enterprise AI Orchestration Platform

<div align="center">

[![Star on GitHub](https://img.shields.io/github/stars/ruvnet/claude-flow?style=for-the-badge&logo=github&color=gold)](https://github.com/ruvnet/claude-flow)
[![Downloads](https://img.shields.io/npm/dt/claude-flow?style=for-the-badge&logo=npm&color=blue&label=Downloads)](https://www.npmjs.com/package/claude-flow)
[![Latest Release](https://img.shields.io/npm/v/claude-flow/alpha?style=for-the-badge&logo=npm&color=green&label=v2.7.0-alpha.10)](https://www.npmjs.com/package/claude-flow)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-SDK%20Integrated-green?style=for-the-badge&logo=anthropic)](https://github.com/ruvnet/claude-flow)
[![Agentics Foundation](https://img.shields.io/badge/Agentics-Foundation-crimson?style=for-the-badge&logo=openai)](https://discord.com/invite/dfxmpwkG2D)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge&logo=opensourceinitiative)](https://opensource.org/licenses/MIT)

</div>

Multi-agent AI orchestration framework for Claude Code with swarm coordination, self-learning hooks, and Domain-Driven Design architecture.

---

## Quick Start

### Prerequisites

- **Node.js 18+** (LTS recommended)
- **npm 9+** or equivalent package manager
- **Windows users**: See [Windows Installation Guide](./docs/windows-installation.md)

**IMPORTANT**: Claude Code must be installed first:

```bash
# 1. Install Claude Code globally
npm install -g @anthropic-ai/claude-code

# 2. (Optional) Skip permissions check for faster setup
claude --dangerously-skip-permissions
```

### Installation

```bash
# Install claude-flow
npm install claude-flow@latest

# Initialize in your project
npx claude-flow init

# Start MCP server for Claude Code integration
npx claude-flow mcp start

# Run a task with agents
npx claude-flow --agent coder --task "Implement user authentication"

# List available agents
npx claude-flow --list
```

---

## Features

### Core Capabilities

- **54+ Specialized Agents** - Purpose-built agents for every development task
- **Swarm Coordination** - Hierarchical, mesh, and adaptive topologies for parallel execution
- **Self-Learning Hooks** - ReasoningBank pattern learning with HNSW vector search
- **MCP Integration** - Native Claude Code support via Model Context Protocol
- **Security-First** - Input validation, path traversal prevention, safe command execution
- **Cross-Platform** - Windows, macOS, and Linux support

### Advanced Features

- Automatic Topology Selection
- Parallel Execution (2.8-4.4x speed improvement)
- Neural Training with 27+ models
- Bottleneck Analysis
- Smart Auto-Spawning
- Self-Healing Workflows
- Cross-Session Memory
- GitHub Integration

---

## Available Agents (54+)

### V3 Specialized Swarm Agents (15-Agent Concurrent)

| Agent | Purpose |
|-------|---------|
| `queen-coordinator` | V3 orchestration & GitHub issue management |
| `security-architect` | Security architecture & threat modeling |
| `security-auditor` | CVE remediation & security testing |
| `memory-specialist` | AgentDB unification (150x-12,500x faster) |
| `swarm-specialist` | Unified coordination engine |
| `integration-architect` | agentic-flow@alpha deep integration |
| `performance-engineer` | 2.49x-7.47x optimization targets |
| `core-architect` | Domain-driven design restructure |
| `test-architect` | TDD London School methodology |
| `project-coordinator` | Cross-domain coordination |

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`, `collective-intelligence-coordinator`, `swarm-memory-manager`

### Consensus & Distributed
`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`, `consensus-builder`, `crdt-synchronizer`, `quorum-manager`, `security-manager`

### Performance & Optimization
`perf-analyzer`, `performance-benchmarker`, `task-orchestrator`, `memory-coordinator`, `smart-agent`

### GitHub & Repository
`github-modes`, `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`, `workflow-automation`, `project-board-sync`, `repo-architect`, `multi-repo-swarm`

### SPARC Methodology
`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`, `refinement`

### Specialized Development
`backend-dev`, `mobile-dev`, `ml-developer`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

---

## Use Cases

| Use Case | Command |
|----------|---------|
| Code review | `npx claude-flow --agent reviewer --task "Review PR #123"` |
| Test generation | `npx claude-flow --agent tester --task "Write tests for auth module"` |
| Security audit | `npx claude-flow --agent security-architect --task "Audit for vulnerabilities"` |
| Multi-agent swarm | `npx claude-flow swarm init --topology hierarchical` |
| Route task | `npx claude-flow hooks route "Optimize database queries"` |
| Performance analysis | `npx claude-flow --agent perf-analyzer --task "Profile API endpoints"` |
| GitHub PR management | `npx claude-flow --agent pr-manager --task "Review open PRs"` |

---

## Self-Learning Hooks System

### Available Commands

```bash
# Before editing - get context and agent suggestions
npx claude-flow hooks pre-edit <filePath>

# After editing - record outcome for learning
npx claude-flow hooks post-edit <filePath> --success true

# Before commands - assess risk
npx claude-flow hooks pre-command "<command>"

# After commands - record outcome
npx claude-flow hooks post-command "<command>" --success true

# Route task to optimal agent using learned patterns
npx claude-flow hooks route "<task description>"

# Explain routing decision with transparency
npx claude-flow hooks explain "<task description>"

# Bootstrap intelligence from repository
npx claude-flow hooks pretrain

# Generate optimized agent configs from pretrain data
npx claude-flow hooks build-agents

# View learning metrics dashboard
npx claude-flow hooks metrics

# Transfer patterns from another project
npx claude-flow hooks transfer <sourceProject>

# RuVector intelligence (SONA, MoE, HNSW 150x faster)
npx claude-flow hooks intelligence
```

### Pretraining Pipeline

1. **RETRIEVE** - Top-k memory injection with MMR diversity
2. **JUDGE** - LLM-as-judge trajectory evaluation
3. **DISTILL** - Extract strategy memories from trajectories
4. **CONSOLIDATE** - Dedup, detect contradictions, prune old patterns

---

## MCP Tools

### Coordination
`swarm_init`, `agent_spawn`, `task_orchestrate`

### Monitoring
`swarm_status`, `agent_list`, `agent_metrics`, `task_status`, `task_results`

### Memory & Neural
`memory_usage`, `neural_status`, `neural_train`, `neural_patterns`

### GitHub Integration
`github_swarm`, `repo_analyze`, `pr_enhance`, `issue_triage`, `code_review`

---

## Architecture

### V3 Module Structure

```
v3/
├── @claude-flow/hooks      # Event-driven lifecycle hooks
├── @claude-flow/memory     # AgentDB unification module
├── @claude-flow/security   # CVE remediation & patterns
├── @claude-flow/swarm      # 15-agent coordination
├── @claude-flow/plugins    # RuVector WASM plugins
├── @claude-flow/cli        # CLI modernization
├── @claude-flow/neural     # SONA learning integration
├── @claude-flow/testing    # TDD London School framework
├── @claude-flow/deployment # Release & CI/CD
└── @claude-flow/shared     # Shared utilities & types
```

### Domain-Driven Design Structure

```
src/
├── agent-lifecycle/      # Bounded Context 1
│   ├── domain/          # Business logic
│   ├── application/     # Use cases
│   ├── infrastructure/  # Persistence
│   └── api/            # CLI, MCP interfaces
├── task-execution/      # Bounded Context 2
├── memory-management/   # Bounded Context 3
├── coordination/        # Bounded Context 4
├── shared-kernel/       # Shared utilities
└── infrastructure/      # Cross-cutting concerns
```

### Architecture Decision Records (ADRs)

| ADR | Decision |
|-----|----------|
| ADR-001 | Adopt agentic-flow as core foundation (eliminate 10,000+ duplicate lines) |
| ADR-002 | Domain-Driven Design structure (bounded contexts) |
| ADR-003 | Single coordination engine (unified SwarmCoordinator) |
| ADR-004 | Plugin-based architecture (microkernel pattern) |
| ADR-005 | MCP-first API design (consistent interfaces) |
| ADR-006 | Unified memory service (AgentDB integration) |
| ADR-007 | Event sourcing for state changes (audit trail) |
| ADR-008 | Vitest over Jest (10x faster testing) |
| ADR-009 | Hybrid memory backend default (SQLite + AgentDB) |
| ADR-010 | Remove Deno support (Node.js 20+ focus) |

---

## Performance

### Benchmarks

| Metric | Result |
|--------|--------|
| SWE-Bench solve rate | **84.8%** |
| Speed improvement | **2.8-4.4x** with parallel execution |
| Token reduction | **32.3%** through pattern learning |
| Neural models | **27+** available |

### V3 Performance Targets

| Target | Improvement |
|--------|-------------|
| Flash Attention | 2.49x-7.47x speedup |
| AgentDB Search | 150x-12,500x faster |
| Memory Reduction | 50-75% |
| Code Reduction | <5,000 lines (vs 15,000+) |
| Startup Time | <500ms |
| SONA Learning | <0.05ms adaptation |

---

## Cross-Platform Support

### Windows (PowerShell)

```powershell
npx @claude-flow/security@latest audit --platform windows
$env:CLAUDE_FLOW_MODE = "integration"
```

### macOS (Bash/Zsh)

```bash
npx @claude-flow/security@latest audit --platform darwin
export CLAUDE_FLOW_SECURITY_MODE="strict"
```

### Linux (Bash)

```bash
npx @claude-flow/security@latest audit --platform linux
export CLAUDE_FLOW_MEMORY_PATH="./data"
```

---

## Security

- **Input Validation** - All inputs validated at boundaries
- **Path Traversal Prevention** - Safe path handling
- **Command Injection Protection** - Allowlisted commands only
- **Prototype Pollution Prevention** - Safe JSON parsing
- **CVE Remediation** - Active security monitoring

---

## Documentation

- [V2 Documentation](./v2/README.md)
- [Architecture Decisions](./v3/docs/adr/)
- [API Reference](./v2/docs/technical/)
- [Examples](./v2/examples/)

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
- Discord: [Agentics Foundation](https://discord.com/invite/dfxmpwkG2D)

## License

MIT - [RuvNet](https://github.com/ruvnet)
