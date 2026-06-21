# Claude Code Configuration - Hive Flow V3

## 🚨 AUTOMATIC SWARM ORCHESTRATION

**When starting work on complex tasks, Claude Code MUST automatically:**

1. **Initialize the swarm** using CLI tools via Bash
2. **Spawn concurrent agents** using Claude Code's Task tool
3. **Coordinate via hooks** and memory

### 🚨 CRITICAL: CLI + Task Tool in SAME Message

**When user says "spawn swarm" or requests complex work, Claude Code MUST in ONE message:**
1. Call CLI tools via Bash to initialize coordination
2. **IMMEDIATELY** call Task tool to spawn REAL working agents
3. Both CLI and Task calls must be in the SAME response

**CLI coordinates, Task tool agents do the actual work!**

### 🤖 INTELLIGENT 3-TIER MODEL ROUTING (ADR-026)

**The routing system has 3 tiers for optimal cost/performance:**

| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| **1** | Agent Booster | <1ms | $0 | Simple transforms (var→const, add-types, remove-console) |
| **2** | Haiku | ~500ms | $0.0002 | Simple tasks, bug fixes, low complexity |
| **3** | Sonnet/Opus | 2-5s | $0.003-$0.015 | Architecture, security, complex reasoning |

**Before spawning agents, get routing recommendation:**
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks pre-task --description "[task description]"
```

**When you see these recommendations:**

1. `[AGENT_BOOSTER_AVAILABLE]` → Skip LLM entirely, use Edit tool directly
   - Intent types: `var-to-const`, `add-types`, `add-error-handling`, `async-await`, `add-logging`, `remove-console`

2. `[TASK_MODEL_RECOMMENDATION] Use model="X"` → Use that model in Task tool:
```javascript
Task({
  prompt: "...",
  subagent_type: "coder",
  model: "haiku"  // ← USE THE RECOMMENDED MODEL (haiku/sonnet/opus)
})
```

**Benefits:** 75% cost reduction, 352x faster for Tier 1 tasks

---

### 🛡️ Anti-Drift Config (PREFERRED)

**Use this to prevent agent drift:**
```bash
# Small teams (6-8 agents) - use hierarchical for tight control
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 8 --strategy specialized

# Large teams (10-15 agents) - use hierarchical-mesh for V3 queen + peer communication
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical-mesh --max-agents 15 --strategy specialized
```

**Valid Topologies:**
- `hierarchical` - Queen controls workers directly (anti-drift for small teams)
- `hierarchical-mesh` - V3 queen + peer communication (recommended for 10+ agents)
- `mesh` - Fully connected peer network
- `ring` - Circular communication pattern
- `star` - Central coordinator with spokes
- `hybrid` - Dynamic topology switching

**Anti-Drift Guidelines:**
- **hierarchical**: Coordinator catches divergence
- **max-agents 6-8**: Smaller team = less drift
- **specialized**: Clear roles, no overlap
- **consensus**: raft (leader maintains state)

---

### 🔄 Auto-Start Swarm Protocol (Background Execution)

When the user requests a complex task, **spawn agents in background and WAIT for completion:**

```javascript
// STEP 1: Initialize swarm coordination (anti-drift config)
Bash("node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 8 --strategy specialized")

// STEP 2: Spawn ALL agents IN BACKGROUND in a SINGLE message
// Use run_in_background: true so agents work concurrently
Task({
  prompt: "Research requirements, analyze codebase patterns, store findings in memory",
  subagent_type: "researcher",
  description: "Research phase",
  run_in_background: true  // ← CRITICAL: Run in background
})
Task({
  prompt: "Design architecture based on research. Document decisions.",
  subagent_type: "system-architect",
  description: "Architecture phase",
  run_in_background: true
})
Task({
  prompt: "Implement the solution following the design. Write clean code.",
  subagent_type: "coder",
  description: "Implementation phase",
  run_in_background: true
})
Task({
  prompt: "Write comprehensive tests for the implementation.",
  subagent_type: "tester",
  description: "Testing phase",
  run_in_background: true
})
Task({
  prompt: "Review code quality, security, and best practices.",
  subagent_type: "reviewer",
  description: "Review phase",
  run_in_background: true
})

