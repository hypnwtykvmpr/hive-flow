#!/bin/bash
# Publish script for @hive-flow/cli
# Publishes to both @hive-flow/cli@alpha AND hive-flow@v3alpha

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

cd "$CLI_DIR"

# Get current version
VERSION=$(node -p "require('./package.json').version")
echo "Publishing version: $VERSION"

# 1. Publish @hive-flow/cli with alpha tag
echo ""
echo "=== Publishing @hive-flow/cli@$VERSION (alpha tag) ==="
npm publish --tag alpha

# 2. Publish to hive-flow with v3alpha tag
echo ""
echo "=== Publishing hive-flow@$VERSION (v3alpha tag) ==="

# Create temp directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Copy necessary files
cp -r dist bin src package.json README.md "$TEMP_DIR/"

# Change package name to unscoped
cd "$TEMP_DIR"
sed -i 's/"name": "@hive-flow\/cli"/"name": "hive-flow"/' package.json

# Publish with v3alpha tag
npm publish --tag v3alpha

echo ""
echo "=== Updating dist-tags ==="

# Update all tags to point to the new version
npm dist-tag add @hive-flow/cli@$VERSION alpha
npm dist-tag add @hive-flow/cli@$VERSION latest
npm dist-tag add @hive-flow/cli@$VERSION v3alpha
npm dist-tag add hive-flow@$VERSION alpha
npm dist-tag add hive-flow@$VERSION latest
npm dist-tag add hive-flow@$VERSION v3alpha

echo ""
echo "=== Published successfully ==="
echo "  @hive-flow/cli@$VERSION (alpha, latest, v3alpha)"
echo "  hive-flow@$VERSION (alpha, latest, v3alpha)"
echo ""
echo "Install with:"
echo "  hive-flow"
echo "  hive-flow"
