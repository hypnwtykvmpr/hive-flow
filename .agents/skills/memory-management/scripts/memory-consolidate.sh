#!/bin/bash
# Memory Management - Consolidate Script
# Optimize and consolidate memory

set -e

echo "Running memory consolidation..."
hive-flow hooks worker dispatch --trigger consolidate

echo "Memory consolidation complete"
hive-flow memory stats
