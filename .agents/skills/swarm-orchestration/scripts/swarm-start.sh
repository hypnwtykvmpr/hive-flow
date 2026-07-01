#!/bin/bash
# Swarm Orchestration - Start Script
# Initialize swarm with default anti-drift settings

set -e

echo "Initializing hierarchical swarm..."
hive-flow swarm init \
  --topology hierarchical \
  --max-agents 8 \
  --strategy specialized

echo "Swarm initialized successfully"
hive-flow swarm status
