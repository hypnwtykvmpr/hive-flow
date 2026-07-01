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
  echo "Hive Flow CLI not found at $PROJECT_ROOT/cli/bin/cli.js" >&2
  return 1
}

CLI_PATH="$(resolve_cli)" || exit 0

case "$1" in
  "route")
    node "$CLI_PATH" hooks route "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
  "pre-edit")
    node "$CLI_PATH" hooks pre-edit "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
esac
