#!/bin/bash
# Capture hook guidance for Claude visibility
GUIDANCE_FILE=".hive-flow/last-guidance.txt"
mkdir -p .hive-flow

case "$1" in
  "route")
    node "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../@hive-flow/cli" && pwd)/bin/cli.js" hooks route "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
  "pre-edit")
    node "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../@hive-flow/cli" && pwd)/bin/cli.js" hooks pre-edit "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
esac
