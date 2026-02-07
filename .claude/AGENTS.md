# Dual-Mode Agent Orchestration

> **Claude Code + OpenAI Codex** - Unified multi-agent development
> Use Claude swarm interactively + Codex headless for parallel background work

---

## TL;DR - Dual Mode Architecture

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  CLAUDE CODE (Interactive)          CODEX (Headless Background)           ║
║  ────────────────────────────        ───────────────────────────           ║
║  • Direct conversation               • claude -p "task" &                  ║
║  • Real-time feedback                • Parallel execution                  ║
║  • Complex reasoning                 • Batch processing                    ║
║  • Architecture decisions            • Code generation                     ║
║                                                                            ║
║  CLAUDE-FLOW (Shared Orchestrator)                                         ║
║  ─────────────────────────────────                                         ║
║  • Swarm coordination (both use same MCP tools)                            ║
║  • Vector memory (shared patterns across sessions)                         ║
║  • Self-learning (patterns stored and retrieved)                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

---

## Dual-Mode Workflow

### Pattern 1: Interactive + Background Workers

```bash
# Claude Code (interactive) - You're talking to this
# Spawn background Codex workers for parallel tasks

claude -p "Implement user authentication module" --session-id auth-task &
claude -p "Write comprehensive test suite for auth" --session-id auth-tests &
claude -p "Create API documentation for auth endpoints" --session-id auth-docs &

# All three run in parallel, share memory via claude-flow
```

### Pattern 2: Swarm Coordination with Headless Agents

```bash
# Step 1: Initialize shared swarm (interactive Claude Code)
npx claude-flow swarm init --topology hierarchical --max-agents 8

# Step 2: Spawn headless Codex workers
claude -p "You are coder-1. Implement src/auth/login.ts. Use memory_search first." &
claude -p "You are coder-2. Implement src/auth/register.ts. Use memory_search first." &
claude -p "You are tester. Write tests for auth module. Wait for coders." &

# Step 3: Monitor and coordinate (interactive)
npx claude-flow swarm status
npx claude-flow memory list --namespace results
```

### Pattern 3: Learning-Enabled Parallel Execution

```bash
# Before spawning workers, search for patterns
npx claude-flow memory search --query "authentication patterns" --namespace patterns

# Spawn workers with learning context
claude -p "
CONTEXT: Found pattern 'jwt-auth-pattern' (score 0.85)
TASK: Implement JWT authentication following this pattern
AFTER: Store results with memory_store
" --session-id jwt-impl &

claude -p "
CONTEXT: Found pattern 'test-auth-pattern' (score 0.72)
TASK: Write auth tests following this pattern
AFTER: Store results with memory_store
" --session-id jwt-tests &

wait  # Wait for all background jobs

# Collect results
npx claude-flow memory list --namespace results
```

---

## MCP Tools (Shared Between Claude Code & Codex)

Both platforms use the same claude-flow MCP tools:

### Coordination Tools
| Tool | Purpose | Example |
|------|---------|---------|
| `swarm_init` | Initialize swarm | `swarm_init(topology="hierarchical")` |
| `agent_spawn` | Register agent | `agent_spawn(type="coder", name="worker-1")` |
| `swarm_status` | Check swarm state | `swarm_status()` |

### Memory Tools (Self-Learning)
| Tool | Purpose | Example |
|------|---------|---------|
| `memory_search` | Find patterns | `memory_search(query="auth patterns")` |
| `memory_store` | Save patterns | `memory_store(key="pattern-x", value="...", upsert=true)` |
| `memory_retrieve` | Get by key | `memory_retrieve(key="pattern-x")` |

### Hive Mind Tools (Advanced)
| Tool | Purpose | Example |
|------|---------|---------|
| `hive-mind_init` | Byzantine swarm | `hive-mind_init(queenId="queen-1")` |
| `hive-mind_spawn` | Spawn workers | `hive-mind_spawn(count=5, type="coder")` |
| `hive-mind_broadcast` | Message all | `hive-mind_broadcast(message="...")` |

---

## Headless Codex Commands

### Basic Headless Execution
```bash
# Single task
claude -p "Implement feature X"

# With model selection
claude -p --model haiku "Simple formatting task"
claude -p --model opus "Complex architecture decision"

# With output format
claude -p --output-format json "Analyze this code"
```

### Parallel Background Execution
```bash
# Spawn multiple in parallel
claude -p "Task 1: Research" &
claude -p "Task 2: Implement" &
claude -p "Task 3: Test" &
wait  # Wait for all

# With session continuation
claude -p --session-id "feature-123" "Start implementing"
claude -p --resume "feature-123" "Continue with tests"
```

