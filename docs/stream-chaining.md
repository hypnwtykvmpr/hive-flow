# Stream-JSON Chaining in Claude Flow

## 🔁 Overview: Stream Chaining in Claude Code

**Stream chaining** in Claude Code is the technique of connecting multiple `claude -p` (non-interactive) processes using real-time **JSON streams**, allowing you to build **modular, recursive, multi-agent pipelines**.

Stream-JSON chaining enables Claude instances to pipe their outputs directly to other Claude instances, creating a seamless workflow where agents can build upon each other's work without intermediate storage.

## 🧱 How It Works

### Core Claude Code Flags

Claude Code supports two key flags that enable stream chaining:

* `--output-format stream-json`: emits newline-delimited JSON (`NDJSON`) with every token, turn, and tool interaction
* `--input-format stream-json`: accepts a stream of messages in NDJSON format, simulating a continuous conversation

By combining them:

```bash
claude -p --output-format stream-json "First task" \
  | claude -p --input-format stream-json --output-format stream-json "Process results" \
  | claude -p --input-format stream-json "Final report"
```

Each agent processes input, emits structured responses, and hands them off to the next agent in the chain.

### Automatic Chaining in Claude Flow

When tasks have dependencies and stream-json output format is enabled, Claude Flow automatically:

1. Detects task dependencies from workflow definitions
2. Captures the stdout stream from the dependency task
3. Pipes it directly to stdin of the dependent task
4. Adds `--input-format stream-json` flag to the receiving agent
5. Maintains the stream connection throughout execution

## 🔄 What You Can Do With Stream Chaining

* **Subagent orchestration**: planner → executor → reviewer
* **Recursive pipelines**: refinement loops, ablation agents, iterative optimization
* **Live feedback systems**: feed Claude output into a scoring or mutation agent
* **Task decomposition**: outer loop breaks work into subtasks, inner loop completes each
* **Multi-stage analysis**: data analysis → feature engineering → model training → validation
* **Complex workflows**: research → design → implementation → testing → documentation

## 🧠 Key Features

### Structured Message Types

Stream-JSON format includes structured message types:
- `init`: Session initialization
- `message`: Assistant/user messages
- `tool_use`: Tool invocations with parameters
- `tool_result`: Tool execution results
- `result`: Final task completion status

### Advanced Control Options
- Supports `--session` for session management
- `--max-turns` for granular conversation control
- Works seamlessly with shell scripts, `jq`, and Python SDKs
- Can simulate multi-turn conversation without REPL
- Preserves full context including reasoning and tool usage

### Example Stream-JSON Output

```json
{"type":"init","session_id":"abc123","timestamp":"2024-01-01T00:00:00Z"}
{"type":"message","role":"assistant","content":[{"type":"text","text":"Analyzing data..."}]}
{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}
{"type":"tool_result","output":"total 64\ndrwxr-xr-x  10 user  staff   320 Jan  1 00:00 ."}
{"type":"result","status":"success","duration_ms":1234}
```

## Enabling Stream Chaining

### Default Behavior
Stream chaining is **enabled by default** when using:
- Non-interactive mode (`--non-interactive` or default for mle-star)
- Stream-json output format (`--output-format stream-json`)
- Tasks with dependencies

### Commands

```bash
# MLE-STAR with automatic chaining
./claude-flow automation mle-star --dataset data.csv --target label --claude --output-format stream-json

# Custom workflow with chaining
./claude-flow automation run-workflow workflow.json --claude --non-interactive --output-format stream-json

# Disable chaining (agents run independently)
./claude-flow automation mle-star --dataset data.csv --target label --claude --output-format stream-json --no-chaining
```

## Benefits

1. **Context Preservation**: Full conversation history flows between agents
2. **Efficiency**: No intermediate file I/O required
3. **Real-time Processing**: Streaming output enables immediate processing
4. **Memory Efficiency**: No need to store large intermediate results

## Implementation Details

### Task Dependencies
Tasks must declare dependencies to enable chaining:

```json
{
  "tasks": [
    {
      "id": "task1",
      "name": "Analyze Data",
      "assignTo": "agent1"
    },
    {
      "id": "task2", 
      "name": "Process Results",
      "assignTo": "agent2",
      "depends": ["task1"]  // This enables chaining from task1
    }
  ]
}
```

### Agent Prompts
When chaining is enabled, agents should be aware they may receive input:

```json
{
  "claudePrompt": "You are receiving analysis results from the previous agent via stream-json. Process these insights and continue the chain..."
}
```

### Console Output
Look for these indicators:
- `🔗 Enabling stream chaining from task1 to task2`
- `🔗 Chaining: Piping output from previous agent to Agent Name`

## Manual Chaining

You can also manually chain Claude instances:

```bash
# Traditional piping
claude --print --output-format stream-json "Task 1" | \
claude --print --input-format stream-json --output-format stream-json "Task 2" | \
claude --print --input-format stream-json "Task 3"
```

## Limitations

1. Only works with `stream-json` output format
2. Requires non-interactive mode
3. Dependencies determine chaining order
4. Currently chains from the last dependency if multiple exist

## Future Enhancements

- Support for multiple input streams (merge/join)
- Conditional chaining based on output
- Stream filtering and transformation
- Parallel stream processing