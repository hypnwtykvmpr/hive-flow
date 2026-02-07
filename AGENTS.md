# Claude Flow V3 - Agent Guide

> **For OpenAI Codex CLI** - Agentic AI Foundation standard
> Skills: `$skill-name` | Config: `.agents/config.toml`

---

## 🚨 CRITICAL: CODEX DOES THE WORK, CLAUDE-FLOW ORCHESTRATES

```
┌─────────────────────────────────────────────────────────────┐
│  CLAUDE-FLOW = ORCHESTRATOR (tracks state, coordinates)     │
│  CODEX = WORKER (writes code, runs commands, implements)    │
└─────────────────────────────────────────────────────────────┘
```

### ❌ WRONG: Expecting claude-flow to execute tasks
```bash
npx claude-flow swarm start --objective "Build API"
# WRONG: Waiting for claude-flow to build the API
# Claude-flow does NOT execute code!
```

### ✅ CORRECT: Codex executes, claude-flow tracks
```bash
# 1. Tell claude-flow what you're doing (optional coordination)
npx claude-flow swarm init --topology hierarchical --max-agents 1
npx claude-flow agent spawn --type coder --name codex-worker

# 2. YOU (CODEX) DO THE ACTUAL WORK:
mkdir -p src
cat > src/api.ts << 'EOF'
export function hello() { return "Hello World"; }
EOF

# 3. Report to claude-flow what you did (optional)
npx claude-flow memory store --key "api-created" --value "src/api.ts" --namespace results
```

### The Division of Labor

| Component | Role | Examples |
|-----------|------|----------|
| **CODEX** | EXECUTES | Write files, run tests, create code, shell commands |
| **claude-flow** | ORCHESTRATES | Track agents, store memory, coordinate tasks |

### When to Use Claude-Flow Commands

| Use Case | Claude-Flow Command | Then Codex Does |
|----------|---------------------|-----------------|
| Track progress | `memory store --key "step1" --value "done"` | Continue to next step |
| Multi-step tasks | `task create --description "step 2"` | Execute step 2 |
| Store results | `memory store --key "output" --value "..."` | Move on |
| Coordinate | `swarm init` | Start working |

### Hello World - Correct Pattern

```bash
# STEP 1: Optional - register with orchestrator
npx claude-flow swarm init --topology mesh --max-agents 1

# STEP 2: CODEX DOES THE WORK
echo 'console.log("Hello World!");' > hello.js
node hello.js

# STEP 3: Optional - report completion
npx claude-flow memory store --key "hello-result" --value "printed Hello World" --namespace results
```

**REMEMBER: If you need something DONE, YOU do it. Claude-flow just tracks.**

---

## ⚡ QUICK COMMANDS (NO DISCOVERY NEEDED)

### Spawn N-Agent Swarm (Copy-Paste Ready)

```bash
# 5-AGENT SWARM - Run these commands in sequence:
npx claude-flow swarm init --topology hierarchical --max-agents 8
npx claude-flow agent spawn --type coordinator --name coord-1
npx claude-flow agent spawn --type coder --name coder-1
npx claude-flow agent spawn --type coder --name coder-2
npx claude-flow agent spawn --type tester --name tester-1
npx claude-flow agent spawn --type reviewer --name reviewer-1
npx claude-flow swarm start --objective "Your task here" --strategy development
```

### Common Swarm Patterns

| Task | Exact Command |
|------|---------------|
| Init hierarchical swarm | `npx claude-flow swarm init --topology hierarchical --max-agents 8` |
| Init mesh swarm | `npx claude-flow swarm init --topology mesh --max-agents 5` |
| Init V3 mode (15 agents) | `npx claude-flow swarm init --v3-mode` |
| Spawn coder | `npx claude-flow agent spawn --type coder --name coder-1` |
| Spawn tester | `npx claude-flow agent spawn --type tester --name tester-1` |
| Spawn coordinator | `npx claude-flow agent spawn --type coordinator --name coord-1` |
| Spawn architect | `npx claude-flow agent spawn --type architect --name arch-1` |
| Spawn reviewer | `npx claude-flow agent spawn --type reviewer --name rev-1` |
| Spawn researcher | `npx claude-flow agent spawn --type researcher --name res-1` |
| Start swarm | `npx claude-flow swarm start --objective "task" --strategy development` |
| Check swarm status | `npx claude-flow swarm status` |
| List agents | `npx claude-flow agent list` |
| Stop swarm | `npx claude-flow swarm stop` |

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
| Create task | `npx claude-flow task create --type implementation --description "desc"` |
| List tasks | `npx claude-flow task list` |
| Assign task | `npx claude-flow task assign TASK_ID --agent AGENT_NAME` |
| Task status | `npx claude-flow task status TASK_ID` |
| Cancel task | `npx claude-flow task cancel TASK_ID` |

### Memory Commands

| Action | Command |
|--------|---------|
| Store | `npx claude-flow memory store --key "key" --value "value" --namespace patterns` |
| Search | `npx claude-flow memory search --query "search terms"` |
| List | `npx claude-flow memory list --namespace patterns` |
| Retrieve | `npx claude-flow memory retrieve --key "key"` |

---

## 🚀 SWARM RECIPES

### Recipe 1: Hello World Test (COMPLETE EXAMPLE)

**Step 1: Setup coordination**
```bash
npx claude-flow swarm init --topology mesh --max-agents 5
npx claude-flow agent spawn --type coder --name hello-main
npx claude-flow swarm start --objective "Print hello world" --strategy development
```

