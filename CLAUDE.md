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

## 🤖 Complete Agent Reference (All 54 Agents)

### 🚀 Concurrent Agent Usage

**CRITICAL**: Always spawn multiple agents concurrently using the Task tool in a single message with exact agent names as shown below.

### 📋 All Available Agents by Category

#### Core Development Agents (5)
- **`coder`** - Implementation specialist for writing clean, efficient code
- **`reviewer`** - Code review and quality assurance specialist
- **`tester`** - Comprehensive testing and quality assurance specialist
- **`planner`** - Strategic planning and task orchestration agent
- **`researcher`** - Deep research and information gathering specialist

#### Swarm Coordination Agents (5)
- **`hierarchical-coordinator`** - Queen-led hierarchical swarm coordination with specialized worker delegation
- **`mesh-coordinator`** - Peer-to-peer mesh network swarm with distributed decision making and fault tolerance
- **`adaptive-coordinator`** - Dynamic topology switching coordinator with self-organizing swarm patterns and real-time optimization
- **`collective-intelligence-coordinator`** - Neural center orchestrating collective decision-making and shared intelligence
- **`swarm-memory-manager`** - Distributed memory coordination and optimization specialist

#### Consensus & Distributed Systems Agents (7)
- **`byzantine-coordinator`** - Coordinates Byzantine fault-tolerant consensus protocols with malicious actor detection
- **`raft-manager`** - Manages Raft consensus algorithm with leader election and log replication
- **`gossip-coordinator`** - Coordinates gossip-based consensus protocols for scalable eventually consistent systems
- **`consensus-builder`** - Byzantine fault-tolerant consensus and voting mechanism specialist
- **`crdt-synchronizer`** - Implements Conflict-free Replicated Data Types for eventually consistent state synchronization
- **`quorum-manager`** - Implements dynamic quorum adjustment and intelligent membership management
- **`security-manager`** - Implements comprehensive security mechanisms for distributed consensus protocols

#### Performance & Optimization Agents (5)
- **`perf-analyzer`** - Performance bottleneck analyzer for identifying and resolving workflow inefficiencies
- **`performance-benchmarker`** - Implements comprehensive performance benchmarking for distributed consensus protocols
- **`task-orchestrator`** - Central coordination agent for task decomposition, execution planning, and result synthesis
- **`memory-coordinator`** - Manage persistent memory across sessions and facilitate cross-agent memory sharing
- **`smart-agent`** - Intelligent agent coordination and dynamic spawning specialist

#### GitHub & Repository Management Agents (9)
- **`github-modes`** - Comprehensive GitHub integration modes for workflow orchestration, PR management, and repository coordination with batch optimization
- **`pr-manager`** - Complete pull request lifecycle management and GitHub workflow coordination
- **`code-review-swarm`** - Deploy specialized AI agents to perform comprehensive, intelligent code reviews that go beyond traditional static analysis
- **`issue-tracker`** - Intelligent issue management and project coordination with automated tracking, progress monitoring, and team coordination
- **`release-manager`** - Automated release coordination and deployment with ruv-swarm orchestration for seamless version management, testing, and deployment across multiple packages
- **`workflow-automation`** - GitHub Actions workflow automation agent that creates intelligent, self-organizing CI/CD pipelines with adaptive multi-agent coordination and automated optimization
- **`project-board-sync`** - Synchronize AI swarms with GitHub Projects for visual task management, progress tracking, and team coordination
- **`repo-architect`** - Repository structure optimization and multi-repo management with ruv-swarm coordination for scalable project architecture and development workflows
- **`multi-repo-swarm`** - Cross-repository swarm orchestration for organization-wide automation and intelligent collaboration

#### SPARC Methodology Agents (6)
- **`sparc-coord`** - SPARC methodology orchestrator for systematic development phase coordination
- **`sparc-coder`** - Transform specifications into working code with TDD practices
- **`specification`** - SPARC Specification phase specialist for requirements analysis
- **`pseudocode`** - SPARC Pseudocode phase specialist for algorithm design
- **`architecture`** - SPARC Architecture phase specialist for system design
- **`refinement`** - SPARC Refinement phase specialist for iterative improvement

