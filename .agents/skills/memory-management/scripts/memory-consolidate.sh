#!/bin/bash
# Memory Management - Consolidate Script
# Optimize and consolidate memory

set -e

echo "Running memory consolidation..."
node v3/@hive-flow/cli/bin/cli.js hooks worker dispatch --trigger consolidate

echo "Memory consolidation complete"
node v3/@hive-flow/cli/bin/cli.js memory stats
