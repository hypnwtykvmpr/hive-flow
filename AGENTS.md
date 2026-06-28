# Hive Flow V3 - Agent Guide

> **For OpenAI Codex CLI** - Agentic AI Foundation standard
> Skills: `$skill-name` | Config: `.agents/config.toml`

---

## 📢 TL;DR - READ THIS FIRST

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  1. hive-flow = LEDGER + PROVIDER AGENT RUNTIME                         ║
║  2. Codex = PRIMARY OPERATOR (edits, tests, commits when authorized)      ║
║  3. NEVER stop after coordination-only calls - continue working          ║
║  4. Delegate audits/reviews to Hive Flow agents when they can do it      ║
║  5. ALWAYS search memory BEFORE starting: memory search --query "task"    ║
║  6. ALWAYS store patterns AFTER success: memory store --namespace patterns║
╚═══════════════════════════════════════════════════════════════════════════╝
```

**Workflow (Use MCP Tools):**
1. `memory_search(query="task keywords")` → LEARN from past patterns (score > 0.7 = use it)
2. `swarm_init(topology="hierarchical")` → coordination record (instant)
3. **YOU write the code / run the commands, or delegate parallel review/audit work to Hive Flow provider agents**
4. `memory_store(key="pattern-x", value="what worked", namespace="patterns")` → REMEMBER for next time

---

## 🚨 CRITICAL: CODEX OPERATES, HIVE-FLOW ORCHESTRATES AND DELEGATES

```
┌─────────────────────────────────────────────────────────────┐
│  HIVE-FLOW = ORCHESTRATOR + PROVIDER AGENT RUNTIME        │
│  CODEX = PRIMARY OPERATOR (edits, tests, direct work)       │
└─────────────────────────────────────────────────────────────┘
```

### ❌ WRONG: Expecting coordination-only commands to execute tasks
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Build API"
# WRONG: Waiting for a coordination-only swarm record to build the API
# Coordination-only commands do not execute code by themselves.
```

### ✅ CORRECT: Codex executes direct work; Hive Flow agents handle delegated work
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
| **CODEX** | PRIMARY OPERATOR | Write files, run tests, create code, shell commands, commit only when authorized |
| **Hive Flow coordination commands** | ORCHESTRATE | Track agents, store memory, coordinate tasks |
| **Hive Flow provider agents** | DELEGATED EXECUTORS | Parallel audits, bug-hunting, verification, research, source review |

### Hive Flow Agent Dogfooding

Codex remains responsible for direct local execution: editing files, running tests, and committing only when explicitly authorized. That does not mean ignoring Hive Flow agents.

- Use Hive Flow agents for delegated work when they can complete it: audits, bug-hunting, source review, verification, planning, research, and parallel inspection.
- Prefer queen-led hives for broad or permission-sensitive work so worker permission requests route to a queen instead of spamming the parent.
- Do not use native subagents or adjacent agent frameworks for work that Hive Flow agents can perform.
- If a Hive Flow agent is overblocked or lacks a tool it should have, pause the lane and fix the Hive Flow harness first instead of routing around it.
- Use native/non-Hive delegation only when Hive Flow agents demonstrably cannot complete the task, and record the reason in the durable handoff or final report.
- When dispatching long-running Hive Flow provider tasks, pass an explicit generous `timeout`; the reaper uses the task's persisted deadline (`timeout` plus fixed cleanup grace).

---

