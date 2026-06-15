#!/bin/bash
# Setup MCP server for Hive Flow

echo "🚀 Setting up Hive Flow MCP server..."

# Check if claude command exists
if ! command -v claude &> /dev/null; then
    echo "❌ Error: Claude Code CLI not found"
    echo "Please install Claude Code first"
    exit 1
fi

# Add MCP server (portable: global install on PATH, else npx)
echo "📦 Adding Hive Flow MCP server..."
if command -v hive-flow-mcp &>/dev/null; then
    claude mcp add hive-flow -- hive-flow-mcp
elif command -v hive-flow &>/dev/null; then
    claude mcp add hive-flow -- hive-flow mcp start
else
    claude mcp add hive-flow -- npx -y "hive-flow" mcp start
fi

echo "✅ MCP server setup complete!"
echo "🎯 You can now use mcp__hive-flow__ tools in Claude Code"