// STEP 3: WAIT - Tell user agents are working, then STOP
// Say: "I've spawned 5 agents to work on this in parallel. They'll report back when done."
// DO NOT check status repeatedly. Just wait for user or agent responses.
```

### ⏸️ CRITICAL: Spawn and Wait Pattern

**After spawning background agents:**

1. **TELL USER** - "I've spawned X agents working in parallel on: [list tasks]"
2. **STOP** - Do not continue with more tool calls
3. **WAIT** - Let the background agents complete their work
4. **RESPOND** - When agents return results, review and synthesize

**Example response after spawning:**
```
I've launched 5 concurrent agents to work on this:
- 🔍 Researcher: Analyzing requirements and codebase
- 🏗️ Architect: Designing the implementation approach
- 💻 Coder: Implementing the solution
- 🧪 Tester: Writing tests
- 👀 Reviewer: Code review and security check

They're working in parallel. I'll synthesize their results when they complete.
```

### 🚫 DO NOT:
- Continuously check swarm status
- Poll TaskOutput repeatedly
- Add more tool calls after spawning
- Ask "should I check on the agents?"

### ✅ DO:
- Spawn all agents in ONE message
- Tell user what's happening
- Wait for agent results to arrive
- Synthesize results when they return

## Turn Completion (CRITICAL)

When you finish the user's request: **report results, then STOP.**
- Do NOT run post-task hooks, memory commands, or neural training
- Do NOT search memory for patterns to store
- Do NOT trigger worker dispatches
- Background systems handle all learning automatically

## Background Learning

These fire automatically — no model action needed:

| Signal | Hook/Trigger | What It Does |
|--------|-------------|--------------|
| File edited | `PostToolUse` → `post-edit` | Logs edit to `pending-insights.jsonl` via `intelligence.recordEdit()` |
| Turn ends | `Stop` → `post-task` + `auto-memory-hook.mjs sync` | Intelligence feedback + incremental memory sync to MEMORY.md |
| Team agent idle | `TeammateIdle` → `post-task` | Intelligence feedback for team turns |
| Task completed | `TaskCompleted` → `post-task` | Intelligence feedback for task completion |
| Session ends | `SessionEnd` → `session-end` | Consolidates pending insights, persists session state |
| Scheduled | Daemon workers (optimize, audit, consolidate) | Background optimization on 60s intervals |

Do NOT run manual memory/hooks/neural commands after completing work. Just stop.

### 📋 Agent Routing (Anti-Drift)

| Code | Task | Agents |
|------|------|--------|
| 1 | Bug Fix | coordinator, researcher, coder, tester |
| 3 | Feature | coordinator, architect, coder, tester, reviewer |
| 5 | Refactor | coordinator, architect, coder, reviewer |
| 7 | Performance | coordinator, perf-engineer, coder |
| 9 | Security | coordinator, security-architect, auditor |
| 11 | Docs | researcher, api-docs |

**Codes 1-9: hierarchical/specialized (anti-drift). Code 11: mesh/balanced**

### 🎯 Task Complexity Detection

**AUTO-INVOKE SWARM when task involves:**
- Multiple files (3+)
- New feature implementation
- Refactoring across modules
- API changes with tests
- Security-related changes
- Performance optimization
- Database schema changes

**SKIP SWARM for:**
- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes
- Quick questions/exploration

## 🚨 CRITICAL: CONCURRENT EXECUTION & FILE MANAGEMENT

**ABSOLUTE RULES**:
1. ALL operations MUST be concurrent/parallel in a single message
2. **NEVER save working files, text/mds and tests to the root folder**
3. ALWAYS organize files in appropriate subdirectories
4. **USE CLAUDE CODE'S TASK TOOL** for spawning agents concurrently, not just MCP

### ⚡ GOLDEN RULE: "1 MESSAGE = ALL RELATED OPERATIONS"

**MANDATORY PATTERNS:**
- **TodoWrite**: ALWAYS batch ALL todos in ONE call (5-10+ todos minimum)
- **Task tool (Claude Code)**: ALWAYS spawn ALL agents in ONE message with full instructions
- **File operations**: ALWAYS batch ALL reads/writes/edits in ONE message
- **Bash commands**: ALWAYS batch ALL terminal operations in ONE message
- **Memory operations**: ALWAYS batch ALL memory store/retrieve in ONE message

### 📁 File Organization Rules

**NEVER save to root folder. Use these directories:**
- `/src` - Source code files
- `/tests` - Test files
- `/docs` - Documentation and markdown files
- `/config` - Configuration files
- `/scripts` - Utility scripts
- `/examples` - Example code

## Project Config (Anti-Drift Defaults)

- **Topology**: hierarchical (prevents drift)
- **Max Agents**: 8 (smaller = less drift)
- **Strategy**: specialized (clear roles)
- **Consensus**: raft
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

## 🚀 V3 CLI Commands (37 Commands, 268 Subcommands)

### Core Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | 5 | Project initialization with wizard, check, skills, hooks, upgrade |
| `agent` | 8 | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm` | 6 | Multi-agent swarm coordination and orchestration |
| `memory` | 12 | HiveMemory memory with vector search (fast HNSW-indexed) |
| `mcp` | 10 | MCP server management and tool execution |
| `task` | 6 | Task creation, assignment, and lifecycle |
| `session` | 8 | Session state management and persistence |
| `config` | 8 | Configuration management and provider setup |
| `status` | 3 | System status monitoring with watch mode |
| `workflow` | 6 | Workflow execution and template management |
| `hooks` | 35 | Self-learning hooks + 12 background workers |
| `hive-mind` | 11 | Queen-led Byzantine fault-tolerant consensus |

