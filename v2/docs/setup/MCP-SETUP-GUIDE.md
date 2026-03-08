# MCP Server Setup Guide for Hive Flow

## 🎯 Overview

Hive Flow integrates with Claude Code through MCP (Model Context Protocol) servers. This guide explains how to set up MCP servers correctly.

## 📋 Two Ways to Initialize

### 1. **Automatic Setup (Recommended)**

```bash
# This command automatically adds MCP servers
npx hive-flow@alpha init --force
```

**What it does:**
- Creates project files (CLAUDE.md, settings.json, etc.)
- Automatically runs: `claude mcp add hive-flow npx hive-flow@alpha mcp start`
- Sets up ruv-swarm and flow-nexus MCP servers (optional)
- Configures hooks and permissions

### 2. **Manual Setup**

If you already have Claude Code installed but need to add MCP servers:

```bash
# Add Hive Flow MCP server
claude mcp add hive-flow npx hive-flow@alpha mcp start

# Optional: Add enhanced coordination
claude mcp add ruv-swarm npx ruv-swarm mcp start

# Optional: Add cloud features
claude mcp add flow-nexus npx flow-nexus@latest mcp start
```

## ✅ Verify Setup

Check that MCP servers are running:

```bash
claude mcp list
```

Expected output:
```
hive-flow: npx hive-flow@alpha mcp start - ✓ Connected
ruv-swarm: npx ruv-swarm mcp start - ✓ Connected
flow-nexus: npx flow-nexus@latest mcp start - ✓ Connected
```

## 🔧 Troubleshooting

### Issue: MCP server shows local path instead of npx

**Example:**
```
hive-flow: /workspaces/claude-code-flow/bin/hive-flow mcp start - ✓ Connected
```

**Solution:**
This happens when you're working in the hive-flow repository itself. It's actually fine for development! The MCP server will work correctly.

If you want to use the npx command instead:

```bash
# Remove the existing server
claude mcp remove hive-flow

# Re-add with npx command
claude mcp add hive-flow npx hive-flow@alpha mcp start
```

### Issue: "claude: command not found"

**Solution:**
Install Claude Code first:

```bash
npm install -g @anthropic-ai/claude-code
```

### Issue: MCP server fails to connect

**Causes and Solutions:**

1. **Package not installed globally:**
   ```bash
   # Install the package
   npm install -g hive-flow@alpha
   ```

2. **Using local development version:**
   ```bash
   # In the hive-flow repo, build first
   npm run build
   ```

3. **Permission issues:**
   ```bash
   # Use --dangerously-skip-permissions for testing
   claude --dangerously-skip-permissions
   ```

## 📚 Understanding the Commands

### `npx hive-flow@alpha init`
- Initializes Hive Flow project files
- **Automatically calls** `claude mcp add` for you
- Only needs to be run once per project

### `claude init`
- Claude Code's own initialization
- Does **NOT** automatically add Hive Flow MCP servers
- Separate from Hive Flow initialization

### `claude mcp add <name> <command>`
- Adds an MCP server to Claude Code's global config
- Persists across projects
- Located in `~/.config/claude/`

## 🎯 Recommended Workflow

```bash
# 1. Install Claude Code (one-time)
npm install -g @anthropic-ai/claude-code

# 2. Initialize your project with Hive Flow (per project)
cd your-project
npx hive-flow@alpha init --force

# 3. Verify MCP servers are connected
claude mcp list

# 4. Start using Claude Code with MCP tools
claude
```

## 💡 Key Points

- **`npx hive-flow@alpha init`** does BOTH file setup AND MCP configuration
- **`claude init`** is just for Claude Code, not Hive Flow
- MCP servers are **global** (affect all Claude Code sessions)
- Project files (.claude/, CLAUDE.md) are **local** to each project

## 🔗 Related Documentation

- [Installation Guide](../setup/remote-setup.md)
- [Environment Setup](../setup/ENV-SETUP-GUIDE.md)
- [MCP Tools Reference](../reference/MCP_TOOLS.md)

---

**Questions?** See [GitHub Issues](https://github.com/ruvnet/hive-flow/issues) or join our [Discord](https://discord.com/invite/dfxmpwkG2D)
