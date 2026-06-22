# Hive Flow V3

> **Modular AI Agent Coordination System** - A complete reimagining of Hive-Flow with 50-agent hierarchical mesh swarm coordination.


## Introduction

Hive Flow V3 is a next-generation AI agent coordination system built on 10 Architecture Decision Records (ADRs). It provides a modular, security-first, high-performance platform for orchestrating multi-agent swarms with hierarchical mesh topology.

V3 represents a complete architectural overhaul:
- **Faster testing** with Vitest
- **fast HNSW-indexed search** with HNSW indexing
- **Flash Attention optimization**
- **Memory reduction**

## Features

### Core Capabilities

- **15-Agent Hierarchical Mesh** - Queen-led coordination with specialized worker agents
- **Domain-Driven Design** - Clean bounded contexts with separation of concerns
- **Plugin Architecture** - Microkernel pattern for extensibility
- **MCP-First API** - Consistent interfaces across all modules
- **Event Sourcing** - Full audit trail for state changes
- **Hybrid Memory Backend** - SQLite + HiveMemory for optimal performance

### Security

- **CVE Remediation** - All known vulnerabilities addressed
- **Input Validation** - Zod-based schema validation
- **Secure ID Generation** - Cryptographic random IDs
- **Path Security** - Traversal protection
- **SQL Injection Prevention** - Parameterized queries

### Performance

| Metric | Target | Achieved |
|--------|--------|----------|
| Event Bus (100k events) | <50ms | Met |
| Map Lookup (100k gets) | <20ms | Met |
| Array.find vs Map O(1) | N/A | Map O(1) lookup |
| Flash Attention | Flash Attention optimization | Validated |
| HiveMemory Search | HNSW-indexed | HNSW indexed |

## Architecture

### Architecture Decision Records (ADRs)

| ADR | Decision |
|-----|----------|
| ADR-001 | Adopt hive-flow as core foundation |
| ADR-002 | Domain-Driven Design structure |
| ADR-003 | Single coordination engine (UnifiedSwarmCoordinator) |
| ADR-004 | Plugin-based architecture (microkernel) |
| ADR-005 | MCP-first API design |
| ADR-006 | Unified memory service (HiveMemory) |
| ADR-007 | Event sourcing for state changes |
| ADR-008 | Vitest over Jest (significantly faster) |
| ADR-009 | Hybrid memory backend default |
| ADR-010 | Remove Deno support (Node.js 20+ only) |

### Module Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     @hive-flow/v3-monorepo                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   security   │  │    memory    │  │    swarm     │          │
│  │  CVE fixes   │  │   HiveMemory    │  │ 50-agent     │          │
│  │  validation  │  │   HNSW       │  │ coordination │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ integration  │  │  performance │  │    neural    │          │
│  │ hive-flow │  │ Flash Attn   │  │   SONA       │          │
│  │  bridge      │  │ benchmarks   │  │  learning    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │     cli      │  │   testing    │  │  deployment  │          │
│  │  commands    │  │ TDD London   │  │   release    │          │
│  │  prompts     │  │   School     │  │    CI/CD     │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                       shared                             │   │
│  │  types • events • core • hooks • resilience • plugins   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
v3/
├── @hive-flow/                    # Modular packages (20 packages)
│   ├── aidefence/                   # AI-threat defence & PII scanning
│   ├── browser/                     # Browser automation (Playwright/CDP)
│   ├── claims/                      # Claims-based authorisation
│   ├── cli/                         # CLI module (40 commands)
│   │   ├── bin/                     # Executable
│   │   ├── e2e/                     # CLI-owned integration tests
│   │   ├── helpers/                 # Cross-platform helper assets
│   │   └── src/
│   │       ├── commands/            # Command handlers
│   │       └── context/             # Internal context assembly helpers
│   ├── codex/                       # Dual-mode Claude + Codex collaboration
│   ├── deployment/                  # Deployment & release management
│   ├── embeddings/                  # Vector embeddings (HNSW, hyperbolic)
│   ├── guidance/                    # Governance control plane
│   ├── hooks/                       # 17 hooks + 12 background workers
│   ├── integration/                 # hive-flow integration bridge
│   │   └── src/
│   │       ├── hive-flow-bridge.ts  # Core bridge
│   │       ├── agent-adapter.ts     # Agent adaptation
│   │       └── sona-adapter.ts      # SONA learning
│   ├── mcp/                         # MCP server & tools
│   ├── memory/                      # HiveMemory + HNSW vector search
│   │   └── src/
│   │       ├── hivememory-backend.ts
│   │       ├── hnsw-index.ts
│   │       ├── hybrid-backend.ts
│   │       └── sqlite-backend.ts
│   ├── neural/                      # Neural/SONA module
│   │   └── src/
│   │       ├── algorithms/          # Learning algorithms
│   │       └── modes/               # Neural modes
│   ├── performance/                 # Performance profiling & benchmarks
│   ├── plugins/                     # Plugin system & IPFS registry
│   ├── providers/                   # LLM provider integrations
│   ├── security/                    # Input validation, CVE remediation
│   ├── shared/                      # Shared types, events, resilience
│   ├── swarm/                       # Swarm coordination
│   │   └── src/
│   │       ├── unified-coordinator.ts
│   │       ├── topology-manager.ts
│   │       └── consensus/
│   └── testing/                     # TDD London School framework
│       └── src/
│           ├── fixtures/
│           ├── mocks/
│           └── helpers/
│
├── docs/                            # Documentation
├── scripts/                         # Utility scripts
├── index.ts                         # Main entry point
├── swarm.config.ts                  # Swarm configuration
├── vitest.config.ts                 # Test configuration
└── package.json                     # Monorepo package
```

## Modules

### @hive-flow/security
Security-first implementation with CVE fixes, input validation, and credential management.

```typescript
import { PasswordHasher, validateInput, sanitizePath } from '@hive-flow/security';

