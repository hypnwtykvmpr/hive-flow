# @hive-flow/plugin-gastown-bridge

> **WASM-Accelerated Bridge to Steve Yegge's Gas Town Multi-Agent Orchestrator**


## Introduction


### What is Gas Town?

Gas Town is a 75,000-line Go codebase that implements:

- **Beads** - Git-backed issue tracking with graph semantics
- **Formulas** - TOML-defined workflows (convoy, workflow, expansion, aspect)
- **Convoys** - Work-order tracking for "slung" work between agents
- **GUPP** - Gastown Universal Propulsion Principle for crash-resilient execution
- **Molecules/Wisps** - Chained work units for durable, resumable workflows

### Why This Plugin?

| Challenge | Solution |
|-----------|----------|
| Gas Town is Go-only | CLI bridge wraps `gt` and `bd` commands |
| Go can't compile to WASM (syscalls) | Hybrid architecture: CLI for I/O, WASM for compute |
| Formula parsing is slow in JS | Rust→WASM provides significant acceleration |
| Graph operations bottleneck | WASM DAG ops are optimized faster |

## Features

### 🚀 WASM-Accelerated Computation

| Operation | JavaScript | WASM | Speedup |
|-----------|------------|------|---------|
| Formula parse (TOML→AST) | 53ms | 0.15ms | **accelerated** |
| Variable cooking | 35ms | 0.1ms | **accelerated** |
| Batch cook (10 formulas) | 350ms | 1ms | **accelerated** |
| DAG topological sort | 75ms | 0.5ms | **optimized** |
| Cycle detection | 45ms | 0.3ms | **optimized** |
| Critical path analysis | 120ms | 0.8ms | **optimized** |
| Pattern search (HNSW) | 5000ms | 5ms | **optimized** |

### 🔗 20 MCP Tools

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Tool Categories                       │
├─────────────────┬─────────────────┬─────────────────────────┤
│  Beads (5)      │  Convoy (3)     │  Formula (4)            │
│  ├─ create      │  ├─ create      │  ├─ list                │
│  ├─ ready       │  ├─ status      │  ├─ cook (WASM)         │
│  ├─ show        │  └─ track       │  ├─ execute             │
│  ├─ dep         │                 │  └─ create              │
│  └─ sync        │                 │                         │
├─────────────────┼─────────────────┼─────────────────────────┤
│  Orchestration  │  WASM (5)       │                         │
│  ├─ sling       │  ├─ parse       │                         │
│  ├─ agents      │  ├─ resolve     │                         │
│  └─ mail        │  ├─ cook_batch  │                         │
│                 │  ├─ match       │                         │
│                 │  └─ optimize    │                         │
└─────────────────┴─────────────────┴─────────────────────────┘
```

### 🛡️ Security-First Design

- **Input Validation**: Zod schemas for all parameters
- **Command Injection Prevention**: Allowlist-only CLI execution
- **Path Traversal Protection**: Strict path validation
- **No Shell Execution**: Uses `execFile` with `shell: false`

### 🔄 Bidirectional Sync

Seamlessly sync between Gas Town's Beads and Hive Flow's HiveMemory:

```
┌──────────────┐     SyncBridge      ┌──────────────┐
│              │  ←───────────────→  │              │
│    Beads     │   Conflict Res.     │   HiveMemory    │
│   (JSONL)    │   • beads-wins      │   (SQLite)   │
│              │   • newest-wins     │              │
│              │   • merge           │              │
└──────────────┘                     └──────────────┘
```

## Enhancement & Comparison

### Gas Town vs Hive Flow V3

| Feature | Gas Town | Hive Flow V3 | With This Plugin |
|---------|----------|----------------|------------------|
| **Issue Tracking** | Beads (Git-backed) | HiveMemory | Unified sync |
| **Workflows** | TOML Formulas | TypeScript | Both supported |
| **Agent Roles** | Mayor, Polecats, Crew | Hierarchical swarm | Interoperable |
| **Crash Recovery** | GUPP hooks | Session persistence | Combined |
| **Work Distribution** | Slinging | Task orchestration | Bridge via sling tool |
| **Pattern Search** | N/A | HNSW (slow JS) | HNSW WASM (accelerated) |

### Performance Comparison

| Metric | Pure JavaScript | This Plugin (WASM) | Improvement |
|--------|-----------------|-------------------|-------------|
| Formula parse | 53ms | 0.15ms | accelerated |
| 100-node DAG sort | 75ms | 0.5ms | optimized |
| Pattern search (10k) | 5000ms | 5ms | accelerated |
| Memory usage | 48MB | 12MB | lower memory |
| Startup time | 850ms | 120ms | faster |

### Architecture Comparison

| Approach | Pros | Cons | This Plugin |
|----------|------|------|-------------|
| **Full TypeScript Port** | Native, no deps | 75k lines to port | ❌ |
| **Go→WASM Compile** | Reuse code | Syscalls block it | ❌ |
| **Pure CLI Bridge** | Simple | Slow for compute | Partial ✓ |
| **Hybrid CLI+WASM** | Best of both | Two codebases | ✅ Selected |

## Installation

```bash
# Install via Hive Flow CLI (recommended)
hive-flow plugins install -n @hive-flow/plugin-gastown-bridge

