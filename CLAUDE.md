# Claude Code Configuration - SPARC Development Environment (Batchtools Optimized)

## 🚨 CRITICAL: Concurrent Execution for ALL Actions

**ABSOLUTE RULE**: ALL operations MUST be concurrent/parallel in a single message.

### 🔴 MANDATORY CONCURRENT PATTERNS:
1. **TodoWrite**: ALWAYS batch ALL todos in ONE call (5-10+ todos minimum)
2. **Task tool**: ALWAYS spawn ALL agents in ONE message with full instructions
3. **File operations**: ALWAYS batch ALL reads/writes/edits in ONE message
4. **Bash commands**: ALWAYS batch ALL terminal operations in ONE message
5. **Memory operations**: ALWAYS batch ALL memory store/retrieve in ONE message

### ⚡ GOLDEN RULE: "1 MESSAGE = ALL RELATED OPERATIONS"

**✅ CORRECT concurrent execution:**
```javascript
// Everything in ONE message
[Single Message]:
  - TodoWrite { todos: [10+ todos with all statuses/priorities] }
  - Task("Agent 1 with full instructions and hooks")
  - Task("Agent 2 with full instructions and hooks")
  - Task("Agent 3 with full instructions and hooks")
  - Read("file1.js"), Read("file2.js")
  - Write("output1.js", content), Write("output2.js", content)
  - Bash("npm install"), Bash("npm test"), Bash("npm run build")
```

**❌ WRONG sequential execution:**
```javascript
// Multiple messages (NEVER DO THIS)
Message 1: TodoWrite { todos: [single todo] }
Message 2: Task("Agent 1")
Message 3: Task("Agent 2")
// This is 6x slower and breaks coordination!
```

## Project Overview

This project uses the SPARC (Specification, Pseudocode, Architecture, Refinement, Completion) methodology for systematic Test-Driven Development with AI assistance through Claude-Flow orchestration.

**🚀 Batchtools Optimization Enabled**: Optimized prompts and parallel processing for improved performance.

## 🎯 Claude Code vs MCP Tools Separation

### ✅ Claude Code ALWAYS Handles:
- 🔧 **ALL file operations** (Read, Write, Edit, MultiEdit, Glob, Grep)
- 💻 **ALL code generation** and programming tasks
- 🖥️ **ALL bash commands** and system operations
- 🏗️ **ALL actual implementation** work
- 📝 **ALL TodoWrite** and task management
- 🔄 **ALL git operations** (commit, push, merge)
- 📦 **ALL package management** (npm, pip, etc.)
- 🧪 **ALL testing** and validation

### 🧠 Claude Flow MCP Tools ONLY Handle:
- 🎯 **Coordination only** - Planning Claude Code's actions
- 💾 **Memory management** - Storing decisions and context
- 🤖 **Neural features** - Learning from Claude Code's work
- 📊 **Performance tracking** - Monitoring Claude Code's efficiency
- 🐝 **Swarm orchestration** - Coordinating multiple Claude Code instances
- 🔗 **GitHub integration** - Advanced repository coordination

**⚠️ Key Principle**: MCP tools coordinate, Claude Code executes. Think of MCP tools as the "brain" that plans, while Claude Code is the "hands" that do all actual work.

## SPARC Development Commands

### Core SPARC Commands
- `npx claude-flow sparc modes` - List all available SPARC development modes
- `npx claude-flow sparc run <mode> "<task>"` - Execute specific SPARC mode
- `npx claude-flow sparc tdd "<feature>"` - Run complete TDD workflow
- `npx claude-flow sparc info <mode>` - Get detailed information about a mode

### Batchtools Commands (Optimized)
- `npx claude-flow sparc batch <modes> "<task>"` - Execute multiple SPARC modes in parallel
- `npx claude-flow sparc pipeline "<task>"` - Execute full SPARC pipeline with parallel processing
- `npx claude-flow sparc concurrent <mode> "<tasks-file>"` - Process multiple tasks concurrently

