---
name: hive-flow-help
description: Show Hive-Flow commands and usage with batchtools optimization
---

# Hive-Flow Commands (Batchtools Optimized)

## Core Commands with Batch Operations

### System Management (Batch Operations)

- `npx hive-flow start` - Start orchestration system
- `npx hive-flow status` - Check system status
- `npx hive-flow monitor` - Real-time monitoring
- `npx hive-flow stop` - Stop orchestration

**Batch Operations:**

```bash
# Check multiple system components in parallel
npx hive-flow batch status --components "agents,tasks,memory,connections"

# Start multiple services concurrently
npx hive-flow batch start --services "monitor,scheduler,coordinator"
```

### Agent Management (Parallel Operations)

- `npx hive-flow agent spawn <type>` - Create new agent
- `npx hive-flow agent list` - List active agents
- `npx hive-flow agent info <id>` - Agent details
- `npx hive-flow agent terminate <id>` - Stop agent

**Batch Operations:**

```bash
# Spawn multiple agents in parallel
npx hive-flow agent batch-spawn "code:3,test:2,review:1"

# Get info for multiple agents concurrently
npx hive-flow agent batch-info "agent1,agent2,agent3"

# Terminate multiple agents
npx hive-flow agent batch-terminate --pattern "test-*"
```

### Task Management (Concurrent Processing)

- `npx hive-flow task create <type> "description"` - Create task
- `npx hive-flow task list` - List all tasks
- `npx hive-flow task status <id>` - Task status
- `npx hive-flow task cancel <id>` - Cancel task

**Batch Operations:**

```bash
# Create multiple tasks from file
npx hive-flow task batch-create tasks.json

# Check status of multiple tasks concurrently
npx hive-flow task batch-status --ids "task1,task2,task3"

# Process task queue in parallel
npx hive-flow task process-queue --parallel 5
```

### Memory Operations (Bulk Processing)

- `npx hive-flow memory store "key" "value"` - Store data
- `npx hive-flow memory query "search"` - Search memory
- `npx hive-flow memory stats` - Memory statistics
- `npx hive-flow memory export <file>` - Export memory

**Batch Operations:**

```bash
# Bulk store from JSON file
npx hive-flow memory batch-store data.json

# Parallel query across namespaces
npx hive-flow memory batch-query "search term" --namespaces "all"

# Export multiple namespaces concurrently
npx hive-flow memory batch-export --namespaces "project,agents,tasks"
```

### SPARC Development (Parallel Workflows)

- `npx hive-flow sparc modes` - List SPARC modes
- `npx hive-flow sparc run <mode> "task"` - Run mode
- `npx hive-flow sparc tdd "feature"` - TDD workflow
- `npx hive-flow sparc info <mode>` - Mode details

**Batch Operations:**

```bash
# Run multiple SPARC modes in parallel
npx hive-flow sparc batch-run --modes "spec:task1,architect:task2,code:task3"

# Execute parallel TDD for multiple features
npx hive-flow sparc batch-tdd features.json

# Analyze multiple components concurrently
npx hive-flow sparc batch-analyze --components "auth,api,database"
```

### Swarm Coordination (Enhanced Parallelization)

- `npx hive-flow swarm "task" --strategy <type>` - Start swarm
- `npx hive-flow swarm "task" --background` - Long-running swarm
- `npx hive-flow swarm "task" --monitor` - With monitoring

**Batch Operations:**

```bash
# Launch multiple swarms for different components
npx hive-flow swarm batch --config swarms.json

# Coordinate parallel swarm strategies
npx hive-flow swarm multi-strategy "project" --strategies "dev:frontend,test:backend,docs:api"
```

## Advanced Batch Examples

### Parallel Development Workflow:

```bash
# Initialize complete project setup in parallel
npx hive-flow batch init --actions "memory:setup,agents:spawn,tasks:queue"

# Run comprehensive analysis
npx hive-flow batch analyze --targets "code:quality,security:audit,performance:profile"
```

### Concurrent Testing Suite:

```bash
# Execute parallel test suites
npx hive-flow sparc batch-test --suites "unit,integration,e2e" --parallel

# Generate reports concurrently
npx hive-flow batch report --types "coverage,performance,security"
```

### Bulk Operations:

```bash
# Process multiple files in parallel
npx hive-flow batch process --files "*.ts" --action "lint,format,analyze"

# Parallel code generation
npx hive-flow batch generate --templates "api:users,api:products,api:orders"
```

## Performance Tips

- Use `--parallel` flag for concurrent operations
- Batch similar operations to reduce overhead
- Leverage `--async` for non-blocking execution
- Use `--stream` for real-time progress updates
- Enable `--cache` for repeated operations

## Monitoring Batch Operations

```bash
# Real-time batch monitoring
npx hive-flow monitor --batch

# Batch operation statistics
npx hive-flow stats --batch-ops

# Performance profiling
npx hive-flow profile --batch-execution
```