### Advanced Commands

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `daemon` | 5 | Background worker daemon (start, stop, status, trigger, enable) |
| `neural` | 9 | Neural pattern training (train, status, patterns, predict, optimize, benchmark, list, export, import) |
| `security` | 6 | Security scanning (scan, audit, cve, threats, validate, report) |
| `performance` | 5 | Performance profiling (benchmark, profile, metrics, optimize, report) |
| `providers` | 5 | AI providers (list, add, remove, test, configure) |
| `plugins` | 9 | Plugin management (list, search, install, uninstall, upgrade, toggle, info, create, rate) |
| `deployment` | 6 | Deployment management (deploy, status, rollback, history, environments, logs) |
| `embeddings` | 15 | Vector embeddings (init, generate, search, compare, collections, index, providers, chunk, normalize, hyperbolic, neural, models, cache, warmup, benchmark) |
| `claims` | 6 | Claims-based authorization (list, check, grant, revoke, roles, policies) |
| `migrate` | 5 | V2 to V3 migration with rollback support |
| `doctor` | 0 | System diagnostics with health checks |
| `completions` | 4 | Shell completions (bash, zsh, fish, powershell) |

### Quick CLI Examples

```bash
# Initialize project
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js init --wizard

# Start daemon with background workers
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js daemon start

# Spawn an agent
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn -t coder --name my-coder

# Initialize swarm
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --v3-mode

# Search memory (HNSW-indexed)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "authentication patterns"

# System diagnostics
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js doctor --fix

# Security scan
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js security scan --depth full

# Performance benchmark
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js performance benchmark --suite all
```

## 🚀 Available Agents (60+ Types)

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### V3 Specialized Agents
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### 🔐 @hive-flow/security
CVE remediation, input validation, path security:
- `InputValidator` - Zod validation
- `PathValidator` - Traversal prevention
- `SafeExecutor` - Injection protection

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

### Testing & Validation
`tdd-london-swarm`, `production-validator`

## 🪝 V3 Hooks System (27 Hooks + 12 Workers)

### All Available Hooks

| Hook | Description | Key Options |
|------|-------------|-------------|
| `pre-edit` | Get context before editing files | `--file`, `--operation` |
| `post-edit` | Record editing outcome for learning | `--file`, `--success`, `--train-neural` |
| `pre-command` | Assess risk before commands | `--command`, `--validate-safety` |
| `post-command` | Record command execution outcome | `--command`, `--track-metrics` |
| `pre-task` | Record task start, get agent suggestions | `--description`, `--coordinate-swarm` |
| `post-task` | Record task completion for learning | `--task-id`, `--success`, `--store-results` |
| `session-start` | Start/restore session (v2 compat) | `--session-id`, `--auto-configure` |
| `session-end` | End session and persist state | `--generate-summary`, `--export-metrics` |
| `session-restore` | Restore a previous session | `--session-id`, `--latest` |
| `route` | Route task to optimal agent | `--task`, `--context`, `--top-k` |
| `route-task` | (v2 compat) Alias for route | `--task`, `--auto-swarm` |
| `explain` | Explain routing decision | `--topic`, `--detailed` |
| `pretrain` | Bootstrap intelligence from repo | `--model-type`, `--epochs` |
| `build-agents` | Generate optimized agent configs | `--agent-types`, `--focus` |
| `metrics` | View learning metrics dashboard | `--v3-dashboard`, `--format` |
| `transfer` | Transfer patterns via IPFS registry | `store`, `from-project` |
| `list` | List all registered hooks | `--format` |
| `intelligence` | Hivector intelligence system | `trajectory-*`, `pattern-*`, `stats` |
| `worker` | Background worker management | `list`, `dispatch`, `status`, `detect` |
| `progress` | Check V3 implementation progress | `--detailed`, `--format` |
| `statusline` | Generate dynamic statusline | `--json`, `--compact`, `--no-color` |
| `coverage-route` | Route based on test coverage gaps | `--task`, `--path` |
| `coverage-suggest` | Suggest coverage improvements | `--path` |
| `coverage-gaps` | List coverage gaps with priorities | `--format`, `--limit` |
| `pre-bash` | (v2 compat) Alias for pre-command | Same as pre-command |
| `post-bash` | (v2 compat) Alias for post-command | Same as post-command |