## ⛔ DON'T STOP AFTER CALLING HIVE-FLOW

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ❌ WRONG: Call hive-flow → STOP → Wait for results                   │
│  ✅ RIGHT: Call coordination tools → continue with direct/delegated work│
└─────────────────────────────────────────────────────────────────────────┘
```

### ❌ WRONG Pattern (Stopping)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name worker-1
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm start --objective "Build hello world"
# WRONG: Codex stops here and waits for something to happen
# Nothing will happen unless you execute directly or send an executable task to a Hive Flow provider agent.
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
**After ANY coordination-only hive-flow command, IMMEDIATELY continue with direct work or an executable Hive Flow provider-agent task.**

Legacy coordination commands return instantly and create coordination records only.
You must ALWAYS follow up with direct Codex execution or a real provider-agent task.

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

**REMEMBER: Coordination-only commands track; Hive Flow provider agents can perform delegated work. Codex stays responsible for the outcome.**

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
| Init V3 mode (50 agents) | `node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --v3-mode` |
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

### Recipe 5: V3 Full Coordination (50 Agents)
```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm init --v3-mode
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js swarm coordinate --agents 50
```

---

## 📋 BEHAVIORAL RULES

- **YOU (CODEX) execute direct tasks** - Hive Flow coordinates and its provider agents execute delegated tasks
- **Use Hive Flow agents for delegated audits/reviews/verification** when their tools can complete the task; Codex still performs direct local edits and shell execution assigned to Codex
- Do what is asked; nothing more, nothing less
- NEVER create files unless absolutely necessary
- ALWAYS prefer editing existing files
- NEVER save to root folder
- NEVER commit secrets or .env files
- ALWAYS read a file before editing it
- NEVER wait after coordination-only hive-flow commands; continue with direct execution or a real provider-agent task
- Use coordination-only hive-flow commands to TRACK progress; use Hive Flow provider-agent tools for delegated execution
- If a Hive Flow agent cannot proceed because of permission/tool overblock, fix the harness or document the real blocker before substituting a non-Hive agent

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

**When ending a work session**, complete the applicable steps below. Work is
complete when the current state is verified and the human has a clear handoff.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Review git state** - Report changed files and whether changes are tracked, ignored, or local-only
5. **Clean up** - Clear temporary files you created and note any retained local artifacts
6. **Verify** - Confirm the requested gates actually ran and report failures honestly
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Do NOT run `git add`, `git commit`, `git push`, or open a PR unless the human explicitly approves that exact git operation.
- Do NOT hide public project policy files with `skip-worktree`. `AGENTS.md`, `CLAUDE.md`, `README.md`, and `.gitignore` are public tracked policy/config files.
- If a push is explicitly approved and fails, report the failure and retry only within the approved scope.

## Local-Only Artifacts

These paths are local/private and must not be staged or committed:

- `.audit/`
- `.dox/`
- `.gemini/`
- `.codex/`
- `.opencode/`
- `.qwen/`
- `.private/`
- `.resources/`
- `.scratch/`
- `.claude/design/`
- `.claude/worktrees/`
- `.claude/settings.local.json`
- `.claude/.context-tracker.json`
- `.claude/memory.db*`
- `.claude/*.db-shm`
- `q7m4x9rz.sh`

Use `.audit/private-guard.sh` to refresh local ignore and skip-worktree
protections for private/runtime files. Generated context blocks such as
<claude-mem-context>
# Memory Context

# [hive-flow] recent context, 2026-06-03 7:00pm CDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (23,035t read) | 1,902,394t work | savings

### May 20, 2026
S2 Wave 1 PR 0B implementation complete + git state investigation (force-push origin/v8 + pre-existing test failures) (May 20 at 8:26 AM)
S1 Three consecutive deliverables completed: (1) design synthesis review, (2) implementation order plan — both written to .dox/mult/design/ in vampyre repo (May 20 at 8:26 AM)
S3 Fix all 5 PR2 blockers in Graphify's schema-aware loader and stable edge identity module, then prepare PR2 for push (May 20 at 2:32 PM)
### May 31, 2026
583 1:57p 🔵 OpenRouter API Key Present in Parent Env But Not Forwarded to Bridge Child Process
588 1:58p 🔵 OSS-Gate Mutation Proof Reproduction Request
587 " 🔵 oss-gate Implementation-Gate Spec-Alignment Verification Scope
589 2:18p 🔵 oss-gate pre-commit readiness verification initiated for 2026-05-31 spec amendment
592 2:57p 🔵 oss-gate Repo: Clean-Env Gate Verification Methodology
593 " 🔵 oss-gate: Independent Mutation Verification of HIGH-1 and HIGH-2 Security Fixes
594 3:42p 🔵 oss-gate Clean-Env Full Gate Verification Scope
596 4:34p 🔵 hive-flow Sentinel Protocol Never Delivers Notifications via MCP Agent Path
597 " ⚖️ tmux Must Be Optional-Only for hive-flow Sentinel Notifications
598 4:40p 🟣 hive-flow provider-auth Phase 2 fixes implemented on branch codex-provider-auth-fixes
599 " 🔵 Phase 2 provider-auth verification: all 6 fixes confirmed real and correct
600 " 🔵 OpenRouter negative path live probe: AUTHENTICATION error + hooks_notify escalation confirmed, no secret leaked
601 " 🔵 Gemini CLI 0.42.0 auth gap: --prompt/--skip-trust flags are correct but cached OAuth is expired/invalid in headless mode
602 " 🔵 Full regression gate passed: cli 3611, providers 420, mcp 65, integration 42 — all matching Codex claims
603 4:54p 🔵 Independent Verification Initiated for hive-flow Provider Auth Fixes
604 " 🔵 Independent Verification Task: Provider-Auth Fixes in hive-flow
605 6:01p 🔵 Sentinel Protocol Live-Test for Agent-Task-Rewake Hook
### Jun 1, 2026
606 12:53a ✅ hive-flow README Accuracy Edits: Remove Stale Hive Flow vector Product References
608 1:10a 🔵 hive-flow README Contains Multiple Verified Stale Performance Claims
614 1:01p ✅ Graphify Fork Rebased and Published onto Upstream v8
615 " 🔵 Hive Flow Tools Require Execution from Hive Flow Repo
617 " 🔵 Vampyre Repo Has Two Pending Stashes and Unpruned Remote Branches
621 2:16p 🚨 CLAUDE.md, AGENTS.md, and .AUDIT/copilot-local-review.sh Publicly Exposed on origin
622 " 🔴 History Rewrite: Scrubbed CLAUDE.md, AGENTS.md, .AUDIT/copilot-local-review.sh from All Refs
623 " 🟣 pre-push Hook Added to Block Publishing of Private-Listed Files
624 " ✅ 9 Stale Local pr10-* and Archive Branches Deleted
S5 Vampyre repo housekeeping + privacy scrub: remove stale branches, audit/fix private file exposure on public GitHub origin (Jun 1 at 3:22 PM)
638 9:52p 🔵 BUG-6: Collision-Prone ID Generation in @hive-flow/cli/hooks
639 " 🔵 BUG-14: addHook() Uses CJS require() for ESM Modules in @hive-flow/cli/hooks
640 10:01p 🔵 Four Bug Classes Identified in @hive-flow/providers Package
643 10:34p 🔴 14 Bug Fixes Applied to hive-flow v3 Working Tree
646 10:59p 🔴 TypeScript Type Error in input-validator.ts After Security Bug Fixes
647 " 🔴 14 Verified Bug Fixes Committed Across hive-flow v3 Monorepo
### Jun 2, 2026
653 10:25a 🔵 claim-service.ts State Machine Identified as Untested — Test Suite Initiated
654 " 🔵 Sentinel module directory did not exist — config parsing was inlined in start.ts
655 " 🟣 Created sentinel config module: loadSentinelConfig, resolveSentinelConfigPath, SentinelConfigError
656 " 🔄 Refactored start.ts: replaced inline config logic with loadSentinelConfig, surfaces actionable errors
657 " 🟣 Added unit tests for sentinel config parsing and path resolution (6 tests, all green)
658 " 🟣 Added E2E tests for hive-flow start CLI entry point (3 tests, all green)
659 " 🔵 Full @hive-flow/cli test suite: 117 test files, 3713 tests, all passing after changes
660 10:39a 🟣 E2E + Unit Tests Planned for @hive-flow/cli Entry Points
662 10:46a 🟣 MCP Recorder Test Suite Planned for statusline
663 10:51a 🟣 Test Suite Planned for memory.ts Recorder
664 11:10a 🟣 Upstream 0.8.28 Fixes Integrated: Community-ID Determinism and tree-sitter-dm Optional
667 " 🔵 Copilot Pre-commit Gate Blocked Upstream Fix Three Times — Required Test Guard Evidence
668 " 🔴 DM Test Suite Guarded with pytest.importorskip for Optional tree-sitter-dm
665 11:24a 🟣 Comprehensive test suite planned for ClaimService state machine
679 9:23p 🔴 drain-notifications: COMPLETION supersedes CHECK-DUE dedup logic
682 10:15p 🟣 parseSummariesFromLines: Completion-Supersedes-Check Dedup Logic
### Jun 3, 2026
685 3:19a ⚖️ ~/.hive-flow/ Promoted to Primary Global Home (Human-Approved 2026-06-03)
686 " 🔵 Phase 2 Verification Hive Confirms Codex Current-State Map (~20/22 Claims)

Access 1902k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
