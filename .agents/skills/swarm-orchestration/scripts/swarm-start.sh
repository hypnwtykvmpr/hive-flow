#!/bin/bash
# Swarm Orchestration - Start Script
# Initialize swarm with default anti-drift settings

set -e

echo "Initializing hierarchical swarm..."
npx @hive-flow/cli swarm init \
  --topology hierarchical \
  --max-agents 8 \
  --strategy specialized

echo "Swarm initialized successfully"
npx @hive-flow/cli swarm status
