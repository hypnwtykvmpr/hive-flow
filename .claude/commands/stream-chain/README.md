# 🔗 Stream Chain Command

Connect multiple Claude instances via stream-json for powerful multi-agent pipelines.

## Overview

Stream chaining enables sequential execution of multiple Claude Code instances where each step receives the full output from the previous step, creating powerful workflows with 100% context preservation.

## Quick Start

```bash
# Run demo chain
claude-flow stream-chain demo

# Custom chain
claude-flow stream-chain run "analyze this" "improve it" "implement changes"

# Predefined pipeline
claude-flow stream-chain pipeline analysis
```

## Subcommands

### `run <prompt1> <prompt2> [...]`
Execute a custom stream chain with your prompts.

```bash
claude-flow stream-chain run \
  "Analyze the codebase" \
  "Identify top 3 issues" \
  "Generate fixes" \
  "Create tests"
```

### `demo`
Run a 3-step demonstration chain:
1. Write a Python function to reverse a string
2. Add type hints to the function
3. Add a docstring to the function

```bash
claude-flow stream-chain demo
claude-flow stream-chain demo --verbose
```

### `pipeline <type>`
Execute predefined pipelines for common workflows.

Available pipelines:
- **analysis** - Code analysis and improvement
- **refactor** - Automated refactoring workflow
- **test** - Comprehensive test generation
- **optimize** - Performance optimization

```bash
claude-flow stream-chain pipeline analysis
claude-flow stream-chain pipeline refactor --timeout 60
```

### `test`
Test stream chain connection and context preservation.

```bash
claude-flow stream-chain test
claude-flow stream-chain test --verbose
```

### `help`
Display comprehensive documentation.

```bash
claude-flow stream-chain help
```

## Options

- `--verbose` - Show detailed execution information
- `--timeout <seconds>` - Timeout per step (default: 30)
- `--debug` - Enable debug mode with full stream-json output

## How It Works

1. **Step 1** executes with `--output-format stream-json` to capture structured output
2. The assistant's response is extracted from the stream-json format
3. **Step 2** receives the previous output as context in its prompt
4. This continues for all steps in the chain
5. Each step has full context of all previous outputs

## Stream-JSON Format

Each step outputs newline-delimited JSON (NDJSON):

```json
{"type":"system","subtype":"init","session_id":"..."}
{"type":"assistant","message":{"content":[{"text":"..."}]}}
{"type":"tool_use","name":"...","input":{}}
{"type":"result","status":"success","duration_ms":1234}
```

## Examples

### Code Improvement Chain
```bash
claude-flow stream-chain run \
  "Analyze this JavaScript file for issues" \
  "Suggest improvements following best practices" \
  "Implement the top 3 suggestions" \
  "Add comprehensive tests"
```

### Documentation Pipeline
```bash
claude-flow stream-chain run \
  "Extract API endpoints from the codebase" \
  "Generate OpenAPI specification" \
  "Create usage examples" \
  "Write developer guide"
```

### Refactoring Workflow
```bash
claude-flow stream-chain pipeline refactor --verbose
```

### Custom Analysis
```bash
claude-flow stream-chain run \
  "Profile performance bottlenecks" \
  "Analyze database queries" \
  "Suggest optimizations" \
  "Generate implementation plan"
```

## Pipeline Details

### Analysis Pipeline
```bash
claude-flow stream-chain pipeline analysis
```
Steps:
1. Analyze current directory structure
2. Identify potential improvements and issues
3. Generate detailed report with recommendations

### Refactor Pipeline
```bash
claude-flow stream-chain pipeline refactor
```
Steps:
1. Find code that needs refactoring
2. Create prioritized refactoring plan
3. Provide refactored code examples

### Test Pipeline
```bash
claude-flow stream-chain pipeline test
```
Steps:
1. Analyze code coverage
2. Design comprehensive test cases
3. Generate test implementations

### Optimize Pipeline
```bash
claude-flow stream-chain pipeline optimize
```
Steps:
1. Profile for performance bottlenecks
2. Identify optimization opportunities
3. Provide optimized implementations

## Performance

- **Latency**: ~10-30s per step depending on complexity
- **Context**: 100% preservation between steps
- **Memory**: O(1) constant via streaming
- **Speed**: 40-60% faster than file-based approaches

## Background Execution

Stream chains can run in the background, allowing you to continue working while complex pipelines execute.

### Background Mode Options

#### Using Keyboard Shortcut
When Claude suggests a stream-chain command, press `Ctrl+B` to run it in background:
```bash
# Claude suggests:
claude-flow stream-chain pipeline analysis

# Press Ctrl+B instead of Enter
→ Command running in background with ID: bash_1
```