const hasher = new PasswordHasher();
const hash = await hasher.hash('password');
const valid = await hasher.verify('password', hash);
```

### @hive-flow/memory
Unified memory service with HiveMemory, HNSW indexing, and fast HNSW-indexed search.

```typescript
import { HybridMemoryRepository, HNSWIndex } from '@hive-flow/memory';

const memory = new HybridMemoryRepository({
  backend: 'hivememory',
  vectorSearch: true
});

await memory.store({ key: 'knowledge', value: 'context', embedding: [...] });
const results = await memory.search({ query: 'knowledge', limit: 10 });
```

### @hive-flow/swarm
50-agent hierarchical mesh coordination with consensus protocols.

```typescript
import { UnifiedSwarmCoordinator } from '@hive-flow/swarm';

const coordinator = new UnifiedSwarmCoordinator({
  topology: 'hierarchical-mesh',
  maxAgents: 15
});

await coordinator.initialize();
await coordinator.spawnAgent({ type: 'queen-coordinator' });
```

### @hive-flow/integration
Local compatibility adapters per ADR-001. External package delegation is detached.

```typescript
import { HiveFlowBridge } from '@hive-flow/integration';

const bridge = new HiveFlowBridge();
await bridge.initialize();
const agent = await bridge.createAgent({ type: 'coder' });
```

### @hive-flow/performance
Benchmarking framework with Flash Attention validation.

```typescript
import { BenchmarkRunner, formatTime } from '@hive-flow/performance';

const runner = new BenchmarkRunner();
const result = await runner.run('map-lookup', () => map.get(key), {
  iterations: 100000,
  targetTime: 20
});
```

### @hive-flow/neural
SONA learning integration for self-optimizing agents.

```typescript
import { SONAAdapter } from '@hive-flow/neural';

const sona = new SONAAdapter();
await sona.train({ patterns: learningData });
const prediction = await sona.predict(context);
```

### @hive-flow/cli
Modern CLI with interactive prompts and formatted output.

```bash
hive-flow swarm init --topology hierarchical-mesh
hive-flow agent spawn --type queen-coordinator
hive-flow memory search "knowledge"
```

### @hive-flow/testing
TDD London School framework with mocks, fixtures, and regression testing.

```typescript
import { createMockAgent, createTestFixture } from '@hive-flow/testing';

const mockAgent = createMockAgent({ type: 'coder' });
const fixture = createTestFixture('swarm-coordination');
```

### @hive-flow/shared
Common types, events, utilities, and core interfaces.

```typescript
import { EventBus, Result, success, failure } from '@hive-flow/shared';
import type { AgentId, TaskStatus } from '@hive-flow/shared/types';
```

### @hive-flow/deployment
Release management and CI/CD automation.

```typescript
import { ReleaseManager } from '@hive-flow/deployment';

