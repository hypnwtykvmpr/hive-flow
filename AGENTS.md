# Hive Flow V3 - Agent Guide

> **For OpenAI Codex CLI** - Agentic AI Foundation standard
> Skills: `$skill-name` | Config: `.agents/config.toml`

---

## 📢 TL;DR - READ THIS FIRST

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  1. hive-flow = LEDGER (tracks state, stores memory, coordinates)       ║
║  2. Codex = EXECUTOR (writes code, runs commands, creates files)          ║
║  3. NEVER stop after calling hive-flow - IMMEDIATELY continue working   ║
║  4. If you need something BUILT/EXECUTED, YOU do it, not hive-flow      ║
║  5. ALWAYS search memory BEFORE starting: memory search --query "task"    ║
║  6. ALWAYS store patterns AFTER success: memory store --namespace patterns║
╚═══════════════════════════════════════════════════════════════════════════╝
```

**Workflow (Use MCP Tools):**
1. `memory_search(query="task keywords")` → LEARN from past patterns (score > 0.7 = use it)
2. `swarm_init(topology="hierarchical")` → coordination record (instant)
3. **YOU write the code / run the commands** ← THIS IS WHERE WORK HAPPENS
4. `memory_store(key="pattern-x", value="what worked", namespace="patterns")` → REMEMBER for next time

---

## 🚨 CRITICAL: CODEX DOES THE WORK, HIVE-FLOW ORCHESTRATES

```
┌─────────────────────────────────────────────────────────────┐
│  HIVE-FLOW = ORCHESTRATOR (tracks state, coordinates)     │
│  CODEX = WORKER (writes code, runs commands, implements)    │
└─────────────────────────────────────────────────────────────┘
```

### ❌ WRONG: Expecting hive-flow to execute tasks
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Build API"
# WRONG: Waiting for hive-flow to build the API
# Hive-flow does NOT execute code!
```

### ✅ CORRECT: Codex executes, hive-flow tracks
```bash
# 1. Tell hive-flow what you're doing (optional coordination)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 1
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name codex-worker

# 2. YOU (CODEX) DO THE ACTUAL WORK:
mkdir -p src
cat > src/api.ts << 'EOF'
export function hello() { return "Hello World"; }
EOF

# 3. Report to hive-flow what you did (optional)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "api-created" --value "src/api.ts" --namespace results
```

### The Division of Labor

| Component | Role | Examples |
|-----------|------|----------|
| **CODEX** | EXECUTES | Write files, run tests, create code, shell commands |
| **hive-flow** | ORCHESTRATES | Track agents, store memory, coordinate tasks |

---

## ⛔ DON'T STOP AFTER CALLING HIVE-FLOW

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ❌ WRONG: Call hive-flow → STOP → Wait for results                   │
│  ✅ RIGHT: Call hive-flow → IMMEDIATELY continue → YOU do the work    │
└─────────────────────────────────────────────────────────────────────────┘
```

### ❌ WRONG Pattern (Stopping)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name worker-1
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Build hello world"
# WRONG: Codex stops here and waits for something to happen
# Nothing will happen! Hive-flow doesn't execute code!
```

### ✅ CORRECT Pattern (Continue Immediately)
```bash
# Step 1: Coordination (optional)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name worker-1

# Step 2: IMMEDIATELY DO THE WORK YOURSELF - DON'T WAIT!
echo 'console.log("Hello World!");' > hello.js
node hello.js

# Step 3: Report what you did
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "result" --value "Hello World printed" --namespace results
```

### The Rule
**After ANY hive-flow command, IMMEDIATELY continue with your own work.**

Hive-flow commands return instantly. They create coordination RECORDS only.
You must ALWAYS follow up with YOUR OWN execution.

| After This... | IMMEDIATELY Do This... |
|---------------|----------------------|
| `swarm init` | Start writing code |
| `agent spawn` | Continue implementation |
| `task create` | Execute the task yourself |
| `swarm start` | Begin actual work |

---

### When to Use Hive-Flow Commands

| Use Case | Hive-Flow Command | Then Codex Does |
|----------|---------------------|-----------------|
| Track progress | `memory store --key "step1" --value "done"` | Continue to next step |
| Multi-step tasks | `task create --description "step 2"` | Execute step 2 |
| Store results | `memory store --key "output" --value "..."` | Move on |
| Coordinate | `swarm init` | Start working |

### Hello World - Correct Pattern

```bash
# STEP 1: Optional - register with orchestrator
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology mesh --max-agents 1

# STEP 2: CODEX DOES THE WORK
echo 'console.log("Hello World!");' > hello.js
node hello.js

# STEP 3: Optional - report completion
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "hello-result" --value "printed Hello World" --namespace results
```

