#!/bin/bash
# Memory Management - Consolidate Script
# Optimize and consolidate memory

set -e

echo "Running memory consolidation..."
npx @hive-flow/cli hooks worker dispatch --trigger consolidate

echo "Memory consolidation complete"
npx @hive-flow/cli memory stats
