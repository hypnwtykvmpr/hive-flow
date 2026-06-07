---
name: hive-flow-help
description: Show Hive-Flow commands and usage
---

# Hive-Flow Commands

## 🌊 Hive-Flow: Agent Orchestration Platform

Claude-Flow is the ultimate multi-terminal orchestration platform that revolutionizes how you work with Claude Code.

## Core Commands

### 🚀 System Management
- `./hive-flow start` - Start orchestration system
- `./hive-flow start --ui` - Start with interactive process management UI
- `./hive-flow status` - Check system status
- `./hive-flow monitor` - Real-time monitoring
- `./hive-flow stop` - Stop orchestration

### 🤖 Agent Management
- `./hive-flow agent spawn <type>` - Create new agent
- `./hive-flow agent list` - List active agents
- `./hive-flow agent info <id>` - Agent details
- `./hive-flow agent terminate <id>` - Stop agent

### 📋 Task Management
- `./hive-flow task create <type> "description"` - Create task
- `./hive-flow task list` - List all tasks
- `./hive-flow task status <id>` - Task status
- `./hive-flow task cancel <id>` - Cancel task
- `./hive-flow task workflow <file>` - Execute workflow

### 🧠 Memory Operations
- `./hive-flow memory store "key" "value"` - Store data
- `./hive-flow memory query "search"` - Search memory
- `./hive-flow memory stats` - Memory statistics
- `./hive-flow memory export <file>` - Export memory
- `./hive-flow memory import <file>` - Import memory

### ⚡ SPARC Development
- `./hive-flow sparc "task"` - Run SPARC orchestrator
- `./hive-flow sparc modes` - List all 17+ SPARC modes
- `./hive-flow sparc run <mode> "task"` - Run specific mode
- `./hive-flow sparc tdd "feature"` - TDD workflow
- `./hive-flow sparc info <mode>` - Mode details

### 🐝 Swarm Coordination
- `./hive-flow swarm "task" --strategy <type>` - Start swarm
- `./hive-flow swarm "task" --background` - Long-running swarm
- `./hive-flow swarm "task" --monitor` - With monitoring
- `./hive-flow swarm "task" --ui` - Interactive UI
- `./hive-flow swarm "task" --distributed` - Distributed coordination

### 🌍 MCP Integration
- `./hive-flow mcp status` - MCP server status
- `./hive-flow mcp tools` - List available tools
- `./hive-flow mcp config` - Show configuration
- `./hive-flow mcp logs` - View MCP logs

### 🤖 Claude Integration
- `./hive-flow claude spawn "task"` - Spawn Claude with enhanced guidance
- `./hive-flow claude batch <file>` - Execute workflow configuration

## 🌟 Quick Examples

### Initialize with SPARC:
```bash
hive-flow init --sparc
```

### Start a development swarm:
```bash
./hive-flow swarm "Build REST API" --strategy development --monitor --review
```

### Run TDD workflow:
```bash
./hive-flow sparc tdd "user authentication"
```

### Store project context:
```bash
./hive-flow memory store "project_requirements" "e-commerce platform specs" --namespace project
```

### Spawn specialized agents:
```bash
./hive-flow agent spawn researcher --name "Senior Researcher" --priority 8
./hive-flow agent spawn developer --name "Lead Developer" --priority 9
```

## 🎯 Best Practices
- Use `./hive-flow` instead of `hive-flow` after initialization
- Store important context in memory for cross-session persistence
- Use swarm mode for complex tasks requiring multiple agents
- Enable monitoring for real-time progress tracking
- Use background mode for tasks > 30 minutes

## 📚 Resources
