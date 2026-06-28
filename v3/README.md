# Hive Flow V3

> **Modular AI Agent Coordination System** - A complete reimagining of Hive-Flow with 50-agent hierarchical mesh swarm coordination.


## Introduction

Hive Flow V3 is a next-generation AI agent coordination system built on 10 Architecture Decision Records (ADRs). It provides a modular, security-first, high-performance platform for orchestrating multi-agent swarms with hierarchical mesh topology.

V3 represents a complete architectural overhaul:
- **Faster testing** with Vitest
- **HiveMemory vector search** where the backend is built
- **Deterministic local pattern utilities**
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
| Local pattern helpers | Deterministic utilities | Validated |
| HiveMemory Search | Vector search where built | Implemented |

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
│  │ hive-flow │  │ Local Attn   │  │ Patterns     │          │
│  │  bridge      │  │ benchmarks   │  │  learning    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │     cli      │  │   testing    │  │   browser    │          │
│  │  commands    │  │ TDD London   │  │ automation   │          │
│  │  prompts     │  │   School     │  │ trajectories │          │
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
├── @hive-flow/                    # Modular packages (3 packages)
│   ├── cli/                         # CLI module (40 commands)
│   │   ├── bin/                     # Executable
│   │   ├── e2e/                     # CLI-owned integration tests
│   │   ├── helpers/                 # Cross-platform helper assets
│   │   ├── docs/                    # CLI-owned package docs
│   │   └── src/
│   │       ├── claims/              # Claims-based authorisation
│   │       ├── commands/            # Command handlers
│   │       ├── codex/               # Codex adapter and dual-mode binary internals
│   │       ├── context/             # Internal context assembly helpers
│   │       ├── deployment/          # Release helper internals
│   │       ├── guidance/            # Governance control plane
│   │       ├── hooks/               # 35 CLI hook subcommands + 10 configured workers
│   │       ├── integration/         # hive-flow integration bridge
│   │       ├── memory/              # HiveMemory + HNSW vector search
│   │       ├── mcp/                 # MCP server internals
│   │       ├── mcp-tools/           # MCP tool definitions
│   │       ├── neural/              # Deterministic local pattern helpers
│   │       ├── performance/         # Performance profiling internals
│   │       ├── plugin-sdk/          # Plugin SDK and examples
│   │       ├── security/            # Input validation, CVE remediation
│   │       ├── swarm/               # Swarm coordination internals
│   │       └── testing/             # CLI-owned testing helpers
│   ├── embeddings/                  # Vector embeddings (HNSW, hyperbolic)
│   ├── providers/                   # LLM provider integrations
│   └── shared/                      # Shared types, events, resilience
│
├── docs/                            # Documentation
├── scripts/                         # Utility scripts
├── swarm.config.ts                  # Swarm configuration
├── vitest.config.ts                 # Test configuration
└── package.json                     # Monorepo package
```

## Modules

### @hive-flow/cli/security
Security-first implementation with CVE fixes, input validation, and credential management.

```typescript
import { PasswordHasher, validateInput, sanitizePath } from '@hive-flow/cli/security';

const hasher = new PasswordHasher();
const hash = await hasher.hash('password');
const valid = await hasher.verify('password', hash);
```

### @hive-flow/cli/memory
Unified memory service with HiveMemory, HNSW indexing, and fast HNSW-indexed search.

```typescript
import { UnifiedMemoryService, HNSWIndex, createDefaultEntry } from '@hive-flow/cli/memory';

const memory = new UnifiedMemoryService({ dimensions: 384 });
await memory.initialize();

const embedding = new Float32Array(384);
await memory.store(createDefaultEntry({ key: 'knowledge', content: 'context', embedding }));
const results = await memory.search(embedding, { k: 10 });
```

### @hive-flow/cli/swarm
150-agent hierarchical mesh coordination with consensus protocols.

```typescript
import { UnifiedSwarmCoordinator } from '@hive-flow/cli/swarm';

const coordinator = new UnifiedSwarmCoordinator({
  topology: 'hierarchical-mesh',
  maxAgents: 15
});

await coordinator.initialize();
await coordinator.spawnAgent({ type: 'queen-coordinator' });
```

### @hive-flow/cli/integration
Local compatibility adapters per ADR-001. External package delegation is detached.

```typescript
import { HiveFlowBridge } from '@hive-flow/cli/integration';

