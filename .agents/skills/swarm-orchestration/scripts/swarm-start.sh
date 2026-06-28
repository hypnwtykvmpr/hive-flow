#!/bin/bash
# Swarm Orchestration - Start Script
# Initialize swarm with default anti-drift settings

set -e

echo "Initializing hierarchical swarm..."
node v3/@hive-flow/cli/bin/cli.js swarm init \
  --topology hierarchical \
  --max-agents 8 \
  --strategy specialized

echo "Swarm initialized successfully"
node v3/@hive-flow/cli/bin/cli.js swarm status