# Or install directly via npm

# Prerequisites: Gas Town and Beads CLI (optional - for full CLI integration)
go install github.com/steveyegge/gastown/cmd/gt@latest
go install github.com/steveyegge/beads/cmd/bd@latest
```

## Usage

### Basic Setup

```typescript
import { GasTownBridgePlugin } from '@hive-flow/plugin-gastown-bridge';

// Initialize the plugin
const plugin = new GasTownBridgePlugin({
  gtPath: '/usr/local/bin/gt',  // Optional: path to gt CLI
  bdPath: '/usr/local/bin/bd',  // Optional: path to bd CLI
  wasmEnabled: true,             // Enable WASM acceleration
});

// Register with Hive Flow
await hiveFlow.registerPlugin(plugin);
```

### Using MCP Tools

```typescript
// Create a bead (issue)
const bead = await plugin.tools.gt_beads_create({
  title: 'Implement feature X',
  description: 'Full description here',
  priority: 2,
  labels: ['feature', 'v3'],
});

// List ready beads (no blockers)
const ready = await plugin.tools.gt_beads_ready({
  limit: 10,
  rig: 'main',
});

// Cook a formula (WASM-accelerated)
const cooked = await plugin.tools.gt_formula_cook({
  formula: 'implement-feature',
  vars: {
    feature_name: 'Authentication',
    target_module: 'src/auth',
  },
});

// Sling work to an agent
await plugin.tools.gt_sling({
  bead_id: 'gt-abc123',
  target: 'polecat',
  formula: 'code-review',
});
```

### WASM-Accelerated Operations

```typescript
// Parse formula (faster than JS)
const ast = await plugin.tools.gt_wasm_parse_formula({
  content: `
    [formula]
    name = "deploy-service"
    type = "convoy"

    [[legs]]
    id = "build"
    title = "Build the service"
  `,
});

// Resolve dependencies (optimized faster)
const sorted = await plugin.tools.gt_wasm_resolve_deps({
  beads: beadList,
  action: 'topo_sort',
});

// Batch cook formulas (WASM-accelerated)
const cooked = await plugin.tools.gt_wasm_cook_batch({
  formulas: formulaList,
  vars: [{ env: 'prod' }, { env: 'staging' }],
});

// Find similar patterns (optimized faster)
const matches = await plugin.tools.gt_wasm_match_pattern({
  query: 'authentication flow',
  candidates: formulaNames,
  k: 5,
});
```

### Sync Between Beads and HiveMemory

```typescript
// Sync beads to HiveMemory
await plugin.tools.gt_beads_sync({
  direction: 'push',
  rig: 'main',
  namespace: 'project-x',
});

// Pull from HiveMemory to Beads
await plugin.tools.gt_beads_sync({
  direction: 'pull',
  conflictStrategy: 'newest-wins',
});

// Bidirectional sync
await plugin.tools.gt_beads_sync({
  direction: 'both',
  conflictStrategy: 'merge',
});
```

## Tutorial

<details>
<summary><strong>📖 Tutorial 1: Your First Gas Town Integration</strong></summary>

### Step 1: Verify Prerequisites

```bash
# Check Gas Town CLI
gt --version

# Check Beads CLI
bd --version

# Both should output version numbers
```

### Step 2: Initialize Plugin in Your Project

```typescript
// hive-flow.config.ts
import { defineConfig } from 'hive-flow';
import { GasTownBridgePlugin } from '@hive-flow/plugin-gastown-bridge';

export default defineConfig({
  plugins: [
    new GasTownBridgePlugin({
      wasmEnabled: true,
    }),
  ],
});
```

### Step 3: Create Your First Bead

```typescript
const bead = await hiveFlow.mcp.call('gt_beads_create', {
  title: 'Hello Gas Town',
  description: 'My first bead from Hive Flow!',
  priority: 3,
  labels: ['tutorial'],
});

console.log(`Created bead: ${bead.id}`);
// Output: Created bead: gt-a1b2c3
```

### Step 4: List Ready Work

```typescript
const ready = await hiveFlow.mcp.call('gt_beads_ready', {
  limit: 5,
});