### Standard Build Commands
- `npm run build` - Build the project
- `npm run test` - Run the test suite
- `npm run lint` - Run linter and format checks
- `npm run typecheck` - Run TypeScript type checking

## SPARC Methodology Workflow

### 1. Specification Phase
```bash
npx claude-flow sparc run spec-pseudocode "Define requirements" --parallel
```
Simultaneously analyze multiple requirement sources, validate constraints in parallel.

### 2. Pseudocode Phase
```bash
npx claude-flow sparc run spec-pseudocode "Create pseudocode" --batch-optimize
```
Process multiple algorithm patterns concurrently, validate logic flows in parallel.

### 3. Architecture Phase
```bash
npx claude-flow sparc run architect "Design architecture" --parallel
```
Generate multiple architectural alternatives simultaneously, validate integration points.

### 4. Refinement Phase (TDD)
```bash
npx claude-flow sparc tdd "implement feature" --batch-tdd
```
Generate multiple test scenarios simultaneously, implement and validate code in parallel.

### 5. Completion Phase
```bash
npx claude-flow sparc run integration "integrate components" --parallel
```
Run integration tests in parallel, generate documentation concurrently.

## 🤖 Available Agents (54 Total)

### 🚀 Concurrent Agent Usage

**CRITICAL**: Always spawn multiple agents concurrently using the Task tool in a single message.

### 📋 Agent Quick Reference

#### Core Development (5)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `coder` | Implementation specialist | Code generation |
| `reviewer` | Code quality assurance | Review & validation |
| `tester` | Test creation and validation | Test suites |
| `planner` | Strategic planning | Task breakdown |
| `researcher` | Information gathering | Research & analysis |

#### Swarm Coordination (5)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `hierarchical-coordinator` | Queen-led coordination | Complex hierarchies |
| `mesh-coordinator` | Peer-to-peer networks | Distributed tasks |
| `adaptive-coordinator` | Dynamic topology | Self-organizing |
| `collective-intelligence-coordinator` | Hive-mind intelligence | Group decisions |
| `swarm-memory-manager` | Distributed memory | State management |

#### Consensus & Distributed (7)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `byzantine-coordinator` | Byzantine fault tolerance | Security |
| `raft-manager` | Leader election protocols | Consensus |
| `gossip-coordinator` | Epidemic dissemination | Distribution |
| `consensus-builder` | Decision-making algorithms | Voting |
| `crdt-synchronizer` | Conflict-free replication | Sync |
| `quorum-manager` | Dynamic quorum management | Decisions |
| `security-manager` | Cryptographic security | Protection |

#### Performance & Optimization (5)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `perf-analyzer` | Bottleneck identification | Analysis |
| `performance-benchmarker` | Performance testing | Benchmarks |
| `task-orchestrator` | Workflow optimization | Coordination |
| `memory-coordinator` | Memory management | Resource handling |
| `smart-agent` | Intelligent coordination | Automation |

#### GitHub & Repository (9)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `github-modes` | Comprehensive GitHub integration | All GitHub ops |
| `pr-manager` | Pull request management | PR workflows |
| `code-review-swarm` | Multi-agent code review | Reviews |
| `issue-tracker` | Issue management | Tracking |
| `release-manager` | Release coordination | Deployments |
| `workflow-automation` | CI/CD automation | Pipelines |
| `project-board-sync` | Project tracking | Boards |
| `repo-architect` | Repository optimization | Structure |
| `multi-repo-swarm` | Cross-repository coordination | Multi-repo |

#### SPARC Methodology (6)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `sparc-coord` | SPARC orchestration | Methodology |
| `sparc-coder` | TDD implementation | Test-driven |
| `specification` | Requirements analysis | Specs |
| `pseudocode` | Algorithm design | Logic |
| `architecture` | System design | Structure |
| `refinement` | Iterative improvement | Enhancement |

