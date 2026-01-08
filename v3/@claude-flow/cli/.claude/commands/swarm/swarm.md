# swarm

Main swarm orchestration command for Claude Flow V3.

## 🚨 CRITICAL: Background Execution Pattern

**When spawning a swarm, Claude Code MUST:**

1. **Spawn ALL agents in background** using `run_in_background: true`
2. **Put ALL Task calls in ONE message** for parallel execution
3. **Tell user what's happening** with clear agent list
4. **STOP and WAIT** - don't add more tool calls or poll status

```javascript
// ✅ CORRECT: Background parallel agents in ONE message
Task({ prompt: "Research...", subagent_type: "researcher", run_in_background: true })
Task({ prompt: "Code...", subagent_type: "coder", run_in_background: true })
Task({ prompt: "Test...", subagent_type: "tester", run_in_background: true })

// Then TELL USER and STOP:
"I've launched 3 agents working in parallel. They'll report when done."
```

```javascript
// ❌ WRONG: Don't poll or check status
TaskOutput({ task_id: "..." })  // NO!
swarm status  // NO!
"Should I check on the agents?"  // NO!
```

## Usage
```bash
npx @claude-flow/cli@latest swarm <objective> [options]
```

## Options
- `--strategy <type>` - Execution strategy (research, development, analysis, testing)
- `--topology <type>` - Swarm topology (hierarchical, mesh, ring, star)
- `--max-agents <n>` - Maximum number of agents (default: 15)
- `--background` - Run agents in background (default: true)
- `--parallel` - Enable parallel execution (default: true)

## Examples
```bash
# Initialize swarm
npx @claude-flow/cli@latest swarm init --topology hierarchical

# Check status (ONLY when agents complete)
npx @claude-flow/cli@latest swarm status
```

## Agent Types by Task
| Task | Agents |
|------|--------|
| New Feature | researcher, architect, coder, tester, reviewer |
| Bug Fix | researcher, coder, tester |
| Refactor | architect, coder, reviewer |
| Security | security-architect, security-auditor, reviewer |
