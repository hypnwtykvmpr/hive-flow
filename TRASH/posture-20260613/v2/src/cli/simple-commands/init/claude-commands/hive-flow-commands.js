import { promises as fs } from 'fs';
// hive-flow-commands.js - Hive-Flow specific slash commands

// Create Hive-Flow specific commands
export async function createHiveFlowCommands(workingDir) {
  // Help command
  const helpCommand = `---
name: hive-flow-help
description: Show Hive-Flow commands and usage
---

# Hive-Flow Commands

## 🌊 Hive-Flow: Agent Orchestration Platform

Claude-Flow is the ultimate multi-terminal orchestration platform that revolutionizes how you work with Claude Code.

## Core Commands

### 🚀 System Management
- \`./hive-flow start\` - Start orchestration system
- \`./hive-flow start --ui\` - Start with interactive process management UI
- \`./hive-flow status\` - Check system status
- \`./hive-flow monitor\` - Real-time monitoring
- \`./hive-flow stop\` - Stop orchestration

### 🤖 Agent Management
- \`./hive-flow agent spawn <type>\` - Create new agent
- \`./hive-flow agent list\` - List active agents
- \`./hive-flow agent info <id>\` - Agent details
- \`./hive-flow agent terminate <id>\` - Stop agent

### 📋 Task Management
- \`./hive-flow task create <type> "description"\` - Create task
- \`./hive-flow task list\` - List all tasks
- \`./hive-flow task status <id>\` - Task status
- \`./hive-flow task cancel <id>\` - Cancel task
- \`./hive-flow task workflow <file>\` - Execute workflow

### 🧠 Memory Operations
- \`./hive-flow memory store "key" "value"\` - Store data
- \`./hive-flow memory query "search"\` - Search memory
- \`./hive-flow memory stats\` - Memory statistics
- \`./hive-flow memory export <file>\` - Export memory
- \`./hive-flow memory import <file>\` - Import memory

### ⚡ SPARC Development
- \`./hive-flow sparc "task"\` - Run SPARC orchestrator
- \`./hive-flow sparc modes\` - List all 17+ SPARC modes
- \`./hive-flow sparc run <mode> "task"\` - Run specific mode
- \`./hive-flow sparc tdd "feature"\` - TDD workflow
- \`./hive-flow sparc info <mode>\` - Mode details

### 🐝 Swarm Coordination
- \`./hive-flow swarm "task" --strategy <type>\` - Start swarm
- \`./hive-flow swarm "task" --background\` - Long-running swarm
- \`./hive-flow swarm "task" --monitor\` - With monitoring
- \`./hive-flow swarm "task" --ui\` - Interactive UI
- \`./hive-flow swarm "task" --distributed\` - Distributed coordination

### 🌍 MCP Integration
- \`./hive-flow mcp status\` - MCP server status
- \`./hive-flow mcp tools\` - List available tools
- \`./hive-flow mcp config\` - Show configuration
- \`./hive-flow mcp logs\` - View MCP logs

### 🤖 Claude Integration
- \`./hive-flow claude spawn "task"\` - Spawn Claude with enhanced guidance
- \`./hive-flow claude batch <file>\` - Execute workflow configuration

## 🌟 Quick Examples

### Initialize with SPARC:
\`\`\`bash
npx -y hive-flow@latest init --sparc
\`\`\`

### Start a development swarm:
\`\`\`bash
./hive-flow swarm "Build REST API" --strategy development --monitor --review
\`\`\`

### Run TDD workflow:
\`\`\`bash
./hive-flow sparc tdd "user authentication"
\`\`\`

### Store project context:
\`\`\`bash
./hive-flow memory store "project_requirements" "e-commerce platform specs" --namespace project
\`\`\`

### Spawn specialized agents:
\`\`\`bash
./hive-flow agent spawn researcher --name "Senior Researcher" --priority 8
./hive-flow agent spawn developer --name "Lead Developer" --priority 9
\`\`\`

## 🎯 Best Practices
- Use \`./hive-flow\` instead of \`npx hive-flow\` after initialization
- Store important context in memory for cross-session persistence
- Use swarm mode for complex tasks requiring multiple agents
- Enable monitoring for real-time progress tracking
- Use background mode for tasks > 30 minutes

## 📚 Resources
- Documentation: https://github.com/ruvnet/claude-code-flow/docs
- Examples: https://github.com/ruvnet/claude-code-flow/examples
- Issues: https://github.com/ruvnet/claude-code-flow/issues
`;

  await fs.writeFile(`${workingDir}/.claude/commands/hive-flow-help.md`, helpCommand, 'utf8');
  console.log('  ✓ Created slash command: /hive-flow-help');

  // Memory command
  const memoryCommand = `---
name: hive-flow-memory
description: Interact with Hive-Flow memory system
---

# 🧠 Hive-Flow Memory System

The memory system provides persistent storage for cross-session and cross-agent collaboration with CRDT-based conflict resolution.

## Store Information
\`\`\`bash
# Store with default namespace
./hive-flow memory store "key" "value"

# Store with specific namespace
./hive-flow memory store "architecture_decisions" "microservices with API gateway" --namespace arch
\`\`\`

## Query Memory
\`\`\`bash
# Search across all namespaces
./hive-flow memory query "authentication"

# Search with filters
./hive-flow memory query "API design" --namespace arch --limit 10
\`\`\`

## Memory Statistics
\`\`\`bash
# Show overall statistics
./hive-flow memory stats

# Show namespace-specific stats
./hive-flow memory stats --namespace project
\`\`\`

## Export/Import
\`\`\`bash
# Export all memory
./hive-flow memory export full-backup.json

# Export specific namespace
./hive-flow memory export project-backup.json --namespace project

# Import memory
./hive-flow memory import backup.json
\`\`\`

## Cleanup Operations
\`\`\`bash
# Clean entries older than 30 days
./hive-flow memory cleanup --days 30

# Clean specific namespace
./hive-flow memory cleanup --namespace temp --days 7
\`\`\`

## 🗂️ Namespaces
- **default** - General storage
- **agents** - Agent-specific data and state
- **tasks** - Task information and results
- **sessions** - Session history and context
- **swarm** - Swarm coordination and objectives
- **project** - Project-specific context
- **spec** - Requirements and specifications
- **arch** - Architecture decisions
- **impl** - Implementation notes
- **test** - Test results and coverage
- **debug** - Debug logs and fixes

## 🎯 Best Practices

### Naming Conventions
- Use descriptive, searchable keys
- Include timestamp for time-sensitive data
- Prefix with component name for clarity

### Organization
- Use namespaces to categorize data
- Store related data together
- Keep values concise but complete

### Maintenance
- Regular backups with export
- Clean old data periodically
- Monitor storage statistics
- Compress large values

## Examples

### Store SPARC context:
\`\`\`bash
./hive-flow memory store "spec_auth_requirements" "OAuth2 + JWT with refresh tokens" --namespace spec
./hive-flow memory store "arch_api_design" "RESTful microservices with GraphQL gateway" --namespace arch
./hive-flow memory store "test_coverage_auth" "95% coverage, all tests passing" --namespace test
\`\`\`

### Query project decisions:
\`\`\`bash
./hive-flow memory query "authentication" --namespace arch --limit 5
./hive-flow memory query "test results" --namespace test
\`\`\`

### Backup project memory:
\`\`\`bash
./hive-flow memory export project-$(date +%Y%m%d).json --namespace project
\`\`\`
`;

  await fs.writeFile(`${workingDir}/.claude/commands/hive-flow-memory.md`, memoryCommand, 'utf8');
  console.log('  ✓ Created slash command: /hive-flow-memory');

  // Swarm command
  const swarmCommand = `---
name: hive-flow-swarm
description: Coordinate multi-agent swarms for complex tasks
---

# 🐝 Hive-Flow Swarm Coordination

Advanced multi-agent coordination system with timeout-free execution, distributed memory sharing, and intelligent load balancing.

## Basic Usage
\`\`\`bash
./hive-flow swarm "your complex task" --strategy <type> [options]
\`\`\`

## 🎯 Swarm Strategies
- **auto** - Automatic strategy selection based on task analysis
- **development** - Code implementation with review and testing
- **research** - Information gathering and synthesis
- **analysis** - Data processing and pattern identification
- **testing** - Comprehensive quality assurance
- **optimization** - Performance tuning and refactoring
- **maintenance** - System updates and bug fixes

## 🤖 Agent Types
- **coordinator** - Plans and delegates tasks to other agents
- **developer** - Writes code and implements solutions
- **researcher** - Gathers and analyzes information
- **analyzer** - Identifies patterns and generates insights
- **tester** - Creates and runs tests for quality assurance
- **reviewer** - Performs code and design reviews
- **documenter** - Creates documentation and guides
- **monitor** - Tracks performance and system health
- **specialist** - Domain-specific expert agents

## 🔄 Coordination Modes
- **centralized** - Single coordinator manages all agents (default)
- **distributed** - Multiple coordinators share management
- **hierarchical** - Tree structure with nested coordination
- **mesh** - Peer-to-peer agent collaboration
- **hybrid** - Mixed coordination strategies

## ⚙️ Common Options
- \`--strategy <type>\` - Execution strategy
- \`--mode <type>\` - Coordination mode
- \`--max-agents <n>\` - Maximum concurrent agents (default: 5)
- \`--timeout <minutes>\` - Timeout in minutes (default: 60)
- \`--background\` - Run in background for tasks > 30 minutes
- \`--monitor\` - Enable real-time monitoring
- \`--ui\` - Launch terminal UI interface
- \`--parallel\` - Enable parallel execution
- \`--distributed\` - Enable distributed coordination
- \`--review\` - Enable peer review process
- \`--testing\` - Include automated testing
- \`--encryption\` - Enable data encryption
- \`--verbose\` - Detailed logging output
- \`--dry-run\` - Show configuration without executing

## 🌟 Examples

### Development Swarm with Review
\`\`\`bash
./hive-flow swarm "Build e-commerce REST API" \\
  --strategy development \\
  --monitor \\
  --review \\
  --testing
\`\`\`

### Long-Running Research Swarm
\`\`\`bash
./hive-flow swarm "Analyze AI market trends 2024-2025" \\
  --strategy research \\
  --background \\
  --distributed \\
  --max-agents 8
\`\`\`

### Performance Optimization Swarm
\`\`\`bash
./hive-flow swarm "Optimize database queries and API performance" \\
  --strategy optimization \\
  --testing \\
  --parallel \\
  --monitor
\`\`\`

### Enterprise Development Swarm
\`\`\`bash
./hive-flow swarm "Implement secure payment processing system" \\
  --strategy development \\
  --mode distributed \\
  --max-agents 10 \\
  --parallel \\
  --monitor \\
  --review \\
  --testing \\
  --encryption \\
  --verbose
\`\`\`

### Testing and QA Swarm
\`\`\`bash
./hive-flow swarm "Comprehensive security audit and testing" \\
  --strategy testing \\
  --review \\
  --verbose \\
  --max-agents 6
\`\`\`

## 📊 Monitoring and Control

### Real-time monitoring:
\`\`\`bash
# Monitor swarm activity
./hive-flow monitor

# Monitor specific component
./hive-flow monitor --focus swarm
\`\`\`

### Check swarm status:
\`\`\`bash
# Overall system status
./hive-flow status

# Detailed swarm status
./hive-flow status --verbose
\`\`\`

### View agent activity:
\`\`\`bash
# List all agents
./hive-flow agent list

# Agent details
./hive-flow agent info <agent-id>
\`\`\`

## 💾 Memory Integration

Swarms automatically use distributed memory for collaboration:

\`\`\`bash
# Store swarm objectives
./hive-flow memory store "swarm_objective" "Build scalable API" --namespace swarm

# Query swarm progress
./hive-flow memory query "swarm_progress" --namespace swarm

# Export swarm memory
./hive-flow memory export swarm-results.json --namespace swarm
\`\`\`

## 🎯 Key Features

### Timeout-Free Execution
- Background mode for long-running tasks
- State persistence across sessions
- Automatic checkpoint recovery

### Work Stealing & Load Balancing
- Dynamic task redistribution
- Automatic agent scaling
- Resource-aware scheduling

### Circuit Breakers & Fault Tolerance
- Automatic retry with exponential backoff
- Graceful degradation
- Health monitoring and recovery

### Real-Time Collaboration
- Cross-agent communication
- Shared memory access
- Event-driven coordination

### Enterprise Security
- Role-based access control
- Audit logging
- Data encryption
- Input validation

## 🔧 Advanced Configuration

### Dry run to preview:
\`\`\`bash
./hive-flow swarm "Test task" --dry-run --strategy development
\`\`\`

### Custom quality thresholds:
\`\`\`bash
./hive-flow swarm "High quality API" \\
  --strategy development \\
  --quality-threshold 0.95
\`\`\`

### Scheduling algorithms:
- FIFO (First In, First Out)
- Priority-based
- Deadline-driven
- Shortest Job First
- Critical Path
- Resource-aware
- Adaptive

For detailed documentation, see: https://github.com/ruvnet/claude-code-flow/docs/swarm-system.md
`;

  await fs.writeFile(`${workingDir}/.claude/commands/hive-flow-swarm.md`, swarmCommand, 'utf8');
  console.log('  ✓ Created slash command: /hive-flow-swarm');
}