**REMEMBER: If you need something DONE, YOU do it. Hive-flow just tracks.**

---

## ⚡ QUICK COMMANDS (NO DISCOVERY NEEDED)

### Spawn N-Agent Swarm (Copy-Paste Ready)

```bash
# 5-AGENT SWARM - Run these commands in sequence:
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 8
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coordinator --name coord-1
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name coder-1
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name coder-2
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type tester --name tester-1
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type reviewer --name reviewer-1
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Your task here" --strategy development
```

### Common Swarm Patterns

| Task | Exact Command |
|------|---------------|
| Init hierarchical swarm | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 8` |
| Init mesh swarm | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology mesh --max-agents 5` |
| Init V3 mode (15 agents) | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --v3-mode` |
| Spawn coder | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name coder-1` |
| Spawn tester | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type tester --name tester-1` |
| Spawn coordinator | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coordinator --name coord-1` |
| Spawn architect | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type architect --name arch-1` |
| Spawn reviewer | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type reviewer --name rev-1` |
| Spawn researcher | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type researcher --name res-1` |
| Start swarm | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "task" --strategy development` |
| Check swarm status | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm status` |
| List agents | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent list` |
| Stop swarm | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm stop` |

### Agent Types (Use with `--type`)

| Type | Purpose |
|------|---------|
| `coordinator` | Orchestrates other agents |
| `coder` | Writes code |
| `tester` | Writes tests |
| `reviewer` | Reviews code |
| `architect` | Designs systems |
| `researcher` | Analyzes requirements |
| `security-architect` | Security design |
| `performance-engineer` | Optimization |

### Task Commands

| Action | Command |
|--------|---------|
| Create task | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task create --type implementation --description "desc"` |
| List tasks | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task list` |
| Assign task | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task assign TASK_ID --agent AGENT_NAME` |
| Task status | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task status TASK_ID` |
| Cancel task | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task cancel TASK_ID` |

### Memory Commands

| Action | Command |
|--------|---------|
| Store | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "key" --value "value" --namespace patterns` |
| Search | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "search terms"` |
| List | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory list --namespace patterns` |
| Retrieve | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory retrieve --key "key"` |

---

## 🚀 SWARM RECIPES

### Recipe 1: Hello World Test (COMPLETE EXAMPLE)

