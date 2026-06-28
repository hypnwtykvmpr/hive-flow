#!/bin/bash
# Quick start guide for Hive Flow

echo "🚀 Hive Flow Quick Start"
echo "=========================="
echo ""
echo "1. Initialize a swarm:"
echo "   node v3/@hive-flow/cli/bin/cli.js swarm init --topology hierarchical"
echo ""
echo "2. Spawn agents:"
echo '   node v3/@hive-flow/cli/bin/cli.js agent spawn --type coder --name "API Developer"'
echo ""
echo "3. Orchestrate tasks:"
echo '   node v3/@hive-flow/cli/bin/cli.js task orchestrate --task "Build REST API"'
echo ""
echo "4. Monitor progress:"
echo "   node v3/@hive-flow/cli/bin/cli.js swarm monitor"
echo ""
echo "📚 For more examples, see .claude/commands/"
