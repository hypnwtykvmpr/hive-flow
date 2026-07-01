#!/bin/bash
# Capture hook guidance for Claude visibility
GUIDANCE_FILE=".hive-flow/last-guidance.txt"
mkdir -p .hive-flow
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

resolve_cli() {
  if [ -f "$PROJECT_ROOT/cli/bin/cli.js" ]; then
    printf '%s\n' "$PROJECT_ROOT/cli/bin/cli.js"
    return 0
  fi
  printf '%s\n' "$PROJECT_ROOT/v3/@hive-flow/cli/bin/cli.js"
}

CLI_PATH="$(resolve_cli)"

case "$1" in
  "route")
    node "$CLI_PATH" hooks route "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
  "pre-edit")
    node "$CLI_PATH" hooks pre-edit "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
esac