### Key Flags
| Flag | Purpose |
|------|---------|
| `-p, --print` | Headless mode (non-interactive) |
| `--model <m>` | Select model (haiku/sonnet/opus) |
| `--session-id <id>` | Named session for resumption |
| `--resume <id>` | Continue previous session |
| `--output-format` | Output: text, json, stream-json |
| `--max-budget-usd` | Spending cap per invocation |
| `--allowedTools` | Restrict available tools |

---

## Self-Learning Workflow (Both Platforms)

### Before Starting Any Task
```bash
# Search for relevant patterns
npx claude-flow memory search --query "task keywords" --namespace patterns
```

### In Claude Code (Interactive)
```
Use tool: memory_search
  query: "authentication implementation patterns"
  namespace: "patterns"

# If score > 0.7, use that pattern
```

### In Codex (Headless Prompt)
```bash
claude -p "
STEP 1: Search memory for patterns
Use tool: memory_search with query='authentication' namespace='patterns'

STEP 2: If pattern found with score > 0.7, follow it

STEP 3: Implement the solution

STEP 4: Store successful pattern
Use tool: memory_store with key='pattern-new-auth' value='what worked' namespace='patterns' upsert=true
"
```

### After Completing Successfully
```bash
# Store pattern for future use
npx claude-flow memory store \
  --key "pattern-name" \
  --value "Description of what worked" \
  --namespace patterns \
  --upsert
```

---

## Agent Types (Available in Both)

### Core Agents
| Type | Use Case |
|------|----------|
| `coder` | Implementation |
| `tester` | Test creation |
| `reviewer` | Code review |
| `architect` | System design |
| `researcher` | Analysis |

### Specialized Agents
| Type | Use Case |
|------|----------|
| `security-architect` | Security design |
| `performance-engineer` | Optimization |
| `api-docs` | Documentation |
| `cicd-engineer` | DevOps |

---

## Example: Full Dual-Mode Feature Implementation

```bash
#!/bin/bash
# feature-impl.sh - Dual-mode feature implementation

FEATURE="user-authentication"

# 1. Initialize shared coordination
npx claude-flow swarm init --topology hierarchical --max-agents 6
npx claude-flow memory search --query "$FEATURE patterns" --namespace patterns

# 2. Spawn headless workers
claude -p "
You are the ARCHITECT for $FEATURE.
1. Search memory for similar patterns
2. Design the architecture in /tmp/$FEATURE/DESIGN.md
3. Store design decisions in memory
" --session-id "${FEATURE}-arch" &

claude -p "
You are CODER-1 for $FEATURE.
1. Wait for architecture (check memory every 10s)
2. Implement core logic in /tmp/$FEATURE/src/
3. Store completion status in memory
" --session-id "${FEATURE}-code1" &

claude -p "
You are CODER-2 for $FEATURE.
1. Wait for architecture (check memory every 10s)
2. Implement API endpoints in /tmp/$FEATURE/api/
3. Store completion status in memory
" --session-id "${FEATURE}-code2" &

claude -p "
You are the TESTER for $FEATURE.
1. Wait for coders to complete (check memory)
2. Write tests in /tmp/$FEATURE/tests/
3. Run tests and store results in memory
" --session-id "${FEATURE}-test" &

# 3. Wait and collect results
wait
echo "All workers completed"

# 4. Review results
npx claude-flow memory list --namespace results
npx claude-flow swarm status
```

---

## Configuration

### Claude Code Settings (.claude/settings.json)
```json
{
  "model": "claude-sonnet-4-5-20250514",
  "permissions": {
    "allow": ["Read", "Write", "Edit", "Bash"]
  }
}
```

### Codex Settings (~/.codex/config.toml)
```toml
model = "gpt-4"
approval_policy = "on-request"

[mcp_servers.claude-flow]
command = "npx"
args = ["claude-flow", "mcp", "start"]
enabled = true
```

---

## Best Practices

### When to Use Claude Code (Interactive)
- Complex architectural decisions
- Debugging with back-and-forth
- Real-time code review
- Exploratory development

### When to Use Codex (Headless)
- Parallel batch processing
- Background code generation
- Automated testing
- Documentation generation
- CI/CD integration

### Shared Memory Patterns
- Always search before starting
- Store successful patterns with `--upsert`
- Use consistent namespaces (`patterns`, `results`, `errors`)
- Include enough context for future retrieval

---

## Support

- Documentation: https://github.com/ruvnet/claude-flow
- Issues: https://github.com/ruvnet/claude-flow/issues

**Remember: Claude-flow coordinates, both Claude Code and Codex execute!**