console.log('Ready beads:', ready.beads.map(b => b.title));
```

</details>

<details>
<summary><strong>📖 Tutorial 2: Working with Formulas</strong></summary>

### Understanding Formula Types

| Type | Purpose | Example |
|------|---------|---------|
| `convoy` | Multi-leg work orders | Feature implementation |
| `workflow` | Step-by-step processes | CI/CD pipeline |
| `expansion` | Generate multiple beads | Test suite creation |
| `aspect` | Cross-cutting concerns | Logging, metrics |

### Creating a Custom Formula

```typescript
// Create a code review formula
await hiveFlow.mcp.call('gt_formula_create', {
  name: 'code-review-flow',
  type: 'workflow',
  steps: [
    {
      id: 'checkout',
      title: 'Checkout branch',
      description: 'Clone and checkout the PR branch',
    },
    {
      id: 'lint',
      title: 'Run linters',
      description: 'Execute ESLint and Prettier',
      needs: ['checkout'],
    },
    {
      id: 'test',
      title: 'Run tests',
      description: 'Execute test suite',
      needs: ['checkout'],
    },
    {
      id: 'review',
      title: 'Code review',
      description: 'Manual code review',
      needs: ['lint', 'test'],
    },
  ],
  vars: {
    branch: { type: 'string', required: true },
    reviewer: { type: 'string', default: 'auto' },
  },
});
```

### Cooking a Formula (WASM-Accelerated)

```typescript
// Cook the formula with variables
const cooked = await hiveFlow.mcp.call('gt_formula_cook', {
  formula: 'code-review-flow',
  vars: {
    branch: 'feature/auth',
    reviewer: '@alice',
  },
});

// cooked.steps now have variables substituted
console.log(cooked.steps[3].description);
// Output: "Manual code review by @alice"
```

</details>

<details>
<summary><strong>📖 Tutorial 3: Convoy Management</strong></summary>

### What is a Convoy?

A convoy is a "work order" that tracks a set of related beads through their lifecycle. Think of it as a sprint or milestone.

### Creating a Convoy

```typescript
// Create convoy for a feature
const convoy = await hiveFlow.mcp.call('gt_convoy_create', {
  name: 'v2.0-release',
  description: 'Version 2.0 release convoy',
  issues: ['gt-abc1', 'gt-abc2', 'gt-abc3'],
});

console.log(`Convoy created: ${convoy.id}`);
```

### Tracking Convoy Progress

```typescript
// Check convoy status
const status = await hiveFlow.mcp.call('gt_convoy_status', {
  convoy_id: convoy.id,
  detailed: true,
});

console.log(`Progress: ${status.progress}%`);
console.log(`Completed: ${status.completed}/${status.total}`);
```

### Optimizing Convoy Execution (WASM)

```typescript
// Get optimal execution order (optimized faster with WASM)
const optimized = await hiveFlow.mcp.call('gt_wasm_optimize_convoy', {
  convoy_id: convoy.id,
  strategy: 'parallel', // or 'serial', 'hybrid'
});

console.log('Execution plan:', optimized.plan);
// Output shows which beads can run in parallel
```

</details>

<details>
<summary><strong>📖 Tutorial 4: Slinging Work to Agents</strong></summary>

### Gas Town Agent Roles

| Role | Purpose |
|------|---------|
| `mayor` | Coordinator, assigns work |
| `polecat` | General worker agents |
| `crew` | Specialized team members |
| `refinery` | Processing and transformation |
| `witness` | Verification and validation |
| `deacon` | Administrative tasks |
| `dog` | Guard duties, security |

### Slinging Work

```typescript
// Sling a bead to a polecat for coding
await hiveFlow.mcp.call('gt_sling', {
  bead_id: 'gt-abc123',
  target: 'polecat',
  formula: 'implement-feature',
});

// The work is now "on the polecat's hook"
// GUPP: "If work is on your hook, YOU MUST RUN IT"
```

### Listing Available Agents

```typescript
const agents = await hiveFlow.mcp.call('gt_agents', {
  rig: 'main',
  role: 'polecat',
  include_inactive: false,
});

agents.forEach(agent => {
  console.log(`${agent.name}: ${agent.status} (${agent.workload} tasks)`);
});
```

</details>

<details>
<summary><strong>📖 Tutorial 5: Beads-HiveMemory Synchronization</strong></summary>

### Sync Strategies

| Strategy | Use Case |
|----------|----------|
| `push` | Export beads to HiveMemory |
| `pull` | Import from HiveMemory to Beads |
| `both` | Bidirectional sync |

### Conflict Resolution

| Resolution | Behavior |
|------------|----------|
| `beads-wins` | Beads data overwrites HiveMemory |
| `hivememory-wins` | HiveMemory data overwrites Beads |
| `newest-wins` | Most recent modification wins |
| `merge` | Combine non-conflicting fields |
| `manual` | Queue conflicts for manual resolution |

### Example: Production Sync Workflow

```typescript
// Morning: Pull overnight changes from shared HiveMemory
await hiveFlow.mcp.call('gt_beads_sync', {
  direction: 'pull',
  rig: 'production',
  conflictStrategy: 'newest-wins',
});