#### Using --background Flag
```bash
claude-flow stream-chain run \
  "Analyze codebase" \
  "Generate report" \
  --background

# Returns immediately with:
→ Stream chain running in background with ID: bash_2
```

#### Using --bg Flag (shorthand)
```bash
claude-flow stream-chain demo --bg
```

### Monitoring Background Chains

#### Check Status
```bash
claude-flow stream-chain monitor
# Or use /bashes in interactive mode
```

Shows:
- All running stream chains
- Current step being executed
- Progress through pipeline
- Estimated time remaining

#### View Output
```bash
# Check specific chain output
claude-flow stream-chain output bash_1

# Filter for errors
claude-flow stream-chain output bash_1 --filter "error|failed"
```

#### Kill Background Chain
```bash
# Kill specific chain
claude-flow stream-chain kill bash_1

# Kill all chains
claude-flow stream-chain kill --all
```

### Background Chain Management

Background chains are tracked in `.claude-flow/stream-chains.json`:
```json
{
  "stream_1755021020133": {
    "command": "stream-chain pipeline analysis",
    "pid": 12345,
    "startTime": "2025-08-12T10:00:00Z",
    "status": "running",
    "currentStep": 2,
    "totalSteps": 3
  }
}
```

### Practical Background Examples

#### Long Analysis Pipeline
```bash
# Start analysis in background
claude-flow stream-chain pipeline analysis --bg --verbose

# Continue with other work
claude-flow pair --start

# Check analysis progress
claude-flow stream-chain monitor

# Get results when complete
claude-flow stream-chain output stream_1755021020133
```

#### Parallel Pipelines
```bash
# Run multiple pipelines simultaneously
claude-flow stream-chain pipeline test --bg
claude-flow stream-chain pipeline optimize --bg
claude-flow stream-chain pipeline refactor --bg

# Monitor all
claude-flow stream-chain monitor --watch
```

#### CI/CD Integration
```bash
# Non-blocking pipeline execution
claude-flow stream-chain run \
  "Lint code" \
  "Run tests" \
  "Build production" \
  "Deploy to staging" \
  --background \
  --on-complete "notify-slack" \
  --on-error "rollback"
```

## Advanced Usage

### Extended Timeout
```bash
claude-flow stream-chain run \
  "Complex analysis task" \
  "Detailed implementation" \
  --timeout 60
```

### Verbose Mode
```bash
claude-flow stream-chain demo --verbose
```
Shows:
- Full command lines being executed
- Content preview from each step
- Stream-json parsing details

### Debug Mode
```bash
claude-flow stream-chain demo --debug --verbose
```
Shows raw stream-json messages between steps.

### Background with Monitoring
```bash
# Start in background with auto-monitoring
claude-flow stream-chain pipeline analysis \
  --background \
  --monitor \
  --alert-on-error
```

## Integration

### With Scripts
```bash
#!/bin/bash
result=$(claude-flow stream-chain run \
  "Analyze security vulnerabilities" \
  "Generate fixes" \
  --timeout 45)
echo "$result"
```

### With CI/CD
```yaml
# GitHub Actions
- name: Run Analysis Pipeline
  run: |
    claude-flow stream-chain pipeline analysis --verbose
```

### With Make
```makefile
analyze:
	claude-flow stream-chain pipeline analysis

refactor:
	claude-flow stream-chain pipeline refactor --timeout 60
```

## Troubleshooting

### "Command not found"
Ensure Claude Code is installed:
```bash
npm install -g @anthropic-ai/claude-code
```

### "Step timed out"
Increase timeout:
```bash
claude-flow stream-chain run "..." "..." --timeout 60
```

### "Context not preserved"
Verify with test command:
```bash
claude-flow stream-chain test --verbose
```

## Configuration

Configure defaults in `.claude-flow/config.json`:

```json
{
  "streamChain": {
    "defaultTimeout": 30,
    "verbose": false,
    "debug": false,
    "pipelines": {
      "custom": {
        "name": "Custom Pipeline",
        "prompts": [
          "Step 1 prompt",
          "Step 2 prompt",
          "Step 3 prompt"
        ]
      }
    }
  }
}
```

## Best Practices

1. **Start Simple**: Test with 2-3 step chains first
2. **Clear Prompts**: Make each step's goal explicit
3. **Reasonable Timeouts**: Allow enough time for complex tasks
4. **Use Pipelines**: Leverage predefined pipelines for common tasks
5. **Monitor Progress**: Use verbose mode to track execution

## Related Commands

- `swarm` - Multi-agent coordination
- `hive-mind` - Collective intelligence
- `sparc` - Development methodology
- `pipeline` - Other pipeline commands