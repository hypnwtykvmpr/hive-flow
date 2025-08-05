# Stream-JSON Chaining in Claude Flow

## Overview

Stream-JSON chaining enables Claude instances to pipe their outputs directly to other Claude instances, creating a seamless workflow where agents can build upon each other's work without intermediate storage.

## How It Works

When tasks have dependencies and stream-json output format is enabled, Claude Flow automatically:

1. Captures the stdout from the first agent
2. Pipes it directly to the stdin of the dependent agent
3. Adds `--input-format stream-json` flag to the receiving agent
4. Maintains the stream connection throughout execution

## Example Flow

```
Agent A (analyzer) → stdout (stream-json) → stdin → Agent B (processor) → stdout → stdin → Agent C (reporter)
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