#### Specialized Development (8)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `backend-dev` | API development | Backend |
| `mobile-dev` | React Native development | Mobile |
| `ml-developer` | Machine learning | AI/ML |
| `cicd-engineer` | CI/CD pipelines | DevOps |
| `api-docs` | OpenAPI documentation | Docs |
| `system-architect` | High-level design | Architecture |
| `code-analyzer` | Code quality analysis | Analysis |
| `base-template-generator` | Boilerplate creation | Templates |

#### Testing & Validation (2)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `tdd-london-swarm` | Mock-driven TDD | London school |
| `production-validator` | Real implementation validation | Production |

#### Migration & Planning (2)
| Agent | Purpose | Usage |
|-------|---------|--------|
| `migration-planner` | System migrations | Migrations |
| `swarm-init` | Topology initialization | Setup |

### 🎯 Concurrent Agent Patterns

#### Full-Stack Development Swarm (8 agents)
```bash
Task("System architecture", "...", "system-architect")
Task("Backend APIs", "...", "backend-dev")
Task("Frontend mobile", "...", "mobile-dev")
Task("Database design", "...", "coder")
Task("API documentation", "...", "api-docs")
Task("CI/CD pipeline", "...", "cicd-engineer")
Task("Performance testing", "...", "performance-benchmarker")
Task("Production validation", "...", "production-validator")
```

#### SPARC TDD Swarm (7 agents)
```bash
Task("Requirements spec", "...", "specification")
Task("Algorithm design", "...", "pseudocode")
Task("System architecture", "...", "architecture")
Task("TDD implementation", "...", "sparc-coder")
Task("London school tests", "...", "tdd-london-swarm")
Task("Iterative refinement", "...", "refinement")
Task("Production validation", "...", "production-validator")
```

### ⚡ Performance Optimization

**Agent Selection Strategy:**
- **High Priority**: Use 3-5 agents max for critical path
- **Medium Priority**: Use 5-8 agents for complex features
- **Large Projects**: Use 8+ agents with proper coordination

**Memory Management:**
- Use `memory-coordinator` for cross-agent state
- Implement `swarm-memory-manager` for distributed coordination
- Apply `collective-intelligence-coordinator` for decision-making

## 🚨 MANDATORY TODO AND TASK BATCHING

**CRITICAL RULES:**

1. **TodoWrite** MUST ALWAYS include ALL todos in ONE call (5-10+ todos)
2. **Task** tool calls MUST be batched - spawn multiple agents in ONE message
3. **NEVER** update todos one by one - this breaks parallel coordination
4. **NEVER** spawn agents sequentially - ALL agents spawn together

**✅ CORRECT TodoWrite usage:**
```javascript
TodoWrite { todos: [
  { id: "1", content: "Initialize system", status: "completed", priority: "high" },
  { id: "2", content: "Analyze requirements", status: "in_progress", priority: "high" },
  { id: "3", content: "Design architecture", status: "pending", priority: "high" },
  { id: "4", content: "Implement core", status: "pending", priority: "high" },
  { id: "5", content: "Build features", status: "pending", priority: "medium" },
  { id: "6", content: "Write tests", status: "pending", priority: "medium" },
  { id: "7", content: "Add monitoring", status: "pending", priority: "medium" },
  { id: "8", content: "Documentation", status: "pending", priority: "low" },
  { id: "9", content: "Performance tuning", status: "pending", priority: "low" },
  { id: "10", content: "Deploy to production", status: "pending", priority: "high" }
]}
```

## 🎯 AGENT COUNT CONFIGURATION

**Dynamic Agent Count Rules:**

1. **Check CLI Arguments First**: If user runs `npx claude-flow@alpha --agents 5`, use 5 agents
2. **Auto-Decide if No Args**: Without CLI args, analyze task complexity:
   - Simple tasks (1-3 components): 3-4 agents
   - Medium tasks (4-6 components): 5-7 agents
   - Complex tasks (7+ components): 8-12 agents
3. **Agent Type Distribution**: Balance agent types based on task

## 📋 MANDATORY AGENT COORDINATION PROTOCOL