// During work: Push local changes
await hiveFlow.mcp.call('gt_beads_sync', {
  direction: 'push',
  rig: 'production',
  namespace: 'team-alpha',
});

// End of day: Full bidirectional sync
const result = await hiveFlow.mcp.call('gt_beads_sync', {
  direction: 'both',
  conflictStrategy: 'merge',
});

console.log(`Synced: ${result.pushed} pushed, ${result.pulled} pulled`);
console.log(`Conflicts: ${result.conflicts.length}`);
```

</details>

<details>
<summary><strong>📖 Tutorial 6: WASM Performance Optimization</strong></summary>

### When to Use WASM Tools

| Use WASM | Use CLI |
|----------|---------|
| Parsing formulas | Creating beads |
| Graph operations | File I/O |
| Pattern matching | SQLite queries |
| Batch processing | Agent communication |

### Batch Processing for Maximum Performance

```typescript
// Instead of this (slow):
for (const formula of formulas) {
  await hiveFlow.mcp.call('gt_formula_cook', {
    formula: formula.name,
    vars: formula.vars,
  });
}

// Do this (WASM-accelerated):
const results = await hiveFlow.mcp.call('gt_wasm_cook_batch', {
  formulas: formulas.map(f => f.name),
  vars: formulas.map(f => f.vars),
});
```

### Profiling WASM Performance

```typescript
// All WASM tools return timing metrics
const result = await hiveFlow.mcp.call('gt_wasm_parse_formula', {
  content: formulaToml,
});

console.log(`Parse time: ${result.durationMs}ms`);
// Output: Parse time: 0.14ms
```

</details>

## API Reference

### Plugin Configuration

```typescript
interface GasTownBridgeConfig {
  /** Path to gt CLI (default: auto-detect) */
  gtPath?: string;

  /** Path to bd CLI (default: auto-detect) */
  bdPath?: string;

  /** Enable WASM acceleration (default: true) */
  wasmEnabled?: boolean;

  /** Default rig for operations */
  defaultRig?: string;

  /** Sync conflict resolution strategy */
  conflictStrategy?: 'beads-wins' | 'hivememory-wins' | 'newest-wins' | 'merge' | 'manual';

  /** CLI execution timeout in ms (default: 30000) */
  timeout?: number;
}
```

### Tool Reference


## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Hive Flow V3 Plugin Host                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────────┐    ┌─────────────────────────────────────┐ │
│  │    CLI Bridge       │    │         WASM Computation Layer       │ │
│  │  (I/O Operations)   │    │             (optimized)              │ │
│  │                     │    │                                      │ │
│  │  • gt commands      │    │  ┌──────────────┐ ┌──────────────┐  │ │
│  │  • bd commands      │    │  │ gastown-     │ │ gastown-     │  │ │
│  │  • File read/write  │    │  │ formula-wasm │ │ gnn-wasm     │  │ │
│  │  • SQLite queries   │    │  │              │ │              │  │ │
│  │                     │    │  │ • TOML parse │ │ • DAG ops    │  │ │
│  │  [Node.js FFI]      │    │  │ • Variable   │ │ • Topo sort  │  │ │
│  │                     │    │  │   cooking    │ │ • Cycle      │  │ │
│  └─────────────────────┘    │  │ • Molecule   │ │   detection  │  │ │
│                             │  │   generation │ │ • Critical   │  │ │
│                             │  └──────────────┘ │   path       │  │ │
│                             │                   └──────────────┘  │ │
│                             │                                      │ │
│                             │  ┌──────────────┐ ┌──────────────┐  │ │
│                             │  │ micro-hnsw-  │ │ gastown-     │  │ │
│                             │  │ wasm         │ │ learning-wasm│  │ │
│                             │  │              │ │              │  │ │
│                             │  │ • Pattern    │ │ • SONA       │  │ │
│                             │  │   search     │ │   patterns   │  │ │
│                             │  │ • accelerated│ │ • MoE routing│  │ │
│                             │  │   search     │ │ • EWC++      │  │ │
│                             │  └──────────────┘ └──────────────┘  │ │
│                             │                                      │ │
│                             │  [wasm-bindgen interface]            │ │
│                             └─────────────────────────────────────┘ │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Related Resources


## Contributing


## License

MIT License - see [LICENSE](./LICENSE) for details.

---

**Built with ❤️ by the Hive Flow Team**