const bridge = new HiveFlowBridge();
await bridge.initialize();
const agent = await bridge.createAgent({ type: 'coder' });
```

### @hive-flow/cli/performance
Benchmarking framework with local attention-style helper validation.

```typescript
import { BenchmarkRunner, formatTime } from '@hive-flow/cli/performance';

const runner = new BenchmarkRunner();
const result = await runner.run('map-lookup', () => map.get(key), {
  iterations: 100000,
  targetTime: 20
});
```

### @hive-flow/cli/neural
Local pattern learning and trajectory tracking helpers.

```typescript
import { createNeuralLearningSystem } from '@hive-flow/cli/neural';

const learning = createNeuralLearningSystem('code');
await learning.initialize();
const trajectoryId = learning.beginTask('review auth middleware', 'code');
```

### @hive-flow/cli
Modern CLI with interactive prompts and formatted output.

```bash
hive-flow swarm init --topology hierarchical-mesh
hive-flow agent spawn --type queen-coordinator
hive-flow memory search "knowledge"
```

Release helper internals that used to live in the standalone deployment package
now ship from the CLI package:

```typescript
import { ReleaseManager } from '@hive-flow/cli/deployment';
```

### @hive-flow/cli/testing
TDD London School framework with mocks, fixtures, and regression testing.

```typescript
import { createMockAgent, createTestFixture } from '@hive-flow/cli/testing';

const mockAgent = createMockAgent({ type: 'coder' });
const fixture = createTestFixture('swarm-coordination');
```

### @hive-flow/cli/shared
Common types, events, utilities, and core interfaces.

```typescript
import { EventBus, Result, success, failure } from '@hive-flow/cli/shared';
import type { AgentId, TaskStatus } from '@hive-flow/cli/shared/types';
```

## Usage

### Quick Start

```typescript
import { createUnifiedSwarmCoordinator } from '@hive-flow/cli/swarm';

const swarm = createUnifiedSwarmCoordinator({
  topology: { type: 'hierarchical-mesh', maxAgents: 150 },
  consensus: { algorithm: 'raft', threshold: 0.67 },
});

await swarm.initialize();
```

### Import Specific Modules

```typescript
// Import the package you need directly.
import { UnifiedSwarmCoordinator } from '@hive-flow/cli/swarm';
import { PasswordHasher } from '@hive-flow/cli/security';
import { HNSWIndex } from '@hive-flow/cli/memory';
```

### MCP Server

```typescript
import { createMCPServer } from '@hive-flow/cli/mcp';

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
| **Search** | HiveMemory vector search | where built |
| **Attention** | Local attention-style helpers | deterministic utilities |
| **Memory** | Reduction | Substantially lower |
| **Code** | Package count | 3 packages |
| **Startup** | Cold start | <500ms |
| **Learning** | Local pattern utilities | deterministic |

## Links

### Documentation
- [Helper System](./@hive-flow/cli/helpers/README.md)

### Modules
- [@hive-flow/cli/security](./@hive-flow/cli/docs/security/README.md)
- [@hive-flow/cli/memory](./@hive-flow/cli/docs/memory/)
- [@hive-flow/cli/swarm](./@hive-flow/cli/src/swarm/)
- [@hive-flow/cli/integration](./@hive-flow/cli/src/integration/)
- [@hive-flow/cli/performance](./@hive-flow/cli/docs/performance/)
- [@hive-flow/cli/neural](./@hive-flow/cli/neural/)
- [@hive-flow/cli](./@hive-flow/cli/)
- [@hive-flow/cli/testing](./@hive-flow/cli/src/testing/)
- [@hive-flow/cli/shared](./@hive-flow/cli/docs/shared/)

### Examples
- [HiveMemory Example](./@hive-flow/cli/docs/memory/examples/hivememory-example.ts)
- [Cross-Platform Usage](./@hive-flow/cli/docs/memory/examples/cross-platform-usage.ts)

### MCP Tools
- [CLI MCP Tool Registry](./@hive-flow/cli/src/mcp-client.ts)
- [CLI MCP Tools](./@hive-flow/cli/src/mcp-tools/)
- [CLI MCP Server](./@hive-flow/cli/src/mcp/)

### External

## Requirements

- **Node.js**: >=20.0.0
- **pnpm**: >=8.0.0
- **TypeScript**: >=5.3.0

## License

MIT License - See [LICENSE](../LICENSE) for details.

---

**Built with the SPARC methodology and 50-agent hierarchical mesh coordination.**