### Every Agent MUST Follow This Protocol:

**1️⃣ BEFORE Starting Work:**
```bash
npx claude-flow@alpha hooks pre-task --description "[agent task]" --auto-spawn-agents false
npx claude-flow@alpha hooks session-restore --session-id "swarm-[id]" --load-memory true
```

**2️⃣ DURING Work (After EVERY Major Step):**
```bash
npx claude-flow@alpha hooks post-edit --file "[filepath]" --memory-key "swarm/[agent]/[step]"
npx claude-flow@alpha hooks notify --message "[what was done]" --telemetry true
npx claude-flow@alpha hooks pre-search --query "[what to check]" --cache-results true
```

**3️⃣ AFTER Completing Work:**
```bash
npx claude-flow@alpha hooks post-task --task-id "[task]" --analyze-performance true
npx claude-flow@alpha hooks session-end --export-metrics true --generate-summary true
```

### 🎯 AGENT PROMPT TEMPLATE

When spawning agents, ALWAYS include these coordination instructions:

```
You are the [Agent Type] agent in a coordinated swarm.

MANDATORY COORDINATION:
1. START: Run `npx claude-flow@alpha hooks pre-task --description "[your task]"`
2. DURING: After EVERY file operation, run `npx claude-flow@alpha hooks post-edit --file "[file]" --memory-key "agent/[step]"`
3. MEMORY: Store ALL decisions using `npx claude-flow@alpha hooks notify --message "[decision]"`
4. END: Run `npx claude-flow@alpha hooks post-task --task-id "[task]" --analyze-performance true`

Your specific task: [detailed task description]

REMEMBER: Coordinate with other agents by checking memory BEFORE making decisions!
```

## 🚀 Quick Setup (Stdio MCP - Recommended)

### 1. Add MCP Server
```bash
# Add Claude Flow MCP server to Claude Code using stdio
claude mcp add claude-flow npx claude-flow@alpha mcp start
```

### 2. Use MCP Tools for Coordination

**Initialize a swarm:**
- Use `mcp__claude-flow__swarm_init` to set up coordination topology
- Choose: mesh, hierarchical, ring, or star

**Spawn agents:**
- Use `mcp__claude-flow__agent_spawn` to create specialized coordinators
- Agent types represent different thinking patterns, not actual coders

**Orchestrate tasks:**
- Use `mcp__claude-flow__task_orchestrate` to coordinate complex workflows
- This breaks down tasks for Claude Code to execute systematically

## Available MCP Tools

### Coordination Tools:
- `mcp__claude-flow__swarm_init` - Set up coordination topology
- `mcp__claude-flow__agent_spawn` - Create cognitive patterns
- `mcp__claude-flow__task_orchestrate` - Break down complex tasks

### Monitoring Tools:
- `mcp__claude-flow__swarm_status` - Monitor coordination
- `mcp__claude-flow__agent_list` - View active patterns
- `mcp__claude-flow__agent_metrics` - Track performance
- `mcp__claude-flow__task_status` - Check progress
- `mcp__claude-flow__task_results` - Review outcomes

### Memory & Neural Tools:
- `mcp__claude-flow__memory_usage` - Persistent memory
- `mcp__claude-flow__neural_status` - Neural patterns
- `mcp__claude-flow__neural_train` - Improve coordination
- `mcp__claude-flow__neural_patterns` - Analyze approaches

### GitHub Integration Tools:
- `mcp__claude-flow__github_swarm` - GitHub management
- `mcp__claude-flow__repo_analyze` - Repository analysis
- `mcp__claude-flow__pr_enhance` - PR improvements
- `mcp__claude-flow__issue_triage` - Issue classification
- `mcp__claude-flow__code_review` - Automated review

### System Tools:
- `mcp__claude-flow__benchmark_run` - Measure efficiency
- `mcp__claude-flow__features_detect` - Available features
- `mcp__claude-flow__swarm_monitor` - Real-time tracking

## 📊 Visual Progress Format