**Step 1: Setup coordination** (returns instantly - don't stop!)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology mesh --max-agents 5
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name hello-main
# ⚠️ DON'T STOP HERE - CONTINUE IMMEDIATELY TO STEP 2
```

**Step 2: YOU (Codex) execute the task** (THIS IS THE REAL WORK)
```bash
# ✅ YOU create the file
echo 'console.log("Hello World from Swarm!");' > /tmp/hello-swarm.js

# ✅ YOU execute it
node /tmp/hello-swarm.js
# Output: Hello World from Swarm!
```

**Step 3: Report completion** (optional - store results)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "hello-world-result" --value "Executed: Hello World from Swarm!" --namespace results
```

### Recipe 1b: 5-Agent Concurrent Hello World (COMPLETE)
```bash
# COORDINATION (instant - creates records only)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 5
for i in 1 2 3 4 5; do
  node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name "worker-$i"
done

# ⚠️ NOW YOU DO THE ACTUAL CONCURRENT WORK:
for i in 1 2 3 4 5; do
  (echo "Worker $i: Hello World!" && sleep 0.$i) &
done
wait
echo "All 5 workers completed!"

# REPORT (optional)
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "concurrent-result" --value "5 workers completed" --namespace results
```

### Recipe 1b: Hello World (Single Command Block)
```bash
# All-in-one execution
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology mesh --max-agents 5 && \
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name hello-main && \
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Print hello world" --strategy development && \
echo 'console.log("Hello World from Swarm!");' > /tmp/hello-swarm.js && \
node /tmp/hello-swarm.js && \
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "hello-world-result" --value "Success" --namespace results
```

### Recipe 2: Feature Implementation (6 Agents)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 8
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coordinator --name lead
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type architect --name arch
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name impl-1
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name impl-2
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type tester --name test
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type reviewer --name review
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Implement [feature]" --strategy development
```

### Recipe 3: Bug Fix (4 Agents)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 4
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coordinator --name lead
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type researcher --name debug
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name fix
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type tester --name verify
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Fix [bug]" --strategy development
```

### Recipe 4: Security Audit (3 Agents)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical --max-agents 4
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coordinator --name lead
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type security-architect --name audit
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type reviewer --name review
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Security audit" --strategy development
```

### Recipe 5: V3 Full Coordination (15 Agents)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --v3-mode
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm coordinate --agents 15
```

---

## 📋 BEHAVIORAL RULES

- **YOU (CODEX) execute tasks** - hive-flow only orchestrates
- Do what is asked; nothing more, nothing less
- NEVER create files unless absolutely necessary
- ALWAYS prefer editing existing files
- NEVER save to root folder
- NEVER commit secrets or .env files
- ALWAYS read a file before editing it
- NEVER wait for hive-flow to "do work" - it doesn't execute, YOU do
- Use hive-flow commands to TRACK progress, not to EXECUTE tasks

## 📁 FILE ORGANIZATION

| Directory | Purpose |
|-----------|---------|
| `/src` | Source code |
| `/tests` | Test files |
| `/docs` | Documentation |
| `/config` | Configuration |
| `/scripts` | Utility scripts |

## 🎯 WHEN TO USE SWARMS

**USE SWARM:**
- Multiple files (3+)
- New feature implementation
- Cross-module refactoring
- API changes with tests
- Security-related changes
- Performance optimization

**SKIP SWARM:**
- Single file edits
- Simple bug fixes (1-2 lines)
- Documentation updates
- Configuration changes

---

## 🔧 CLI REFERENCE

### Swarm Commands
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init [--topology TYPE] [--max-agents N] [--v3-mode]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "task" --strategy [development|research]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm status [SWARM_ID]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm stop [SWARM_ID]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm scale --count N
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm coordinate --agents N
```

### Agent Commands
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type TYPE --name NAME
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent list [--filter active|idle|busy]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent status AGENT_ID
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent stop AGENT_ID
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent metrics [AGENT_ID]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent health
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent logs AGENT_ID
```

### Task Commands
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task create --type TYPE --description "desc"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task list [--all]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task status TASK_ID
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task assign TASK_ID --agent AGENT_NAME
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task cancel TASK_ID
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js task retry TASK_ID
```

### Memory Commands
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key KEY --value VALUE [--namespace NS]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "terms" [--namespace NS]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory list [--namespace NS]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory retrieve --key KEY [--namespace NS]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory init [--force]
```

### Hooks Commands
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks pre-task --description "task"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks post-task --task-id ID --success true
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks route --task "task"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-start --session-id ID
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-end --export-metrics true
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks worker list
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks worker dispatch --trigger audit
```

### System Commands
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js init [--wizard] [--codex] [--full]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js daemon start
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js daemon stop
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js daemon status
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js doctor [--fix]
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js status
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/mcp-server.js
```

---

## 🔌 TOPOLOGIES

| Topology | Use Case | Command Flag |
|----------|----------|--------------|
| `hierarchical` | Coordinated teams, anti-drift | `--topology hierarchical` |
| `mesh` | Peer-to-peer, equal agents | `--topology mesh` |
| `hierarchical-mesh` | Hybrid (recommended for V3) | `--topology hierarchical-mesh` |
| `ring` | Sequential processing | `--topology ring` |
| `star` | Central coordinator | `--topology star` |
| `adaptive` | Dynamic switching | `--topology adaptive` |

## 🤖 AGENT TYPES

### Core
`coordinator`, `coder`, `tester`, `reviewer`, `architect`, `researcher`

### Specialized
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`

### Consensus
`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`

---

## ⚙️ CONFIGURATION

### Default Swarm Config
- Topology: `hierarchical`
- Max Agents: 8
- Strategy: `specialized`
- Consensus: `raft`
- Memory: `hybrid`

### Environment Variables
```bash
HIVE_FLOW_CONFIG=./hive-flow.config.json
HIVE_FLOW_LOG_LEVEL=info
HIVE_FLOW_MEMORY_BACKEND=hybrid
```

---

## 🔗 SKILLS

Invoke with `$skill-name`:

| Skill | Purpose |
|-------|---------|
| `$swarm-orchestration` | Multi-agent coordination |
| `$memory-management` | Pattern storage/retrieval |
| `$sparc-methodology` | Structured development |
| `$security-audit` | Security scanning |
| `$performance-analysis` | Profiling |
| `$github-automation` | CI/CD management |
| `$hive-mind` | Byzantine consensus |
| `$neural-training` | Pattern learning |

---

---

## 🔌 MCP INTEGRATION (Learning & Coordination)

Codex doesn't have native hooks like Claude Code, but uses **MCP (Model Context Protocol)** for learning and coordination.

### MCP Auto-Registration

When you run `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js init --codex`, the MCP server is **automatically registered** with Codex.

```bash
# Verify MCP is registered:
codex mcp list

# Expected output:
# Name         Command  Args                                                                                          Status
# hive-flow  node     /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/mcp-server.js  enabled

# If not present, add manually:
codex mcp add hive-flow -- node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/mcp-server.js
```

### Test MCP Connection
```bash
# Test MCP server starts correctly:
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/mcp-server.js
```

### MCP Tools Available
Once added, Codex can use these tools via MCP:

**Coordination:**
| Tool | Purpose |
|------|---------|
| `swarm_init` | Initialize swarm (topology, maxAgents) |
| `swarm_status` | Check swarm state |
| `agent_spawn` | Register agent roles |
| `agent_status` | Check agent state |
| `task_orchestrate` | Coordinate multi-agent tasks |

**Learning & Memory (USE THESE!):**
| Tool | Purpose | When |
|------|---------|------|
| `memory_search` | Semantic vector search | BEFORE every task |
| `memory_store` | Store patterns with embeddings | AFTER success |
| `memory_retrieve` | Get by exact key | When key is known |
| `neural_train` | Train on patterns | Periodic improvement |
| `neural_status` | Check learning state | Debugging |

**Hive Mind (Advanced):**
| Tool | Purpose |
|------|---------|
| `hive-mind_init` | Byzantine consensus swarm |
| `hive-mind_spawn` | Spawn hive workers |
| `hive-mind_broadcast` | Message all workers |

### Self-Learning via MCP Tools (PREFERRED)

Use MCP tools directly - faster than CLI commands:

**BEFORE starting any task - SEARCH for patterns:**
```
Use tool: memory_search
  query: "keywords related to your task"
  namespace: "patterns"
```

**AFTER completing successfully - STORE the pattern:**
```
Use tool: memory_store
  key: "pattern-[descriptive-name]"
  value: "What worked: approach, code patterns, gotchas"
  namespace: "patterns"
```

### MCP Learning Workflow (Use This!)

```
1. LEARN: memory_search(query="task keywords", namespace="patterns")
   → If score > 0.7, USE that pattern

2. COORDINATE: swarm_init(topology="hierarchical")
   → agent_spawn(type="coder", name="worker-1")

3. EXECUTE: YOU write the code, run commands, create files

4. REMEMBER: memory_store(key="pattern-x", value="what worked", namespace="patterns")
```

### MCP Tools for Learning

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `memory_search` | Find similar past patterns | BEFORE starting any task |
| `memory_store` | Save successful patterns | AFTER completing a task |
| `memory_retrieve` | Get specific pattern by key | When you know the exact key |
| `neural_train` | Train on successful patterns | After multiple successes |

### Example: Learning-Enabled Task

```
STEP 1 - LEARN:
Use tool: memory_search
  query: "validation utility function"
  namespace: "patterns"

→ Found: pattern-email-validator (score: 0.82)
→ Use this pattern as reference!

STEP 2 - COORDINATE:
Use tool: swarm_init with topology="hierarchical", maxAgents=3

STEP 3 - EXECUTE:
YOU create the files:
  echo 'export function validate(x) { ... }' > /tmp/validator.js
  node --test /tmp/validator.js

STEP 4 - REMEMBER:
Use tool: memory_store
  key: "pattern-phone-validator"
  value: "Phone validation: regex /^\+?[\d\s-]{10,}$/, normalize first, test edge cases"
  namespace: "patterns"
```

### Vector Search Tips
- Searches are SEMANTIC (meaning-based, not just keywords)
- Score > 0.7 = strong match, use that pattern
- Score 0.5-0.7 = partial match, adapt as needed
- Store DETAILED values for better future retrieval

### CLI Fallback (if MCP unavailable)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory search --query "keywords" --namespace patterns
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js memory store --key "pattern-x" --value "what worked" --namespace patterns
```

### Coordination via MCP

When hive-flow is added as MCP server, Codex can call tools directly:
```
Use tool: swarm_init with topology="hierarchical"
Use tool: memory_store with key="result" value="success"
```

### config.toml MCP Setup
```toml
# ~/.codex/config.toml
[mcp_servers.hive-flow]
command = "npx"
args = ["hive-flow", "mcp", "start"]
enabled = true
```

---

## 📚 SUPPORT

- Docs: https://github.com/ruvnet/hive-flow
- Issues: https://github.com/ruvnet/hive-flow/issues

**Remember: Codex executes, hive-flow orchestrates!**

<!-- BEGIN BEADS INTEGRATION v:1 profile:full hash:d4f96305 -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->