### 12 Background Workers

| Worker | Priority | Description |
|--------|----------|-------------|
| `ultralearn` | normal | Deep knowledge acquisition |
| `optimize` | high | Performance optimization |
| `consolidate` | low | Memory consolidation |
| `predict` | normal | Predictive preloading |
| `audit` | critical | Security analysis |
| `map` | normal | Codebase mapping |
| `preload` | low | Resource preloading |
| `deepdive` | normal | Deep code analysis |
| `document` | normal | Auto-documentation |
| `refactor` | normal | Refactoring suggestions |
| `benchmark` | normal | Performance benchmarking |
| `testgaps` | normal | Test coverage analysis |

### Essential Hook Commands

```bash
# Core hooks
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks pre-task --description "[task]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks post-task --task-id "[id]" --success true
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks post-edit --file "[file]" --train-neural true

# Session management
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-start --session-id "[id]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-end --export-metrics true
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-restore --session-id "[id]"

# Intelligence routing
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks route --task "[task]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks explain --topic "[topic]"

# Neural learning
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks pretrain --model-type moe --epochs 10
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks build-agents --agent-types coder,tester

# Background workers
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks worker list
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks worker dispatch --trigger audit
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks worker status

# Coverage-aware routing
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks coverage-gaps --format table
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks coverage-route --task "[task]"

# Statusline (for Claude Code integration)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks statusline
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks statusline --json
```

## 🔄 Migration (V2 to V3)

```bash
# Check migration status
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js migrate status

# Run migration with backup
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js migrate run --backup

# Rollback if needed
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js migrate rollback

# Validate migration
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js migrate validate
```

## 🧠 Intelligence System (Hivector)

V3 includes the Hive Flow intelligence system:
- **SONA**: Self-Optimizing Neural Architecture (low-latency adaptation)
- **MoE**: Mixture of Experts for specialized routing
- **HNSW**: fast HNSW-indexed pattern search
- **EWC++**: Elastic Weight Consolidation (prevents forgetting)
- **Flash Attention**: Flash Attention optimization

The 4-step intelligence pipeline:
1. **RETRIEVE** - Fetch relevant patterns via HNSW
2. **JUDGE** - Evaluate with verdicts (success/failure)
3. **DISTILL** - Extract key learnings via LoRA
4. **CONSOLIDATE** - Prevent catastrophic forgetting via EWC++

## 📦 Embeddings Package (v3.0.0-alpha.12)

Features:
- **sql.js**: Cross-platform SQLite persistent cache (WASM, no native compilation)
- **Document chunking**: Configurable overlap and size
- **Normalization**: L2, L1, min-max, z-score
- **Hyperbolic embeddings**: Poincaré ball model for hierarchical data
- **Local ONNX embeddings**: With hive-flow ONNX integration
- **Neural substrate**: Integration with Hivector

## 🐝 Hive-Mind Consensus

### Topologies
- `hierarchical` - Queen controls workers directly
- `mesh` - Fully connected peer network
- `hierarchical-mesh` - Hybrid (recommended)
- `adaptive` - Dynamic based on load

### Consensus Strategies
- `byzantine` - BFT (tolerates f < n/3 faulty)
- `raft` - Leader-based (tolerates f < n/2)
- `gossip` - Epidemic for eventual consistency
- `crdt` - Conflict-free replicated data types
- `quorum` - Configurable quorum-based

## V3 Performance Targets

| Metric | Target |
|--------|--------|
| Flash Attention | Flash Attention optimization |
| HNSW Search | HNSW-indexed |
| Memory Reduction | 50-75% with quantization |
| MCP Response | <100ms |
| CLI Startup | <500ms |
| SONA Adaptation | low-latency |