**Step 2: YOU (Codex) execute the task**
```bash
# Create the hello world file
echo 'console.log("Hello World from Swarm!");' > /tmp/hello-swarm.js

# Execute it
node /tmp/hello-swarm.js
```

**Step 3: Report completion**
```bash
npx claude-flow memory store --key "hello-world-result" --value "Executed: Hello World from Swarm!" --namespace results
npx claude-flow task create --type implementation --description "Hello world executed successfully"
```

**Step 4: Verify**
```bash
npx claude-flow swarm status
npx claude-flow memory list --namespace results
```

### Recipe 1b: Hello World (Single Command Block)
```bash
# All-in-one execution
npx claude-flow swarm init --topology mesh --max-agents 5 && \
npx claude-flow agent spawn --type coder --name hello-main && \
npx claude-flow swarm start --objective "Print hello world" --strategy development && \
echo 'console.log("Hello World from Swarm!");' > /tmp/hello-swarm.js && \
node /tmp/hello-swarm.js && \
npx claude-flow memory store --key "hello-world-result" --value "Success" --namespace results
```

### Recipe 2: Feature Implementation (6 Agents)
```bash
npx claude-flow swarm init --topology hierarchical --max-agents 8
npx claude-flow agent spawn --type coordinator --name lead
npx claude-flow agent spawn --type architect --name arch
npx claude-flow agent spawn --type coder --name impl-1
npx claude-flow agent spawn --type coder --name impl-2
npx claude-flow agent spawn --type tester --name test
npx claude-flow agent spawn --type reviewer --name review
npx claude-flow swarm start --objective "Implement [feature]" --strategy development
```

### Recipe 3: Bug Fix (4 Agents)
```bash
npx claude-flow swarm init --topology hierarchical --max-agents 4
npx claude-flow agent spawn --type coordinator --name lead
npx claude-flow agent spawn --type researcher --name debug
npx claude-flow agent spawn --type coder --name fix
npx claude-flow agent spawn --type tester --name verify
npx claude-flow swarm start --objective "Fix [bug]" --strategy development
```

### Recipe 4: Security Audit (3 Agents)
```bash
npx claude-flow swarm init --topology hierarchical --max-agents 4
npx claude-flow agent spawn --type coordinator --name lead
npx claude-flow agent spawn --type security-architect --name audit
npx claude-flow agent spawn --type reviewer --name review
npx claude-flow swarm start --objective "Security audit" --strategy development
```

### Recipe 5: V3 Full Coordination (15 Agents)
```bash
npx claude-flow swarm init --v3-mode
npx claude-flow swarm coordinate --agents 15
```

---

## 📋 BEHAVIORAL RULES

- **YOU (CODEX) execute tasks** - claude-flow only orchestrates
- Do what is asked; nothing more, nothing less
- NEVER create files unless absolutely necessary
- ALWAYS prefer editing existing files
- NEVER save to root folder
- NEVER commit secrets or .env files
- ALWAYS read a file before editing it
- NEVER wait for claude-flow to "do work" - it doesn't execute, YOU do
- Use claude-flow commands to TRACK progress, not to EXECUTE tasks

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
npx claude-flow swarm init [--topology TYPE] [--max-agents N] [--v3-mode]
npx claude-flow swarm start --objective "task" --strategy [development|research]
npx claude-flow swarm status [SWARM_ID]
npx claude-flow swarm stop [SWARM_ID]
npx claude-flow swarm scale --count N
npx claude-flow swarm coordinate --agents N
```

### Agent Commands
```bash
npx claude-flow agent spawn --type TYPE --name NAME
npx claude-flow agent list [--filter active|idle|busy]
npx claude-flow agent status AGENT_ID
npx claude-flow agent stop AGENT_ID
npx claude-flow agent metrics [AGENT_ID]
npx claude-flow agent health
npx claude-flow agent logs AGENT_ID
```

### Task Commands
```bash
npx claude-flow task create --type TYPE --description "desc"
npx claude-flow task list [--all]
npx claude-flow task status TASK_ID
npx claude-flow task assign TASK_ID --agent AGENT_NAME
npx claude-flow task cancel TASK_ID
npx claude-flow task retry TASK_ID
```

### Memory Commands
```bash
npx claude-flow memory store --key KEY --value VALUE [--namespace NS]
npx claude-flow memory search --query "terms" [--namespace NS]
npx claude-flow memory list [--namespace NS]
npx claude-flow memory retrieve --key KEY [--namespace NS]
npx claude-flow memory init [--force]
```

### Hooks Commands
```bash
npx claude-flow hooks pre-task --description "task"
npx claude-flow hooks post-task --task-id ID --success true
npx claude-flow hooks route --task "task"
npx claude-flow hooks session-start --session-id ID
npx claude-flow hooks session-end --export-metrics true
npx claude-flow hooks worker list
npx claude-flow hooks worker dispatch --trigger audit
```

### System Commands
```bash
npx claude-flow init [--wizard] [--codex] [--full]
npx claude-flow daemon start
npx claude-flow daemon stop
npx claude-flow daemon status
npx claude-flow doctor [--fix]
npx claude-flow status
npx claude-flow mcp start
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
CLAUDE_FLOW_CONFIG=./claude-flow.config.json
CLAUDE_FLOW_LOG_LEVEL=info
CLAUDE_FLOW_MEMORY_BACKEND=hybrid
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

## 📚 SUPPORT

- Docs: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues

**Remember: Copy-paste commands, no discovery needed!**
