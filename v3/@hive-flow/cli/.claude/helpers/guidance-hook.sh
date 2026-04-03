#!/bin/bash
# Capture hook guidance for Claude visibility
GUIDANCE_FILE=".hive-flow/last-guidance.txt"
mkdir -p .hive-flow

case "$1" in
  "route")
    node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks route "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
  "pre-edit")
    node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks pre-edit "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
esac