const release = new ReleaseManager();
await release.prepare({ version: '3.0.0', changelog: '...' });
```

## Usage

### Quick Start

```typescript
import { createUnifiedSwarmCoordinator } from '@hive-flow/swarm';

const swarm = createUnifiedSwarmCoordinator({
  topology: { type: 'hierarchical-mesh', maxAgents: 150 },
  consensus: { algorithm: 'raft', threshold: 0.67 },
});

await swarm.initialize();
```

### Import Specific Modules

```typescript
// Import the package you need directly.
import { UnifiedSwarmCoordinator } from '@hive-flow/swarm';
import { PasswordHasher } from '@hive-flow/security';
import { HNSWIndex } from '@hive-flow/memory';
```

### MCP Server

```typescript
import { createMCPServer } from '@hive-flow/mcp';

const server = createMCPServer({
  transport: 'stdio',
});

await server.start();
```

## Helper System

Cross-platform automation for V3 development:

```bash
# Linux/macOS
./@hive-flow/cli/helpers/hive-flow-v3.sh init
./@hive-flow/cli/helpers/hive-flow-v3.sh status
./@hive-flow/cli/helpers/hive-flow-v3.sh update domain 3

# Windows (PowerShell)
.\@hive-flow\cli\helpers\hive-flow-v3.ps1 init
.\@hive-flow\cli\helpers\hive-flow-v3.ps1 status
.\@hive-flow\cli\helpers\hive-flow-v3.ps1 update domain 3
```

Features:
- **Progress Tracking**: Real-time domain/agent/performance metrics
- **Checkpointing**: Auto-commit with development milestones
- **Validation**: Environment and configuration verification
- **GitHub Integration**: PR management and issue tracking

## Installation

```bash
# Clone the repository
cd hive-flow/v3

# Install dependencies
pnpm install

# Build all modules
pnpm build
```

## Testing

```bash
# Run all tests
pnpm test

# Run integration tests
pnpm test:integration

# Run specific module tests
pnpm test:memory
pnpm test:swarm
pnpm test:security

# Run benchmarks
pnpm bench

# Quick benchmark (no dependencies)
node scripts/quick-benchmark.mjs

# Coverage report
pnpm test:coverage
```

## Performance Targets

| Category | Metric | Target |
|----------|--------|--------|
| **Search** | HiveMemory HNSW | fast HNSW-indexed |
| **Attention** | Flash Attention | Flash Attention optimization |
| **Memory** | Reduction | Substantially lower |
| **Code** | Package count | 22 packages |
| **Startup** | Cold start | <500ms |
| **Learning** | SONA adaptation | low-latency |

## Links

### Documentation
- [Helper System](./@hive-flow/cli/helpers/README.md)

### Modules
- [@hive-flow/security](./@hive-flow/security/)
- [@hive-flow/memory](./@hive-flow/memory/)
- [@hive-flow/swarm](./@hive-flow/swarm/)
- [@hive-flow/integration](./@hive-flow/integration/)
- [@hive-flow/performance](./@hive-flow/performance/)
- [@hive-flow/neural](./@hive-flow/neural/)
- [@hive-flow/cli](./@hive-flow/cli/)
- [@hive-flow/testing](./@hive-flow/testing/)
- [@hive-flow/shared](./@hive-flow/shared/)
- [@hive-flow/deployment](./@hive-flow/deployment/)

### Examples
- [HiveMemory Example](./@hive-flow/memory/examples/hivememory-example.ts)
- [Cross-Platform Usage](./@hive-flow/memory/examples/cross-platform-usage.ts)

### MCP Tools
- [CLI MCP Tool Registry](./@hive-flow/cli/src/mcp-client.ts)
- [CLI MCP Tools](./@hive-flow/cli/src/mcp-tools/)
- [Standalone MCP Server](./@hive-flow/mcp/)

### External

## Requirements

- **Node.js**: >=20.0.0
- **pnpm**: >=8.0.0
- **TypeScript**: >=5.3.0

## License

MIT License - See [LICENSE](../LICENSE) for details.

---

**Built with the SPARC methodology and 50-agent hierarchical mesh coordination.**
