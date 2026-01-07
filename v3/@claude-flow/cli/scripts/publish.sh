#!/bin/bash
# Publish script for @claude-flow/cli
# Publishes to both @claude-flow/cli@alpha AND claude-flow@v3alpha

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

cd "$CLI_DIR"

# Get current version
VERSION=$(node -p "require('./package.json').version")
echo "Publishing version: $VERSION"

# 1. Publish @claude-flow/cli with alpha tag
echo ""
echo "=== Publishing @claude-flow/cli@$VERSION (alpha tag) ==="
npm publish --tag alpha

# 2. Publish to claude-flow with v3alpha tag
echo ""
echo "=== Publishing claude-flow@$VERSION (v3alpha tag) ==="

# Create temp directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Copy necessary files
cp -r dist bin src package.json README.md "$TEMP_DIR/"

# Change package name to unscoped
cd "$TEMP_DIR"
sed -i 's/"name": "@claude-flow\/cli"/"name": "claude-flow"/' package.json

# Publish with v3alpha tag
npm publish --tag v3alpha

echo ""
echo "=== Published successfully ==="
echo "  @claude-flow/cli@$VERSION (alpha)"
echo "  claude-flow@$VERSION (v3alpha)"
echo ""
echo "Install with:"
echo "  npx @claude-flow/cli@alpha"
echo "  npx claude-flow@v3alpha"
