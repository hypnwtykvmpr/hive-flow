# Claude-Flow v3: Enterprise AI Orchestration Platform

<div align="center">

[![Star on GitHub](https://img.shields.io/github/stars/ruvnet/claude-flow?style=for-the-badge&logo=github&color=gold)](https://github.com/ruvnet/claude-flow)
[![Downloads](https://img.shields.io/npm/dt/claude-flow?style=for-the-badge&logo=npm&color=blue&label=Downloads)](https://www.npmjs.com/package/claude-flow)
[![Latest Release](https://img.shields.io/npm/v/claude-flow/alpha?style=for-the-badge&logo=npm&color=green&label=v2.7.0-alpha.10)](https://www.npmjs.com/package/claude-flow)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-SDK%20Integrated-green?style=for-the-badge&logo=anthropic)](https://github.com/ruvnet/claude-flow)
[![Agentics Foundation](https://img.shields.io/badge/Agentics-Foundation-crimson?style=for-the-badge&logo=openai)](https://discord.com/invite/dfxmpwkG2D)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge&logo=opensourceinitiative)](https://opensource.org/licenses/MIT)

</div>

Multi-agent AI orchestration framework for Claude Code with swarm coordination, self-learning hooks, and Domain-Driven Design architecture.

---

## Quick Start

### Prerequisites

- **Node.js 18+** (LTS recommended)
- **npm 9+** or equivalent package manager
- **Windows users**: See [Windows Installation Guide](./docs/windows-installation.md)

**IMPORTANT**: Claude Code must be installed first:

```bash
# 1. Install Claude Code globally
npm install -g @anthropic-ai/claude-code

# 2. (Optional) Skip permissions check for faster setup
claude --dangerously-skip-permissions
```

### Installation

```bash
# Install claude-flow
npm install claude-flow@latest

# Initialize in your project
npx claude-flow init

# Start MCP server for Claude Code integration
npx claude-flow mcp start

# Run a task with agents
npx claude-flow --agent coder --task "Implement user authentication"
```

---

## Features

- **54+ Specialized Agents** - Coder, reviewer, tester, security-architect, performance-engineer, and more
- **Swarm Coordination** - Hierarchical, mesh, and adaptive topologies for parallel execution
- **Self-Learning Hooks** - ReasoningBank pattern learning with 150x faster HNSW search
- **MCP Integration** - Native Claude Code support via Model Context Protocol
- **Security-First** - Input validation, path traversal prevention, safe command execution
- **Cross-Platform** - Windows, macOS, and Linux support

---

## Use Cases

| Use Case | Command |
|----------|---------|
| Code review | `npx claude-flow --agent reviewer --task "Review PR #123"` |
| Test generation | `npx claude-flow --agent tester --task "Write tests for auth module"` |
| Security audit | `npx claude-flow --agent security-architect --task "Audit for vulnerabilities"` |
| Multi-agent swarm | `npx claude-flow swarm init --topology hierarchical` |
| Route task | `npx claude-flow hooks route "Optimize database queries"` |

---

## Architecture

```
v3/
├── @claude-flow/hooks      # Event-driven lifecycle hooks
├── @claude-flow/memory     # AgentDB vector storage
├── @claude-flow/security   # CVE remediation & patterns
├── @claude-flow/swarm      # 15-agent coordination
└── @claude-flow/plugins    # RuVector WASM plugins
```

## Performance

- **84.8%** SWE-Bench solve rate
- **2.8-4.4x** speed improvement with parallel execution
- **150x-12,500x** faster vector search with HNSW indexing
- **32.3%** token reduction through pattern learning

---

## Documentation

- [V2 Documentation](./v2/README.md)
- [Architecture Decisions](./v3/docs/adr/)
- [API Reference](./v2/docs/technical/)

## License

MIT - [RuvNet](https://github.com/ruvnet)
