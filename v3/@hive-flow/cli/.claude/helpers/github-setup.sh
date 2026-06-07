#!/bin/bash
# Setup GitHub integration for Hive Flow

echo "🔗 Setting up GitHub integration..."

# Check for gh CLI
if ! command -v gh &> /dev/null; then
    echo "⚠️  GitHub CLI (gh) not found"
    echo "Continuing without GitHub features..."
else
    echo "✅ GitHub CLI found"
    
    # Check auth status
    if gh auth status &> /dev/null; then
        echo "✅ GitHub authentication active"
    else
        echo "⚠️  Not authenticated with GitHub"
        echo "Run: gh auth login"
    fi
fi

echo ""
echo "📦 GitHub swarm commands available:"
echo "  - hive-flow github swarm"
echo "  - hive-flow repo analyze"
echo "  - hive-flow pr enhance"
echo "  - hive-flow issue triage"
