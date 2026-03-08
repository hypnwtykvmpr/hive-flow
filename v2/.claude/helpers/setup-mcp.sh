#!/bin/bash
# Setup MCP server for Hive Flow

echo "🚀 Setting up Hive Flow MCP server..."

# Check if claude command exists
if ! command -v claude &> /dev/null; then
    echo "❌ Error: Claude Code CLI not found"
    echo "Please install Claude Code first"
    exit 1
fi

# Add MCP server
echo "📦 Adding Hive Flow MCP server..."
claude mcp add hive-flow npx hive-flow mcp start

echo "✅ MCP server setup complete!"
echo "🎯 You can now use mcp__hive-flow__ tools in Claude Code"