```
📊 Progress Overview
├── Total Tasks: X
├── ✅ Completed: X (X%)
├── 🔄 In Progress: X (X%)
├── ⭕ Todo: X (X%)
└── ❌ Blocked: X (X%)

Priority indicators: 🔴 HIGH/CRITICAL, 🟡 MEDIUM, 🟢 LOW
```

## 🎨 Visual Swarm Status

```
🐝 Swarm Status: ACTIVE
├── 🏗️ Topology: hierarchical
├── 👥 Agents: 6/8 active
├── ⚡ Mode: parallel execution
├── 📊 Tasks: 12 total (4 complete, 6 in-progress, 2 pending)
└── 🧠 Memory: 15 coordination points stored
```

## Best Practices

### ✅ DO:
- Use MCP tools to coordinate Claude Code's approach
- Let the swarm break down problems into manageable pieces
- Use memory tools to maintain context across sessions
- Monitor coordination effectiveness with status tools
- Train neural patterns for better coordination
- Leverage GitHub tools for repository management

### ❌ DON'T:
- Expect agents to write code (Claude Code does all implementation)
- Use MCP tools for file operations (use Claude Code's native tools)
- Try to make agents execute bash commands (Claude Code handles this)
- Confuse coordination with execution (MCP coordinates, Claude executes)

## Performance Benefits

When using Claude Flow coordination with Claude Code:
- **84.8% SWE-Bench solve rate** - Better problem-solving
- **32.3% token reduction** - Efficient task breakdown
- **2.8-4.4x speed improvement** - Parallel coordination
- **27+ neural models** - Diverse cognitive approaches
- **GitHub automation** - Streamlined repository management

## Claude Code Hooks Integration

### Pre-Operation Hooks
- **Auto-assign agents** before file edits based on file type
- **Validate commands** before execution for safety
- **Prepare resources** automatically for complex operations
- **Optimize topology** based on task complexity analysis
- **Cache searches** for improved performance
- **GitHub context** loading for repository operations

### Post-Operation Hooks
- **Auto-format code** using language-specific formatters
- **Train neural patterns** from successful operations
- **Update memory** with operation context
- **Analyze performance** and identify bottlenecks
- **Track token usage** for efficiency metrics
- **Sync GitHub** state for consistency

### Session Management
- **Generate summaries** at session end
- **Persist state** across Claude Code sessions
- **Track metrics** for continuous improvement
- **Restore previous** session context automatically
- **Export workflows** for reuse

### Advanced Features (v2.0.0!)
- **🚀 Automatic Topology Selection** - Optimal swarm structure
- **⚡ Parallel Execution** - 2.8-4.4x speed improvements
- **🧠 Neural Training** - Continuous learning
- **📊 Bottleneck Analysis** - Real-time optimization
- **🤖 Smart Auto-Spawning** - Zero manual agent management
- **🛡️ Self-Healing Workflows** - Automatic error recovery
- **💾 Cross-Session Memory** - Persistent learning & context
- **🔗 GitHub Integration** - Repository-aware swarms

### Configuration
Hooks are pre-configured in `.claude/settings.json`. Key features:
- Automatic agent assignment for different file types
- Code formatting on save
- Neural pattern learning from edits
- Session state persistence
- Performance tracking and optimization
- Intelligent caching and token reduction
- GitHub workflow automation

## Integration Tips

1. **Start Simple**: Begin with basic swarm init and single agent
2. **Scale Gradually**: Add more agents as task complexity increases
3. **Use Memory**: Store important decisions and context
4. **Monitor Progress**: Regular status checks ensure effective coordination
5. **Train Patterns**: Let neural agents learn from successful coordinations
6. **Enable Hooks**: Use the pre-configured hooks for automation
7. **GitHub First**: Use GitHub tools for repository management

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues
- Examples: https://github.com/ruvnet/claude-flow/tree/main/examples

---

**Remember**: Claude Flow coordinates, Claude Code creates! Start with `mcp__claude-flow__swarm_init` to enhance your development workflow.