#### Specialized Development Agents (8)
- **`backend-dev`** - Specialized agent for backend API development, including REST and GraphQL endpoints
- **`mobile-dev`** - Expert agent for React Native mobile application development across iOS and Android
- **`ml-developer`** - Specialized agent for machine learning model development, training, and deployment
- **`cicd-engineer`** - Specialized agent for GitHub Actions CI/CD pipeline creation and optimization
- **`api-docs`** - Expert agent for creating and maintaining OpenAPI/Swagger documentation
- **`system-architect`** - Expert agent for system architecture design, patterns, and high-level technical decisions
- **`code-analyzer`** - Advanced code quality analysis agent for comprehensive code reviews and improvements
- **`base-template-generator`** - Use this agent when you need to create foundational templates, boilerplate code, or starter configurations for new projects

#### Testing & Validation Agents (2)
- **`tdd-london-swarm`** - TDD London School specialist for mock-driven development within swarm coordination
- **`production-validator`** - Production validation specialist ensuring applications are fully implemented and deployment-ready

#### Migration & Planning Agents (2)
- **`migration-planner`** - Comprehensive migration plan for converting commands to agent-based system
- **`swarm-init`** - Swarm initialization and topology optimization specialist

#### Special Purpose Agents (4)
- **`general-purpose`** - General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks
- **`swarm-pr`** - Pull request swarm management agent that coordinates multi-agent code review, validation, and integration workflows
- **`release-swarm`** - Orchestrate complex software releases using AI swarms that handle everything from changelog generation to multi-platform deployment
- **`swarm-issue`** - GitHub issue-based swarm coordination agent that transforms issues into intelligent multi-agent tasks with automatic decomposition and progress tracking

#### Repository & Sync Agents (1)
- **`sync-coordinator`** - Multi-repository synchronization coordinator that manages version alignment, dependency synchronization, and cross-package integration

### 🎯 Concurrent Agent Spawning Examples

#### Full-Stack Development Swarm (8 agents)
```javascript
Task("System architecture design", "Design microservices architecture", "system-architect")
Task("Backend API development", "Build REST endpoints", "backend-dev")
Task("Mobile app development", "Create React Native app", "mobile-dev")
Task("Database implementation", "Design and implement database", "coder")
Task("API documentation", "Generate OpenAPI docs", "api-docs")
Task("CI/CD pipeline setup", "Configure GitHub Actions", "cicd-engineer")
Task("Performance testing", "Benchmark all endpoints", "performance-benchmarker")
Task("Production validation", "Validate deployment readiness", "production-validator")
```

#### SPARC TDD Swarm (7 agents)
```javascript
Task("Analyze requirements", "Extract user stories", "specification")
Task("Design algorithms", "Create solution pseudocode", "pseudocode")
Task("System architecture", "Design component structure", "architecture")
Task("TDD implementation", "Write tests and code", "sparc-coder")
Task("Mock-driven tests", "Create London school tests", "tdd-london-swarm")
Task("Iterative refinement", "Optimize implementation", "refinement")
Task("Production validation", "Ensure production ready", "production-validator")
```

#### GitHub Workflow Swarm (5 agents)
```javascript
Task("PR management", "Handle pull request lifecycle", "pr-manager")
Task("Code review coordination", "Orchestrate multi-agent review", "code-review-swarm")
Task("Issue management", "Track and triage issues", "issue-tracker")
Task("Release coordination", "Manage version releases", "release-manager")
Task("Workflow automation", "Setup CI/CD pipelines", "workflow-automation")
```

#### Distributed Systems Swarm (6 agents)
```javascript
Task("Byzantine consensus", "Implement fault tolerance", "byzantine-coordinator")
Task("Raft consensus", "Setup leader election", "raft-manager")
Task("Gossip protocols", "Configure epidemic dissemination", "gossip-coordinator")
Task("CRDT sync", "Implement conflict-free replication", "crdt-synchronizer")
Task("Security implementation", "Add cryptographic security", "security-manager")
Task("Performance analysis", "Identify bottlenecks", "perf-analyzer")
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