## 🔧 Environment Variables

```bash
# Configuration
HIVE_FLOW_CONFIG=./hive-flow.config.json
HIVE_FLOW_LOG_LEVEL=info

# Provider API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# MCP Server
HIVE_FLOW_MCP_PORT=3000
HIVE_FLOW_MCP_HOST=localhost
HIVE_FLOW_MCP_TRANSPORT=stdio

# Memory
HIVE_FLOW_MEMORY_BACKEND=hybrid
HIVE_FLOW_MEMORY_PATH=./data/memory
```

## 🔍 Doctor Health Checks

Run `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js doctor` to check:
- Node.js version (20+)
- npm version (9+)
- Git installation
- Config file validity
- Daemon status
- Memory database
- API keys
- MCP servers
- Disk space
- TypeScript installation

## 🚀 Quick Setup

```bash
# Add MCP servers (auto-detects MCP mode when stdin is piped)
claude mcp add hive-flow -- node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/mcp-server.js
claude mcp add hive-flow -- hive-flow mcp start  # Optional
claude mcp add flow-nexus -- flow-nexus mcp start  # Optional

# Start daemon
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js daemon start

# Run doctor
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js doctor --fix
```

## 🎯 Claude Code vs CLI Tools

### Claude Code Handles ALL EXECUTION:
- **Task tool**: Spawn and run agents concurrently
- File operations (Read, Write, Edit, MultiEdit, Glob, Grep)
- Code generation and programming
- Bash commands and system operations
- TodoWrite and task management
- Git operations

### CLI Tools Handle Coordination (via Bash):
- **Swarm init**: `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology <type>`
- **Swarm status**: `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm status`
- **Agent spawn**: `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn -t <type> --name <name>`
- **Memory store**: `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "mykey" --value "myvalue" --namespace patterns`
- **Memory search**: `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "search terms"`
- **Memory list**: `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory list --namespace patterns`
- **Memory retrieve**: `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory retrieve --key "mykey" --namespace patterns`
- **Hooks**: `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks <hook-name> [options]`

## 📝 Memory Commands Reference (IMPORTANT)

### Store Data (ALL options shown)
```bash
# REQUIRED: --key and --value
# OPTIONAL: --namespace (default: "default"), --ttl, --tags
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "pattern-auth" --value "JWT with refresh tokens" --namespace patterns
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "bug-fix-123" --value "Fixed null check" --namespace solutions --tags "bugfix,auth"
```

### Search Data (semantic vector search)
```bash
# REQUIRED: --query (full flag, not -q)
# OPTIONAL: --namespace, --limit, --threshold
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "authentication patterns"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "error handling" --namespace patterns --limit 5
```

### List Entries
```bash
# OPTIONAL: --namespace, --limit
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory list
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory list --namespace patterns --limit 10
```

### Retrieve Specific Entry
```bash
# REQUIRED: --key
# OPTIONAL: --namespace (default: "default")
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory retrieve --key "pattern-auth"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory retrieve --key "pattern-auth" --namespace patterns
```

### Initialize Memory Database
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory init --force --verbose
```

**KEY**: CLI coordinates the strategy via Bash, Claude Code's Task tool executes with real agents.

## Support


---

Remember: **Hive Flow CLI coordinates, Claude Code Task tool creates!**

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Never save working files, text/mds and tests to the root folder.

## 🚨 SWARM EXECUTION RULES (CRITICAL)
1. **SPAWN IN BACKGROUND**: Use `run_in_background: true` for all agent Task calls
2. **SPAWN ALL AT ONCE**: Put ALL agent Task calls in ONE message for parallel execution
3. **TELL USER**: After spawning, list what each agent is doing (use emojis for clarity)
4. **STOP AND WAIT**: After spawning, STOP - do NOT add more tool calls or check status
5. **NO POLLING**: Never poll TaskOutput or check swarm status - trust agents to return
6. **SYNTHESIZE**: When agent results arrive, review ALL results before proceeding
7. **NO CONFIRMATION**: Don't ask "should I check?" - just wait for results

Example spawn message:
```
"I've launched 4 agents in background:
- 🔍 Researcher: [task]
- 💻 Coder: [task]
- 🧪 Tester: [task]
- 👀 Reviewer: [task]
Working in parallel - I'll synthesize when they complete."
```
